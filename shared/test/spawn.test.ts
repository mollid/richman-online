import { describe, expect, it } from 'vitest';
import {
  addPlayer,
  applyAction,
  availableActions,
  BOARD_SIZE,
  createGame,
  ReplayEngine,
  SHOP_CARD_IDS,
  spawnCellPool,
  type GameState,
  type PlayerAction,
  type PlayerDef,
} from '../src/index.js';

const MONDAY = { year: 2026, month: 1, day: 5 } as const;
const SEATS: PlayerDef[] = [
  { id: 'p1', name: '阿福', color: 0xef5350 },
  { id: 'p2', name: '小美', color: 0x42a5f5 },
  { id: 'p3', name: '老王', color: 0x66bb6a },
  { id: 'p4', name: '小陈', color: 0xffb300 },
];

/** 出生格允许的格型：站上去无事发生，且不含「经过才领薪水」的起点 */
const ALLOWED = ['property', 'commercial', 'chance', 'shop'];
/** 明确禁止当出生点的格型：特权格与要交钱/坐牢的格 */
const FORBIDDEN = ['start', 'jail', 'hospital', 'bank', 'god', 'tax', 'company'];

const ringGap = (a: number, b: number) => {
  const d = Math.abs(a - b);
  return Math.min(d, BOARD_SIZE - d);
};

/** 出生点候选池按静态默认盘算 */
const board = createGame([], 1).board;
const spawnOf = (state: GameState) => state.players.map((p) => p.position);

describe('SP-01 随机出生点', () => {
  it('出生格只落在可行走普通格，特权格与罚则格一概不作出生点', () => {
    const pool = spawnCellPool(board);
    for (const id of pool) expect(ALLOWED).toContain(board[id]!.type);
    for (const cell of board) {
      if (FORBIDDEN.includes(cell.type)) expect(pool).not.toContain(cell.id);
    }
    // 池子要够大，才谈得上「四人撒得开」
    expect(pool.length).toBeGreaterThanOrEqual(4 * 4);
  });

  it('同种子同座位恒等，换种子则真的会挪位置', () => {
    const first = spawnOf(createGame(SEATS, 20260105));
    expect(spawnOf(createGame(SEATS, 20260105))).toEqual(first);
    const others = new Set<number>();
    for (let seed = 1; seed <= 60; seed++) others.add(spawnOf(createGame(SEATS, seed))[0]!);
    expect(others.size).toBeGreaterThan(10);
  });

  it('四人局出生点互不重叠，且沿环至少隔 4 格', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const got = spawnOf(createGame(SEATS, seed));
      expect(new Set(got).size).toBe(4);
      for (let a = 0; a < got.length; a++) {
        for (let b = a + 1; b < got.length; b++) expect(ringGap(got[a]!, got[b]!)).toBeGreaterThanOrEqual(4);
      }
    }
  });

  it('派生不消耗 RNG 抽数：开局 rngState 仍等于种子', () => {
    const g = createGame(SEATS, 777);
    expect(g.rngState).toBe(777);
    expect(g.seed).toBe(777);
  });

  it('联机逐个进房与一次性建局算出同一批出生点（录像按座位序还原）', () => {
    let lobby = createGame([], 20260105, { startDate: { ...MONDAY } });
    for (const def of SEATS) lobby = addPlayer(lobby, def);
    expect(spawnOf(lobby)).toEqual(spawnOf(createGame(SEATS, 20260105)));
  });

  it('中途进人不会挪动别人已经拿到的出生点', () => {
    let lobby = createGame([], 55, { startDate: { ...MONDAY } });
    for (const def of SEATS.slice(0, 3)) lobby = addPlayer(lobby, def);
    const before = spawnOf(lobby);
    lobby = addPlayer(lobby, SEATS[3]!);
    expect(spawnOf(lobby).slice(0, 3)).toEqual(before);
  });

  it('开局把每人的出生格播报进日志', () => {
    const g = applyAction(createGame(SEATS.slice(0, 2), 20260105, { startDate: { ...MONDAY } }), { type: 'START_GAME' });
    for (const p of g.players) {
      expect(g.log.some((l) => l.text.includes(`${p.name} 随机出生落在「${g.board[p.position]!.name}」`))).toBe(true);
    }
  });

  it('随机出生不需要新的建局参数：只存 seed 与座位序，回放就能还原整局', () => {
    let s = applyAction(createGame(SEATS.slice(0, 2), 4242, { startDate: { ...MONDAY } }), { type: 'START_GAME' });
    const spawns = spawnOf(s);
    const actions: PlayerAction[] = [{ type: 'START_GAME' }];
    for (let i = 0; i < 40 && s.phase !== 'game_over'; i++) {
      const action: PlayerAction =
        s.phase === 'awaiting_roll'
          ? { type: 'ROLL_DICE' }
          : s.phase === 'awaiting_auction'
            ? { type: 'AUCTION_PASS' }
            : s.phase === 'awaiting_pick'
              ? { type: 'MINIGAME_PICK', hole: 0 }
              : s.phase === 'awaiting_discard'
                ? { type: 'DISCARD_CARD', cardId: s.players[s.currentPlayerIndex]!.cards[0]! }
                : { type: 'FINISH_LANDING' };
      s = applyAction(s, action);
      actions.push(action);
    }
    const replay = new ReplayEngine({
      seed: 4242,
      startDate: { ...MONDAY },
      players: SEATS.slice(0, 2).map((p) => ({ player_name: p.name, color: p.color, player_key: p.id })),
      actions: actions.map((action, i) => ({ turn: i, action })),
    });
    // 出生点建局即定 ⇒ 回放第一帧就是同一批格子，跑完终局也逐位相同
    expect(spawnOf(replay.states[0]!)).toEqual(spawns);
    expect(spawnOf(replay.finalState)).toEqual(spawnOf(s));
    expect(replay.finalState.turn).toBe(s.turn);
  });
});

/**
 * SP-02：出生格是开局「撒」到的，不是走到的 ⇒ 站着不算落到。
 *
 * 踏出一步就解除（`Player.spawnCell` 置 null），此后绕回同一格是真走到的，照常可买可进。
 * 用例都走「停留 ⇒ 一步没动却进入落格结算」这条真实路径（`holdTurns` 就是停留卡的效果）：
 * 开局第一手在 `awaiting_roll` 阶段本来就买不了地，光钉那个阶段看不出差别。
 */
describe('SP-02 出生格站着不算落到', () => {
  /** 造一个「刚开局、掷了骰却原地不动、正站在出生格上做落格决策」的局面 */
  function stuckAtSpawn(seed: number): GameState {
    const g = applyAction(createGame(SEATS.slice(0, 2), seed, { startDate: { ...MONDAY } }), { type: 'START_GAME' });
    g.players[0]!.holdTurns = 1; // 停留卡：下一次前进原地不动
    return applyAction(g, { type: 'ROLL_DICE' });
  }

  it('出生格正好是可购地：押着不放，门控与引擎同源拒绝', () => {
    const g = stuckAtSpawn(1);
    const spawn = createGame(SEATS.slice(0, 2), 1).players[0]!.position;
    expect(g.players[0]!.position).toBe(spawn); // 一步没走，还站在出生格
    expect(g.board[spawn]!.type).toBe('property');
    expect(availableActions(g).canBuy).toBe(false);
    expect(() => applyAction(g, { type: 'BUY_LAND' })).toThrow('出生格不能直接购买');
  });

  it('出生格撒在商店格：站着不算进店，买卡买道具都关着', () => {
    const g = stuckAtSpawn(30);
    expect(g.board[g.players[0]!.position]!.name).toBe('商店');
    expect(availableActions(g).canShop).toBe(false);
    expect(() => applyAction(g, { type: 'BUY_CARD', cardId: SHOP_CARD_IDS[0]! })).toThrow('不在商店');
  });

  it('踏出过一步就解除：再回到出生格是「走到的」，照常可买', () => {
    const spawn = createGame(SEATS.slice(0, 2), 1).players[0]!.position;
    let g = applyAction(createGame(SEATS.slice(0, 2), 1, { startDate: { ...MONDAY } }), { type: 'START_GAME' });
    expect(g.players[0]!.spawnCell).toBe(spawn);
    g = applyAction(g, { type: 'ROLL_DICE' });
    expect(g.players[0]!.position).not.toBe(spawn);
    expect(g.players[0]!.spawnCell).toBeNull();
    const back = structuredClone(g);
    back.currentPlayerIndex = 0;
    back.phase = 'awaiting_action';
    back.players[0]!.position = spawn;
    expect(availableActions(back).canBuy).toBe(true);
    expect(() => applyAction(back, { type: 'BUY_LAND' })).not.toThrow();
  });

  it('站在出生格上只做被允许的事：掷骰、炒股、用道具都还开着', () => {
    const acts = availableActions(stuckAtSpawn(1));
    expect(acts.canFinishLanding).toBe(true); // 停留这一手已掷过骰，至少能收尾
    expect(acts.canTradeStock).toBe(true);
    expect(acts.usableItems.length).toBeGreaterThan(0);
  });
});
