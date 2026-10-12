import { describe, expect, it } from 'vitest';
import {
  MAX_DAY_CHOICES,
  ONLINE_DEFAULT_MAX_DAYS,
  applyAction,
  createGame,
  resolveMaxDays,
  ReplayEngine,
  totalAssets,
  type GameState,
  type PlayerAction,
  type PlayerDef,
} from '../src/index.js';
import { pinIndexOne } from './helpers/state.js';
import { MONDAY, runGoldenMatch } from './helpers/golden_run.js';

/**
 * 对局结束条件（CORE-04 / 玩法文档 §14 第 2 项，W4）。
 *
 * 原版只有「对手全破产」一条收场路径；本作新增「打满 N 天后按总资产结算」，
 * 因为联机长局收不了口。这些用例钉住新增那条：谁赢、怎么排名、什么时候不该触发。
 */

const PLAYERS: PlayerDef[] = [
  { id: 'p1', name: '阿福', color: 0xef5350 },
  { id: 'p2', name: '小美', color: 0x42a5f5 },
  { id: 'p3', name: '老王', color: 0x66bb6a },
];

function game(maxDays: number | null, seed = 42): GameState {
  // 神明现身会占日切的 RNG 抽数，本文件只关心结算口径 ⇒ 关掉（玩法文档 §8.3）
  const g = applyAction(createGame(PLAYERS, seed, { startDate: { ...MONDAY }, spawnGods: false, maxDays }), {
    type: 'START_GAME',
  });
  return pinIndexOne(g);
}

/**
 * 立刻推过一次日切，而不让任何人掷骰移动。
 *
 * 把回合交给最后一位玩家再让他结束行动 ⇒ `advanceTurn` 必然绕回 0 号 ⇒ 跨日、跑日切钩子。
 * 中间没有落格、租金与薪水，测试里摆好的资产数字才不会被「打了一天」冲掉。
 */
function toDayBoundary(state: GameState): GameState {
  const s = structuredClone(state);
  if (s.phase === 'game_over') return s;
  s.currentPlayerIndex = s.players.length - 1;
  s.phase = 'awaiting_action';
  return applyAction(s, { type: 'FINISH_LANDING' });
}

/** 连过 n 个日切 */
function runBoundaries(state: GameState, n: number): GameState {
  let s = state;
  for (let i = 0; i < n; i++) s = toDayBoundary(s);
  return s;
}

/** 让指定玩家认输退场（走引擎的破产判定，不手改 bankrupt 标记） */
function surrender(state: GameState, playerId: string): GameState {
  const s = structuredClone(state);
  s.currentPlayerIndex = s.players.findIndex((p) => p.id === playerId);
  s.phase = 'awaiting_action';
  const target = s.players.find((p) => p.id !== playerId && !p.bankrupt)!.id;
  return applyAction(s, { type: 'SURRENDER', revengeTargetId: target });
}

describe('天数上限收场（W4）', () => {
  it('打满上限那天按总资产结算，资产最高者获胜', () => {
    const g = game(2);
    // 三人起始现金相同，用存款拉开差距：总资产口径含存款（ECON-01）
    g.players[0]!.deposit = 8000;
    g.players[1]!.deposit = 3000;
    expect(totalAssets(g, g.players[0]!)).toBeGreaterThan(totalAssets(g, g.players[2]!));

    const oneDay = runBoundaries(g, 1);
    expect(oneDay.phase).not.toBe('game_over'); // 第 1 天期满前不该提前收场
    expect(oneDay.calendar.elapsedDays).toBe(1);
    const ended = toDayBoundary(oneDay);
    expect(ended.calendar.elapsedDays).toBe(2);
    expect(ended.phase).toBe('game_over');
    expect(ended.endReason).toBe('daylimit');
    expect(ended.winnerId).toBe('p1');
    expect(ended.turnStage).toBe('end');
    expect(ended.log.at(-1)!.text).toContain('按总资产结算');
  });

  it('没设上限时连过 30 个日切也不结束（原版的唯一结束条件仍然成立）', () => {
    const ended = runBoundaries(game(null), 30);
    expect(ended.maxDays).toBeNull();
    expect(ended.calendar.elapsedDays).toBe(30);
    expect(ended.phase).not.toBe('game_over');
    expect(ended.endReason).toBeNull();
  });

  it('总资产并列时现金多者胜', () => {
    const g = game(1);
    // 两人总资产都是 5000，但阿福的现金更多：账面相同 ⇒ 真金白银定高下
    g.players[0]!.cash = 4000;
    g.players[0]!.deposit = 1000;
    g.players[1]!.cash = 3000;
    g.players[1]!.deposit = 2000;
    g.players[2]!.cash = 1000;
    g.players[2]!.deposit = 0;
    expect(totalAssets(g, g.players[0]!)).toBe(totalAssets(g, g.players[1]!));
    expect(runBoundaries(g, 1).winnerId).toBe('p1');
  });

  it('现金与存款都相同才算真并列 ⇒ 平局（无人获胜）', () => {
    const g = game(1);
    for (const p of g.players) {
      p.cash = 5000;
      p.deposit = 1000;
      p.properties = [];
    }
    const ended = runBoundaries(g, 1);
    expect(ended.phase).toBe('game_over');
    expect(ended.endReason).toBe('daylimit');
    expect(ended.winnerId).toBeNull();
    expect(ended.log.at(-1)!.text).toContain('本局平局');
  });

  it('到点当天不再走其余日切钩子（不多结一次股利与利息）', () => {
    // 上限落在第 1 天：跨过边界时 dayLimitHook 是 DAY_HOOKS 的第一个，
    // 它一收场，后面的分红 / 计息 / 研发 / 神明钩子都不再执行 ⇒ 结算那条必须是日志末条
    const ended = runBoundaries(game(1), 1);
    expect(ended.log.at(-1)!.text).toContain('按总资产结算');
  });

  it('破产制胜优先于天数上限：对手全灭时收场原因记为 bankrupt', () => {
    // 上限设到 60 天、此刻才第 1 天 ⇒ 日切钩子不可能触发，能结束这一局的只有「对手全破产」
    let s = game(60);
    s = surrender(s, 'p2');
    expect(s.players[1]!.bankrupt).toBe(true);
    expect(s.phase).not.toBe('game_over'); // 还剩两位
    s = surrender(s, 'p3');
    expect(s.phase).toBe('game_over');
    expect(s.endReason).toBe('bankrupt');
    expect(s.winnerId).toBe('p1');
  });

  it('到期结算的整局动作序列能被 ReplayEngine 复现 —— 上限必须随记录一起存', () => {
    // 注意两点：① 不能用 `game()` 夹具（它带 pinIndexOne，物价指数分母是夹具改的、
    // 记录里没有）；② 神明现身按生产默认开着 —— 关掉的话回放里它是开的，轨迹就分叉。
    let s = applyAction(createGame(PLAYERS, 42, { startDate: { ...MONDAY }, maxDays: 3 }), { type: 'START_GAME' });
    const actions: PlayerAction[] = [{ type: 'START_GAME' }];
    // 出生点随机（SP-01）之后到点那一手更靠后，预算从 60 放宽到 120 —— 本用例钉的是「记录能复现」，
    // 不是「几手收口」。这里也绝不能用 atLegacyStart 把出生点钉回起点：那等于造一个录像记录里
    // 不存在的前提，回放拿的是没钉过的那一局，轨迹必然分叉。
    for (let i = 0; i < 120 && s.phase !== 'game_over'; i++) {
      const mg = s.minigame;
      const open = mg?.kind === 'memory'
        ? mg.matched.map((m, idx) => (m || mg.revealed.includes(idx) ? -1 : idx)).find((idx) => idx >= 0) ?? 0
        : 0;
      const action: PlayerAction =
        s.phase === 'awaiting_roll'
          ? { type: 'ROLL_DICE' }
          : s.phase === 'awaiting_auction'
            ? { type: 'AUCTION_PASS' }
            : s.phase === 'awaiting_pick'
              ? { type: 'MINIGAME_PICK', hole: open }
              : s.phase === 'awaiting_discard'
                ? { type: 'DISCARD_CARD', cardId: s.players[s.currentPlayerIndex]!.cards[0]! }
                : { type: 'FINISH_LANDING' };
      s = applyAction(s, action);
      actions.push(action);
    }
    expect(s.endReason).toBe('daylimit');

    const record = {
      seed: 42,
      startDate: { ...MONDAY },
      maxDays: 3,
      // player_key 用局内 id：认输复仇、挂牌成交那类动作引用的就是它，回放必须同名
      players: PLAYERS.map((p) => ({ player_name: p.name, color: p.color, player_key: p.id })),
      actions: actions.map((action, i) => ({ turn: i, action })),
    };
    const replay = new ReplayEngine(record).finalState;
    expect(replay.endReason).toBe('daylimit');
    expect(replay.winnerId).toBe(s.winnerId);
    // 终局逐位对齐：名次、脚下了哪一格、总资产。旧夹具在此前给阿福塞过 9000 存款，
    // 那种局外改动进不了记录 ⇒ 回放拿到的是没塞过的初始态，随机出生之后排名就会分叉。
    const finalForm = (state: GameState) =>
      state.players.map((p) => [p.id, p.position, Math.round(totalAssets(state, p))]);
    expect(finalForm(replay)).toEqual(finalForm(s));
    expect(replay.calendar.elapsedDays).toBe(s.calendar.elapsedDays);

    // 反证：漏存 maxDays 就复现不出到期结算 —— 这一条正是本次修复的意义
    expect(new ReplayEngine({ ...record, maxDays: null }).finalState.endReason).not.toBe('daylimit');
  });

  it('结束后不再开拍：进行中的拍卖与待拍队列一并清空', () => {
    const g = game(1);
    g.auction = {
      cellId: 4,
      sellerId: null,
      trigger: 'bankrupt',
      bidders: ['p1', 'p2'],
      turnIndex: 0,
      minBid: 175,
      highestBid: 0,
      highestBidderId: null,
      passedSinceBid: [],
      withdrawn: [],
      afterComplete: 'advance',
    };
    const ended = runBoundaries(g, 1);
    expect(ended.phase).toBe('game_over');
    expect(ended.auction).toBeNull();
    expect(ended.auctionQueue).toEqual([]);
  });
});

describe('天数上限的取值口径（建房参数 / 默认档位）', () => {  it('联机默认 60 天，档位表里含「不限」', () => {
    expect(ONLINE_DEFAULT_MAX_DAYS).toBe(60);
    expect(MAX_DAY_CHOICES).toContain(null);
    expect(MAX_DAY_CHOICES).toContain(60);
  });

  it('resolveMaxDays：没填 / 0 / 非法 ⇒ 不限，越界夹到区间内', () => {
    expect(resolveMaxDays(undefined)).toBeNull();
    expect(resolveMaxDays(null)).toBeNull();
    expect(resolveMaxDays(0)).toBeNull();
    expect(resolveMaxDays('abc')).toBeNull();
    expect(resolveMaxDays(5)).toBe(10); // 下限：短到没意义的局不允许
    expect(resolveMaxDays(9999)).toBe(360);
    expect(resolveMaxDays(45.7)).toBe(45);
  });
});

describe('收场写定之后不许被覆盖（R5 修的两处活锁）', () => {
  /**
   * 不变式：`endReason` 一旦非空，那一帧必须停在 `game_over`。
   *
   * 钉的是这一类 bug：`advanceTurn` 里「日切 → 行情 → 开新回合」是一条直线，而**每一步都可能
   * 把某人逼到破产**（行情里的每日随机新闻正是这么做的），`endGame` 写完 `game_over` 之后
   * 直线还在往下走，最后一句 `phase = 'awaiting_roll'` 就把刚写定的收场抹了。
   * 局面带着胜者却仍在开局 ⇒ 可以继续打到所有人破产 ⇒ `checkWinner` 的「只剩 1 人」永远等不到
   * ⇒ 整局收不了口（实测：地图 2 上 turn=220 已判定三号胜，却一路打到 turn=369 全员破产）。
   */
  it('默认图与地图 2 的整局每一帧都满足「已判胜负 ⇒ phase 是 game_over」', () => {
    for (const mapId of [null, 2]) {
      const run = runGoldenMatch({ mapId, maxTurns: 300, sampleEvery: 100, collectStates: true });
      expect(run.stalls).toBe(0);
      const clobbered = run.states.filter((s) => s.endReason !== null && s.phase !== 'game_over');
      expect(clobbered).toHaveLength(0);
    }
  }, 180_000);

  it('双人房同归于尽：认输者退场、复仇者被索命打破产 ⇒ 无人获胜，但必须收场', () => {
    const g = applyAction(
      createGame(PLAYERS.slice(0, 2), 21, { startDate: { ...MONDAY }, spawnGods: false }),
      { type: 'START_GAME' },
    );
    pinIndexOne(g);
    const avenger = g.players[1]!;
    avenger.cash = 0;
    avenger.deposit = 0;
    const ended = surrender(g, 'p1');
    expect(ended.players.every((p) => p.bankrupt)).toBe(true);
    expect(ended.phase).toBe('game_over');
    expect(ended.endReason).toBe('bankrupt');
    expect(ended.winnerId).toBeNull();
    expect(ended.log.filter((e) => e.text.includes('无存活者'))).toHaveLength(1);
  });

  it('认输那一手已经判出结局：不再重开一局，也不把胜利播报写两遍', () => {
    const g = game(null, 22); // 三人局
    const avenger = g.players[1]!;
    avenger.cash = 0;
    avenger.deposit = 0;
    const ended = surrender(g, 'p1'); // p1 认输 → 死神落到 p2 → 只剩 p3
    expect(ended.phase).toBe('game_over');
    expect(ended.winnerId).toBe('p3');
    expect(ended.log.filter((e) => e.text.includes('获得最终胜利'))).toHaveLength(1);
  });
});
