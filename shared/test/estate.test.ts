import { describe, expect, it } from 'vitest';
import {
  applyAction,
  availableActions,
  BOARD_SIZE,
  CHAIN_RENT_BASE,
  createGame,
  FACILITIES,
  FACILITY_ORDER,
  facilityBuildCost,
  gradeName,
  holdsWholeStreet,
  landRent,
  MAX_GRADE,
  POINTS_START,
  RESEARCH_ORDER,
  rollDie,
  streetCells,
  totalAssets,
  TREASURE_POINTS,
} from '../src/index.js';
import type { GameState, PlayerDef } from '../src/index.js';

/**
 * 波 3 商业建设与扩棋盘测试（对标文档 §4 EST-01..12 与 §9 TILE-01..31）：
 * - 商业用地（TILE-02）：首次只能购地，再次抵达才能建设（EST-06/07）；
 * - 五种设施：公园（免费/不可升级）、购物中心、旅馆、加油站、研究所（EST-08..12）；
 * - 住宅 5 级加盖（EST-02）与连锁店（EST-04/05）；
 * - 街区联合租金与黄金路线加成（EST-03）；
 * - 研究所研发队列（EST-09/10）；
 * - 新增格型：免费卡片 / 点券 / 宝箱 / 新闻 / 乐透行（TILE-13..19、TILE-31）；
 * - TILE-08 公立银行：路过可存取款、不可贷款。
 */

/**
 * 三人局：让「p2 落地结算」不会触发回合回绕（回绕会带动日切钩子：
 * 研发推进、定时效果递减、随机新闻），从而把断言隔离在单次落格结算上。
 */
const PLAYERS: PlayerDef[] = [
  { id: 'p1', name: '阿福', color: 0xef5350 },
  { id: 'p2', name: '小美', color: 0x42a5f5 },
  { id: 'p3', name: '老王', color: 0x66bb6a },
];

/** 周一、非 15 号、非月末：隔离日切钩子（与 engine.test 保持一致） */
const MONDAY = { year: 2026, month: 1, day: 5 } as const;

function newGame(seed = 42): GameState {
  const g = applyAction(createGame(PLAYERS, seed, { startDate: { ...MONDAY } }), { type: 'START_GAME' });
  // 机车（diceCount=2）：历史断言基于「两骰之和」
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

/** 找一个能让两骰之和等于 target 的确定性种子 */
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

/** 让指定玩家落到目标格（自动切换当前玩家） */
function landOnBy(state: GameState, playerIndex: number, targetCell: number, sum = 6): GameState {
  const s = structuredClone(state);
  s.currentPlayerIndex = playerIndex;
  s.rngState = seedForSum(sum);
  s.players[playerIndex]!.position = (targetCell - sum + BOARD_SIZE) % BOARD_SIZE;
  return s;
}

describe('商业用地与设施（EST-06..12）', () => {
  it('商业用地首次只能购地，再次抵达才能建设', () => {
    // 40 号世贸天阶（无主商业用地）
    let g = landOn(newGame(1001), 40);
    g = pinIndexOne(g);
    const rolled = applyAction(g, { type: 'ROLL_DICE' });
    expect(rolled.players[0]!.position).toBe(40);
    expect(rolled.phase).toBe('awaiting_action');
    const acts = availableActions(rolled);
    expect(acts.canBuy).toBe(true);
    expect(acts.buildableFacilities).toHaveLength(0); // 尚未购地

    const bought = applyAction(rolled, { type: 'BUY_LAND' });
    expect(bought.players[0]!.properties).toEqual([{ cellId: 40, grade: 1 }]);
    expect(bought.players[0]!.properties[0]!.facility).toBeUndefined();
  });

  it('自有商业用地可开工建设，且建设不结束回合、可继续升级', () => {
    // 直接授予地权，避免购地动作结束回合
    const base = landOn(newGame(1002), 40);
    base.players[0]!.properties = [{ cellId: 40, grade: 1 }];
    const state = pinIndexOne(base);
    const rolled = applyAction(state, { type: 'ROLL_DICE' });
    expect(rolled.phase).toBe('awaiting_action');

    const acts = availableActions(rolled);
    expect(acts.buildableFacilities).toEqual(FACILITY_ORDER);

    const cost = facilityBuildCost(rolled, rolled.board[40]!, 'mall');
    expect(cost).toBe(Math.round(600 * FACILITIES.mall.buildRatio));
    const built = applyAction(rolled, { type: 'BUILD_FACILITY', facility: 'mall' });
    expect(built.phase).toBe('awaiting_action'); // 建设不结束回合
    expect(built.players[0]!.properties[0]!.facility).toBe('mall');
    expect(built.players[0]!.cash).toBe(rolled.players[0]!.cash - cost);

    // 已建且可升级 → 同回合继续加盖
    expect(availableActions(built).canUpgrade).toBe(true);
    const upgraded = applyAction(built, { type: 'UPGRADE_LAND' });
    expect(upgraded.players[0]!.properties[0]!.grade).toBe(2);
    expect(upgraded.phase).toBe('awaiting_roll');
  });

  it('公园不向使用者收费，且不能升级（EST-08）', () => {
    const base = newGame(1003);
    base.players[0]!.properties = [{ cellId: 40, grade: 1, facility: 'park' }];
    const g = pinIndexOne(base);
    const rolled = applyAction(landOnBy(g, 1, 40), { type: 'ROLL_DICE' });
    expect(rolled.players[1]!.cash).toBe(15000); // 免费落脚
    expect(rolled.log.some((e) => e.text.includes('免费开放'))).toBe(true);

    // 主人自己站着也看不到「升级」
    const own = structuredClone(g);
    own.currentPlayerIndex = 0;
    own.players[0]!.position = 40;
    own.phase = 'awaiting_action';
    expect(availableActions(own).canUpgrade).toBe(false);
    expect(() => applyAction(own, { type: 'UPGRADE_LAND' })).toThrow();
  });

  it('加油站按行走步数 × 交通工具等级收费（EST-11）', () => {
    const base = newGame(1004);
    base.players[0]!.properties = [{ cellId: 40, grade: 1, facility: 'gas' }];
    const g = pinIndexOne(base);
    const rolled = applyAction(landOnBy(g, 1, 40, 6), { type: 'ROLL_DICE' });
    // 6 步 × 机车（2 级）× 50 = 600
    expect(rolled.players[1]!.cash).toBe(15000 - 600);
    expect(rolled.players[0]!.deposit).toBe(600);
  });

  it('购物中心转轮盘决定消费金额（EST-12）', () => {
    const base = newGame(1005);
    base.players[0]!.properties = [{ cellId: 40, grade: 1, facility: 'mall' }];
    const g = pinIndexOne(base);
    const rolled = applyAction(landOnBy(g, 1, 40), { type: 'ROLL_DICE' });
    const spent = 15000 - rolled.players[1]!.cash;
    // 基数 = round(600 × 0.25) × 1 级 = 150；轮盘 1..3 档
    expect(spent).toBeGreaterThanOrEqual(150);
    expect(spent).toBeLessThanOrEqual(450);
    expect(rolled.players[1]!.skipTurns).toBe(0);
  });

  it('旅馆转轮盘决定消费金额并强制休息 1..3 天（EST-12）', () => {
    const base = newGame(1006);
    base.players[0]!.properties = [{ cellId: 40, grade: 1, facility: 'hotel' }];
    const g = pinIndexOne(base);
    const rolled = applyAction(landOnBy(g, 1, 40), { type: 'ROLL_DICE' });
    const spent = 15000 - rolled.players[1]!.cash;
    expect(spent).toBeGreaterThanOrEqual(150);
    expect(spent).toBeLessThanOrEqual(450);
    expect(rolled.players[1]!.skipTurns).toBeGreaterThanOrEqual(1);
    expect(rolled.players[1]!.skipTurns).toBeLessThanOrEqual(3);
    expect(rolled.players[1]!.rentBlockedTurns).toBe(rolled.players[1]!.skipTurns);
  });

  it('研究所不收费，主人可按所等级立项研发（EST-09/10）', () => {
    const base = newGame(1007);
    base.players[0]!.properties = [{ cellId: 40, grade: 1, facility: 'lab' }];
    const g = pinIndexOne(base);
    const rolled = applyAction(landOnBy(g, 1, 40), { type: 'ROLL_DICE' });
    expect(rolled.players[1]!.cash).toBe(15000); // 研究所免费落脚

    // 3 级研究所解锁前 3 个项目
    const own = structuredClone(g);
    own.currentPlayerIndex = 0;
    own.players[0]!.position = 40;
    own.players[0]!.properties = [{ cellId: 40, grade: 3, facility: 'lab' }];
    own.phase = 'awaiting_action';
    const acts = availableActions(own);
    expect(acts.researchableItems).toEqual(RESEARCH_ORDER.slice(0, 3).map((r) => r.itemId));

    const started = applyAction(own, { type: 'START_RESEARCH', itemId: 'teleporter' });
    expect(started.phase).toBe('awaiting_action'); // 立项不结束回合
    expect(started.players[0]!.research).toEqual({ itemId: 'teleporter', remainDays: 4 });
    // 同时只能进行一项
    expect(() => applyAction(started, { type: 'START_RESEARCH', itemId: 'robot-worker' })).toThrow();
    // 等级不足的项目不可立项
    expect(() => applyAction(own, { type: 'START_RESEARCH', itemId: 'nuke' })).toThrow('研究所等级不足');
  });

  it('研发按天推进，到期后道具自动入栏（EST-09）', () => {
    let g = newGame(1008);
    g.players[0]!.research = { itemId: 'robot-worker', remainDays: 2 };
    // 2 人局：两人各行动一次 = 一整天；每回合都落到 2 号商店并结束回合
    while (g.players[0]!.research) {
      const s = structuredClone(g);
      s.rngState = seedForSum(6);
      s.players[s.currentPlayerIndex]!.position = 60; // 60 + 6 = 2（商店）
      let r = applyAction(s, { type: 'ROLL_DICE' });
      if (r.phase === 'awaiting_action') r = applyAction(r, { type: 'END_TURN' });
      g = r;
      if (g.turn > 40) throw new Error('研发未按预期推进');
    }
    expect(g.players[0]!.items['robot-worker']).toBe(1);
    expect(g.players[0]!.research).toBeNull();
  });
});

describe('等级、街区与连锁店（EST-02..05）', () => {
  it('住宅可加盖至 5 级，满级不可再升级', () => {
    const base = newGame(1101);
    base.players[0]!.properties = [{ cellId: 1, grade: 4 }];
    base.players[0]!.position = 1;
    base.phase = 'awaiting_action';
    pinIndexOne(base);
    expect(MAX_GRADE).toBe(5);
    const up = applyAction(base, { type: 'UPGRADE_LAND' });
    expect(up.players[0]!.properties[0]!.grade).toBe(5);
    expect(gradeName(5)).toBe('大厦');

    const full = structuredClone(up);
    full.phase = 'awaiting_action';
    full.currentPlayerIndex = 0; // 升级已结束回合，需把当前玩家拨回 p0
    full.players[0]!.position = 1;
    expect(availableActions(full).canUpgrade).toBe(false);
    expect(() => applyAction(full, { type: 'UPGRADE_LAND' })).toThrow('地产已满级');
  });

  it('同路段产业租金联合计算，买下整条街再享 1.5 倍黄金路线（EST-03）', () => {
    const base = newGame(1102);
    base.players[0]!.properties = [
      { cellId: 8, grade: 1 },
      { cellId: 9, grade: 1 },
      { cellId: 10, grade: 1 },
    ];
    const g = pinIndexOne(base);
    expect(streetCells(g, 9)).toEqual([8, 9, 10]);
    expect(holdsWholeStreet(g, 'p1', 9)).toBe(true);

    const single = landRent(g, g.board[9]!, 1);
    const total = [8, 9, 10].reduce((sum, id) => sum + landRent(g, g.board[id]!, 1), 0);
    expect(total).toBeGreaterThan(single);

    const rolled = applyAction(landOnBy(g, 1, 9), { type: 'ROLL_DICE' });
    const paid = 15000 - rolled.players[1]!.cash;
    expect(paid).toBe(Math.round(total * 1.5)); // 黄金路线加成
  });

  it('只持有路段的一部分时按联合总额计租（无加成）', () => {
    const base = newGame(1103);
    base.players[0]!.properties = [
      { cellId: 8, grade: 1 },
      { cellId: 9, grade: 1 },
    ];
    const g = pinIndexOne(base);
    expect(holdsWholeStreet(g, 'p1', 9)).toBe(false);
    const total = landRent(g, g.board[8]!, 1) + landRent(g, g.board[9]!, 1);
    const rolled = applyAction(landOnBy(g, 1, 9), { type: 'ROLL_DICE' });
    expect(15000 - rolled.players[1]!.cash).toBe(total);
  });

  it('连锁店按店面总数计价，且不能再加盖（EST-04/05）', () => {
    const base = newGame(1104);
    // 三处连锁店（第 6 号南京路 + 两处住宅；连锁店租金只数店面总数，不看路段）
    base.players[0]!.properties = [
      { cellId: 6, grade: 2, chain: true },
      { cellId: 36, grade: 2, chain: true },
      { cellId: 39, grade: 2, chain: true },
    ];
    const g = pinIndexOne(base);
    const rolled = applyAction(landOnBy(g, 1, 6), { type: 'ROLL_DICE' });
    expect(15000 - rolled.players[1]!.cash).toBe(CHAIN_RENT_BASE * 3);

    const own = structuredClone(g);
    own.currentPlayerIndex = 0;
    own.players[0]!.position = 6;
    own.phase = 'awaiting_action';
    expect(availableActions(own).canUpgrade).toBe(false);
    expect(() => applyAction(own, { type: 'UPGRADE_LAND' })).toThrow('连锁店不能再加盖');
  });
});

describe('新增格型与公立银行（TILE-13..19、TILE-31、TILE-08）', () => {
  it('免费卡片格获得一张卡片（TILE-13）', () => {
    const g = pinIndexOne(newGame(1201));
    const rolled = applyAction(landOn(g, 42), { type: 'ROLL_DICE' });
    expect(rolled.players[0]!.cards).toHaveLength(1);
  });

  it('点券格按格发放点券（TILE-14/15/16）', () => {
    for (const [cellId, gain] of [[41, 10], [46, 30], [52, 50]] as const) {
      const g = pinIndexOne(newGame(1202 + cellId));
      const rolled = applyAction(landOn(g, cellId), { type: 'ROLL_DICE' });
      expect(rolled.players[0]!.points).toBe(POINTS_START + gain);
    }
  });

  it('宝箱格获得宝箱点券（TILE-31）', () => {
    const g = pinIndexOne(newGame(1210));
    const rolled = applyAction(landOn(g, 56), { type: 'ROLL_DICE' });
    expect(rolled.players[0]!.points).toBe(POINTS_START + TREASURE_POINTS);
  });

  it('新闻格触发随机新闻事件（TILE-18）', () => {
    const g = pinIndexOne(newGame(1211));
    const rolled = applyAction(landOn(g, 44), { type: 'ROLL_DICE' });
    expect(rolled.log.some((e) => e.text.includes('【新闻】'))).toBe(true);
  });

  it('乐透行投注现金并累积奖池（TILE-19）', () => {
    const g = pinIndexOne(newGame(1212));
    const rolled = applyAction(landOn(g, 54), { type: 'ROLL_DICE' });
    expect(rolled.players[0]!.cash).toBe(15000 - 1000);
    expect(rolled.lotteryPool).toBe(1000);
    expect(rolled.log.some((e) => e.text.includes('奖池累计'))).toBe(true);
  });

  it('路过公立银行可存取款但不可贷款（TILE-08）', () => {
    const base = newGame(1213);
    base.players[0]!.position = 33; // 33 + 6 = 39，途经 35 号公立银行
    const g = pinIndexOne(base);
    const rolled = applyAction(landOn(g, 39), { type: 'ROLL_DICE' });
    expect(rolled.players[0]!.position).toBe(39);
    expect(rolled.bankAccess).toEqual({ canDeposit: true, canLoan: false, cellId: 35 });
    const acts = availableActions(rolled);
    expect(acts.canDeposit).toBe(true);
    expect(acts.canWithdraw).toBe(false);
    expect(acts.canLoan).toBe(false);

    const dep = applyAction(rolled, { type: 'DEPOSIT', amount: 1000 });
    expect(dep.players[0]!.cash).toBe(rolled.players[0]!.cash - 1000);
    expect(dep.players[0]!.deposit).toBe(1000);
    expect(() => applyAction(rolled, { type: 'TAKE_LOAN', amount: 1000 })).toThrow('此处不能贷款');
  });

  it('停在公立银行当格可存取款与贷款（TILE-08）', () => {
    const base = newGame(1214);
    const g = pinIndexOne(base);
    const rolled = applyAction(landOn(g, 35), { type: 'ROLL_DICE' });
    expect(rolled.phase).toBe('awaiting_action');
    expect(rolled.bankAccess).toEqual({ canDeposit: true, canLoan: true, cellId: 35 });
    expect(availableActions(rolled).canLoan).toBe(true);
  });
});