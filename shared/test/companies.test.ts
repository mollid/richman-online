import { describe, expect, it } from 'vitest';
import {
  actionRefusal,
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
  lockedSharesOf,
  majorityHolderId,
  maxCashShares,
  MAX_SHARES_PER_BUY,
  nextRandom,
  OIL_FEE,
  POWER_FEE_PER_LEVEL,
  priceIndex,
  RESTAURANT_FEE_PER_DAY,
  ReplayEngine,
  rollDie,
  scaled,
  sellableSharesOf,
  stockExecPrice,
  totalAssets,
  WATER_FEE_PER_LAND,
  WHEEL_KINDS,
} from '../src/index.js';
import type { DateSerial, GameState, PlayerAction, PlayerDef } from '../src/index.js';
import { atLegacyStart, nextStepAction, pinIndexOne, standAt } from './helpers/state.js';

const PLAYERS: PlayerDef[] = [
  { id: 'p1', name: '阿福', color: 0xef5350 },
  { id: 'p2', name: '小美', color: 0x42a5f5 },
];

/** 周一、非 15 号、非月末：保证日切钩子不会在用例中途被动触发 */
const MONDAY: DateSerial = { year: 2026, month: 1, day: 5 };

function newGame(seed = 9001, startDate: DateSerial = MONDAY): GameState {
  const g = applyAction(createGame(PLAYERS, seed, { startDate: { ...startDate } }), { type: 'START_GAME' });
  atLegacyStart(g); // SP-01 出生点随机：本文件多处拿「脚下那格是什么」当门控前提
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
  // 搭场景时授予的持股现在会计入总资产（CORP-14），指数因此漂移 ⇒ 先冻结回 1，费用断言才能写死数字
  pinIndexOne(s);
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
  it('按股面值现金结算；单次上限 1000 张；认购后成为董事长并自动结束回合', () => {
    let g = landOnCompany(43); // 电脑公司 ¥400
    expect(g.phase).toBe('awaiting_action');
    // R4：单步窗 —— 公司格（非银行 / 非百货）没有会话场所，选完即走
    expect(g.landing).toEqual({ cellId: 43, venue: null, turn: g.turn });
    expect(availableActions(g).canBuyShares).toBe(true);
    expect(availableActions(g).sharePrice).toBe(400);

    // 上限 / 数量这两条校验要在**窗口还开着**的那一帧问：认购一落地，回合就不再属于这位玩家了
    expect(() => applyAction(g, { type: 'BUY_SHARES', cellId: 43, quantity: MAX_SHARES_PER_BUY + 1 })).toThrow(/上限/);
    expect(() => applyAction(g, { type: 'BUY_SHARES', cellId: 43, quantity: 0 })).toThrow(/正整数/);

    const before = g.players[0]!.cash;
    g = applyAction(g, { type: 'BUY_SHARES', cellId: 43, quantity: 10 });
    expect(g.players[0]!.cash).toBe(before - 4000);
    const comp = companyAtCell(g, 43)!;
    expect(comp.shares['p1']).toBe(10);
    expect(comp.chairmanId).toBe('p1');
    expect(comp.firstHeldDayIndex['p1']).toBe(0);
    // R4：玩家手上没有「结束回合」那颗按钮 —— 认购本身就是终结动作
    expect(g.landing).toBeNull();
    expect(g.phase).toBe('awaiting_roll');
    expect(g.currentPlayerIndex).toBe(1);
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

  it('买不成时连窗都不开，理由写进播报（R4：没得选就不钉人）', () => {
    const g = landOnCompany(43, (s) => {
      s.players[0]!.cash = 100;
    });
    expect(g.landing).toBeNull();
    expect(g.phase).toBe('awaiting_roll'); // 没有可当场办理的事 ⇒ 本格不开窗，回合自己走
    expect(availableActions(g).canBuyShares).toBe(false);
    expect(g.log.some((l) => l.text.includes('现金不足'))).toBe(true);
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
  it('功能同公立银行：落格开放存取款与贷款（股票改到掷骰前，R4）', () => {
    const g = landOnCompany(58, (s) => giveChairman(s, 'bank', 'p2'));
    expect(g.bankAccess).not.toBeNull();
    const acts = availableActions(g);
    expect(acts.canDeposit).toBe(true);
    expect(acts.canLoan).toBe(true);
    // 企业银行那格从此不再附带交易权限：炒股是自由操作，和存取款不在同一扇窗口里
    expect(acts.canTradeStock).toBe(false);
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
    // R4：交易只认掷骰前 —— 这个夹具造的是「手里正拿着钱要建仓」的那一段
    s.phase = 'awaiting_roll';
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

  it('企业银行那格不再就地交易股票（R4：落格窗只办这一格的事）', () => {
    const g = landOnCompany(58);
    g.players[g.currentPlayerIndex]!.deposit = 100000;
    const stock = g.stockMarket.stocks[0]!;
    expect(() => applyAction(g, { type: 'BUY_STOCK', stockId: stock.id, quantity: 1 })).toThrow('当前不能交易股票');
    // 同一笔存款在掷骰前照样建仓 —— 限制的是时机，不是格子
    const pre = structuredClone(g);
    pre.phase = 'awaiting_roll';
    pre.landing = null;
    const acted = applyAction(pre, { type: 'BUY_STOCK', stockId: stock.id, quantity: 1 });
    expect(acted.players[0]!.stocks[stock.id]).toBe(1);
  });
});

/**
 * CORP-14（自定扩展，玩法文档 §3.4 / §5.1）：地图上的 11 家公司同时挂在股市里。
 *
 * 钉四件事：① 原始股按**面值**、只用**现金**，且**只有踩到公司格那一手才能认购**（面板只转手），
 *    与「存款炒股」两档不串；
 * ② 本回合认购的要到**下次行动**才能转手（回合推进即解锁）；
 * ③ 休市与全市场停牌挡得住转手，挡不住向公司申购（一级市场不看盘口）；
 * ④ 持股计入**总资产** —— 把钱换成原始股不该凭空把物价指数压低。
 */
describe('CORP-14 原始股与股市互通', () => {
  /** 不动棋子只推进回合（掷骰会引 RNG 与落格，这里只关心锁定期） */
  function passTurn(state: GameState): GameState {
    const s = structuredClone(state);
    s.phase = 'awaiting_action';
    return applyAction(s, { type: 'FINISH_LANDING' });
  }

  /** 两人局要连过两手才轮回到 p1 */
  function backToFirstPlayer(state: GameState): GameState {
    let s = state;
    let guard = 0;
    while (s.currentPlayerIndex !== 0 && guard++ < 4) s = passTurn(s);
    return s;
  }

  const computer = (g: GameState) => companyAtCell(g, 43)!;

  /** 认购一手（先站到那家公司格上 —— 新口径下这是唯一的入口） */
  const subscribe = (state: GameState, quantity: number, cellId = 43) =>
    applyAction(standAt(structuredClone(state), 0, cellId), { type: 'BUY_SHARES', cellId, quantity });

  it('认购只认「踩到公司格」这一条路：站在别处、掷骰前都不给', () => {
    let g = newGame();
    expect(g.phase).toBe('awaiting_roll');
    expect(g.players[0]!.position).toBe(0); // 脚下是起点，不是公司格
    expect(actionRefusal(g, { type: 'BUY_SHARES', cellId: 43, quantity: 10 })).toMatch(/踩到公司格/);
    // 进了决策阶段但脚下不是公司格 ⇒ 同样不给（股市面板从此没有现金认购通道）
    expect(actionRefusal(standAt(structuredClone(g), 0, 0), { type: 'BUY_SHARES', cellId: 43, quantity: 10 })).toMatch(/踩到公司格/);
    const before = g.players[0]!.cash;
    g = subscribe(g, 10); // 踩上去才成
    expect(g.players[0]!.cash).toBe(before - 400 * 10);
    const comp = computer(g);
    expect(comp.shares.p1).toBe(10);
    expect(comp.chairmanId).toBe('p1');
    expect(lockedSharesOf(comp, 'p1')).toBe(10);
  });

  it('原始股只认现金：存款再多也买不成，上市股那边才动存款', () => {
    const g = standAt(structuredClone(newGame()), 0, 43);
    g.players[0]!.cash = 0;
    g.players[0]!.deposit = 500000;
    expect(() => applyAction(g, { type: 'BUY_SHARES', cellId: 43, quantity: 1 })).toThrow(/现金不足/);
    // 同一笔钱换成现金才能买的原始股，而存款那档只认掷骰前（R4）：关上窗口再问
    const pre = structuredClone(g);
    pre.phase = 'awaiting_roll';
    pre.landing = null;
    expect(actionRefusal(pre, { type: 'BUY_STOCK', stockId: 'tech', quantity: 1 })).toBeNull();
  });

  it('本回合认购的锁到下次行动；解锁后按市价卖回，钱进存款、退出股东名册', () => {
    // 锁定期只有**面板这一侧**才看得出来：市价买入不结束回合，同一回合内转手必须被拒。
    // 踩格认购在 R4 之后自带回合推进，绕回自己行动时锁已解 —— 那正是「到下次行动才能转手」的字面口径。
    const seeded = newGame();
    seeded.players[0]!.deposit = 30000;
    const byMarket = applyAction(structuredClone(seeded), { type: 'BUY_STOCK', stockId: 'corp-computer', quantity: 30 });
    expect(lockedSharesOf(computer(byMarket), 'p1')).toBe(30);
    expect(() => applyAction(byMarket, { type: 'SELL_SHARES', cellId: 43, quantity: 10 })).toThrow(/下次行动/);

    let g = backToFirstPlayer(passTurn(subscribe(newGame(), 30)));
    expect(g.currentPlayerIndex).toBe(0);
    expect(lockedSharesOf(computer(g), 'p1')).toBe(0);
    // CORP-14 改口径：卖回走股市那侧 —— 按当日市价（含冲击）成交、收入进存款，现金一分不动
    const stock = g.stockMarket.stocks.find((s) => s.id === 'corp-computer')!;
    const exec = stockExecPrice(stock, 30, 'sell');
    const cash = g.players[0]!.cash;
    const deposit = g.players[0]!.deposit;
    g = applyAction(g, { type: 'SELL_SHARES', cellId: 43, quantity: 30 });
    expect(g.players[0]!.cash).toBe(cash);
    expect(g.players[0]!.deposit).toBe(deposit + exec * 30);
    const comp = computer(g);
    expect(comp.shares.p1).toBeUndefined();
    expect(comp.firstHeldDayIndex.p1).toBeUndefined(); // 卖光即退出名册，再进场「先到先得」重新起算
    expect(comp.chairmanId).toBeNull();
  });

  it('锁定期只锁新买的：可卖数与「满额」都和引擎同一个口径', () => {
    let g = backToFirstPlayer(passTurn(subscribe(newGame(), 20)));
    g = subscribe(g, 10); // 30 张里 10 张在锁定
    const comp = computer(g);
    expect(comp.shares.p1).toBe(30);
    expect(lockedSharesOf(comp, 'p1')).toBe(10);
    expect(sellableSharesOf(comp, 'p1')).toBe(20);
    // 此刻轮到 p2：TA 名下无股，卖 21 被拒的是「持股不足」而不是锁定期
    expect(() => applyAction(g, { type: 'SELL_SHARES', cellId: 43, quantity: 21 })).toThrow(/持股不足/);
    // 绕回 p1 的下一手 = 解锁时刻：10 张一起放行，30 张全部可卖
    const mine = backToFirstPlayer(passTurn(g));
    expect(lockedSharesOf(computer(mine), 'p1')).toBe(0);
    expect(actionRefusal(mine, { type: 'SELL_SHARES', cellId: 43, quantity: 30 })).toBeNull();
    // 「满额」上限问的就是引擎那一句（现金 ÷ 面值），面板不自算
    const probe = standAt(structuredClone(mine), 0, 43);
    const cap = maxCashShares(400, probe.players[0]!.cash);
    expect(actionRefusal(probe, { type: 'BUY_SHARES', cellId: 43, quantity: cap })).toBeNull();
    expect(actionRefusal(probe, { type: 'BUY_SHARES', cellId: 43, quantity: cap + 1 })).toMatch(/现金不足/);
  });

  it('例假日与全市场停牌：挡得住转手，挡不住申购', () => {
    // 2026-01-10 是周六；两人都过一手落到 01-11（周日），锁已解但仍在休市
    let g = applyAction(createGame(PLAYERS, 9105, { startDate: { year: 2026, month: 1, day: 10 } }), {
      type: 'START_GAME',
    });
    g = subscribe(g, 10);
    expect(computer(g).shares.p1).toBe(10); // 一级市场不看盘口，休市照买
    g = backToFirstPlayer(passTurn(g));
    expect(lockedSharesOf(computer(g), 'p1')).toBe(0);
    expect(() => applyAction(g, { type: 'SELL_SHARES', cellId: 43, quantity: 1 })).toThrow(/例假日休市/);
    // 转手是股市动作 ⇒ 在掷骰前那一段问它；停牌挡得住它
    const halted = structuredClone(g);
    halted.phase = 'awaiting_roll';
    halted.stockHaltAllDays = 3;
    expect(() => applyAction(halted, { type: 'SELL_SHARES', cellId: 43, quantity: 1 })).toThrow(/全市场停牌/);
    // 申购是向公司直接认购 ⇒ 踩格那一手照办，停牌挡不住一级市场
    const atCell = standAt(structuredClone(halted), 0, 43);
    atCell.stockHaltAllDays = 3;
    expect(actionRefusal(atCell, { type: 'BUY_SHARES', cellId: 43, quantity: 1 })).toBeNull();
  });

  it('踩到公司格认购同样上锁，且只开脚下这一家', () => {
    const landed = landOnCompany(43, (s) => {
      s.players[0]!.cash = 30000;
    });
    expect(availableActions(landed).canBuyShares).toBe(true);
    // 脚下是电脑公司 ⇒ 别家不跟着开门：想认购另一家，得自己走到那一格（要在窗口开着时问）
    expect(actionRefusal(landed, { type: 'BUY_SHARES', cellId: 51, quantity: 10 })).toMatch(/没走到该公司格/);
    const g = applyAction(landed, { type: 'BUY_SHARES', cellId: 43, quantity: 10 });
    expect(lockedSharesOf(computer(g), 'p1')).toBe(10);
    expect(g.phase).toBe('awaiting_roll'); // R4：认购即结束回合
  });

  it('持股计入总资产：现金换成原始股前后一分不差，物价指数不漂移', () => {
    let g = newGame();
    const idx0 = priceIndex(g);
    const assets0 = totalAssets(g, g.players[0]!);
    g = subscribe(g, 20);
    expect(totalAssets(g, g.players[0]!)).toBe(assets0); // 8000 现金 → 8000 持股
    expect(priceIndex(g)).toBe(idx0);
    // 卖回按市价 ⇒ 不再守恒，差额就是这笔投资的盈亏（面值锚只用于持股估值）
    const unlocked = structuredClone(g);
    computer(unlocked).lockedShares = {};
    unlocked.currentPlayerIndex = 0; // 认购自带推进（R4）已把行动权交给下一位，拨回来才是在测 p1 的持仓
    const exec = stockExecPrice(unlocked.stockMarket.stocks.find((s) => s.id === 'corp-computer')!, 20, 'sell');
    const deposit0 = unlocked.players[0]!.deposit;
    const sold = applyAction(unlocked, { type: 'SELL_SHARES', cellId: 43, quantity: 20 });
    expect(sold.players[0]!.deposit).toBe(deposit0 + exec * 20);
    expect(totalAssets(sold, sold.players[0]!)).toBe(assets0 + (exec - 400) * 20);
  });

  it('分红不分渠道：股市申购、尚在锁定期的持股照样分盈余', () => {
    let g = applyAction(createGame(PLAYERS, 9107, { startDate: { year: 2026, month: 1, day: 14 } }), {
      type: 'START_GAME',
    });
    for (const p of g.players) p.diceCount = 2; // advanceOneDay 用的是两骰之和 3
    g = subscribe(g, 10);
    g.phase = 'awaiting_roll'; // 认购那一手的决策收尾：不推进回合，推进就解锁了（本用例要钉的正是锁定期分红）
    computer(g).surplus = 1000;
    const cash = g.players[0]!.cash;
    g = advanceOneDay(g); // 推到 15 号分红日
    expect(g.players[0]!.cash).toBe(cash + 1000);
    expect(g.log.some((l) => l.text.includes('【电脑公司】'))).toBe(true);
  });

  it('认购与卖出（含锁定期）都能被回放复现', () => {
    // 只用动作能表达的东西建局：夹具里的 `diceCount = 2` 之类改动不在动作日志里，回放拿不到
    const seed = 9103; // 这一局第 7 回合有人踩到电脑公司，锁一过就能转手（9109 太晚，80 手内来不及卖）
    let s = applyAction(createGame(PLAYERS, seed, { startDate: { ...MONDAY } }), { type: 'START_GAME' });
    const actions: Array<{ turn: number; action: PlayerAction }> = [{ turn: 0, action: { type: 'START_GAME' } }];
    const push = (state: GameState, action: PlayerAction) => {
      actions.push({ turn: state.turn, action });
      return applyAction(state, action);
    };
    const buy: PlayerAction = { type: 'BUY_SHARES', cellId: 43, quantity: 10 };
    const sell: PlayerAction = { type: 'SELL_SHARES', cellId: 43, quantity: 5 };
    let bought = false;
    let soldOnce = false;
    let buyer = '';
    // 认购绑定「脚下那一格」（CORP-14 改口径）⇒「走到电脑公司」这件事本身也必须进动作日志，
    // 否则回放拿到的是没走过的局面，持股就对不上。这里因此不搭任何局外夹具，纯靠动作推进。
    for (let i = 0; i < 80 && s.phase !== 'game_over'; i++) {
      if (!bought && actionRefusal(s, buy) === null) {
        buyer = s.players[s.currentPlayerIndex]!.id;
        s = push(s, buy);
        bought = true;
        continue;
      }
      // 锁定期一过就卖掉一半：卖出这条通道同样要在动作日志里
      if (bought && !soldOnce && actionRefusal(s, sell) === null) {
        s = push(s, sell);
        soldOnce = true;
        continue;
      }
      s = push(s, nextStepAction(s));
    }
    expect(bought, '这一局里应有人踩到电脑公司并认购').toBe(true);
    expect(soldOnce, '回合绕回后锁定期应已解除').toBe(true);
    // 这一局走到电脑公司的是 p2 —— 断言跟着「谁认购的」走，不写死座位
    expect(companyAtCell(s, 43)!.shares[buyer]).toBe(5); // 认购 10 张、卖掉 5 张
    const record = {
      seed,
      startDate: { ...MONDAY },
      players: PLAYERS.map((p) => ({ player_name: p.name, color: p.color, player_key: p.id })),
      actions,
    };
    const replayed = new ReplayEngine(record).finalState;
    expect(replayed.turn).toBe(s.turn);
    for (const company of s.companies) {
      const twin = replayed.companies.find((c) => c.kind === company.kind)!;
      expect(twin.shares, company.kind).toEqual(company.shares);
      expect(twin.lockedShares, company.kind).toEqual(company.lockedShares);
      expect(twin.chairmanId, company.kind).toBe(company.chairmanId);
    }
    expect(replayed.players[0]!.cash).toBe(s.players[0]!.cash);
  });
});
/**
 * CORP-14 一本账：面板买 `corp-*` 与踩格认购记在同一个股东名册上，差别只剩价格与钱袋。
 * （上一轮曾做成「纸面持仓 / 不进名册」两本账，这几条钉住合回一本之后的口径。）
 */
describe('CORP-14 一本账：面板买入也是股东', () => {
  it('面板按市价买公司股：进股东名册、拿经营权，钱从存款出', () => {
    const g = newGame();
    g.players[0]!.deposit = 20000; // 炒股只花存款
    const comp = companyAtCell(g, 43)!;
    const before = { deposit: g.players[0]!.deposit, cash: g.players[0]!.cash };
    const bought = applyAction(g, { type: 'BUY_STOCK', stockId: 'corp-computer', quantity: 10 });
    const after = companyAtCell(bought, 43)!;
    expect(after.shares.p1).toBe(10); // 同一本名册，不是 player.stocks
    expect(bought.players[0]!.stocks['corp-computer']).toBeUndefined();
    expect(after.chairmanId).toBe('p1'); // 唯一的在场股东 ⇒ 经营权到手
    expect(after.lockedShares.p1).toBe(10); // 本回合到手的先锁一手
    expect(bought.players[0]!.deposit).toBeLessThan(before.deposit);
    expect(bought.players[0]!.cash).toBe(before.cash); // 现金不动
  });

  it('两个渠道同一本账：踩格按面值花现金，面板按市价花存款', () => {
    const face = companyAtCell(newGame(), 43)!.sharePrice;
    const seeded = newGame();
    seeded.players[0]!.deposit = 20000;
    const byCell = applyAction(standAt(seeded, 0, 43), { type: 'BUY_SHARES', cellId: 43, quantity: 10 });
    expect(byCell.players[0]!.cash).toBe(15000 - face * 10);
    expect(companyAtCell(byCell, 43)!.shares.p1).toBe(10);
    byCell.currentPlayerIndex = 0; // 踩格认购自带回合推进（R4），拨回 p1 才测得到同一个人的两笔账
    const byMarket = applyAction(byCell, { type: 'BUY_STOCK', stockId: 'corp-computer', quantity: 5 });
    expect(companyAtCell(byMarket, 43)!.shares.p1).toBe(15); // 累加进同一本
  });

  it('公司股的转手只有一条路：SELL_STOCK 打 corp-* 被拒，门控与引擎同源', () => {
    const seeded = newGame();
    seeded.players[0]!.deposit = 20000;
    const g = applyAction(seeded, { type: 'BUY_STOCK', stockId: 'corp-computer', quantity: 10 });
    const refusal = actionRefusal(g, { type: 'SELL_STOCK', stockId: 'corp-computer', quantity: 5 });
    expect(refusal).toMatch(/原始股权益/);
    expect(() => applyAction(g, { type: 'SELL_STOCK', stockId: 'corp-computer', quantity: 5 })).toThrow(/原始股权益/);
  });

  it('持股按现市价估值：面板买完总资产不因价差凭空多出一截', () => {
    const g = newGame();
    g.players[0]!.deposit = 20000;
    const stock = g.stockMarket.stocks.find((x) => x.id === 'corp-computer')!;
    const assets0 = totalAssets(g, g.players[0]!);
    const bought = applyAction(g, { type: 'BUY_STOCK', stockId: 'corp-computer', quantity: 10 });
    const exec = stockExecPrice(stock, 10, 'buy');
    const price = bought.stockMarket.stocks.find((x) => x.id === 'corp-computer')!.price;
    // 付出 exec×10（含冲击），拿回按盘口计价的一截 —— 差额就是自己把价格推高的那部分
    expect(totalAssets(bought, bought.players[0]!)).toBe(assets0 - (exec - price) * 10);
  });
});
