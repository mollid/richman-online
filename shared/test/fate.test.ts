import { describe, expect, it } from 'vitest';
import {
  applyAction,
  BOARD_SIZE,
  createGame,
  FATE_CARD_COUNT,
  FATE_CARDS,
  FATE_MAP_IDS,
  FATE_PUBLIC_COUNT,
  FATE_PUBLIC_IDS,
  fateCardById,
  nextRandom,
  renderFateText,
  rollDie,
  totalAssets,
} from '../src/index.js';
import type { GameState, PlayerDef } from '../src/index.js';

/**
 * 波 8 命运卡池 / 乞讨 / 恶犬测试
 * （对标文档 §9 EVT-04、NPC-05、TILE-17，数据源 docs/extraction/fate_pool_数据表_2026-09-27.txt）：
 * - 命运卡池 49 条（公共池 33 张 / 地图专属池 16 张）数据完备性；
 * - 机会格 TILE-17 改抽命运卡（原「抽卡」为 V0 权宜）；
 * - 代表效果：捡钱 / 罚款入乐透池 / 银行拒往 / 拆房 / 坐牢可被免罪卡抵消；
 * - EVT-04 倒闭乞讨：路人施舍 1000 元；
 * - NPC-05 恶犬：步行者被咬住院 3 天，驾车者撞跑恶犬；两者都只认**踩中**那一格（路过不算）。
 */

const PLAYERS: PlayerDef[] = [
  { id: 'p1', name: '阿福', color: 0xef5350 },
  { id: 'p2', name: '小美', color: 0x42a5f5 },
  { id: 'p3', name: '老王', color: 0x66bb6a },
];

/** 周一、非 15 号、非月末：隔离日切钩子 */
const MONDAY = { year: 2026, month: 1, day: 5 } as const;

function newGame(seed = 42): GameState {
  const g = applyAction(createGame(PLAYERS, seed, { startDate: { ...MONDAY } }), { type: 'START_GAME' });
  for (const p of g.players) p.diceCount = 2;
  return g;
}

/** 冻结物价指数为 1（分母对齐为当前总资产） */
function pinIndexOne(state: GameState): GameState {
  let total = 0;
  for (const p of state.players) {
    if (!p.bankrupt) total += totalAssets(state, p);
  }
  state.initialCashPerPlayer = Math.max(1, total);
  state.initialPlayerCount = 1;
  return state;
}

/** 找种子使「下一次 nextRandom」的取值落在指定命运卡下标（公共池 33 张）内 */
function seedForFateIndex(index: number): number {
  for (let s = 1; s <= 2_000_000; s++) {
    const v = nextRandom(s).value;
    if (Math.min(FATE_PUBLIC_COUNT - 1, Math.floor(v * FATE_PUBLIC_COUNT)) === index) return s;
  }
  throw new Error(`找不到命运卡下标 ${index} 的种子`);
}

/**
 * 把当前玩家摆到能以 steps 步落到 3 号机会格的位置，并把 RNG 置为「首抽恰好抽到 cardId」。
 * 用 `pendingFixedDice` 固定骰子 → 掷骰本身不消耗抽数，落格抽签可精确断言。
 */
function prepareChance(state: GameState, cardId: number, steps = 3): GameState {
  const s = structuredClone(state);
  const p = s.players[s.currentPlayerIndex]!;
  p.diceCount = 1;
  p.position = (3 - steps + BOARD_SIZE) % BOARD_SIZE;
  s.pendingFixedDice = steps;
  s.rngState = seedForFateIndex(cardId);
  return s;
}

describe('命运卡池数据（fate.ts）', () => {
  it('49 张卡、id 连续 0..48、文本非空', () => {
    expect(FATE_CARD_COUNT).toBe(49);
    expect(FATE_CARDS).toHaveLength(49);
    expect(FATE_CARDS.map((c) => c.id)).toEqual([...Array(49).keys()]);
    for (const c of FATE_CARDS) {
      expect(c.text.length).toBeGreaterThan(0);
    }
  });

  it('公共池 33 张 / 地图专属池 16 张，划分与下标一致', () => {
    expect(FATE_PUBLIC_COUNT).toBe(33);
    expect(FATE_PUBLIC_IDS).toHaveLength(33);
    expect(FATE_MAP_IDS).toHaveLength(16);
    expect(FATE_PUBLIC_IDS[0]).toBe(0);
    expect(FATE_PUBLIC_IDS.at(-1)).toBe(32);
    expect(FATE_MAP_IDS[0]).toBe(33);
    expect(FATE_MAP_IDS.at(-1)).toBe(48);
    // 地图专属池全部为坐牢案由
    for (const id of FATE_MAP_IDS) expect(fateCardById(id)!.effect).toBe('jail');
  });

  it('fateCardById 命中与未命中', () => {
    expect(fateCardById(25)!.effect).toBe('inherit');
    expect(fateCardById(999)).toBeUndefined();
  });

  it('renderFateText 填充占位符，缺参渲染为空串', () => {
    const def = fateCardById(20)!; // 在路边捡到 {amount} 元
    expect(renderFateText(def, { amount: 1000 })).toBe('在路边捡到 1000 元');
    expect(renderFateText(def)).toBe('在路边捡到  元');
    expect(renderFateText(fateCardById(33)!, { days: 2 })).toBe('酒醉大闹警局坐牢 2 天');
  });
});

describe('TILE-17 机会格抽命运卡', () => {
  it('落格抽到「在路边捡到 1000 元」：加现金且恰好消耗 1 抽', () => {
    const s = prepareChance(newGame(7), 20);
    const before = s.rngState;
    const landed = applyAction(s, { type: 'ROLL_DICE' });
    expect(landed.players[0]!.position).toBe(3);
    expect(landed.players[0]!.cash).toBe(15000 + 1000);
    expect(landed.log.some((l) => l.text.includes('【命运】') && l.text.includes('在路边捡到 1000 元'))).toBe(true);
    // 无额外随机的卡：抽签恰好 1 抽
    expect(landed.rngState).toBe(nextRandom(before).nextState);
  });

  it('意外获得遗产 20000 元', () => {
    const landed = applyAction(prepareChance(newGame(11), 25), { type: 'ROLL_DICE' });
    expect(landed.players[0]!.cash).toBe(15000 + 20000);
  });

  it('乱丢垃圾罚款 1200 元并汇入乐透奖池（ECON-08）', () => {
    const s = pinIndexOne(prepareChance(newGame(13), 18)); // 乱丢垃圾罚款 {amount}=1200
    const poolBefore = s.lotteryPool;
    const landed = applyAction(s, { type: 'ROLL_DICE' });
    expect(landed.players[0]!.cash).toBe(15000 - 1200);
    expect(landed.lotteryPool).toBe(poolBefore + 1200);
  });

  it('支票跳票：银行拒绝往来 30 天（loanBanDays=30）', () => {
    const landed = applyAction(prepareChance(newGame(17), 3), { type: 'ROLL_DICE' });
    expect(landed.loanBanDays).toBe(30);
    expect(landed.log.some((l) => l.text.includes('银行拒绝往来'))).toBe(true);
  });

  it('强制拆除房屋一栋：建筑等级还原为 1', () => {
    const g = newGame(19);
    g.players[1]!.properties = [{ cellId: 1, grade: 3 }];
    const landed = applyAction(prepareChance(g, 0), { type: 'ROLL_DICE' });
    expect(landed.players[1]!.properties[0]!.grade).toBe(1);
    expect(landed.log.some((l) => l.text.includes('强制拆除房屋') && l.text.includes('桃园路'))).toBe(true);
  });

  it('变卖所有卡片道具：按成本半价回收点券', () => {
    const g = newGame(23);
    g.players[0]!.cards = ['free-pass'];
    g.players[0]!.points = 0;
    const landed = applyAction(prepareChance(g, 32), { type: 'ROLL_DICE' });
    expect(landed.players[0]!.cards).toHaveLength(0);
    expect(landed.players[0]!.points).toBeGreaterThan(0);
  });
});

describe('EVT-02 坐牢可被免罪卡抵消', () => {
  it('持有免罪卡时抵消违法坐牢，卡片被消耗', () => {
    // 找一个会触发违法坐牢的种子（公共池无坐牢卡，出现 jail 即违法事件成立）
    let crimeSeed = 0;
    for (let seed = 1; seed <= 5000; seed++) {
      const r = applyAction(prepareChance(newGame(seed), 20), { type: 'ROLL_DICE' });
      if (r.players[0]!.custody?.kind === 'jail') {
        crimeSeed = seed;
        break;
      }
    }
    expect(crimeSeed).toBeGreaterThan(0);

    const g = prepareChance(newGame(crimeSeed), 20);
    g.players[0]!.cards = ['absolve'];
    const landed = applyAction(g, { type: 'ROLL_DICE' });
    expect(landed.players[0]!.custody).toBeNull();
    expect(landed.players[0]!.cards).not.toContain('absolve');
    expect(landed.log.some((l) => l.text.includes('抵消') && l.text.includes('牢狱'))).toBe(true);
  });
});

describe('EVT-04 倒闭者原地乞讨', () => {
  it('路人经过原地乞讨的倒闭者，施舍 1000 元', () => {
    const g = newGame(31);
    // p3 已倒闭并留在 4 号格乞讨；p1 从 3 号走 1 步经过
    const beggar = g.players[2]!;
    beggar.bankrupt = true;
    beggar.cash = 0;
    beggar.position = 4;
    pinIndexOne(g); // 倒闭者不计入总资产，冻结指数为 1
    const s = structuredClone(g);
    s.players[0]!.position = 3;
    s.players[0]!.diceCount = 1;
    s.pendingFixedDice = 1;
    const before = s.rngState;
    const landed = applyAction(s, { type: 'ROLL_DICE' });
    expect(landed.players[0]!.position).toBe(4);
    expect(landed.players[0]!.cash).toBe(15000 - 1000);
    expect(landed.players[2]!.cash).toBe(1000);
    expect(landed.log.some((l) => l.text.includes('乞讨') && l.text.includes('施舍'))).toBe(true);
    // 乞讨结算不消耗抽数
    expect(landed.rngState).toBe(before);
  });
});

/** 找一个种子，使「连掷两颗骰子之和」正好是 target（与 `drawDice` 同一套取数：rollDie 串两次） */
function seedForSum(target: number): number {
  for (let s = 1; s <= 200_000; s++) {
    const a = rollDie(s);
    const b = rollDie(a.nextState);
    if (a.value + b.value === target) return s;
  }
  throw new Error(`找不到和为 ${target} 的种子`);
}

describe('NPC-05 恶犬（TILE 随机出没）', () => {
  it('步行者（1 颗骰子）被咬伤，住院 3 天并丧失收租权', () => {
    const g = newGame(37);
    g.npcs = [{ kind: 'dog', position: 4, ownerId: null, daysLeft: 1, jailed: false }];
    const s = structuredClone(g);
    s.players[0]!.position = 3;
    s.players[0]!.diceCount = 1;
    s.pendingFixedDice = 1;
    const before = s.rngState;
    const landed = applyAction(s, { type: 'ROLL_DICE' });
    expect(landed.players[0]!.custody?.kind).toBe('hospital');
    expect(landed.players[0]!.skipTurns).toBe(3);
    expect(landed.players[0]!.rentBlockedTurns).toBeGreaterThanOrEqual(3);
    expect(landed.npcs.some((n) => n.kind === 'dog')).toBe(false);
    expect(landed.log.some((l) => l.text.includes('恶犬') && l.text.includes('咬伤'))).toBe(true);
    expect(landed.rngState).toBe(before); // 恶犬判定不消耗抽数
  });

  it('驾车者（≥2 颗骰子）踩中恶犬：把它撞跑，不受伤害', () => {
    const g = newGame(41);
    // 恶犬在 8 号格；p1 从 2 号出发，两骰之和固定为 6 ⇒ 正好**落**在那一格。
    // 用户规则：恶犬与宝箱都只认踩中，路过不算撞上（所以不能像旧实现那样拿途经格做用例）。
    g.npcs = [{ kind: 'dog', position: 8, ownerId: null, daysLeft: 1, jailed: false }];
    const s = structuredClone(g);
    s.players[0]!.position = 2;
    s.players[0]!.diceCount = 2;
    s.rngState = seedForSum(6);
    const landed = applyAction(s, { type: 'ROLL_DICE' });
    expect(landed.players[0]!.position).toBe(8);
    expect(landed.players[0]!.custody).toBeNull();
    expect(landed.npcs.some((n) => n.kind === 'dog')).toBe(false);
    expect(landed.log.some((l) => l.text.includes('撞跑了恶犬'))).toBe(true);
  });

  it('驾车者从恶犬那一格路过：不撞跑它，也不被咬', () => {
    const g = newGame(43);
    g.npcs = [{ kind: 'dog', position: 5, ownerId: null, daysLeft: 1, jailed: false }];
    const s = structuredClone(g);
    s.players[0]!.position = 2;
    s.players[0]!.diceCount = 2;
    s.rngState = seedForSum(6); // 2 → 8：5 号格只是路过
    const landed = applyAction(s, { type: 'ROLL_DICE' });
    expect(landed.players[0]!.position).toBe(8);
    expect(landed.npcs.some((n) => n.kind === 'dog')).toBe(true);
    expect(landed.log.some((l) => l.text.includes('恶犬'))).toBe(false);
  });

  it('createGame 初始化四大恶人在押于监狱、magic 为空', () => {
    const g = createGame(PLAYERS, 1, { startDate: { ...MONDAY } });
    expect(g.magic).toBeNull();
    // NPC-01..04 四大恶人初始在押于监狱格（26），无主、刑期 0；恶犬是日切才随机出没的，开局没有
    expect(g.npcs).toEqual([
      { kind: 'thief', position: 26, ownerId: null, daysLeft: 0, jailed: true },
      { kind: 'protection', position: 26, ownerId: null, daysLeft: 0, jailed: true },
      { kind: 'robber', position: 26, ownerId: null, daysLeft: 0, jailed: true },
      { kind: 'rent-thief', position: 26, ownerId: null, daysLeft: 0, jailed: true },
    ]);
  });
});