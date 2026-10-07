import { describe, expect, it } from 'vitest';
import {
  applyAction,
  availableActions,
  createGame,
  describeTarget,
  MAX_ITEM_COUNT,
  refreshTrades,
  tradableAssets,
  type GameState,
  type PlayerDef,
} from '../src/index.js';

/**
 * UI-06 公布栏公开交易测试（help [11]「透過公佈欄，與其他的玩家公開的交易房地產、股票、卡片、道具」）：
 * - 挂出 / 买下 / 撤下三条主流程；
 * - 四类标的（地产含等级与建设、股票、卡片、道具）的产权转移；
 * - 现金即时过手、成交记录留存；
 * - 标的失效（被转手 / 消耗 / 卖方倒闭）后挂牌自动下架；
 * - 非法输入被拒；全程零 RNG 消耗（保回放确定性）。
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

/** 造一个有地产/股票/卡片/道具的挂出场景 */
function richSeller(): GameState {
  const g = newGame();
  const land = g.board.find((c) => c.type === 'property' && c.price)!;
  g.players[0]!.properties.push({ cellId: land.id, grade: 3, facility: 'hotel' });
  g.players[0]!.stocks.tech = 10;
  g.players[0]!.cards = ['angel'];
  g.players[0]!.items = { teleporter: 2 };
  g.phase = 'awaiting_action';
  return g;
}

/** 切到指定玩家行动（公布栏买下只要求 awaiting_action） */
function asPlayer(g: GameState, index: number): GameState {
  const s = structuredClone(g);
  s.currentPlayerIndex = index;
  s.phase = 'awaiting_action';
  return s;
}

describe('UI-06 公布栏：挂出与列表', () => {
  it('新建对局的公布栏为空', () => {
    const g = newGame();
    expect(g.trades).toEqual([]);
    expect(g.tradeHistory).toEqual([]);
  });

  it('可挂出的标的覆盖地产/股票/卡片/道具四类', () => {
    const g = richSeller();
    const kinds = tradableAssets(g, g.players[0]!).map((a) => a.kind);
    expect(kinds).toContain('land');
    expect(kinds).toContain('stock');
    expect(kinds).toContain('card');
    expect(kinds).toContain('item');
  });

  it('挂出后进入公布栏，并写日志', () => {
    const g = richSeller();
    const land = g.board.find((c) => c.type === 'property' && c.price)!;
    const r = applyAction(g, { type: 'POST_TRADE', kind: 'land', targetId: String(land.id), price: 5000 });
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0]!.sellerId).toBe('p1');
    expect(r.trades[0]!.price).toBe(5000);
    expect(r.trades[0]!.cellId).toBe(land.id);
    expect(r.log.some((l) => l.text.includes('公布栏挂出'))).toBe(true);
  });

  it('同一标的不重复挂牌；已挂牌的不再出现在可挂清单', () => {
    const g = richSeller();
    const land = g.board.find((c) => c.type === 'property' && c.price)!;
    const r1 = applyAction(g, { type: 'POST_TRADE', kind: 'land', targetId: String(land.id), price: 1000 });
    const keys = tradableAssets(r1, r1.players[0]!).map((a) => `${a.kind}:${a.targetId}`);
    expect(keys).not.toContain(`land:${land.id}`);
    // 再挂一次同标的：两条并存，刷新时只留最早一条
    const r2 = applyAction(r1, { type: 'POST_TRADE', kind: 'land', targetId: String(land.id), price: 2000 });
    refreshTrades(r2);
    expect(r2.trades.filter((t) => t.targetId === String(land.id))).toHaveLength(1);
    expect(r2.trades[0]!.price).toBe(1000);
  });

  it('非法挂出被拒：不持有 / 负价 / 非法标的类型', () => {
    const g = newGame();
    g.phase = 'awaiting_action';
    expect(() => applyAction(g, { type: 'POST_TRADE', kind: 'card', targetId: 'angel', price: 100 })).toThrow();
    expect(() =>
      applyAction(richSeller(), { type: 'POST_TRADE', kind: 'land', targetId: '1', price: -1 }),
    ).toThrow();
  });
});

describe('UI-06 公布栏：买下成交', () => {
  it('买下他人挂牌：现金即时过手、产权转移、成交记录留存', () => {
    const g = richSeller();
    const posted = applyAction(g, { type: 'POST_TRADE', kind: 'card', targetId: 'angel', price: 800 });
    const listingId = posted.trades[0]!.id;

    const buyerBefore = posted.players[1]!.cash;
    const sellerBefore = posted.players[0]!.cash;
    const buyer = asPlayer(posted, 1);
    const r = applyAction(buyer, { type: 'BUY_TRADE', listingId });

    expect(r.players[1]!.cash).toBe(buyerBefore - 800);
    expect(r.players[0]!.cash).toBe(sellerBefore + 800);
    expect(r.players[1]!.cards).toContain('angel');
    expect(r.players[0]!.cards).not.toContain('angel');
    expect(r.trades).toHaveLength(0);
    expect(r.tradeHistory).toHaveLength(1);
    expect(r.tradeHistory[0]!.price).toBe(800);
    expect(r.tradeHistory[0]!.buyerId).toBe('p2');
    expect(r.log.some((l) => l.text.includes('【交易】'))).toBe(true);
  });

  it('地产连同等级与建设一并转移', () => {
    const g = richSeller();
    const land = g.board.find((c) => c.type === 'property' && c.price)!;
    const posted = applyAction(g, { type: 'POST_TRADE', kind: 'land', targetId: String(land.id), price: 6000 });
    const r = applyAction(asPlayer(posted, 2), { type: 'BUY_TRADE', listingId: posted.trades[0]!.id });
    expect(r.players[0]!.properties.find((q) => q.cellId === land.id)).toBeUndefined();
    const got = r.players[2]!.properties.find((q) => q.cellId === land.id);
    expect(got).toBeDefined();
    expect(got!.grade).toBe(3);
    expect(got!.facility).toBe('hotel');
  });

  it('连锁店标记一并转移', () => {
    const g = newGame();
    const land = g.board.find((c) => c.type === 'property')!;
    g.players[0]!.properties.push({ cellId: land.id, grade: 1, chain: true });
    g.phase = 'awaiting_action';
    const posted = applyAction(g, { type: 'POST_TRADE', kind: 'land', targetId: String(land.id), price: 4000 });
    const r = applyAction(asPlayer(posted, 1), { type: 'BUY_TRADE', listingId: posted.trades[0]!.id });
    expect(r.players[1]!.properties.find((q) => q.cellId === land.id)!.chain).toBe(true);
  });

  it('股票按一股成交，数量正确递减/递增', () => {
    const g = richSeller(); // p1 持 tech 10 股
    const posted = applyAction(g, { type: 'POST_TRADE', kind: 'stock', targetId: 'tech', price: 150 });
    const r = applyAction(asPlayer(posted, 1), { type: 'BUY_TRADE', listingId: posted.trades[0]!.id });
    expect(r.players[0]!.stocks.tech).toBe(9);
    expect(r.players[1]!.stocks.tech ?? 0).toBe(1);
  });

  it('道具按一个成交', () => {
    const g = richSeller(); // p1 持 teleporter 2 个
    const posted = applyAction(g, { type: 'POST_TRADE', kind: 'item', targetId: 'teleporter', price: 50 });
    const r = applyAction(asPlayer(posted, 1), { type: 'BUY_TRADE', listingId: posted.trades[0]!.id });
    expect(r.players[0]!.items.teleporter).toBe(1);
    expect(r.players[1]!.items.teleporter ?? 0).toBe(1);
  });

  it('非法买下被拒：买自己的 / 现金不足 / 挂牌不存在 / 道具达上限', () => {
    const g = richSeller();
    const posted = applyAction(g, { type: 'POST_TRADE', kind: 'card', targetId: 'angel', price: 800 });
    const id = posted.trades[0]!.id;

    // 买自己的
    expect(() => applyAction(asPlayer(posted, 0), { type: 'BUY_TRADE', listingId: id })).toThrow();
    // 现金不足
    const poor = asPlayer(posted, 1);
    poor.players[1]!.cash = 100;
    expect(() => applyAction(poor, { type: 'BUY_TRADE', listingId: id })).toThrow();
    // 挂牌不存在
    expect(() => applyAction(asPlayer(posted, 1), { type: 'BUY_TRADE', listingId: 'nope' })).toThrow();

    // 买方道具已满
    const g2 = newGame();
    g2.players[0]!.items = { teleporter: 1 };
    g2.phase = 'awaiting_action';
    const posted2 = applyAction(g2, { type: 'POST_TRADE', kind: 'item', targetId: 'teleporter', price: 10 });
    const full = asPlayer(posted2, 1);
    full.players[1]!.items = { teleporter: MAX_ITEM_COUNT };
    expect(() => applyAction(full, { type: 'BUY_TRADE', listingId: posted2.trades[0]!.id })).toThrow();
  });

  it('已持有该地产时不能买下（避免重复产权）', () => {
    const g = richSeller();
    const land = g.board.find((c) => c.type === 'property' && c.price)!;
    const posted = applyAction(g, { type: 'POST_TRADE', kind: 'land', targetId: String(land.id), price: 100 });
    const dup = asPlayer(posted, 1);
    dup.players[1]!.properties.push({ cellId: land.id, grade: 1 });
    expect(() => applyAction(dup, { type: 'BUY_TRADE', listingId: posted.trades[0]!.id })).toThrow();
  });
});

describe('UI-06 公布栏：撤下与失效', () => {
  it('卖方可撤下自己的挂牌，且不收费', () => {
    const g = richSeller();
    const posted = applyAction(g, { type: 'POST_TRADE', kind: 'card', targetId: 'angel', price: 800 });
    const cashBefore = posted.players[0]!.cash;
    const r = applyAction(posted, { type: 'CANCEL_TRADE', listingId: posted.trades[0]!.id });
    expect(r.trades).toHaveLength(0);
    expect(r.players[0]!.cash).toBe(cashBefore);
    expect(r.players[0]!.cards).toContain('angel');
    expect(r.log.some((l) => l.text.includes('撤下'))).toBe(true);
  });

  it('不能撤下他人的挂牌', () => {
    const g = richSeller();
    const posted = applyAction(g, { type: 'POST_TRADE', kind: 'card', targetId: 'angel', price: 800 });
    expect(() =>
      applyAction(asPlayer(posted, 1), { type: 'CANCEL_TRADE', listingId: posted.trades[0]!.id }),
    ).toThrow();
  });

  it('标的被用掉后挂牌自动失效（不再可买）', () => {
    const g = richSeller();
    const posted = applyAction(g, { type: 'POST_TRADE', kind: 'card', targetId: 'angel', price: 800 });
    // 卖方把卡用掉了
    const spent = structuredClone(posted);
    spent.players[0]!.cards = [];
    refreshTrades(spent);
    expect(spent.trades).toHaveLength(0);
    expect(() => applyAction(asPlayer(spent, 1), { type: 'BUY_TRADE', listingId: posted.trades[0]!.id })).toThrow();
  });

  it('卖方倒闭后挂牌自动下架', () => {
    const g = richSeller();
    const posted = applyAction(g, { type: 'POST_TRADE', kind: 'card', targetId: 'angel', price: 800 });
    const dead = structuredClone(posted);
    dead.players[0]!.bankrupt = true;
    refreshTrades(dead);
    expect(dead.trades).toHaveLength(0);
  });
});

describe('UI-06 公布栏：只读与确定性', () => {
  it('查询可挂清单不改状态、不消耗 RNG', () => {
    const g = richSeller();
    const snapshot = JSON.stringify(g);
    const rngBefore = g.rngState;
    tradableAssets(g, g.players[0]!);
    tradableAssets(g, g.players[1]!);
    refreshTrades(g);
    expect(JSON.stringify(g)).toBe(snapshot);
    expect(g.rngState).toBe(rngBefore);
  });

  it('挂出 / 买下 / 撤下全程零 RNG 消耗', () => {
    const g = richSeller();
    const rngBefore = g.rngState;
    const posted = applyAction(g, { type: 'POST_TRADE', kind: 'card', targetId: 'angel', price: 800 });
    expect(posted.rngState).toBe(rngBefore);
    const bought = applyAction(asPlayer(posted, 1), { type: 'BUY_TRADE', listingId: posted.trades[0]!.id });
    expect(bought.rngState).toBe(rngBefore);
  });

  it('availableActions 暴露可挂清单与现金', () => {
    const g = richSeller();
    const acts = availableActions(g);
    expect(acts.tradeCash).toBe(g.players[0]!.cash);
    expect(acts.tradableAssets.length).toBeGreaterThan(0);
  });

  it('describeTarget 输出可读文案', () => {
    const g = richSeller();
    const land = g.board.find((c) => c.type === 'property' && c.price)!;
    expect(describeTarget(g, 'land', String(land.id))).toContain(land.name);
    expect(describeTarget(g, 'stock', 'tech')).toContain('科技股');
    const cardText = describeTarget(g, 'card', 'angel-road');
    expect(cardText).toMatch(/^卡片「.+」$/);
    expect(cardText).not.toContain('angel-road'); // 未知名时回落显示 id
    expect(describeTarget(g, 'item', 'teleporter')).toMatch(/^道具「.+」$/);
  });
});