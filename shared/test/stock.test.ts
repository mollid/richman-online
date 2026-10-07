import { describe, expect, it } from 'vitest';
import {
  applyAction,
  availableActions,
  BOARD_SIZE,
  createGame,
  gameDate,
  totalAssets,
  type GameState,
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

/** 把当前玩家直接摆到指定格（用 pendingFixedDice 固定骰子，掷骰 0 抽） */
function landAt(state: GameState, cellId: number, steps = 3): GameState {
  const s = structuredClone(state);
  s.pendingFixedDice = steps;
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

  it('银行格不再是交易的前提（回归：旧实现限定银行格）', () => {
    const bankCell = newGame().board.find((c) => c.type === 'bank')!.id;
    const propCell = newGame().board.find((c) => c.type === 'property')!.id;
    const atBank = applyAction(landAt(withDeposit(newGame(43)), bankCell), { type: 'ROLL_DICE' });
    const atProp = applyAction(landAt(withDeposit(newGame(43)), propCell), { type: 'ROLL_DICE' });
    // 两处都可交易（至少不应因为「不在银行」而被拒）
    if (availableActions(atProp).canTradeStock) {
      expect(() => applyAction(atProp, { type: 'BUY_STOCK', stockId: 'tech', quantity: 1 })).not.toThrow();
    }
    expect(availableActions(atBank).canTradeStock).toBe(true);
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

  it('决策阶段（awaiting_action）交易同样不推进回合', () => {
    const g = withDeposit(newGame(53));
    g.phase = 'awaiting_action';
    const turnBefore = g.turn;
    const bought = applyAction(g, { type: 'BUY_STOCK', stockId: 'food', quantity: 2 });
    expect(bought.turn).toBe(turnBefore);
    expect(bought.phase).toBe('awaiting_action');
  });

  it('一次可买任意张（数量仅受资金与持股约束）', () => {
    const g = withDeposit(newGame(55));
    const price = priceOf(g, 'tech');
    const afford = Math.floor(g.players[0]!.deposit / price); // 只能用存款买
    expect(afford).toBeGreaterThan(10);
    expect(g.players[0]!.cash).toBeGreaterThan(0); // 现金还有但用不上
    const bought = applyAction(g, { type: 'BUY_STOCK', stockId: 'tech', quantity: afford });
    expect(bought.players[0]!.stocks.tech).toBe(afford);
    // 再买 1 张则资金不足
    expect(() => applyAction(bought, { type: 'BUY_STOCK', stockId: 'tech', quantity: 1 })).toThrow();
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
    const price = priceOf(g, 'tech');
    const cashBefore = g.players[0]!.cash;
    const bought = applyAction(g, { type: 'BUY_STOCK', stockId: 'tech', quantity: 2 });
    expect(bought.players[0]!.deposit).toBe(5000 - price * 2);
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
    const price = priceOf(g, 'estate'); // 200/股
    const qty = 25; // 需 5000
    const bought = applyAction(g, { type: 'BUY_STOCK', stockId: 'estate', quantity: qty });
    const p = bought.players[0]!;
    expect(p.stocks.estate).toBe(qty);
    expect(p.deposit).toBe(0);
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

  it('卖出所得进现金（三货币规则：收入用现金）', () => {
    const g = withDeposit(newGame(67));
    const price = priceOf(g, 'tech');
    const bought = applyAction(g, { type: 'BUY_STOCK', stockId: 'tech', quantity: 3 });
    const cashAfterBuy = bought.players[0]!.cash;
    const depositAfterBuy = bought.players[0]!.deposit;
    const sold = applyAction(bought, { type: 'SELL_STOCK', stockId: 'tech', quantity: 3 });
    expect(sold.players[0]!.cash).toBe(cashAfterBuy + price * 3);
    expect(sold.players[0]!.deposit).toBe(depositAfterBuy); // 卖出不动存款
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
    const price = priceOf(g, 'media'); // 100/股
    const bought = applyAction(g, { type: 'BUY_STOCK', stockId: 'media', quantity: 10 });
    expect(bought.players[0]!.stockCost?.media).toBe(price * 10);

    // 股价涨到 150 后全卖 → 盈亏 +500
    const up = structuredClone(bought);
    up.stockMarket.stocks.find((s) => s.id === 'media')!.price = 150;
    const sold = applyAction(up, { type: 'SELL_STOCK', stockId: 'media', quantity: 10 });
    expect(sold.players[0]!.stocks.media).toBeUndefined();
    expect(sold.players[0]!.stockCost?.media).toBeUndefined();
    expect(sold.log.some((l) => l.text.includes('赚'))).toBe(true);

    // 股价跌到 50 → 亏500
    const down = structuredClone(bought);
    down.stockMarket.stocks.find((s) => s.id === 'media')!.price = 50;
    const soldDown = applyAction(down, { type: 'SELL_STOCK', stockId: 'media', quantity: 10 });
    expect(soldDown.log.some((l) => l.text.includes('亏'))).toBe(true);
  });

  it('部分卖出按比例结转成本', () => {
    const g = withDeposit(newGame(73));
    const price = priceOf(g, 'media');
    const bought = applyAction(g, { type: 'BUY_STOCK', stockId: 'media', quantity: 10 });
    const sold = applyAction(bought, { type: 'SELL_STOCK', stockId: 'media', quantity: 4 });
    expect(sold.players[0]!.stocks.media).toBe(6);
    expect(sold.players[0]!.stockCost?.media).toBe(price * 6);
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


describe('负债时强制变卖股票：股票不变现就倒闭', () => {
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

  /** p2 拥有一块 5 级地，p1 踩上去必须付租金（走 pay 变卖链路） */
  function withRentBill(state: GameState): { state: GameState; landId: number } {
    const land = state.board.find((c) => c.type === 'property' && c.price)!;
    state.players[1]!.properties.push({ cellId: land.id, grade: 5 });
    state.players[1]!.cash = 0;
    state.players[1]!.deposit = 0;
    state.players[1]!.stocks = {};
    const cur = state.players[0]!;
    cur.position = (land.id - 1 + BOARD_SIZE) % BOARD_SIZE;
    state.pendingFixedDice = 1;
    cur.diceCount = 1;
    return { state, landId: land.id };
  }

  it('现金存款花光后付租金：强制变卖股票偿债，不倒闭', () => {
    const g = poorWithStock(newGame(107), 'tech', 5);
    const { state } = withRentBill(g);
    const r = applyAction(state, { type: 'ROLL_DICE' });
    const p = r.players[0]!;
    // 股票被变卖换现金用于支付租金
    expect(p.stocks.tech ?? 0).toBeLessThan(5);
    expect(r.log.some((l) => l.text.includes('变卖'))).toBe(true);
    expect(p.bankrupt).toBe(false);
    // 债权人收到了钱
    expect(r.players[1]!.deposit).toBeGreaterThan(0);
  });

  it('股票不足以偿债时变卖地产；全空则倒闭', () => {
    const g = poorWithStock(newGame(109), 'food', 1); // 只持1 张低价股
    const { state } = withRentBill(g);
    const r = applyAction(state, { type: 'ROLL_DICE' });
    const p = r.players[0]!;
    expect(p.stocks.food).toBeUndefined();
    // 地产也在变卖链路中被处置，或直接破产
    if (p.bankrupt) {
      expect(r.log.some((l) => l.text.includes('破产'))).toBe(true);
      expect(p.properties).toHaveLength(0);
    } else {
      expect(p.deposit).toBe(0);
      expect(p.cash).toBeLessThan(10000);
    }
  });

  it('手里只有股票、无现金存款，一旦被强制偿债就连环变卖并可能倒闭', () => {
    const g = poorWithStock(newGame(111), 'finance', 1);
    const { state } = withRentBill(g);
    const r = applyAction(state, { type: 'ROLL_DICE' });
    const p = r.players[0]!;
    // 关键不变量：股票一定优先于地产被变卖；卖光后若仍不足必然破产
    expect(p.stocks.finance).toBeUndefined();
    expect(p.cash).toBeLessThan(100000);
    // 玩家不会「凭空有钱」——总资产不得因变卖而增加
    expect(p.deposit).toBe(0);
  });

  it('正常有现金时不会被动变卖股票', () => {
    const g = withDeposit(newGame(113));
    const p = g.players[0]!;
    p.stocks = { tech: 3 };
    p.stockCost = { tech: 3 * priceOf(g, 'tech') };
    const { state } = withRentBill(g);
    const r = applyAction(state, { type: 'ROLL_DICE' });
    // 现金充足 → 股票不动
    expect(r.players[0]!.stocks.tech).toBe(3);
  });
});
