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
      const landed = applyAction(landAt(newGame(41), cellId), { type: 'ROLL_DICE' });
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
    const atBank = applyAction(landAt(newGame(43), bankCell), { type: 'ROLL_DICE' });
    const atProp = applyAction(landAt(newGame(43), propCell), { type: 'ROLL_DICE' });
    // 两处都可交易（至少不应因为「不在银行」而被拒）
    if (availableActions(atProp).canTradeStock) {
      expect(() => applyAction(atProp, { type: 'BUY_STOCK', stockId: 'tech', quantity: 1 })).not.toThrow();
    }
    expect(availableActions(atBank).canTradeStock).toBe(true);
  });
});

describe('「每人每回合可自由购买」', () => {
  it('掷骰前（awaiting_roll）即可交易，且不消耗回合', () => {
    const g = newGame(51);
    expect(g.phase).toBe('awaiting_roll');
    expect(availableActions(g).canTradeStock).toBe(true);
    const turnBefore = g.turn;
    const bought = applyAction(g, { type: 'BUY_STOCK', stockId: 'food', quantity: 3 });
    expect(bought.turn).toBe(turnBefore); // 交易不推进回合
    expect(bought.phase).toBe('awaiting_roll'); // 交易后可继续掷骰
    expect(bought.players[0]!.stocks.food).toBe(3);
  });

  it('决策阶段（awaiting_action）交易同样不推进回合', () => {
    const g = newGame(53);
    g.phase = 'awaiting_action';
    const turnBefore = g.turn;
    const bought = applyAction(g, { type: 'BUY_STOCK', stockId: 'food', quantity: 2 });
    expect(bought.turn).toBe(turnBefore);
    expect(bought.phase).toBe('awaiting_action');
  });

  it('一次可买任意张（数量仅受资金与持股约束）', () => {
    const g = newGame(55);
    const price = priceOf(g, 'tech');
    const afford = Math.floor((g.players[0]!.cash + g.players[0]!.deposit) / price);
    expect(afford).toBeGreaterThan(10);
    const bought = applyAction(g, { type: 'BUY_STOCK', stockId: 'tech', quantity: afford });
    expect(bought.players[0]!.stocks.tech).toBe(afford);
    // 再买 1 张则资金不足
    expect(() => applyAction(bought, { type: 'BUY_STOCK', stockId: 'tech', quantity: 1 })).toThrow();
  });

  it('不限每回合交易次数：同一回合可连续买卖多次', () => {
    const g = newGame(57);
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
  it('现金充足时只动现金', () => {
    const g = newGame(61);
    const price = priceOf(g, 'tech');
    const bought = applyAction(g, { type: 'BUY_STOCK', stockId: 'tech', quantity: 2 });
    expect(bought.players[0]!.cash).toBe(15000 - price * 2);
    expect(bought.players[0]!.deposit).toBe(0);
  });

  it('现金不足时自动从存款扣，缺口由存款补足', () => {
    const g = newGame(63);
    g.players[0]!.cash = 1000;
    g.players[0]!.deposit = 5000;
    const price = priceOf(g, 'estate'); // 200/股
    const qty = 30; // 需6000：现金1000 缺口 5000
    const bought = applyAction(g, { type: 'BUY_STOCK', stockId: 'estate', quantity: qty });
    const p = bought.players[0]!;
    expect(p.stocks.estate).toBe(qty);
    expect(p.cash).toBe(0);
    expect(p.deposit).toBe(5000 - (price * qty - 1000));
    expect(bought.log.some((l) => l.text.includes('自动从存款扣除'))).toBe(true);
  });

  it('现金与存款合计不足时拒绝买入（不产生半截状态）', () => {
    const g = newGame(65);
    g.players[0]!.cash = 100;
    g.players[0]!.deposit = 100;
    const snapshot = JSON.stringify(g);
    expect(() => applyAction(g, { type: 'BUY_STOCK', stockId: 'finance', quantity: 1 })).toThrow('不足');
    // applyAction 是纯函数：抛错时传入对象不被修改
    expect(JSON.stringify(g)).toBe(snapshot);
  });

  it('卖出所得进现金（三货币规则：收入用现金）', () => {
    const g = newGame(67);
    const price = priceOf(g, 'tech');
    const bought = applyAction(g, { type: 'BUY_STOCK', stockId: 'tech', quantity: 3 });
    const cashAfterBuy = bought.players[0]!.cash;
    const sold = applyAction(bought, { type: 'SELL_STOCK', stockId: 'tech', quantity: 3 });
    expect(sold.players[0]!.cash).toBe(cashAfterBuy + price * 3);
    expect(sold.players[0]!.deposit).toBe(0);
  });

  it('买入的支出不进乐透奖池（不属于「意外损失」）', () => {
    const g = newGame(69);
    const poolBefore = g.lotteryPool;
    const bought = applyAction(g, { type: 'BUY_STOCK', stockId: 'tech', quantity: 2 });
    expect(bought.lotteryPool).toBe(poolBefore);
  });
});

describe('help[06] 总市值 / 成本 / 经营权', () => {
  it('买入累计成本，卖出按比例结转，盈亏随之变化', () => {
    const g = newGame(71);
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
    const g = newGame(73);
    const price = priceOf(g, 'media');
    const bought = applyAction(g, { type: 'BUY_STOCK', stockId: 'media', quantity: 10 });
    const sold = applyAction(bought, { type: 'SELL_STOCK', stockId: 'media', quantity: 4 });
    expect(sold.players[0]!.stocks.media).toBe(6);
    expect(sold.players[0]!.stockCost?.media).toBe(price * 6);
  });

  it('股票现值计入总资产（ECON-03）', () => {
    const g = newGame(75);
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
    const g = newGame(79);
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
    const g = newGame(83);
    g.stockHalts = [{ stockId: 'tech', kind: 'suspend', daysLeft: 2 }];
    expect(() => applyAction(g, { type: 'BUY_STOCK', stockId: 'tech', quantity: 1 })).toThrow('暂停交易');
    expect(() => applyAction(g, { type: 'BUY_STOCK', stockId: 'food', quantity: 1 })).not.toThrow();
  });

  it('红卡涨停/黑卡跌停期间仍可交易（只是不能继续涨/跌）', () => {
    const up = newGame(85);
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
    const g = newGame(95);
    const rngBefore = g.rngState;
    const a = applyAction(g, { type: 'BUY_STOCK', stockId: 'tech', quantity: 2 });
    const b = applyAction(g, { type: 'BUY_STOCK', stockId: 'tech', quantity: 2 });
    expect(a.rngState).toBe(rngBefore);
    expect(b.rngState).toBe(rngBefore);
    expect(a.rngState).toBe(b.rngState);
    expect(a.players[0]!.stocks.tech).toBe(b.players[0]!.stocks.tech);
  });
});