import { describe, expect, it } from 'vitest';
import {
  applyAction,
  BOARD_SIZE,
  createGame,
  DEATH_DURATION_DAYS,
  GOD_DURATION_DAYS,
  godDef,
  GODS,
  isNegativeGod,
  rollDie,
} from '../src/index.js';
import type { GameState, PlayerDef } from '../src/index.js';
import { pinIndexOne } from './helpers/state.js';

/**
 * 波 4 神明系统测试（对标文档 §8.1 GOD-01..12）：
 * - 天数制：神明以「天」计时（1 天 = 全员各行动一次），由日切钩子递减；
 * - 对偶转化：财/福/穷/衰 大⇄小、天使⇄恶魔、死神固定 13 天期满消失；
 * - 附身效果：附身瞬间一次性结算（四位数现金、赠卡、遗失卡片道具……）；
 * - 行进显灵：土地公侵占、财神抵赖租金、穷神租金加倍、福神免费买地/投资加倍、
 *   衰神买地流拍/投资失败、天使加盖/恶魔拆屋。
 */

/** 三人局：p0 行动不会触发回合回绕（回绕会带动日切钩子，污染断言） */
const PLAYERS: PlayerDef[] = [
  { id: 'p1', name: '阿福', color: 0xef5350 },
  { id: 'p2', name: '小美', color: 0x42a5f5 },
  { id: 'p3', name: '老王', color: 0x66bb6a },
];

/** 周一、非 15 号、非月末：隔离例假/分红/月末计息等日切钩子 */
const MONDAY = { year: 2026, month: 1, day: 5 } as const;

function newGame(seed = 42): GameState {
  const g = applyAction(createGame(PLAYERS, seed, { startDate: { ...MONDAY } }), { type: 'START_GAME' });
  for (const p of g.players) p.diceCount = 2; // 机车：两骰之和（历史语义）
  return g;
}

function seedForSum(target: number): number {
  for (let s = 1; s <= 200000; s++) {
    const a = rollDie(s);
    const b = rollDie(a.nextState);
    if (a.value + b.value === target) return s;
  }
  throw new Error(`找不到和为 ${target} 的种子`);
}

/** 把当前玩家摆到能以 sum 点落到 targetCell 的位置，并固定骰子结果 */
function landOn(state: GameState, targetCell: number, sum = 6): GameState {
  const s = structuredClone(state);
  s.rngState = seedForSum(sum);
  s.players[s.currentPlayerIndex]!.position = (targetCell - sum + BOARD_SIZE) % BOARD_SIZE;
  return s;
}

/** 推进一个动作（掷骰 / 结束回合 / 小游戏选杯）：落格可能停在 awaiting_action，需能收尾 */
function step(state: GameState): GameState {
  if (state.phase === 'awaiting_roll') return applyAction(state, { type: 'ROLL_DICE' });
  if (state.phase === 'awaiting_pick') return applyAction(state, { type: 'MINIGAME_PICK', hole: 0 });
  return applyAction(state, { type: 'END_TURN' });
}

/** 一直推进到跨过一天（触发日切钩子：神明计时递减/转化/消失） */
function advanceOneDay(state: GameState): GameState {
  const start = state.calendar.elapsedDays;
  let s = state;
  for (let i = 0; i < 16 && s.calendar.elapsedDays === start; i++) s = step(s);
  return s;
}

/**
 * CARD-23 请神卡：召唤「视窗范围内最靠近自己」的一位神明（纯计算，零抽数）。
 * 测试做法：把玩家摆到目标神明所在格（距离 0），必定请到该神明。
 */
function inviteGodAt(godId: string): GameState {
  const def = godDef(godId);
  if (!def) throw new Error(`没有神明 ${godId}`);
  const g = pinIndexOne(newGame(1));
  g.players[0]!.cards = ['invite-god'];
  g.players[0]!.position = def.cellId ?? 5;
  const r = applyAction(g, { type: 'USE_CARD', cardId: 'invite-god' });
  if (r.players[0]!.god?.godId !== godId) {
    throw new Error(`请神未落到 ${godId}，实际为 ${r.players[0]!.god?.godId}`);
  }
  return r;
}

/** 请神卡前置状态（未执行），供用例自行追加手牌/道具等再执行 */
function prepareInvite(godId: string): GameState {
  const def = godDef(godId);
  if (!def) throw new Error(`没有神明 ${godId}`);
  const g = pinIndexOne(newGame(1));
  g.players[0]!.cards = ['invite-god'];
  g.players[0]!.position = def.cellId ?? 5;
  return g;
}

describe('GOD-01..12 数据表与对偶转化图', () => {
  it('共 12 尊神明，常规 7 天、死神 13 天', () => {
    expect(GODS).toHaveLength(12);
    expect(godDef('death')?.durationDays).toBe(DEATH_DURATION_DAYS);
    for (const g of GODS) {
      if (g.id !== 'death') expect(g.durationDays).toBe(GOD_DURATION_DAYS);
    }
  });

  it('对偶转化闭环：财/福/穷/衰 大⇄小、天使⇄恶魔', () => {
    const pairs: Array<[string, string]> = [
      ['big-wealth', 'small-wealth'],
      ['big-fortune', 'small-fortune'],
      ['big-poverty', 'small-poverty'],
      ['big-misfortune', 'small-misfortune'],
      ['angel', 'devil'],
    ];
    for (const [a, b] of pairs) {
      expect(godDef(a)?.transformsTo).toBe(b);
      expect(godDef(b)?.transformsTo).toBe(a);
    }
  });

  it('土地公与死神不转化（期满自动离开）', () => {
    const independent = GODS.filter((g) => g.transformsTo === undefined).map((g) => g.id).sort();
    expect(independent).toEqual(['death', 'land-god']);
  });

  it('不祥神明判定（AI 送神卡用）', () => {
    expect(isNegativeGod('big-poverty')).toBe(true);
    expect(isNegativeGod('small-misfortune')).toBe(true);
    expect(isNegativeGod('death')).toBe(true);
    expect(isNegativeGod('big-wealth')).toBe(false);
    expect(isNegativeGod('angel')).toBe(false);
    expect(isNegativeGod(undefined)).toBe(false);
  });
});

describe('GOD 附身效果（一次性结算）', () => {
  it('GOD-02 大财神：意外获得四位数现金', () => {
    const g0 = prepareInvite('big-wealth');
    const before = g0.players[0]!.cash;
    const r = applyAction(g0, { type: 'USE_CARD', cardId: 'invite-god' });
    const gain = r.players[0]!.cash - before;
    expect(gain).toBeGreaterThanOrEqual(1000);
    expect(gain).toBeLessThanOrEqual(3999);
    expect(r.players[0]!.god?.remainingDays).toBe(GOD_DURATION_DAYS);
  });

  it('GOD-03 小财神：向其他每个人收取三位数现金', () => {
    const g0 = prepareInvite('small-wealth');
    const before = g0.players[0]!.cash;
    const beforeOthers = g0.players.slice(1).map((p) => p.cash);
    const r = applyAction(g0, { type: 'USE_CARD', cardId: 'invite-god' });
    const transfer = beforeOthers[0]! - r.players[1]!.cash; // 每位对手被收取的金额
    expect(transfer).toBeGreaterThanOrEqual(100);
    expect(transfer).toBeLessThanOrEqual(999);
    expect(beforeOthers[1]! - r.players[2]!.cash).toBe(transfer);
    expect(r.players[0]!.cash - before).toBe(transfer * 2);
  });

  it('GOD-04 大福神：赠送两张卡片', () => {
    const g0 = prepareInvite('big-fortune');
    const r = applyAction(g0, { type: 'USE_CARD', cardId: 'invite-god' });
    expect(r.players[0]!.cards).toHaveLength(1 + 2 - 1); // 请神卡消耗 1 张，附身再赠 2 张
  });

  it('GOD-05 小福神：赠送一张卡片', () => {
    const g0 = prepareInvite('small-fortune');
    const r = applyAction(g0, { type: 'USE_CARD', cardId: 'invite-god' });
    expect(r.players[0]!.cards).toHaveLength(1 + 1 - 1);
  });

  it('GOD-06 大穷神：损失四位数现金', () => {
    const g0 = prepareInvite('big-poverty');
    const before = g0.players[0]!.cash;
    const r = applyAction(g0, { type: 'USE_CARD', cardId: 'invite-god' });
    const loss = before - r.players[0]!.cash;
    expect(loss).toBeGreaterThanOrEqual(1000);
    expect(loss).toBeLessThanOrEqual(3999);
  });

  it('GOD-07 小穷神：送给其他每个人三位数现金', () => {
    const g0 = prepareInvite('small-poverty');
    const before = g0.players[0]!.cash;
    const beforeOthers = g0.players.slice(1).map((p) => p.cash);
    const r = applyAction(g0, { type: 'USE_CARD', cardId: 'invite-god' });
    const transfer = r.players[1]!.cash - beforeOthers[0]!;
    expect(transfer).toBeGreaterThanOrEqual(100);
    expect(transfer).toBeLessThanOrEqual(999);
    expect(r.players[2]!.cash - beforeOthers[1]!).toBe(transfer);
    expect(before - r.players[0]!.cash).toBe(transfer * 2);
  });

  it('GOD-08 大衰神：卡片遗失一半', () => {
    const g0 = prepareInvite('big-misfortune');
    g0.players[0]!.cards = ['invite-god', 'angel', 'devil', 'rebuild'];
    const r = applyAction(g0, { type: 'USE_CARD', cardId: 'invite-god' });
    expect(r.log.some((e) => e.text.includes('大衰神作祟') && e.text.includes('遗失 2 张卡片'))).toBe(true);
  });

  it('GOD-09 小衰神：遗失一张卡片', () => {
    const g0 = prepareInvite('small-misfortune');
    g0.players[0]!.cards = ['invite-god', 'angel', 'devil'];
    const r = applyAction(g0, { type: 'USE_CARD', cardId: 'invite-god' });
    expect(r.log.some((e) => e.text.includes('小衰神作祟') && e.text.includes('遗失一张卡片'))).toBe(true);
    expect(r.players[0]!.cards.length).toBeLessThanOrEqual(2);
  });

  it('GOD-12 死神：遗失所有卡片与道具并遭逢倒霉事', () => {
    const g0 = prepareInvite('death');
    g0.players[0]!.cards = ['invite-god', 'angel'];
    g0.players[0]!.items = { foo: 2 };
    const before = g0.players[0]!.cash;
    const r = applyAction(g0, { type: 'USE_CARD', cardId: 'invite-god' });
    expect(r.players[0]!.cards).toEqual([]);
    expect(r.players[0]!.items).toEqual({});
    expect(before - r.players[0]!.cash).toBe(2000);
    expect(r.players[0]!.god?.remainingDays).toBe(DEATH_DURATION_DAYS);
  });
});

describe('GOD 行进显灵', () => {
  /** 构造：p2（小美）拥有「南京路」(6)——商业组单格街道，1 级基础租金 ¥130 */
  function rentSetup(godId: string, grade: 1 | 2 | 3 = 1): GameState {
    const base = newGame(7);
    base.players[1]!.properties = [{ cellId: 6, grade }];
    const g = landOn(pinIndexOne(base), 6, 6); // p0 从起点走 6 步落到「南京路」
    g.players[0]!.god = { godId, remainingDays: 3 };
    return g;
  }

  /** 构造：p0（阿福）自己拥有「南京路」(6)，落到自家地进入 awaiting_action */
  function ownSetup(godId: string): GameState {
    const base = newGame(7);
    base.players[0]!.properties = [{ cellId: 6, grade: 1 }];
    const g = landOn(pinIndexOne(base), 6, 6);
    g.players[0]!.god = { godId, remainingDays: 3 };
    return g;
  }

  it('GOD-01 土地公：所到无主之地占为己有', () => {
    const g = landOn(pinIndexOne(newGame(7)), 6, 6);
    g.players[0]!.god = { godId: 'land-god', remainingDays: 3 };
    const r = applyAction(g, { type: 'ROLL_DICE' });
    expect(r.players[0]!.properties.some((q) => q.cellId === 6)).toBe(true);
    expect(r.players[0]!.cash).toBe(15000); // 免费占有，未付费
  });

  it('GOD-01 土地公：不必缴过路费', () => {
    const r = applyAction(rentSetup('land-god'), { type: 'ROLL_DICE' });
    expect(r.players[0]!.cash).toBe(15000);
    expect(r.players[1]!.deposit).toBe(0);
  });

  it('GOD-02 大财神：抵赖所有租金', () => {
    const r = applyAction(rentSetup('big-wealth'), { type: 'ROLL_DICE' });
    expect(r.players[0]!.cash).toBe(15000);
  });

  it('GOD-03 小财神：抵赖一半租金', () => {
    const r = applyAction(rentSetup('small-wealth'), { type: 'ROLL_DICE' });
    expect(15000 - r.players[0]!.cash).toBe(65); // 130 / 2
    expect(r.players[1]!.deposit).toBe(65);
  });

  it('GOD-06/07 穷神：踩到别人的地租金加倍', () => {
    const big = applyAction(rentSetup('big-poverty'), { type: 'ROLL_DICE' });
    expect(15000 - big.players[0]!.cash).toBe(260);
    const small = applyAction(rentSetup('small-poverty'), { type: 'ROLL_DICE' });
    expect(15000 - small.players[0]!.cash).toBe(260);
  });

  it('GOD-04 大福神：买地完全免费', () => {
    const g = landOn(pinIndexOne(newGame(7)), 6, 6);
    g.players[0]!.god = { godId: 'big-fortune', remainingDays: 3 };
    const landed = applyAction(g, { type: 'ROLL_DICE' });
    const bought = applyAction(landed, { type: 'BUY_LAND' });
    expect(bought.players[0]!.properties.some((q) => q.cellId === 6)).toBe(true);
    expect(bought.players[0]!.cash).toBe(15000); // 未扣款
  });

  it('GOD-08/09 衰神：买地流拍', () => {
    for (const godId of ['big-misfortune', 'small-misfortune']) {
      const g = landOn(pinIndexOne(newGame(7)), 6, 6);
      g.players[0]!.god = { godId, remainingDays: 3 };
      const landed = applyAction(g, { type: 'ROLL_DICE' });
      expect(() => applyAction(landed, { type: 'BUY_LAND' })).toThrow(/买地流拍/);
    }
  });

  it('GOD-08/09 衰神：投资失败（无法加盖）', () => {
    const landed = applyAction(ownSetup('small-misfortune'), { type: 'ROLL_DICE' });
    expect(landed.phase).toBe('awaiting_action');
    expect(() => applyAction(landed, { type: 'UPGRADE_LAND' })).toThrow(/投资失败/);
  });

  it('GOD-04/05 福神：盖房投资加倍（一次加盖两层）', () => {
    const landed = applyAction(ownSetup('small-fortune'), { type: 'ROLL_DICE' });
    const up = applyAction(landed, { type: 'UPGRADE_LAND' });
    expect(up.players[0]!.properties.find((q) => q.cellId === 6)?.grade).toBe(3);
  });

  it('GOD-10 天使：所到之处一律加盖一层房屋', () => {
    const r = applyAction(rentSetup('angel', 2), { type: 'ROLL_DICE' });
    expect(r.players[1]!.properties.find((q) => q.cellId === 6)?.grade).toBe(3);
  });

  it('GOD-11 恶魔：所到之处一律拆掉一层房屋', () => {
    const r = applyAction(rentSetup('devil', 2), { type: 'ROLL_DICE' });
    expect(r.players[1]!.properties.find((q) => q.cellId === 6)?.grade).toBe(1);
  });
});

describe('GOD 天数变更现身', () => {
  it('跨日后计时递减；死神 13 天期满自动消失（不转化）', () => {
    const g = landOn(pinIndexOne(newGame(11)), 62, 6); // p0 落到公司格（占位安全格）
    g.players[0]!.god = { godId: 'death', remainingDays: 1 };
    const after0 = applyAction(g, { type: 'ROLL_DICE' });
    expect(after0.players[0]!.god).toEqual({ godId: 'death', remainingDays: 1 });
    // 推到跨日 → 日切 → 死神期满自动消失（不转化）
    const afterDay = advanceOneDay(after0);
    expect(afterDay.players[0]!.god).toBeNull();
    expect(afterDay.log.some((e) => e.text.includes('死神 离开了 阿福'))).toBe(true);
  });
});