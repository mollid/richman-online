import { describe, expect, it } from 'vitest';
import { applyAction, availableActions, createGame, totalAssets } from '../src/index.js';
import type { GameState, PlayerDef } from '../src/index.js';

/**
 * 波 6 拍卖器测试（ECON-13 / CARD-08 / EVT-03）：
 * - 触发源：拍卖卡（所得归使用者，使用者本人不参与竞价）；
 * - 竞买人筛选：非破产且持有现金者，无现金不得参与；
 * - 出价轮询：轮流出价，连续放弃达竞买人数即收锤，价高者得；
 * - 流拍与无人竞买资格的处理；
 * - 倒闭清算入队 → `advanceTurn` 先开拍、收锤后再继续推进回合。
 */

const PLAYERS: PlayerDef[] = [
  { id: 'p1', name: '阿福', color: 0xef5350 },
  { id: 'p2', name: '小美', color: 0x42a5f5 },
  { id: 'p3', name: '老王', color: 0x66bb6a },
];

const MONDAY = { year: 2026, month: 1, day: 5 } as const;

function newGame(seed = 42): GameState {
  const g = applyAction(createGame(PLAYERS, seed, { startDate: { ...MONDAY } }), { type: 'START_GAME' });
  for (const p of g.players) p.diceCount = 2;
  return g;
}

/** 冻结物价指数为 1（起拍价等 scaled 数值可预测） */
function pinIndexOne(state: GameState): GameState {
  let total = 0;
  for (const p of state.players) {
    if (!p.bankrupt) total += totalAssets(state, p);
  }
  state.initialCashPerPlayer = Math.max(1, total);
  state.initialPlayerCount = 1;
  return state;
}

/** p1 手持拍卖卡、站在决策阶段，可对指定土地开拍 */
function withAuctionCard(state: GameState): GameState {
  const g = structuredClone(state);
  g.players[0]!.cards = ['auction'];
  g.phase = 'awaiting_action';
  g.bankAccess = null;
  return g;
}

describe('拍卖卡开拍（CARD-08 / ECON-13）', () => {
  it('拍到土地：卖家不参与竞价、价高者得、地权连同等级一并交割', () => {
    const base = newGame(2101);
    base.players[1]!.properties = [{ cellId: 1, grade: 2 }]; // p2 持有桃园路（价 300）
    const g = withAuctionCard(pinIndexOne(base));

    const opened = applyAction(g, { type: 'USE_CARD', cardId: 'auction', cellId: 1 });
    expect(opened.phase).toBe('awaiting_auction');
    expect(opened.players[0]!.cards).toEqual([]); // 拍卖卡已消耗
    const a = opened.auction!;
    expect(a.cellId).toBe(1);
    expect(a.sellerId).toBe('p1');
    expect(a.trigger).toBe('card');
    expect(a.bidders).toEqual(['p2', 'p3']); // 卖家本人不参与
    expect(a.minBid).toBe(150); // 地价 300 的半价
    expect(a.turnIndex).toBe(0);
    expect(availableActions(opened).auction).not.toBeNull();

    // p2 先放弃 → 轮到 p3
    let s = applyAction(opened, { type: 'AUCTION_PASS' });
    expect(s.auction!.turnIndex).toBe(1);
    expect(s.auction!.passes).toBe(1);

    // 出价校验：低于起拍价、超过自身现金、非整数均被拒
    expect(() => applyAction(s, { type: 'AUCTION_BID', amount: 100 })).toThrow('出价不得低于 ¥150');
    expect(() => applyAction(s, { type: 'AUCTION_BID', amount: 150.5 })).toThrow('出价不得低于 ¥150');
    expect(() => applyAction(s, { type: 'AUCTION_BID', amount: 999999 })).toThrow('出价不能超过自己的现金');

    // p3 出价 200 → 轮次回到 p2，放弃计数清零
    s = applyAction(s, { type: 'AUCTION_BID', amount: 200 });
    expect(s.auction!.highestBid).toBe(200);
    expect(s.auction!.highestBidderId).toBe('p3');
    expect(s.auction!.passes).toBe(0);
    expect(s.auction!.turnIndex).toBe(0);

    // 两位竞买人相继放弃 → 收锤
    s = applyAction(s, { type: 'AUCTION_PASS' }); // p2
    expect(s.phase).toBe('awaiting_auction');
    s = applyAction(s, { type: 'AUCTION_PASS' }); // p3 → 放弃数达竞买人数
    expect(s.auction).toBeNull();
    expect(s.phase).toBe('awaiting_action'); // 拍卖卡触发源收锤后回到决策阶段

    // 成交：p3 付款、卖家（用卡者 p1）收款、地权转移且保留等级
    expect(s.players[2]!.cash).toBe(15000 - 200);
    expect(s.players[0]!.cash).toBe(15000 + 200);
    expect(s.players[2]!.properties).toEqual([{ cellId: 1, grade: 2 }]);
    expect(s.players[1]!.properties).toEqual([]);
    expect(s.log.some((e) => e.text.includes('成交！'))).toBe(true);
  });

  it('无人具备竞买资格（其他玩家无现金）时流拍，不进入拍卖阶段', () => {
    const base = newGame(2102);
    base.players[1]!.properties = [{ cellId: 1, grade: 1 }];
    base.players[1]!.cash = 0;
    base.players[2]!.cash = 0;
    const g = withAuctionCard(pinIndexOne(base));

    const s = applyAction(g, { type: 'USE_CARD', cardId: 'auction', cellId: 1 });
    expect(s.auction).toBeNull();
    expect(s.phase).toBe('awaiting_action');
    expect(s.players[0]!.cards).toEqual([]); // 卡片仍被消耗
    expect(s.log.some((e) => e.text.includes('流拍'))).toBe(true);
    expect(s.players[1]!.properties).toEqual([{ cellId: 1, grade: 1 }]); // 地权不变
  });

  it('拍卖卡目标必须是有主的土地，公司企业不可拍卖', () => {
    const g = withAuctionCard(pinIndexOne(newGame(2103)));
    // 40 号世贸天阶无主
    expect(() => applyAction(g, { type: 'USE_CARD', cardId: 'auction', cellId: 40 })).toThrow('该土地无主，无法拍卖');
    // 43 号电脑公司属公司企业格
    expect(() => applyAction(g, { type: 'USE_CARD', cardId: 'auction', cellId: 43 })).toThrow('目标必须是土地');
  });

  it('全员放弃时流拍，地权仍归原主', () => {
    const base = newGame(2104);
    base.players[1]!.properties = [{ cellId: 1, grade: 1 }];
    const g = withAuctionCard(pinIndexOne(base));

    let s = applyAction(g, { type: 'USE_CARD', cardId: 'auction', cellId: 1 });
    expect(s.auction!.bidders).toEqual(['p2', 'p3']);
    s = applyAction(s, { type: 'AUCTION_PASS' });
    s = applyAction(s, { type: 'AUCTION_PASS' });
    expect(s.auction).toBeNull();
    expect(s.players[1]!.properties).toEqual([{ cellId: 1, grade: 1 }]);
    expect(s.log.some((e) => e.text.includes('流拍，无人出价'))).toBe(true);
  });

  it('非拍卖阶段不能出价或放弃', () => {
    const g = pinIndexOne(newGame(2105));
    g.phase = 'awaiting_action';
    expect(() => applyAction(g, { type: 'AUCTION_BID', amount: 100 })).toThrow('当前没有进行中的拍卖');
    expect(() => applyAction(g, { type: 'AUCTION_PASS' })).toThrow('当前没有进行中的拍卖');
  });
});

describe('倒闭清算与待拍队列（ECON-13 / EVT-03）', () => {
  it('待拍标的使回合暂停：先开拍，收锤后继续推进回合', () => {
    const base = newGame(2106);
    base.players[1]!.properties = [{ cellId: 1, grade: 1 }]; // 标的：原倒闭者名下土地
    base.auctionQueue = [{ cellId: 1, sellerId: null, trigger: 'bankrupt' }];
    base.currentPlayerIndex = 0; // 不绕回（避免带动日切与随机新闻，断言可精确）
    base.phase = 'awaiting_action';

    const opened = applyAction(base, { type: 'END_TURN' });
    expect(opened.phase).toBe('awaiting_auction');
    expect(opened.currentPlayerIndex).toBe(0); // 回合尚未推进，让位于拍卖
    expect(opened.auction!.trigger).toBe('bankrupt');
    expect(opened.auction!.sellerId).toBeNull(); // 银行拍卖：所得不入玩家口袋
    expect(opened.auction!.bidders).toEqual(['p1', 'p2', 'p3']); // 无卖家可排除
    expect(opened.auctionQueue).toEqual([]);

    // 全员放弃 → 收锤流拍 → 继续推进回合（交给下一位玩家掷骰）
    let s = opened;
    for (let i = 0; i < 3; i++) s = applyAction(s, { type: 'AUCTION_PASS' });
    expect(s.auction).toBeNull();
    expect(s.phase).toBe('awaiting_roll');
    expect(s.currentPlayerIndex).toBe(1);
    expect(s.players[1]!.properties).toEqual([{ cellId: 1, grade: 1 }]); // 流拍不转移地权
  });

  it('拍卖中成交后，地权与款项随收锤一并交割（银行拍卖所得归银行）', () => {
    const base = newGame(2107);
    base.players[1]!.properties = [{ cellId: 1, grade: 3 }];
    base.auctionQueue = [{ cellId: 1, sellerId: null, trigger: 'bankrupt' }];
    base.currentPlayerIndex = 0;
    base.phase = 'awaiting_action';

    let s = applyAction(base, { type: 'END_TURN' });
    const minBid = s.auction!.minBid;
    s = applyAction(s, { type: 'AUCTION_BID', amount: minBid }); // p1 以起拍价应价
    expect(s.auction!.highestBidderId).toBe('p1');
    for (let i = 0; i < 3; i++) {
      if (s.auction) s = applyAction(s, { type: 'AUCTION_PASS' });
    }
    expect(s.auction).toBeNull();
    expect(s.players[0]!.properties).toEqual([{ cellId: 1, grade: 3 }]); // 保留原等级
    expect(s.players[0]!.cash).toBe(15000 - minBid);
    expect(s.players[1]!.properties).toEqual([]);
    expect(s.phase).toBe('awaiting_roll');
  });
});