import { describe, expect, it } from 'vitest';
import {
  AIRLINE_FEE_PER_DAY,
  applyAction,
  availableActions,
  CAR_MAINTENANCE_FEE,
  companyAtCell,
  companyFee,
  COMPANIES,
  COMPANY_LIST,
  COMPUTER_FEE,
  createGame,
  ESTATE_BUILD_RATIO,
  INSURANCE_FEE_PER_DAY,
  majorityHolderId,
  MAX_SHARES_PER_BUY,
  nextRandom,
  OIL_FEE,
  POWER_FEE_PER_LEVEL,
  RESTAURANT_FEE_PER_DAY,
  rollDie,
  scaled,
  stockExecPrice,
  WATER_FEE_PER_LAND,
  WHEEL_KINDS,
} from '../src/index.js';
import type { DateSerial, GameState, PlayerDef } from '../src/index.js';
import { pinIndexOne } from './helpers/state.js';

const PLAYERS: PlayerDef[] = [
  { id: 'p1', name: '阿福', color: 0xef5350 },
  { id: 'p2', name: '小美', color: 0x42a5f5 },
];

/** 周一、非 15 号、非月末：保证日切钩子不会在用例中途被动触发 */
const MONDAY: DateSerial = { year: 2026, month: 1, day: 5 };

function newGame(seed = 9001, startDate: DateSerial = MONDAY): GameState {
  const g = applyAction(createGame(PLAYERS, seed, { startDate: { ...startDate } }), { type: 'START_GAME' });
  // 统一配机车（diceCount=2），两骰之和可控
  for (const p of g.players) p.diceCount = 2;
  return g;
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

/** 找一个让单骰等于 target 的确定性种子 */
function seedForDie(target: number): number {
  for (let s = 1; s <= 200000; s++) {
    if (rollDie(s).value === target) return s;
  }
  throw new Error(`找不到点数为 ${target} 的种子`);
}

/** 找掷骰和为 target、且回合回绕（日切）时【不触发】玩家新闻事件的种子 */
function seedForSumQuietNews(target: number): number {
  for (let seed = 1; seed <= 200000; seed++) {
    const a = rollDie(seed);
    const b = rollDie(a.nextState);
    if (a.value + b.value !== target) continue;
    // 日切抽数固定：6 支股票波动 + 新闻选股 + 涨跌方向 = 8 抽，第 9 抽是事件门槛
    let st = b.nextState;
    for (let i = 0; i < 8; i++) st = nextRandom(st).nextState;
    if (nextRandom(st).value >= 0.25) return seed;
  }
  throw new Error('找不到满足条件的种子');
}

/** 让当前玩家落到指定公司格（两骰之和 7），可在掷骰前注入初始状态 */
function landOnCompany(cellId: number, mutate?: (g: GameState) => void): GameState {
  const s = newGame();
  s.rngState = seedForSum(7);
  s.players[s.currentPlayerIndex]!.position = cellId - 7;
  mutate?.(s);
  return applyAction(s, { type: 'ROLL_DICE' });
}

/** 把某公司的经营权直接交给指定玩家（跳过认购流程） */
function giveChairman(g: GameState, kind: (typeof COMPANY_LIST)[number]['kind'], playerId: string, shares = 100): void {
  const comp = g.companies.find((c) => c.kind === kind)!;
  comp.shares[playerId] = shares;
  comp.firstHeldDayIndex[playerId] = 0;
  comp.chairmanId = playerId;
}

/**
 * 双方各掷一次 3 点自动结算 → 推进正好一天。
 * 落格取 41 号「点券站」（38 + 3）：只加点券、不动现金/存款；
 * 种子取「日切不触发玩家新闻事件」的样本，避免随机新闻扰动金额断言。
 */
function advanceOneDay(state: GameState): GameState {
  let s = state;
  for (let i = 0; i < 2; i++) {
    s.rngState = seedForSumQuietNews(3);
    s.players[s.currentPlayerIndex]!.position = 38;
    s = applyAction(s, { type: 'ROLL_DICE' });
  }
  return s;
}

describe('CORP 公司企业：数据与经营权', () => {
  it('createGame 建立 11 家公司，格位与棋盘一致，股面值各不相同', () => {
    const g = newGame();
    expect(g.companies).toHaveLength(11);
    expect(new Set(g.companies.map((c) => c.sharePrice)).size).toBe(11);
    for (const co of g.companies) {
      const cell = g.board[co.cellId]!;
      expect(cell.type).toBe('company');
      expect(cell.companyKind).toBe(co.kind);
      expect(co.sharePrice).toBe(COMPANIES[co.kind].sharePrice);
      expect(co.surplus).toBe(0);
      expect(co.chairmanId).toBeNull();
    }
    // 需转轮盘的三家：航空/饭店/保险
    expect([...WHEEL_KINDS].sort()).toEqual(['airline', 'insurance', 'restaurant']);
  });

  it('CORP-02：持股最多者取得经营权；同票时归先入股者', () => {
    const g = newGame();
    const comp = g.companies.find((c) => c.kind === 'airline')!;
    comp.shares = { p1: 50, p2: 50 };
    comp.firstHeldDayIndex = { p1: 2, p2: 5 };
    expect(majorityHolderId(comp, g.players)).toBe('p1');
    comp.firstHeldDayIndex = { p1: 5, p2: 2 };
    expect(majorityHolderId(comp, g.players)).toBe('p2');
    comp.shares = { p1: 10, p2: 80 };
    expect(majorityHolderId(comp, g.players)).toBe('p2');
    comp.shares = {};
    expect(majorityHolderId(comp, g.players)).toBeNull();
  });
});

describe('CORP-01 认购股份', () => {
  it('按股面值现金结算；单次上限 1000 张；认购后成为董事长', () => {
    let g = landOnCompany(43); // 电脑公司 ¥400
    expect(g.phase).toBe('awaiting_action');
    expect(availableActions(g).canBuyShares).toBe(true);
    expect(availableActions(g).sharePrice).toBe(400);

    const before = g.players[0]!.cash;
    g = applyAction(g, { type: 'BUY_SHARES', cellId: 43, quantity: 10 });
    expect(g.players[0]!.cash).toBe(before - 4000);
    const comp = companyAtCell(g, 43)!;
    expect(comp.shares['p1']).toBe(10);
    expect(comp.chairmanId).toBe('p1');
    expect(comp.firstHeldDayIndex['p1']).toBe(0);

    expect(() => applyAction(g, { type: 'BUY_SHARES', cellId: 43, quantity: MAX_SHARES_PER_BUY + 1 })).toThrow(/上限/);
    expect(() => applyAction(g, { type: 'BUY_SHARES', cellId: 43, quantity: 0 })).toThrow(/正整数/);
  });

  it('他人持股反超后经营权自动移交（CORP-02）', () => {
    // p2 先做董事长；p1 一次买 200 张 → 反超 p2
    let g = landOnCompany(43, (s) => {
      giveChairman(s, 'computer', 'p2', 100);
      s.players[0]!.cash = 200000;
    });
    g = applyAction(g, { type: 'BUY_SHARES', cellId: 43, quantity: 200 });
    expect(companyAtCell(g, 43)!.chairmanId).toBe('p1');
    expect(g.log.some((l) => l.text.includes('取得电脑公司经营权'))).toBe(true);
  });

  it('现金不足时无法认购', () => {
    const g = landOnCompany(43, (s) => {
      s.players[0]!.cash = 100;
    });
    expect(availableActions(g).canBuyShares).toBe(false);
    expect(() => applyAction(g, { type: 'BUY_SHARES', cellId: 43, quantity: 1 })).toThrow(/现金不足/);
  });
});

describe('CORP-01/02 落格结算：董事长免付费，他人缴费入盈余', () => {
  it('董事长本人停靠免付费，且不产生盈余', () => {
    const g = landOnCompany(43, (s) => giveChairman(s, 'computer', 'p1'));
    expect(g.players[0]!.cash).toBe(15000);
    expect(companyAtCell(g, 43)!.surplus).toBe(0);
    expect(g.log.some((l) => l.text.includes('来到「电脑公司」（董事长）'))).toBe(true);
  });

  it('经营权空缺时不收费，仅进入决策阶段', () => {
    const g = landOnCompany(43);
    expect(g.players[0]!.cash).toBe(15000);
    expect(companyAtCell(g, 43)!.surplus).toBe(0);
    expect(g.log.some((l) => l.text.includes('经营权空缺'))).toBe(true);
  });

  it('CORP-05 电脑公司：非董事长停靠缴定额费（¥800）并计入累积盈余', () => {
    const g = landOnCompany(43, (s) => giveChairman(s, 'computer', 'p2'));
    expect(g.players[0]!.cash).toBe(15000 - COMPUTER_FEE);
    expect(companyAtCell(g, 43)!.surplus).toBe(COMPUTER_FEE);
    expect(g.phase).toBe('awaiting_action');
  });
});

describe('CORP-03/04/06 转轮盘公司', () => {
  it('CORP-03 航空：轮盘定出国天数（1..3），出国期间不能收租', () => {
    const g = landOnCompany(51, (s) => giveChairman(s, 'airline', 'p2'));
    const me = g.players[0]!;
    expect(me.abroadTurns).toBeGreaterThanOrEqual(1);
    expect(me.abroadTurns).toBeLessThanOrEqual(3);
    expect(me.skipTurns).toBe(me.abroadTurns);
    expect(me.rentBlockedTurns).toBe(me.abroadTurns);
    expect(companyAtCell(g, 51)!.surplus).toBe(AIRLINE_FEE_PER_DAY * me.abroadTurns);
  });

  it('CORP-03 出国期间不能收租（收租拦截）', () => {
    // p2 拥有 1 号地产，但 p2 正在国外；p1 落到 1 号时应免租
    let g = newGame();
    g.players[1]!.properties = [{ cellId: 1, grade: 1 }];
    g.players[1]!.abroadTurns = 3;
    g.players[0]!.position = 0;
    g.players[0]!.diceCount = 1;
    g.rngState = seedForDie(1); // 走 1 步 → 1 号桃园路
    const beforeDeposit = g.players[1]!.deposit;
    g = applyAction(g, { type: 'ROLL_DICE' });
    expect(g.players[1]!.deposit).toBe(beforeDeposit);
    expect(g.log.some((l) => l.text.includes('国外旅游') && l.text.includes('无权收租'))).toBe(true);
  });

  it('CORP-04 饭店：轮盘定休息天数与消费金额', () => {
    const g = landOnCompany(55, (s) => giveChairman(s, 'restaurant', 'p2'));
    const me = g.players[0]!;
    expect(me.skipTurns).toBeGreaterThanOrEqual(1);
    expect(me.skipTurns).toBeLessThanOrEqual(3);
    expect(me.rentBlockedTurns).toBe(me.skipTurns);
    expect(companyAtCell(g, 55)!.surplus).toBe(RESTAURANT_FEE_PER_DAY * me.skipTurns);
  });

  it('CORP-06 保险：强制签约，轮盘定投保天数与保费', () => {
    const g = landOnCompany(47, (s) => giveChairman(s, 'insurance', 'p2'));
    const me = g.players[0]!;
    expect(me.insurance).not.toBeNull();
    const days = me.insurance!.daysLeft;
    expect(days).toBeGreaterThanOrEqual(1);
    expect(days).toBeLessThanOrEqual(3);
    expect(companyAtCell(g, 47)!.surplus).toBe(INSURANCE_FEE_PER_DAY * days);
  });
});

describe('CORP-07/08/10/11 按持有物计费', () => {
  it('CORP-07/08：汽车与石油公司——没开车免费，开车才收', () => {
    const g = newGame();
    const p = g.players[0]!;
    pinIndexOne(g);
    p.diceCount = 1;
    expect(companyFee(g, 'car', p, 0)).toBe(0);
    expect(companyFee(g, 'oil', p, 0)).toBe(0);
    p.diceCount = 2;
    expect(companyFee(g, 'car', p, 0)).toBe(CAR_MAINTENANCE_FEE);
    expect(companyFee(g, 'oil', p, 0)).toBe(OIL_FEE);
  });

  it('CORP-10：水力公司——按拥有土地总笔数计费', () => {
    const g = newGame();
    const p = g.players[0]!;
    p.properties = [
      { cellId: 1, grade: 1 },
      { cellId: 4, grade: 1 },
      { cellId: 6, grade: 2 },
    ];
    pinIndexOne(g);
    expect(companyFee(g, 'water', p, 0)).toBe(3 * WATER_FEE_PER_LAND);
  });

  it('CORP-11：电力公司——按房屋/连锁店/建设级数总和计费', () => {
    const g = newGame();
    const p = g.players[0]!;
    p.properties = [
      { cellId: 1, grade: 3 },
      { cellId: 4, grade: 2 },
    ];
    pinIndexOne(g);
    expect(companyFee(g, 'power', p, 0)).toBe(5 * POWER_FEE_PER_LEVEL);
  });
});

describe('CORP-12 百货公司', () => {
  it('同公立百货可购物；董事长进入获赠卡片或道具', () => {
    const g = landOnCompany(62, (s) => giveChairman(s, 'department', 'p1'));
    const me = g.players[0]!;
    const itemCount = Object.values(me.items).reduce((a, b) => a + b, 0);
    expect(me.cards.length + itemCount).toBeGreaterThan(0);
    expect(availableActions(g).canShop).toBe(true);
  });

  it('非董事长进入百货公司不缴费但可购物', () => {
    const g = landOnCompany(62, (s) => giveChairman(s, 'department', 'p2'));
    expect(g.players[0]!.cash).toBe(15000);
    expect(availableActions(g).canShop).toBe(true);
  });
});

describe('CORP-13 房地产公司加盖', () => {
  it('可任选一处自有地产加盖一层，按该地地价收施工费', () => {
    const landed = landOnCompany(63, (s) => {
      s.players[0]!.properties = [{ cellId: 1, grade: 1 }];
    });
    const acts = availableActions(landed);
    expect(acts.canBuildEstate).toBe(true);
    expect(acts.estateBuildCells).toEqual([1]);

    const cost = scaled(landed, Math.round(300 * ESTATE_BUILD_RATIO)); // 桃园路 ¥300
    const before = landed.players[0]!.cash;
    const g = applyAction(landed, { type: 'BUILD_ESTATE', cellId: 1 });
    expect(g.players[0]!.properties[0]!.grade).toBe(2);
    expect(before - g.players[0]!.cash).toBe(cost);
    expect(companyAtCell(g, 63)!.surplus).toBe(cost);
  });

  it('满级地产不可加盖；只能加盖自己的地产', () => {
    const landed = landOnCompany(63, (s) => {
      s.players[0]!.properties = [{ cellId: 1, grade: 5 }];
    });
    expect(availableActions(landed).canBuildEstate).toBe(false);
    expect(() => applyAction(landed, { type: 'BUILD_ESTATE', cellId: 1 })).toThrow(/满级/);
    expect(() => applyAction(landed, { type: 'BUILD_ESTATE', cellId: 4 })).toThrow(/自己的地产/);
  });
});

describe('CORP-09 企业银行与特别融资', () => {
  it('功能同公立银行：落格开放存取款/贷款/股票', () => {
    const g = landOnCompany(58, (s) => giveChairman(s, 'bank', 'p2'));
    expect(g.bankAccess).not.toBeNull();
    const acts = availableActions(g);
    expect(acts.canDeposit).toBe(true);
    expect(acts.canLoan).toBe(true);
    expect(acts.canTradeStock).toBe(true);
    // 非董事长无融资权
    expect(acts.canFinancing).toBe(false);
  });

  it('董事长特别融资：上限 = 其他玩家存款总额', () => {
    const landed = landOnCompany(58, (s) => {
      giveChairman(s, 'bank', 'p1');
      s.players[1]!.deposit = 5000;
    });
    const acts = availableActions(landed);
    expect(acts.canFinancing).toBe(true);
    expect(acts.financingRemaining).toBe(5000);

    const before = landed.players[0]!.cash;
    const g = applyAction(landed, { type: 'SPECIAL_FINANCING', amount: 3000 });
    expect(g.players[0]!.cash).toBe(before + 3000);
    expect(g.players[0]!.financing).toBe(3000);
    expect(() => applyAction(g, { type: 'SPECIAL_FINANCING', amount: 3000 })).toThrow(/上限/);
  });

  it('董事长特别融资周转期间，月末存款不计息', () => {
    const s0 = newGame(9001, { year: 2026, month: 1, day: 30 });
    s0.players[0]!.financing = 3000;
    s0.players[0]!.deposit = 1000;
    const g = advanceOneDay(s0);
    expect(g.players[0]!.deposit).toBe(1000);
    expect(g.log.some((l) => l.text.includes('特别融资周转') && l.text.includes('不计息'))).toBe(true);
  });

  it('特别融资超出客户存款总额时，日切强制还清', () => {
    const s = newGame();
    s.players[0]!.financing = 3000;
    s.players[1]!.deposit = 1000; // 上限 1000 < 3000
    const g = advanceOneDay(s);
    expect(g.players[0]!.financing).toBe(0);
    expect(g.log.some((l) => l.text.includes('超出客户存款总额') && l.text.includes('须立即还清'))).toBe(true);
  });

  it('CORP-09：董事长换人时上任董事长的融资须立即还清', () => {
    let g = landOnCompany(58, (s) => {
      giveChairman(s, 'bank', 'p2', 100);
      s.players[0]!.cash = 200000;
      s.players[1]!.financing = 2000;
      s.players[1]!.deposit = 9999;
    });
    // p1 认购 200 张反超 p2 → 经营权移交，p2 融资立即清算
    g = applyAction(g, { type: 'BUY_SHARES', cellId: 58, quantity: 200 });
    expect(companyAtCell(g, 58)!.chairmanId).toBe('p1');
    expect(g.players[1]!.financing).toBe(0);
    expect(g.log.some((l) => l.text.includes('董事长换人') && l.text.includes('须立即还清'))).toBe(true);
  });
});

describe('TIME-03 十五号股东分红', () => {
  it('按持股比例分配累积盈余', () => {
    // 起始日期 2026-01-14，推进一天到 15 号
    const g0 = applyAction(createGame(PLAYERS, 9001, { startDate: { year: 2026, month: 1, day: 14 } }), {
      type: 'START_GAME',
    });
    for (const p of g0.players) p.diceCount = 2;
    pinIndexOne(g0);
    const comp = g0.companies.find((c) => c.kind === 'airline')!;
    comp.shares = { p1: 60, p2: 40 };
    comp.firstHeldDayIndex = { p1: 0, p2: 0 };
    comp.chairmanId = 'p1';
    comp.surplus = 1000;

    const cashBefore = [g0.players[0]!.cash, g0.players[1]!.cash];
    const g = advanceOneDay(g0);
    expect(g.players[0]!.cash - cashBefore[0]!).toBe(600);
    expect(g.players[1]!.cash - cashBefore[1]!).toBe(400);
    expect(companyAtCell(g, 51)!.surplus).toBe(0);
    expect(g.log.some((l) => l.text.includes('【分红日】'))).toBe(true);
    expect(g.log.some((l) => l.text.includes('按 60/100 股获分红 ¥600'))).toBe(true);
  });

  it('盈余为负时由股东按比例承担（TIME-03）', () => {
    const g0 = applyAction(createGame(PLAYERS, 9001, { startDate: { year: 2026, month: 1, day: 14 } }), {
      type: 'START_GAME',
    });
    for (const p of g0.players) p.diceCount = 2;
    pinIndexOne(g0);
    const comp = g0.companies.find((c) => c.kind === 'computer')!;
    comp.shares = { p1: 1, p2: 1 };
    comp.firstHeldDayIndex = { p1: 0, p2: 0 };
    comp.chairmanId = 'p1';
    comp.surplus = -800;

    const cashBefore = [g0.players[0]!.cash, g0.players[1]!.cash];
    const g = advanceOneDay(g0);
    expect(g.players[0]!.cash - cashBefore[0]!).toBe(-400);
    expect(g.players[1]!.cash - cashBefore[1]!).toBe(-400);
    expect(companyAtCell(g, 43)!.surplus).toBe(0);
    expect(g.log.some((l) => l.text.includes('承担亏损 ¥400'))).toBe(true);
  });

  it('非 15 号不触发分红', () => {
    const g = advanceOneDay(newGame());
    expect(g.log.some((l) => l.text.includes('【分红日】'))).toBe(false);
  });
});

describe('ECON-10 股票持仓成本指标', () => {
  function stockCell(): GameState {
    const s = newGame();
    s.players[s.currentPlayerIndex]!.position = 38; // 证交所
    s.players[s.currentPlayerIndex]!.deposit = 100000; // 股票只能用存款买
    s.phase = 'awaiting_action';
    return s;
  }

  it('买入累计建仓成本；卖出按比例结转', () => {
    let g = stockCell();
    const stock = g.stockMarket.stocks[0]!;
    // 冲击成本：第二笔的均价被第一笔的买盘推高了，所以不能再写 `unit × 20`
    const firstUnit = stockExecPrice(stock, 10, 'buy');
    g = applyAction(g, { type: 'BUY_STOCK', stockId: stock.id, quantity: 10 });
    expect(g.players[0]!.stockCost?.[stock.id]).toBe(firstUnit * 10);
    const secondUnit = stockExecPrice(g.stockMarket.stocks[0]!, 10, 'buy');
    expect(secondUnit).toBeGreaterThan(firstUnit);
    g = applyAction(g, { type: 'BUY_STOCK', stockId: stock.id, quantity: 10 });
    const costAfterTwoBuys = g.players[0]!.stockCost?.[stock.id] ?? 0;
    expect(costAfterTwoBuys).toBe(firstUnit * 10 + secondUnit * 10);
    // 卖出 10 股 → 成本按持股比例结转一半
    g = applyAction(g, { type: 'SELL_STOCK', stockId: stock.id, quantity: 10 });
    expect(g.players[0]!.stocks[stock.id]).toBe(10);
    expect(g.players[0]!.stockCost?.[stock.id]).toBe(costAfterTwoBuys - Math.round(costAfterTwoBuys / 2));
    // 清仓 → 成本项删除
    g = applyAction(g, { type: 'SELL_STOCK', stockId: stock.id, quantity: 10 });
    expect(g.players[0]!.stocks[stock.id]).toBeUndefined();
    expect(g.players[0]!.stockCost?.[stock.id]).toBeUndefined();
  });

  it('企业银行格同样可交易股票（CORP-09）', () => {
    const g = landOnCompany(58);
    g.players[g.currentPlayerIndex]!.deposit = 100000;
    const stock = g.stockMarket.stocks[0]!;
    const acted = applyAction(g, { type: 'BUY_STOCK', stockId: stock.id, quantity: 1 });
    expect(acted.players[0]!.stocks[stock.id]).toBe(1);
  });
});