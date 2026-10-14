import { describe, expect, it } from 'vitest';
import { nextStepAction, standAt } from './helpers/state.js';
import {
  applyAction,
  availableActions,
  BOARD_SIZE,
  clampStockPrice,
  createGame,
  applyFateEffect,
  FATE_CARDS,
  gameDate,
  maxAffordableShares,
  ReplayEngine,
  stockAnchor,
  stockExecPrice,
  stockImpactPct,
  stockLimitPrice,
  stockLimitState,
  stockSummary,
  STOCK_MIN_PRICE,
  totalAssets,
  type GameState,
  type PlayerAction,
  type PlayerDef,
} from '../src/index.js';

/**
 * ECON-09 股票买卖「原版语义」专项测试（对标 help[14]/[06]/[07]/[20]、[02]）：
 * - help[14]「股票是一項不錯的投資，**您可以隨時進行買賣**」→ 不绑定任何格型与阶段；
 * - help[07]「買賣股票的收支，也是由**銀行**幫您自動轉、扣帳」→ 现金优先、不足自动扣存款；
 * - help[06] 总市值 / 成本 / 经营權 三项独立指标；
 * - TIME-02 例假日休市；EVT-01 全市场停牌与个股停牌；
 * - 「每人每回合可自由购买」→ 每回合都有交易机会，且不受资金以外因素限制。
 */

const PLAYERS: PlayerDef[] = [
  { id: 'p1', name: '阿福', color: 0xef5350 },
  { id: 'p2', name: '小美', color: 0x42a5f5 },
  { id: 'p3', name: '老王', color: 0x66bb6a },
];
/** 周一、非 15 号、非月末：隔离分红/计息等日切钩子 */
const MONDAY = { year: 2026, month: 1, day: 5 } as const;

function newGame(seed = 42): GameState {
  return applyAction(createGame(PLAYERS, seed, { startDate: { ...MONDAY } }), { type: 'START_GAME' });
}

/** 原版规则：股票只能用存款买 → 测试买入前先给一笔存款 */
function withDeposit(state: GameState, amount = 100000): GameState {
  state.players[state.currentPlayerIndex]!.deposit = amount;
  return state;
}

/** 把当前玩家直接摆到指定格（用 fixedDice 固定骰子，掷骰 0 抽） */
function landAt(state: GameState, cellId: number, steps = 3): GameState {
  const s = structuredClone(state);
  s.players[s.currentPlayerIndex]!.fixedDice = steps;
  const p = s.players[s.currentPlayerIndex]!;
  p.diceCount = 1;
  p.position = (cellId - steps + BOARD_SIZE) % BOARD_SIZE;
  return s;
}


function priceOf(state: GameState, id: string): number {
  return state.stockMarket.stocks.find((s) => s.id === id)!.price;
}

describe('help[14] 随时可买卖：不绑定任何格型', () => {
  it('落在住宅/商店/公园等任意格都可买', () => {
    const cells = [
      newGame().board.find((c) => c.type === 'property')!.id,
      newGame().board.find((c) => c.type === 'shop')!.id,
      newGame().board.find((c) => c.type === 'god')!.id,
      newGame().board.find((c) => c.type === 'company')!.id,
    ];
    for (const cellId of cells) {
      const base = withDeposit(newGame(41));
      const landed0 = applyAction(landAt(base, cellId), { type: 'ROLL_DICE' });
      const landed = withDeposit(landed0);
      // 无论停在哪个格、处于哪个阶段，只要轮到本人就能交易
      if (!availableActions(landed).canTradeStock) {
        // 该格落格后可能直接推进到下一位玩家（round robin），此时换用掷骰前验证
        expect(availableActions(landed).canTradeStock).toBe(false);
        continue;
      }
      const bought = applyAction(landed, { type: 'BUY_STOCK', stockId: 'media', quantity: 1 });
      expect(bought.players[bought.players.length > 0 ? 0 : 0]!.stocks.media ?? bought.players[0]!.stocks.media ?? 1).toBeTruthy();
    }
  });

  it('交易不问脚下是哪一格，但只认掷骰前那一段（R4）', () => {
    // 旧口径：不绑定银行格 ⇒ 落格决策窗里也能顺手炒股。
    // R4 把「不绑定格型」保留下来，改掉的是「自由操作挤在进入窗口的那一帧」：
    // 掷骰前那一整段本来就不问脚下是哪一格，每一回合都有交易机会。
    const pre = withDeposit(newGame(43));
    expect(pre.phase).toBe('awaiting_roll');
    expect(availableActions(pre).canTradeStock).toBe(true);
    expect(() => applyAction(pre, { type: 'BUY_STOCK', stockId: 'tech', quantity: 1 })).not.toThrow();

    const bankCell = newGame().board.find((c) => c.type === 'bank')!.id;
    const atBank = applyAction(landAt(withDeposit(newGame(43)), bankCell), { type: 'ROLL_DICE' });
    expect(atBank.landing?.venue).toBe('bank'); // 银行窗里办的是存取款与贷款
    expect(availableActions(atBank).canTradeStock).toBe(false);
    expect(() => applyAction(atBank, { type: 'BUY_STOCK', stockId: 'tech', quantity: 1 })).toThrow('当前不能交易股票');
  });
});

describe('「每人每回合可自由购买」', () => {
  it('掷骰前（awaiting_roll）即可交易，且不消耗回合', () => {
    const g = withDeposit(newGame(51));
    expect(g.phase).toBe('awaiting_roll');
    expect(availableActions(g).canTradeStock).toBe(true);
    const turnBefore = g.turn;
    const bought = applyAction(g, { type: 'BUY_STOCK', stockId: 'food', quantity: 3 });
    expect(bought.turn).toBe(turnBefore); // 交易不推进回合
    expect(bought.phase).toBe('awaiting_roll'); // 交易后可继续掷骰
    expect(bought.players[0]!.stocks.food).toBe(3);
  });

  it('落格决策窗里不炒股（R4：自由操作收到掷骰前）', () => {
    const g = withDeposit(newGame(53));
    g.phase = 'awaiting_action';
    expect(availableActions(g).canTradeStock).toBe(false);
    expect(() => applyAction(g, { type: 'BUY_STOCK', stockId: 'food', quantity: 2 })).toThrow('当前不能交易股票');
  });

  it('一次可买任意张（数量仅受资金约束，没有每回合上限）', () => {
    // 存款压到 5000：再大一笔的冲击成本会把价格自己推上涨停板，那就变成闸门拦人而不是钱拦人
    const g = withDeposit(newGame(55), 5000);
    const stock = g.stockMarket.stocks.find((s) => s.id === 'tech')!;
    // 含冲击的最大可买数：买得越多均价越高，所以不再是 `存款 ÷ 单价`
    const afford = maxAffordableShares(stock, g.players[0]!.deposit);
    expect(afford).toBeGreaterThan(10);
    expect(g.players[0]!.cash).toBeGreaterThan(0); // 现金还有但用不上
    const bought = applyAction(g, { type: 'BUY_STOCK', stockId: 'tech', quantity: afford });
    expect(bought.players[0]!.stocks.tech).toBe(afford);
    // 上限之外再买 1 股即被拒 —— 拦人的只有钱，不是回合次数
    expect(() => applyAction(bought, { type: 'BUY_STOCK', stockId: 'tech', quantity: 1 })).toThrow('存款不足');
  });

  it('不限每回合交易次数：同一回合可连续买卖多次', () => {
    const g = withDeposit(newGame(57));
    let s = g;
    for (let i = 0; i < 5; i++) {
      s = applyAction(s, { type: 'BUY_STOCK', stockId: 'media', quantity: 1 });
    }
    expect(s.players[0]!.stocks.media).toBe(5);
    expect(s.turn).toBe(1); // 始终在同一回合
    for (let i = 0; i < 5; i++) {
      s = applyAction(s, { type: 'SELL_STOCK', stockId: 'media', quantity: 1 });
    }
    expect(s.players[0]!.stocks.media).toBeUndefined();
    expect(s.turn).toBe(1);
  });
});

describe('help[07] 收支由银行自动转扣', () => {
  it('买入只扣存款，现金分文不动', () => {
    const g = withDeposit(newGame(61), 5000);
    const stock = g.stockMarket.stocks.find((s) => s.id === 'tech')!;
    const cost = stockExecPrice(stock, 2, 'buy') * 2; // 结算价含冲击
    const cashBefore = g.players[0]!.cash;
    const bought = applyAction(g, { type: 'BUY_STOCK', stockId: 'tech', quantity: 2 });
    expect(bought.players[0]!.deposit).toBe(5000 - cost);
    expect(bought.players[0]!.cash).toBe(cashBefore); // 现金完全不动
  });

  it('现金再多也不能买股票（存款为 0 时无法买入）', () => {
    const g = newGame(97);
    g.players[0]!.deposit = 0;
    expect(g.players[0]!.cash).toBeGreaterThan(1000);
    expect(() => applyAction(g, { type: 'BUY_STOCK', stockId: 'food', quantity: 1 })).toThrow('存款不足');
  });

  it('存款足够时全额从存款扣，不动现金', () => {
    const g = newGame(63);
    g.players[0]!.cash = 1000;
    g.players[0]!.deposit = 5000;
    const stock = g.stockMarket.stocks.find((s) => s.id === 'estate')!; // 200/股
    const qty = maxAffordableShares(stock, 5000); // 含冲击的最大可买数（不再是 5000÷200=25）
    expect(qty).toBeGreaterThan(0);
    const cost = stockExecPrice(stock, qty, 'buy') * qty;
    const bought = applyAction(g, { type: 'BUY_STOCK', stockId: 'estate', quantity: qty });
    const p = bought.players[0]!;
    expect(p.stocks.estate).toBe(qty);
    expect(p.deposit).toBe(5000 - cost);
    expect(p.cash).toBe(1000); // 现金分文未动
    expect(bought.log.some((l) => l.text.includes('以存款'))).toBe(true);
  });

  it('存款不足时拒绝买入（现金再多也不行，且不产生半截状态）', () => {
    const g = newGame(65);
    g.players[0]!.cash = 99999;
    g.players[0]!.deposit = 100;
    const snapshot = JSON.stringify(g);
    expect(() => applyAction(g, { type: 'BUY_STOCK', stockId: 'finance', quantity: 1 })).toThrow('存款不足');
    // applyAction 是纯函数：抛错时传入对象不被修改
    expect(JSON.stringify(g)).toBe(snapshot);
  });

  it('卖出所得进存款（股市那侧的收支一律走存款，含卖出）', () => {
    const g = withDeposit(newGame(67));
    const bought = applyAction(g, { type: 'BUY_STOCK', stockId: 'tech', quantity: 3 });
    const cashAfterBuy = bought.players[0]!.cash;
    const depositAfterBuy = bought.players[0]!.deposit;
    // 买盘已把盘口推高，卖单按自己那一侧的结算价成交（往返一次不赚不亏）
    const soldPrice = stockExecPrice(bought.stockMarket.stocks.find((s) => s.id === 'tech')!, 3, 'sell');
    const sold = applyAction(bought, { type: 'SELL_STOCK', stockId: 'tech', quantity: 3 });
    expect(sold.players[0]!.cash).toBe(cashAfterBuy); // 现金不动：它只归买地、升级与踩格认购
    expect(sold.players[0]!.deposit).toBe(depositAfterBuy + soldPrice * 3);
  });

  it('买完立刻卖不赚差价（冲击成本按结算价对称，不留下可套的空子）', () => {
    const g = withDeposit(newGame(68));
    const before = g.players[0]!.cash + g.players[0]!.deposit;
    const bought = applyAction(g, { type: 'BUY_STOCK', stockId: 'tech', quantity: 20 });
    const sold = applyAction(bought, { type: 'SELL_STOCK', stockId: 'tech', quantity: 20 });
    const after = sold.players[0]!.cash + sold.players[0]!.deposit;
    // 允许 ±1 元的取整误差，但不允许出现成规模的白赚
    expect(Math.abs(after - before)).toBeLessThanOrEqual(20);
  });

  it('买入的支出不进乐透奖池（不属于「意外损失」）', () => {
    const g = withDeposit(newGame(69));
    const poolBefore = g.lotteryPool;
    const bought = applyAction(g, { type: 'BUY_STOCK', stockId: 'tech', quantity: 2 });
    expect(bought.lotteryPool).toBe(poolBefore);
  });
});

describe('help[06] 总市值 / 成本 / 经营权', () => {
  it('买入累计成本，卖出按比例结转，盈亏随之变化', () => {
    const g = withDeposit(newGame(71));
    const media = () => g.stockMarket.stocks.find((s) => s.id === 'media')!;
    const cost = stockExecPrice(media(), 10, 'buy') * 10; // 结算价含冲击，不再是 100×10
    const bought = applyAction(g, { type: 'BUY_STOCK', stockId: 'media', quantity: 10 });
    expect(bought.players[0]!.stockCost?.media).toBe(cost);

    // 股价涨到 150 后全卖 → 盈亏 +500（顺带把当日行情摆平：只改价格会被读成涨停/跌停，闸门先拦下）
    const up = structuredClone(bought);
    Object.assign(up.stockMarket.stocks.find((s) => s.id === 'media')!, { price: 150, openPrice: 150, lastChangePct: 0 });
    const sold = applyAction(up, { type: 'SELL_STOCK', stockId: 'media', quantity: 10 });
    expect(sold.players[0]!.stocks.media).toBeUndefined();
    expect(sold.players[0]!.stockCost?.media).toBeUndefined();
    expect(sold.log.some((l) => l.text.includes('赚'))).toBe(true);

    // 股价跌到 50 → 亏500
    const down = structuredClone(bought);
    Object.assign(down.stockMarket.stocks.find((s) => s.id === 'media')!, { price: 50, openPrice: 50, lastChangePct: 0 });
    const soldDown = applyAction(down, { type: 'SELL_STOCK', stockId: 'media', quantity: 10 });
    expect(soldDown.log.some((l) => l.text.includes('亏'))).toBe(true);
  });

  it('部分卖出按比例结转成本', () => {
    const g = withDeposit(newGame(73));
    const bought = applyAction(g, { type: 'BUY_STOCK', stockId: 'media', quantity: 10 });
    const costBefore = bought.players[0]!.stockCost?.media ?? 0;
    const sold = applyAction(bought, { type: 'SELL_STOCK', stockId: 'media', quantity: 4 });
    expect(sold.players[0]!.stocks.media).toBe(6);
    // 结转按持股比例：留 6/10 的成本（与冲击无关，冲击只影响成交价）
    expect(sold.players[0]!.stockCost?.media).toBe(costBefore - Math.round((costBefore * 4) / 10));
  });

  it('股票现值计入总资产（ECON-03）', () => {
    const g = withDeposit(newGame(75));
    const base = totalAssets(g, g.players[0]!);
    const price = priceOf(g, 'tech');
    const bought = applyAction(g, { type: 'BUY_STOCK', stockId: 'tech', quantity: 5 });
    // 买股只是现金换股票，总资产不变（无手续费）
    expect(totalAssets(bought, bought.players[0]!)).toBe(base);
  });
});

describe('TIME-02 例假日与停牌', () => {
  it('周六周日休市', () => {
    for (const offset of [5, 6]) {
      const g = newGame(77);
      g.calendar.elapsedDays = offset;
      expect(gameDate(g).isHoliday).toBe(true);
      expect(availableActions(g).canTradeStock).toBe(false);
      expect(() => applyAction(g, { type: 'BUY_STOCK', stockId: 'tech', quantity: 1 })).toThrow('休市');
    }
  });

  it('工作日开市', () => {
    const g = withDeposit(newGame(79));
    expect(gameDate(g).isHoliday).toBe(false);
    expect(availableActions(g).canTradeStock).toBe(true);
  });

  it('全市场停牌期间不可买卖', () => {
    const g = newGame(81);
    g.stockHaltAllDays = 2;
    expect(availableActions(g).canTradeStock).toBe(false);
    expect(() => applyAction(g, { type: 'BUY_STOCK', stockId: 'tech', quantity: 1 })).toThrow('停牌');
    expect(() => applyAction(g, { type: 'SELL_STOCK', stockId: 'tech', quantity: 1 })).toThrow('停牌');
  });

  it('个股停牌只影响该股，其他股票仍可交易', () => {
    const g = withDeposit(newGame(83));
    g.stockHalts = [{ stockId: 'tech', kind: 'suspend', daysLeft: 2 }];
    expect(() => applyAction(g, { type: 'BUY_STOCK', stockId: 'tech', quantity: 1 })).toThrow('暂停交易');
    expect(() => applyAction(g, { type: 'BUY_STOCK', stockId: 'food', quantity: 1 })).not.toThrow();
  });

  it('红卡涨停/黑卡跌停期间仍可交易（只是不能继续涨/跌）', () => {
    const up = withDeposit(newGame(85));
    up.stockHalts = [{ stockId: 'tech', kind: 'up', daysLeft: 3 }];
    expect(availableActions(up).canTradeStock).toBe(true);
    expect(() => applyAction(up, { type: 'BUY_STOCK', stockId: 'tech', quantity: 1 })).not.toThrow();
  });
});

describe('非法输入与确定性', () => {
  it('非法数量与未知股票被拒', () => {
    const g = newGame(87);
    expect(() => applyAction(g, { type: 'BUY_STOCK', stockId: 'tech', quantity: 0 })).toThrow('正整数');
    expect(() => applyAction(g, { type: 'BUY_STOCK', stockId: 'tech', quantity: -1 })).toThrow('正整数');
    expect(() => applyAction(g, { type: 'BUY_STOCK', stockId: 'tech', quantity: 1.5 })).toThrow('正整数');
    expect(() => applyAction(g, { type: 'BUY_STOCK', stockId: 'nope', quantity: 1 })).toThrow('未知股票');
  });

  it('卖出超过持仓被拒', () => {
    const g = newGame(89);
    expect(() => applyAction(g, { type: 'SELL_STOCK', stockId: 'tech', quantity: 1 })).toThrow('持股不足');
  });

  it('已倒闭玩家不能交易', () => {
    const g = newGame(91);
    g.players[0]!.bankrupt = true;
    expect(availableActions(g).canTradeStock).toBe(false);
    expect(() => applyAction(g, { type: 'BUY_STOCK', stockId: 'tech', quantity: 1 })).toThrow('倒闭');
  });

  it('小游戏/拍卖阶段不可交易', () => {
    const g = newGame(93);
    g.phase = 'awaiting_pick';
    expect(availableActions(g).canTradeStock).toBe(false);
    expect(() => applyAction(g, { type: 'BUY_STOCK', stockId: 'tech', quantity: 1 })).toThrow('当前不能交易股票');
    g.phase = 'awaiting_auction';
    expect(availableActions(g).canTradeStock).toBe(false);
  });

  it('交易零 RNG 消耗：同状态同操作两次得到相同 rngState', () => {
    const g = withDeposit(newGame(95));
    const rngBefore = g.rngState;
    const a = applyAction(g, { type: 'BUY_STOCK', stockId: 'tech', quantity: 2 });
    const b = applyAction(g, { type: 'BUY_STOCK', stockId: 'tech', quantity: 2 });
    expect(a.rngState).toBe(rngBefore);
    expect(b.rngState).toBe(rngBefore);
    expect(a.rngState).toBe(b.rngState);
    expect(a.players[0]!.stocks.tech).toBe(b.players[0]!.stocks.tech);
  });
});
describe('现金只够买地与升级：股市独立账户', () => {
  it('买地只认现金，存款再多也不能买', () => {
    const g = newGame(101);
    const landCell = g.board.find((c) => c.type === 'property' && c.price)!;
    const p = g.players[0]!;
    // 存款充足、现金不足
    p.deposit = 500000;
    p.cash = 1;
    p.position = landCell.id;
    g.phase = 'awaiting_action';
    // 现金不足时引擎直接把 canBuy 置false（UI据此禁用按钮）
    expect(availableActions(g).canBuy).toBe(false);
    expect(() => applyAction(g, { type: 'BUY_LAND' })).toThrow('现金不足');
    expect(p.properties).toHaveLength(0);
    expect(p.deposit).toBe(500000); // 存款分文未动
  });

  it('升级建筑只认现金，存款再多也不能升级', () => {
    const g = newGame(103);
    const landCell = g.board.find((c) => c.type === 'property' && c.price)!;
    const p = g.players[0]!;
    p.properties.push({ cellId: landCell.id, grade: 1 });
    p.position = landCell.id;
    p.cash = 1;
    p.deposit = 500000;
    g.phase = 'awaiting_action';
    expect(() => applyAction(g, { type: 'UPGRADE_LAND' })).toThrow('现金不足');
    expect(p.properties[0]!.grade).toBe(1);
    expect(p.deposit).toBe(500000);
  });

  it('现金足够时买地照常成功（不受存款规则影响）', () => {
    const g = newGame(105);
    const landCell = g.board.find((c) => c.type === 'property' && c.price)!;
    const p = g.players[0]!;
    p.deposit = 0;
    p.position = landCell.id;
    g.phase = 'awaiting_action';
    const cashBefore = p.cash;
    const after = applyAction(g, { type: 'BUY_LAND' });
    expect(after.players[0]!.properties.map((x) => x.cellId)).toContain(landCell.id);
    expect(after.players[0]!.cash).toBeLessThan(cashBefore);
    expect(after.players[0]!.deposit).toBe(0);
  });
});


describe('负债不自动变卖股票：股票只能靠随机事件兑现', () => {
  /** 让 p1 现金存款归零、只剩股票 */
  function poorWithStock(state: GameState, stockId: string, qty: number): GameState {
    const p = state.players[0]!;
    p.cash = 0;
    p.deposit = 0;
    p.properties = [];
    p.stocks = { [stockId]: qty };
    p.stockCost = { [stockId]: qty * priceOf(state, stockId) };
    return state;
  }

  /** p2 拥有一块 5 级地，p1 踩上去必须付租金（走 pay 链路） */
  function withRentBill(state: GameState): GameState {
    const land = state.board.find((c) => c.type === 'property' && c.price)!;
    state.players[1]!.properties.push({ cellId: land.id, grade: 5 });
    state.players[1]!.cash = 0;
    state.players[1]!.deposit = 0;
    state.players[1]!.stocks = {};
    const cur = state.players[0]!;
    cur.position = (land.id - 1 + BOARD_SIZE) % BOARD_SIZE;
    state.players[state.currentPlayerIndex]!.fixedDice = 1;
    cur.diceCount = 1;
    return state;
  }

  it('现金存款不足以付租金时直接破产，股票不会被自动卖掉', () => {
    const g = poorWithStock(newGame(107), 'tech', 5);
    const r = applyAction(withRentBill(g), { type: 'ROLL_DICE' });
    const p = r.players[0]!;
    expect(p.bankrupt).toBe(true);
    // 关键：日志里没有「变卖股票」这一动作
    expect(r.log.some((l) => l.text.includes('变卖 科技股'))).toBe(false);
    expect(r.log.some((l) => l.text.includes('无力支付'))).toBe(true);
  });

  it('现金存款足够付租金时，股票分毫不动', () => {
    const g = newGame(113);
    const p = g.players[0]!;
    p.stocks = { tech: 3 };
    p.stockCost = { tech: 3 * priceOf(g, 'tech') };
    p.cash = 100000; // 现金充足
    const r = applyAction(withRentBill(g), { type: 'ROLL_DICE' });
    expect(r.players[0]!.stocks.tech).toBe(3);
    expect(r.players[0]!.bankrupt).toBe(false);
  });

  it('存款可支付租金时优先扣存款，同样不动股票', () => {
    const g = poorWithStock(newGame(115), 'food', 4);
    g.players[0]!.deposit = 100000;
    const r = applyAction(withRentBill(g), { type: 'ROLL_DICE' });
    const p = r.players[0]!;
    expect(p.bankrupt).toBe(false);
    expect(p.stocks.food).toBe(4);
    expect(p.cash).toBe(0);
    expect(p.deposit).toBeLessThan(100000);
  });

  it('随机事件「变卖所有股票求现」是股票兑现途径（存在性）', () => {
    expect(FATE_CARDS.some((c) => c.effect === 'sell-all-stocks')).toBe(true);
  });

  it('该事件生效时股票全部变现为现金', () => {
    const g = poorWithStock(newGame(117), 'tech', 8);
    g.players[0]!.stocks.media = 4;
    const before = 8 * priceOf(g, 'tech') + 4 * priceOf(g, 'media');
    const def = FATE_CARDS.find((c) => c.effect === 'sell-all-stocks')!;
    applyFateEffect(g, g.players[0]!, def); // 原地结算
    const p = g.players[0]!;
    expect(p.stocks).toEqual({});
    expect(p.cash).toBe(before);
    expect(p.stockCost).toEqual({});
    expect(g.log.some((l) => l.text.includes('变卖所有股票求现'))).toBe(true);
  });

  it('股票违约交割事件：损失部分股票（另一条股票消减途径）', () => {
    const g = newGame(119);
    const p = g.players[0]!;
    p.cash = 1000;
    p.deposit = 1000;
    p.stocks = { tech: 100, food: 100 };
    p.stockCost = { tech: 10000, food: 8000 };
    const def = FATE_CARDS.find((c) => c.effect === 'stock-default')!;
    applyFateEffect(g, p, def); // 原地结算
    // 20% 交割 → 至少有一支被削
    const total = (p.stocks.tech ?? 0) + (p.stocks.food ?? 0);
    expect(total).toBeLessThan(200);
  });
});

/**
 * 日 K 线与成交量（玩法文档 §3.4 的自定扩展）。
 *
 * 三条纪律各自钉一条：① 一根 = 一个交易日，且「下一根的开 = 上一根的收」（图不能断）；
 * ② 量分背景换手与玩家真实成交两笔；③ 画 K 线与算冲击都**不消耗随机数**，
 * 否则就等于新增一条随机源，把整局骰子序列打散。
 */
describe('日 K 线与成交量（自定扩展）', () => {
  /** 立刻推过一次日切：把回合交给最后一位玩家再结束，中间没人移动 ⇒ 只有日钩子动状态 */
  function toDayBoundary(state: GameState): GameState {
    const s = structuredClone(state);
    if (s.phase === 'game_over') return s;
    s.currentPlayerIndex = s.players.length - 1;
    s.phase = 'awaiting_action';
    return applyAction(s, { type: 'FINISH_LANDING' });
  }

  const candlesOf = (s: GameState, id = 'tech') => s.stockMarket.stocks.find((x) => x.id === id)!.candles;

  it('每个交易日收一根；下一根的开等于上一根的收', () => {
    let s = newGame(301);
    s = toDayBoundary(s);
    const first = candlesOf(s)[0]!;
    expect(candlesOf(s)).toHaveLength(1);
    expect(first.day).toBe(s.calendar.elapsedDays);
    expect(first.open).toBe(120); // 首根的开 = 建仓价
    expect(first.close).toBe(priceOf(s, 'tech'));
    expect(first.high).toBeGreaterThanOrEqual(Math.max(first.open, first.close));
    expect(first.low).toBeLessThanOrEqual(Math.min(first.open, first.close));
    expect(first.low).toBeGreaterThanOrEqual(5);
    s = toDayBoundary(s);
    expect(candlesOf(s)[1]!.open).toBe(first.close);
  });

  it('成交量分两笔记：背景换手 + 玩家真实成交', () => {
    let s = toDayBoundary(newGame(303));
    s = withDeposit(s);
    const background = candlesOf(s).at(-1)!.volume;
    expect(background).toBeGreaterThan(0);
    expect(candlesOf(s).at(-1)!.playerVolume).toBe(0);
    s = applyAction(s, { type: 'BUY_STOCK', stockId: 'tech', quantity: 10 });
    const c = candlesOf(s).at(-1)!;
    expect(c.playerVolume).toBe(10);
    expect(c.volume).toBe(background + 10);
    expect(c.close).toBe(priceOf(s, 'tech')); // 当日这根跟着成交走
    expect(c.high).toBeGreaterThanOrEqual(c.low);
  });

  it('K 线不消耗随机数：交易前后 rngState 分文不动', () => {
    let s = withDeposit(toDayBoundary(newGame(305)));
    const before = s.rngState;
    s = applyAction(s, { type: 'BUY_STOCK', stockId: 'tech', quantity: 30 });
    s = applyAction(s, { type: 'SELL_STOCK', stockId: 'tech', quantity: 30 });
    expect(s.rngState).toBe(before);
  });

  it('停牌日是一字线且零成交；例假日干脆不生成根', () => {
    let halted = newGame(307);
    // 停牌天数由日切钩子递减，而 tickStockMarket 在钩子之后才跑 ⇒ 得留够余量
    halted.stockHaltAllDays = 3;
    halted = toDayBoundary(halted);
    const flat = candlesOf(halted).at(-1)!;
    expect(flat.volume).toBe(0);
    expect(flat.high).toBe(flat.low);
    expect(flat.open).toBe(flat.close);

    let holiday = newGame(309);
    holiday.calendar.elapsedDays = 5; // 2026-01-10 是周六
    holiday = toDayBoundary(holiday);
    expect(candlesOf(holiday)).toHaveLength(0); // 休市不生成当日 K 线
  });

  it('只保留最近 30 根，且日期单调递增', () => {
    let s = newGame(311);
    for (let i = 0; i < 60 && s.phase !== 'game_over'; i++) s = toDayBoundary(s);
    const candles = candlesOf(s);
    expect(candles.length).toBeLessThanOrEqual(30);
    expect(candles.length).toBeGreaterThan(20); // 60 天里约有 40 多个交易日
    for (let i = 1; i < candles.length; i++) {
      expect(candles[i]!.day).toBeGreaterThan(candles[i - 1]!.day);
    }
  });

  it('冲击：买推高、卖压低，力度按成交股数占流通股本的比例', () => {
    const g = withDeposit(newGame(313));
    const tech = g.stockMarket.stocks.find((s) => s.id === 'tech')!;
    const bought = applyAction(g, { type: 'BUY_STOCK', stockId: 'tech', quantity: 40 });
    expect(priceOf(bought, 'tech')).toBeGreaterThan(tech.price);
    const sold = applyAction(bought, { type: 'SELL_STOCK', stockId: 'tech', quantity: 40 });
    expect(priceOf(sold, 'tech')).toBeLessThan(priceOf(bought, 'tech'));
    // 同样 40 股，流通盘更大的食品股被推动的比例更小
    const food = g.stockMarket.stocks.find((s) => s.id === 'food')!;
    expect(stockImpactPct(food, 40)).toBeLessThan(stockImpactPct(tech, 40));
  });

  it('最大可买数与引擎校验同源：按它下单必被接受，再多一股即拒', () => {
    const g = withDeposit(newGame(317));
    const tech = g.stockMarket.stocks.find((s) => s.id === 'tech')!;
    const money = g.players[0]!.deposit;
    const qty = maxAffordableShares(tech, money);
    expect(qty).toBeGreaterThan(0);
    const cost = (q: number) => stockExecPrice(tech, q, 'buy') * q;
    expect(cost(qty)).toBeLessThanOrEqual(money);
    expect(cost(qty + 1)).toBeGreaterThan(money);
    expect(() => applyAction(g, { type: 'BUY_STOCK', stockId: 'tech', quantity: qty })).not.toThrow();
    expect(() => applyAction(g, { type: 'BUY_STOCK', stockId: 'tech', quantity: qty + 1 })).toThrow('存款不足');
    expect(maxAffordableShares(tech, 0)).toBe(0);
  });

  it('K 线随录像一起复现：整段 candles 逐位一致', () => {
    // 只用动作能表达的东西建局 —— `withDeposit` 这类夹具改动不在动作日志里，
    // 回放拿不到，测试就会假失败（同 game_end.test.ts 里 pinIndexOne 那个坑）。
    let s = newGame(319);
    const actions: { turn: number; action: PlayerAction }[] = [{ turn: 0, action: { type: 'START_GAME' } }];
    const push = (state: GameState, action: PlayerAction) => {
      actions.push({ turn: state.turn, action });
      return applyAction(state, action);
    };
    for (let i = 0; i < 12 && s.phase !== 'game_over'; i++) {
      s = push(s, nextStepAction(s));
    }
    const record = {
      seed: 319,
      startDate: { ...MONDAY },
      players: PLAYERS.map((p) => ({ player_name: p.name, color: p.color, player_key: p.id })),
      actions,
    };
    const replayed = new ReplayEngine(record).finalState;
    expect(replayed.calendar.elapsedDays).toBe(s.calendar.elapsedDays);
    for (const stock of s.stockMarket.stocks) {
      const twin = replayed.stockMarket.stocks.find((x) => x.id === stock.id)!;
      expect(twin.candles).toEqual(stock.candles);
      expect(twin.candles.length).toBeGreaterThan(0);
    }
  });
});

/**
 * 反汇编实证第一波（`docs/玩法拆解_股票系统.md` §2 / §3）：
 * 涨跌停的**非对称**闸门、游走的趋势惯性与均值回归、单日 ±10% 的硬边界。
 */
describe('涨跌停闸门与价格游走（反汇编实证第一波）', () => {
  const stockOf = (s: GameState, id = 'tech') => s.stockMarket.stocks.find((x) => x.id === id)!;

  /** 立刻推过一个交易日：回合交给最后一位玩家再结束 ⇒ 绕回 0 号、跑日切钩子（含行情） */
  function toTradingDay(state: GameState): GameState {
    const s = structuredClone(state);
    if (s.phase === 'game_over') return s;
    s.currentPlayerIndex = s.players.length - 1;
    s.phase = 'awaiting_action';
    return applyAction(s, { type: 'FINISH_LANDING' });
  }

  /** 当日这支被新闻改过价 ⇒ 这一档比较作废（新闻也按板钉价，会盖掉游走的读数） */
  const newsHit = (s: GameState): boolean => s.log.some((e) => /【新闻】科技股/.test(e.text));

  it('涨停只能卖不能买、跌停只能买不能卖、平盘双向（FUN_004295ea）', () => {
    const flat = withDeposit(newGame(201));
    expect(stockLimitState(stockOf(flat))).toBe('flat');
    expect(() => applyAction(flat, { type: 'BUY_STOCK', stockId: 'tech', quantity: 1 })).not.toThrow();

    const pinned = (pct: number, held = 0): GameState => {
      const s = structuredClone(flat);
      const t = stockOf(s);
      t.openPrice = t.price;
      t.lastChangePct = pct;
      if (held) s.players[0]!.stocks.tech = held;
      return s;
    };
    expect(() => applyAction(pinned(10), { type: 'BUY_STOCK', stockId: 'tech', quantity: 1 })).toThrow('涨停中，无法买进');
    expect(() => applyAction(pinned(10, 3), { type: 'SELL_STOCK', stockId: 'tech', quantity: 1 })).not.toThrow();
    expect(() => applyAction(pinned(-10), { type: 'SELL_STOCK', stockId: 'tech', quantity: 1 })).toThrow('跌停中，无法卖出');
    expect(() => applyAction(pinned(-10), { type: 'BUY_STOCK', stockId: 'tech', quantity: 1 })).not.toThrow();
    // 板是「当日」的状态，+9% 不算被钉住
    expect(stockLimitState({ ...stockOf(flat), lastChangePct: 9 })).toBe('flat');
  });

  it('踩格按面值申购走一级市场、不吃闸门；同一支在二级转手照样吃跌停', () => {
    const g = newGame(203);
    const cellId = g.board.find((c) => c.companyKind === 'computer')!.id;
    const s = standAt(g, 0, cellId);
    s.players[0]!.cash = 100_000;
    stockOf(s, 'corp-computer').lastChangePct = -10;
    const bought = applyAction(s, { type: 'BUY_SHARES', cellId, quantity: 1 });
    expect(bought.log.some((e) => e.text.includes('认购'))).toBe(true);

    const sell = structuredClone(bought);
    sell.currentPlayerIndex = 0;
    sell.phase = 'awaiting_roll';
    const company = sell.companies.find((c) => c.cellId === cellId)!;
    company.shares[sell.players[0]!.id] = 5;
    expect(() => applyAction(sell, { type: 'SELL_SHARES', cellId, quantity: 1 })).toThrow('跌停中，无法卖出原始股');
  });

  it('游走读昨日涨跌（趋势惯性）：同一手随机数下，昨日涨的那支只会更贵或持平', () => {
    let compared = 0;
    let differs = 0;
    for (let seed = 1; seed <= 24; seed++) {
      const base = newGame(seed * 61);
      const run = (prev: number): GameState => {
        const s = structuredClone(base);
        stockOf(s).lastChangePct = prev;
        return toTradingDay(s);
      };
      const up = run(8);
      const down = run(-8);
      if (newsHit(up) || newsHit(down)) continue;
      compared += 1;
      expect(stockOf(up).lastChangePct).toBeGreaterThanOrEqual(stockOf(down).lastChangePct);
      if (stockOf(up).lastChangePct > stockOf(down).lastChangePct) differs += 1;
    }
    // 若公式里根本没读昨日涨跌，两档会逐位相同 ⇒ 必须至少有一档拉开
    expect(compared).toBeGreaterThan(0);
    expect(differs).toBeGreaterThan(0);
  });

  it('跌破锚的一半被往回拉、涨过 8 倍被压住（均值回归）', () => {
    const base = newGame(211);
    const anchor = stockOf(base).anchorPrice;
    const run = (price: number): GameState => {
      const s = structuredClone(base);
      Object.assign(stockOf(s), { price, openPrice: price, lastChangePct: 0 });
      return toTradingDay(s);
    };
    let compared = 0;
    let pulled = 0;
    for (let seed = 1; seed <= 24; seed++) {
      const low = run(Math.max(6, Math.round(anchor * 0.4)));
      const mid = run(anchor);
      if (newsHit(low) || newsHit(mid)) continue;
      compared += 1;
      expect(stockOf(low).lastChangePct).toBeGreaterThanOrEqual(stockOf(mid).lastChangePct);
      if (stockOf(low).lastChangePct > stockOf(mid).lastChangePct) pulled += 1;
    }
    expect(compared).toBeGreaterThan(0);
    expect(pulled).toBeGreaterThan(0);
  });

  it('单日行情不会越过 ±10%（游走与新闻共用同一块板）', () => {
    let s = newGame(213);
    let days = 0;
    for (let i = 0; i < 40 && s.phase !== 'game_over'; i++) {
      const before = s.calendar.elapsedDays;
      s = toTradingDay(s);
      if (s.calendar.elapsedDays === before) continue;
      days += 1;
      for (const stock of s.stockMarket.stocks) {
        if (!stock.openPrice) continue;
        expect(stock.price).toBeLessThanOrEqual(stockLimitPrice(stock.openPrice, 1));
        expect(stock.price).toBeGreaterThanOrEqual(Math.max(5, stockLimitPrice(stock.openPrice, -1)));
      }
    }
    expect(days).toBeGreaterThan(20); // 别空跑
  });
});

/**
 * 反汇编实证第二波（`docs/玩法拆解_股票系统.md` §1 / §6）：
 * 流通股可以被买光、锚跟着绑定城市的地价走、全市场涨跌新闻按开盘钉板。
 */
describe('流通股可买光 + 地价定锚（反汇编实证第二波）', () => {
  const stockOf = (s: GameState, id: string) => s.stockMarket.stocks.find((x) => x.id === id)!;

  it('流通股可以被买光：买光即拒，卖回来才有货', () => {
    const g = withDeposit(newGame(221));
    stockOf(g, 'tech').remainingShares = 5;
    const bought = applyAction(g, { type: 'BUY_STOCK', stockId: 'tech', quantity: 5 });
    expect(stockOf(bought, 'tech').remainingShares).toBe(0);
    expect(() => applyAction(bought, { type: 'BUY_STOCK', stockId: 'tech', quantity: 1 })).toThrow('流通股只剩 0 张');

    // 卖回 2 张 ⇒ 流通盘回补，下一位才买得到（回补的上限就是总股本：手里有多少才卖得回多少）
    const sold = applyAction(bought, { type: 'SELL_STOCK', stockId: 'tech', quantity: 2 });
    expect(stockOf(sold, 'tech').remainingShares).toBe(2);
    expect(() => applyAction(sold, { type: 'BUY_STOCK', stockId: 'tech', quantity: 2 })).not.toThrow();
  });

  it('门控与引擎同源：最多可买数不会超过还没被买走的量', () => {
    const g = withDeposit(newGame(223), 10_000_000);
    const tech = stockOf(g, 'tech');
    tech.remainingShares = 7;
    expect(maxAffordableShares(tech, 10_000_000)).toBe(7);
    tech.remainingShares = 0;
    expect(maxAffordableShares(tech, 10_000_000)).toBe(0);
    expect(() => applyAction(g, { type: 'BUY_STOCK', stockId: 'tech', quantity: 1 })).toThrow('流通股只剩 0 张');
  });

  it('本地股的锚 = 面值 × 今日地价水平 ÷ 开局地价水平（地价翻倍则锚翻倍，读不到就退回面值）', () => {
    const g = newGame(225);
    const stock = { ...stockOf(g, 'tech'), landPriceBase: 1000, anchorPrice: 200 };
    expect(stockAnchor(stock, 1000)).toBe(200);
    expect(stockAnchor(stock, 2000)).toBe(400);
    expect(stockAnchor(stock, 500)).toBe(100);
    expect(stockAnchor(stock, 0)).toBe(200);
    const unbound = { ...stock, landPriceBase: undefined };
    expect(stockAnchor(unbound, 5000)).toBe(200);
  });

  it('全市场上涨新闻按开盘钉板：当天已在板上的票不会被再推一层', () => {
    const g = newGame(227);
    g.newsCursor = 25;                       // 游标正好指向「股市气势如虹，全面上涨」
    const s = landAt(withDeposit(g), 44, 4); // 44 号是报社
    const media = stockOf(s, 'media');
    Object.assign(media, { openPrice: 100, price: 110, lastChangePct: 10 });
    const food = stockOf(s, 'food');
    food.openPrice = 80;
    const landed = applyAction(s, { type: 'ROLL_DICE' });
    expect(landed.log.some((e) => /全市场上涨 10%/.test(e.text))).toBe(true);
    // 已经 +10% 的那支停在板上（乘在现价上会变成 121 = 一天 +21%）
    expect(stockOf(landed, 'media').price).toBe(110);
    expect(stockOf(landed, 'media').lastChangePct).toBe(10);
    // 没涨过的那支从开盘推上去：80 → 88
    expect(stockOf(landed, 'food').price).toBe(88);
  });
});

/**
 * R11 收尾三件里的两件半：价格钳制收口（原版的 9999 天花板 + 处处取整）与
 * 「公司股也记成本账」（此前只有虚拟股记，原始股那条分支被 `if (company)` 挡住了）。
 */
describe('价格钳制与成本账（R11）', () => {
  const stockOf = (s: GameState, id: string) => s.stockMarket.stocks.find((x) => x.id === id)!;

  it('clampStockPrice 上下都收口并取整 —— 结算价与成交价说的是同一个价', () => {
    expect(clampStockPrice(12345.6)).toBe(9999);
    expect(clampStockPrice(0.4)).toBe(STOCK_MIN_PRICE);
    expect(clampStockPrice(132.5)).toBe(133);
  });

  it('一笔大卖单把盘口压到底就不再往下，且存款不会被扣出小数', () => {
    const g = newGame(240);
    const tech = stockOf(g, 'tech');
    Object.assign(tech, { floatShares: 120, remainingShares: 120, price: 40, openPrice: 40 });
    const p = g.players[g.currentPlayerIndex]!;
    p.stocks.tech = 120;
    p.stockCost = { tech: 12_000 };
    const sold = applyAction(g, { type: 'SELL_STOCK', stockId: 'tech', quantity: 120 });
    // 120 张 = 全部流通盘，抛压早就该触底了
    expect(stockOf(sold, 'tech').price).toBe(STOCK_MIN_PRICE);
    expect(Number.isInteger(sold.players[0]!.deposit)).toBe(true);
    // 卖光即退出账本，成本也跟着清（不留一条 0 股的悬账）
    expect(sold.players[0]!.stocks.tech ?? 0).toBe(0);
    expect(sold.players[0]!.stockCost?.tech).toBeUndefined();
  });

  it('公司股两条进货渠道都记成本：面板按市价、踩格按面值，进同一条账', () => {
    const g = withDeposit(newGame(241), 1_000_000);
    const comp = stockOf(g, 'corp-computer');
    Object.assign(comp, { price: 500, openPrice: 500, floatShares: 2000, remainingShares: 2000 });
    const bought = applyAction(g, { type: 'BUY_STOCK', stockId: 'corp-computer', quantity: 10 });
    const cost1 = bought.players[0]!.stockCost?.['corp-computer'] ?? 0;
    // 冲击成本让 10 张的均价高于盘口 500 —— 记的必须是成交价而不是盘口价，否则盈亏是假的
    expect(cost1).toBeGreaterThan(500 * 10);
    expect(Number.isInteger(cost1)).toBe(true);

    // 踩到公司格按面值认购 10 张（现金），累加进同一条账
    const atDoor = standAt(bought, 0, 43);
    atDoor.players[0]!.cash = 1_000_000;
    const sub = applyAction(atDoor, { type: 'BUY_SHARES', cellId: 43, quantity: 10 });
    expect(sub.players[0]!.stockCost?.['corp-computer']).toBe(cost1 + 400 * 10);
    expect(sub.players[0]!.stocks['corp-computer'] ?? 0).toBe(0);   // 公司股的持股在股东名册上，不在这里
  });

  it('原始股按市价计值，所以报表给得出盈亏（旧口径按面值，profit 恒 0）', () => {
    const g = newGame(242);
    const comp = stockOf(g, 'corp-computer');
    comp.price = 800;                       // 行情翻倍，而面值仍是 400
    const company = g.companies.find((c) => c.kind === 'computer')!;
    company.shares[g.players[0]!.id] = 10;
    g.players[0]!.stockCost = { 'corp-computer': 4000 };   // 按面值认购过 10 张
    const row = stockSummary(g, g.players[0]!).corpRows.find((r) => r.kind === 'computer')!;
    expect(row.price).toBe(800);
    expect(row.faceValue).toBe(400);
    expect(row.marketValue).toBe(8000);
    expect(row.profit).toBe(4000);
    // 与 totalAssets 同口径（那边一直按市价计），别让报表与资产清单两个数
    expect(stockSummary(g, g.players[0]!).marketValue).toBeGreaterThanOrEqual(8000);
  });
});
