import { describe, expect, it } from 'vitest';
import {
  applyAction,
  availableActions,
  BOARD_SIZE,
  CARDS,
  createGame,
  ITEMS,
  MINIGAME_POINTS_PER_HIT,
  POINTS_START,
  rollDie,
  type GameState,
  type PlayerDef,
} from '../src/index.js';

/**
 * 点券经济（用户规则）：
 * - **初始没有点券**（POINTS_START = 0）；
 * - 产出**只有**四个渠道：宝箱、点券格（踩到特殊格子）、小游戏、商店变卖卡片/道具；
 * - 卡片与道具是点券的唯一去处（商店购买）。
 *
 * 宝箱 / 点券格的落格结算在 estate.test 覆盖，命运卡「变卖所有卡片道具」在 fate.test
 * 覆盖；本文件固化初始 0 与**商店变卖**（TILE-12 买/卖，help [27]）两条。
 */

const PLAYERS: PlayerDef[] = [
  { id: 'p1', name: '阿福', color: 0xef5350 },
  { id: 'p2', name: '小美', color: 0x42a5f5 },
  { id: 'p3', name: '老王', color: 0x66bb6a },
];
const MONDAY = { year: 2026, month: 1, day: 5 } as const;

function newGame(seed = 42): GameState {
  const g = applyAction(createGame(PLAYERS, seed, { startDate: { ...MONDAY } }), { type: 'START_GAME' });
  // 与 engine.test 同口径：测试玩家配机车（2 颗骰子），两骰之和才能精确落格
  for (const p of g.players) p.diceCount = 2;
  return g;
}

/** 找一个能让两骰之和等于 target 的确定性种子（与 engine.test 同款） */
function seedForSum(target: number): number {
  for (let s = 1; s <= 200000; s++) {
    const a = rollDie(s);
    const b = rollDie(a.nextState);
    if (a.value + b.value === target) return s;
  }
  throw new Error(`找不到和为 ${target} 的种子`);
}

/** 把当前玩家摆到「掷骰 sum 后落到 targetCell」的状态 */
function setupLanding(state: GameState, targetCell: number, sum: number): GameState {
  const s = structuredClone(state);
  s.rngState = seedForSum(sum);
  s.players[s.currentPlayerIndex]!.position = (targetCell - sum + BOARD_SIZE) % BOARD_SIZE;
  return s;
}

describe('点券经济：初始为 0', () => {
  it('开局每人 0 点券', () => {
    expect(POINTS_START).toBe(0);
    const g = newGame(7);
    for (const p of g.players) expect(p.points).toBe(0);
  });
});

describe('TILE-12 商店变卖：点券产出渠道之一', () => {
  /** 落到 2 号商店并进入决策阶段 */
  function atShop(seed: number): GameState {
    const g = setupLanding(newGame(seed), 2, 2);
    const rolled = applyAction(g, { type: 'ROLL_DICE' });
    expect(availableActions(rolled).canShop).toBe(true);
    return rolled;
  }

  it('变卖卡片：回收半价点券，卡片离手', () => {
    const g = atShop(111);
    const p = g.players[g.currentPlayerIndex]!;
    p.cards = ['demolish'];
    const before = p.points;
    const refund = Math.floor(CARDS['demolish']!.cost / 2);
    expect(refund).toBeGreaterThan(0);
    const r = applyAction(g, { type: 'SELL_CARD', cardId: 'demolish' });
    expect(r.players[g.currentPlayerIndex]!.cards).not.toContain('demolish');
    expect(r.players[g.currentPlayerIndex]!.points).toBe(before + refund);
    expect(r.log.some((l) => l.text.includes('变卖给商店'))).toBe(true);
  });

  it('变卖道具：回收半价点券，数量减一', () => {
    const g = atShop(112);
    const p = g.players[g.currentPlayerIndex]!;
    p.items = { roadblock: 2 };
    const before = p.points;
    const refund = Math.floor(ITEMS['roadblock']!.cost! / 2);
    const r = applyAction(g, { type: 'SELL_ITEM', itemId: 'roadblock' });
    expect(r.players[g.currentPlayerIndex]!.items['roadblock']).toBe(1);
    expect(r.players[g.currentPlayerIndex]!.points).toBe(before + refund);
  });

  it('变卖最后一个道具后从持有表中移除', () => {
    const g = atShop(113);
    const p = g.players[g.currentPlayerIndex]!;
    p.items = { roadblock: 1 };
    const r = applyAction(g, { type: 'SELL_ITEM', itemId: 'roadblock' });
    expect(r.players[g.currentPlayerIndex]!.items['roadblock']).toBeUndefined();
  });

  it('不在商店不能变卖', () => {
    const g = newGame(114);
    g.players[0]!.cards = ['demolish'];
    g.phase = 'awaiting_action';
    expect(() => applyAction(g, { type: 'SELL_CARD', cardId: 'demolish' })).toThrow('不在商店');
    g.players[0]!.items = { roadblock: 1 };
    expect(() => applyAction(g, { type: 'SELL_ITEM', itemId: 'roadblock' })).toThrow('不在商店');
  });

  it('没有的卡片/道具不能变卖', () => {
    const g = atShop(115);
    expect(() => applyAction(g, { type: 'SELL_CARD', cardId: 'demolish' })).toThrow('没有这张卡片');
    // 汽车不在开局赠礼中 → 确实「没有」
    expect(() => applyAction(g, { type: 'SELL_ITEM', itemId: 'car' })).toThrow('没有这个道具');
  });
});

describe('点券渠道：小游戏命中发放', () => {
  it('小游戏结束时按命中数发放点券（每中 +100）', () => {
    const g = newGame(21);
    g.phase = 'awaiting_pick';
    g.currentPlayerIndex = 0;
    // 直接构造最后一轮，前两轮全中 → 结算必然 ≥ 2 中
    g.minigame = { kind: 'shells', round: 2, hits: [true, true, false], symbols: [], revealed: [], matched: [], flips: 0 };
    const r = applyAction(g, { type: 'MINIGAME_PICK', hole: 0 });
    const awardLog = r.log.find((l) => l.text.includes('额外获得'));
    expect(awardLog).toBeTruthy();
    const pts = Number(awardLog!.text.match(/(\d+) 点券/)![1]);
    const hits = Number(r.log.find((l) => l.text.includes('小游戏结束：命中'))!.text.match(/命中 (\d)\/3/)![1]);
    expect(pts).toBe(hits * MINIGAME_POINTS_PER_HIT);
    expect(r.players[0]!.points).toBe(pts);
  });
});
