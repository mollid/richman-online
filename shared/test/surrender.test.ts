import { describe, expect, it } from 'vitest';
import {
  applyAction,
  availableActions,
  createGame,
  DEATH_DURATION_DAYS,
  totalAssets,
  unluckyMultiplier,
  type GameState,
  type PlayerDef,
} from '../src/index.js';

/**
 * UI-13 投票认输 + GOD-12 死神效果（对标 help[51]、文档 UI-13 与GOD-12）。
 *
 * 原版依据：
 * - help[51]「死神附身時，不但會遺失所有卡片道具，還會發生一連串倒楣的事情。為期十三天」
 * - 文档 UI-13「認輸後**魔法屋女巫召喚死神**附身到**指定的人身上**」
 * - GOD-12 死神：遗失所有卡片道具 + 一连串倒霉事，13 天后自动消失
 *
 * 本组用例固化：认输者干净退出，死神落在投票选出的**复仇者**身上，
 * 复仇者被清空卡牌道具并进入 13 天**霉运加倍**状态。
 */

const PLAYERS: PlayerDef[] = [
  { id: 'p1', name: '阿福', color: 0xef5350 },
  { id: 'p2', name: '小美', color: 0x42a5f5 },
  { id: 'p3', name: '老王', color: 0x66bb6a },
];
const MONDAY = { year: 2026, month: 1, day: 5 } as const;

function newGame(seed = 42): GameState {
  return applyAction(createGame(PLAYERS, seed, { startDate: { ...MONDAY } }), { type: 'START_GAME' });
}

/** 让p1（当前玩家）持有卡牌与道具，便于验证被清空 */
function arm(p: GameState, playerId: string, cards = 3, items = 2): GameState {
  const target = p.players.find((q) => q.id === playerId)!;
  target.cards = Array.from({ length: cards }, () => 'angel');
  target.items = { teleporter: items };
  return p;
}

/** 冻结核桃指数为 1，让金额断言可写死 */
function pinIndexOne(state: GameState): GameState {
  let total = 0;
  for (const p of state.players) if (!p.bankrupt) total += totalAssets(state, p);
  state.initialCashPerPlayer = Math.max(1, total);
  state.initialPlayerCount = 1;
  return state;
}

describe('UI-13 认输：指定复仇者时死神不落在自己头上', () => {
  it('认输者干净退出（不承受死神惩罚）', () => {
    const g = arm(pinIndexOne(newGame()), 'p1', 3, 2);
    g.phase = 'awaiting_action';
    const r = applyAction(g, { type: 'SURRENDER', revengeTargetId: 'p2' });
    const me = r.players[0]!;
    expect(me.bankrupt).toBe(true);
    expect(me.god).toBeNull();
    expect(me.unlucky).toBeNull();
  });

  it('死神附身于复仇者：清空其全部卡片与道具', () => {
    const g = pinIndexOne(newGame());
    arm(g, 'p2', 4, 3);
    g.phase = 'awaiting_action';
    const r = applyAction(g, { type: 'SURRENDER', revengeTargetId: 'p2' });
    const avenger = r.players[1]!;
    expect(avenger.cards).toEqual([]);
    expect(avenger.items).toEqual({});
    expect(avenger.god?.godId).toBe('death');
    expect(r.log.some((l) => l.text.includes('复仇者'))).toBe(true);
  });

  it('复仇者进入 13 天霉运且倍率加倍', () => {
    const g = pinIndexOne(newGame());
    g.phase = 'awaiting_action';
    const r = applyAction(g, { type: 'SURRENDER', revengeTargetId: 'p3' });
    const avenger = r.players[2]!;
    expect(avenger.unlucky).not.toBeNull();
    expect(avenger.unlucky!.daysLeft).toBe(DEATH_DURATION_DAYS);
    expect(avenger.unlucky!.multiplier).toBe(2);
    expect(unluckyMultiplier(avenger)).toBe(2);
    // 死神本体同样 13 天
    expect(avenger.god?.remainingDays).toBe(DEATH_DURATION_DAYS);
  });

  it('未指定复仇者时沿用旧行为：死神落在认输者身上', () => {
    const g = arm(pinIndexOne(newGame()), 'p1', 2, 1);
    g.phase = 'awaiting_action';
    const r = applyAction(g, { type: 'SURRENDER' });
    const me = r.players[0]!;
    expect(me.bankrupt).toBe(true);
    expect(me.cards).toEqual([]);
    expect(me.items).toEqual({});
    expect(r.log.some((l) => l.text.includes('死神附身'))).toBe(true);
  });

  it('非法复仇者被拒（不存在 / 自己 / 已倒闭）', () => {
    const g = pinIndexOne(newGame());
    g.phase = 'awaiting_action';
    expect(() => applyAction(g, { type: 'SURRENDER', revengeTargetId: 'nobody' })).toThrow('复仇者不存在');
    expect(() => applyAction(g, { type: 'SURRENDER', revengeTargetId: 'p1' })).toThrow('不能是认输者本人');
    g.players[2]!.bankrupt = true;
    expect(() => applyAction(g, { type: 'SURRENDER', revengeTargetId: 'p3' })).toThrow('已倒闭');
  });

  it('两人局：认输者出局后另一人获胜', () => {
    const two = applyAction(createGame([PLAYERS[0]!, PLAYERS[1]!], 5, { startDate: { ...MONDAY } }), {
      type: 'START_GAME',
    });
    const r = applyAction(two, { type: 'SURRENDER', revengeTargetId: 'p2' });
    expect(r.phase).toBe('game_over');
    expect(r.winnerId).toBe('p2');
  });
});

describe('GOD-12 霉运的实效', () => {
  it('霉运期间过路费被抬高 2 倍', () => {
    const g = pinIndexOne(newGame());
    g.phase = 'awaiting_action';
    const r = applyAction(g, { type: 'SURRENDER', revengeTargetId: 'p2' });
    const avenger = r.players[1]!;
    expect(avenger.unlucky!.multiplier).toBe(2);
    // 租金计算入口应用了 unluckyMultiplier
    expect(unluckyMultiplier(avenger)).toBeGreaterThan(1);
    expect(r.log.some((l) => l.text.includes('复仇者'))).toBe(true);
  });

  it('无霉运时倍率为 1', () => {
    const g = newGame(7);
    expect(unluckyMultiplier(g.players[0]!)).toBe(1);
    expect(g.players[0]!.unlucky).toBeNull();
  });

  it('霉运在 13 天后自动清除', () => {
    const g = pinIndexOne(newGame());
    g.phase = 'awaiting_action';
    let s = applyAction(g, { type: 'SURRENDER', revengeTargetId: 'p2' });
    expect(s.players[1]!.unlucky).not.toBeNull();
    // 推进若干天让霉运到期（死神 13 天到期后自动消失）
    for (let i = 0; i < 13 * 3 + 20; i++) {
      if (s.phase === 'game_over') break;
      if (s.phase === 'awaiting_roll') s = applyAction(s, { type: 'ROLL_DICE' });
      else if (s.phase === 'awaiting_action') s = applyAction(s, { type: 'END_TURN' });
      else if (s.phase === 'awaiting_pick') s = applyAction(s, { type: 'MINIGAME_PICK', hole: 0 });
      else if (s.phase === 'awaiting_discard') s = applyAction(s, { type: 'DISCARD_CARD', cardId: s.players[s.currentPlayerIndex]!.cards[0]! });
      else break;
    }
    expect(s.players[1]!.unlucky).toBeNull();
    expect(unluckyMultiplier(s.players[1]!)).toBe(1);
  });
});

describe('UI-13 投票认输', () => {
  /** 手动构造投票期状态（认输者已出局） */
  function votingState(): GameState {
    const g = newGame(11);
    g.players[0]!.bankrupt = true; // 认输者已出局
    g.surrenderVote = {
      initiatorId: 'p1',
      candidateIds: ['p2', 'p3'],
      votes: {},
      resolved: false,
      stage: 'voting',
    };
    g.currentPlayerIndex = 1; // 指向存活玩家（p1 已出局）
    g.phase = 'awaiting_action';
    return g;
  }

  /** 推进到下一位存活玩家的决策阶段 */
  function nextVoter(state: GameState): GameState {
    let s = state;
    if (s.phase === 'awaiting_roll') s = applyAction(s, { type: 'ROLL_DICE' });
    else if (s.phase === 'awaiting_action') s = applyAction(s, { type: 'END_TURN' });
    else if (s.phase === 'awaiting_pick') s = applyAction(s, { type: 'MINIGAME_PICK', hole: 0 });
    // 轮转到下一个存活玩家
    while (s.players[s.currentPlayerIndex]?.bankrupt) {
      s.currentPlayerIndex = (s.currentPlayerIndex + 1) % s.players.length;
    }
    s.phase = 'awaiting_action';
    return s;
  }

  it('投票期暴露候选复仇者', () => {
    const g = votingState();
    const acts = availableActions(g);
    expect(acts.inSurrenderVote).toBe(true);
    expect(acts.revengeCandidates.map((c) => c.id)).toEqual(['p2', 'p3']);
  });

  it('投票记录并可改投', () => {
    let g = votingState();
    g = applyAction(g, { type: 'VOTE_REVENGE', revengeTargetId: 'p2' });
    expect(g.surrenderVote!.votes['p2']).toBe('p2');
    expect(availableActions(g).myRevengeVote).toBe('p2');
    // 改投
    g = applyAction(g, { type: 'VOTE_REVENGE', revengeTargetId: 'p3' });
    expect(g.surrenderVote!.votes['p2']).toBe('p3');
    expect(availableActions(g).myRevengeVote).toBe('p3');
  });

  it('不能投非候选者', () => {
    const g = votingState();
    expect(() => applyAction(g, { type: 'VOTE_REVENGE', revengeTargetId: 'p1' })).toThrow('不是复仇者候选');
  });

  it('全体投完自动结算：得票最多者成为复仇者并被死神附身', () => {
    let g = votingState();
    g = arm(g, 'p2', 3, 2);
    // p2 投p3，然后轮转到 p3 也投 p3 → p3 得票
    g = applyAction(g, { type: 'VOTE_REVENGE', revengeTargetId: 'p3' });
    g = nextVoter(g);
    g = applyAction(g, { type: 'VOTE_REVENGE', revengeTargetId: 'p3' });
    // 结算后投票关闭
    expect(g.surrenderVote).toBeNull();
    const winner = g.players[2]!;
    expect(winner.god?.godId).toBe('death');
    expect(winner.unlucky?.multiplier).toBe(2);
    // 被投的 p2 未受影响
    expect(g.players[1]!.god).toBeNull();
  });

  it('同票时按玩家顺序取先者（确定性）', () => {
    let g = votingState();
    g = applyAction(g, { type: 'VOTE_REVENGE', revengeTargetId: 'p2' });
    g = nextVoter(g);
    g = applyAction(g, { type: 'VOTE_REVENGE', revengeTargetId: 'p3' });
    // 1:1 平票→ 按 order取先出现的 p2
    expect(g.players[1]!.god?.godId).toBe('death');
    expect(g.players[2]!.god).toBeNull();
  });

  it('无投票进行中时候选为空', () => {
    const g = newGame(13);
    const acts = availableActions(g);
    expect(acts.inSurrenderVote).toBe(false);
    expect(acts.revengeCandidates).toEqual([]);
  });

  it('显式结算动作在无人投票时安全返回', () => {
    const g = newGame(15);
    const r = applyAction(g, { type: 'RESOLVE_SURRENDER_VOTE' });
    expect(r.surrenderVote).toBeNull();
  });
});