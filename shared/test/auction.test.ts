import { describe, expect, it } from 'vitest';
import {
  applyAction,
  auctionBidStep,
  availableActions,
  botDecide,
  createGame,
  nextBidAmount,
} from '../src/index.js';
import type { GameState, PlayerDef } from '../src/index.js';
import { pinIndexOne, standAt } from './helpers/state.js';

/**
 * 波 6 拍卖器测试（ECON-13 / CARD-08 / EVT-03）+ W3 收口规则：
 * - 触发源：拍卖卡（所得归使用者，使用者本人不参与竞价）；
 * - 竞买人筛选：非破产且持有现金者，无现金不得参与；
 * - 出价轮询：轮流出价，除最高价者外全员让过即收锤，价高者得；
 * - 加价幅度与 PASS / GIVE UP 两条语义（W3，见「拍卖收口」describe）；
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

    // p2 先让过一轮 → 轮到 p3
    let s = applyAction(opened, { type: 'AUCTION_PASS' });
    expect(s.auction!.turnIndex).toBe(1);
    expect(s.auction!.passedSinceBid).toEqual(['p2']);

    // 出价校验：低于起拍价、超过自身现金、非整数均被拒
    expect(() => applyAction(s, { type: 'AUCTION_BID', amount: 100 })).toThrow('出价不得低于 ¥150');
    expect(() => applyAction(s, { type: 'AUCTION_BID', amount: 150.5 })).toThrow('出价不得低于 ¥150');
    expect(() => applyAction(s, { type: 'AUCTION_BID', amount: 999999 })).toThrow('出价不能超过自己的现金');

    // p3 出价 200 → 轮次回到 p2，让过记录清空
    s = applyAction(s, { type: 'AUCTION_BID', amount: 200 });
    expect(s.auction!.highestBid).toBe(200);
    expect(s.auction!.highestBidderId).toBe('p3');
    expect(s.auction!.passedSinceBid).toEqual([]);
    expect(s.auction!.turnIndex).toBe(0);

    // 「其他人都放弃后由最后出价者得标」：p2 一让过就该收锤，不必再等 p3 自己也放弃一次
    s = applyAction(s, { type: 'AUCTION_PASS' }); // p2
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

    const opened = applyAction(base, { type: 'FINISH_LANDING' });
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

    let s = applyAction(base, { type: 'FINISH_LANDING' });
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

/**
 * 拍卖收口（W3）。
 *
 * 要根治的 bug 类：这场拍卖**收不了口**。实测 seed=77 / 424242 在 200 回合窗口里烧完
 * 2400 个动作仍停在 `awaiting_auction`。三个成因分别是加价幅度只有 1 元、
 * PASS 与 GIVE UP 混成一条规则、以及收锤要连最高价者本人也放弃一次。
 */

/**
 * 银行拍卖（无卖家）：三位玩家都在场，轮询比拍卖卡更长，好演示让过 / 弃权。
 * 标的挂在 p3 名下，免得出现「自己的地被自己拍回去」这种看不出转移发生了的局面。
 */
function openBankAuction(seed: number, grade: 1 | 2 | 3 | 4 | 5 = 1): GameState {
  const base = newGame(seed);
  base.players[2]!.properties = [{ cellId: 1, grade }]; // 桃园路，标价 300 ⇒ 起拍价 150
  base.auctionQueue = [{ cellId: 1, sellerId: null, trigger: 'bankrupt' }];
  base.currentPlayerIndex = 0;
  base.phase = 'awaiting_action';
  return applyAction(pinIndexOne(base), { type: 'FINISH_LANDING' });
}

describe('拍卖收口（W3：加价幅度 / PASS 与 GIVE UP / 收锤）', () => {
  it('最小加价 = ¥50 与当前价 10% 取大，再向上取整到 ¥10', () => {
    expect(auctionBidStep(0)).toBe(50);
    expect(auctionBidStep(150)).toBe(50); // 10% = 15，不到底线
    expect(auctionBidStep(500)).toBe(50); // 10% 正好等于底线
    expect(auctionBidStep(600)).toBe(60);
    expect(auctionBidStep(1234)).toBe(130); // 123.4 ⇒ 向上取整到 130
  });

  it('只想加 1 元不再被接受：最低出价随当前价抬升', () => {
    let s = openBankAuction(3101);
    expect(s.auction!.minBid).toBe(150);
    expect(nextBidAmount(s.auction!)).toBe(150); // 无人出价 ⇒ 起拍价
    s = applyAction(s, { type: 'AUCTION_BID', amount: 150 }); // p1 应价，轮到 p2
    expect(nextBidAmount(s.auction!)).toBe(200);
    expect(() => applyAction(s, { type: 'AUCTION_BID', amount: 151 })).toThrow('出价不得低于 ¥200');
    expect(() => applyAction(s, { type: 'AUCTION_BID', amount: 200 })).not.toThrow();
    s = applyAction(s, { type: 'AUCTION_BID', amount: 200 }); // p2 加价，轮到 p3
    expect(nextBidAmount(s.auction!)).toBe(250);
    expect(() => applyAction(s, { type: 'AUCTION_BID', amount: 201 })).toThrow('出价不得低于 ¥250');
    s = applyAction(s, { type: 'AUCTION_BID', amount: 250 });
    expect(s.auction!.highestBid).toBe(250);
  });

  it('PASS 只是本轮让过：清空让过记录后，同一个人下一轮照样能加价', () => {
    let s = openBankAuction(3102);
    s = applyAction(s, { type: 'AUCTION_BID', amount: 150 }); // p1 出价
    s = applyAction(s, { type: 'AUCTION_PASS' }); // p2 让过（仍留在场）
    expect(s.auction!.passedSinceBid).toEqual(['p2']);
    s = applyAction(s, { type: 'AUCTION_BID', amount: 200 }); // p3 加价 ⇒ 重新数一圈
    expect(s.auction!.passedSinceBid).toEqual([]);
    s = applyAction(s, { type: 'AUCTION_PASS' }); // p1 让过
    expect(s.phase).toBe('awaiting_auction');
    // p2 上一轮已经让过，这一轮仍然可以出手 —— 这正是 PASS 与 GIVE UP 的分别
    s = applyAction(s, { type: 'AUCTION_BID', amount: 250 });
    expect(s.auction!.highestBidderId).toBe('p2');
    s = applyAction(s, { type: 'AUCTION_PASS' }); // p3
    expect(s.phase).toBe('awaiting_auction'); // 还差 p1
    s = applyAction(s, { type: 'AUCTION_PASS' }); // p1 ⇒ 除最高价者外全体让过
    expect(s.auction).toBeNull();
    expect(s.players[1]!.properties).toEqual([{ cellId: 1, grade: 1 }]); // p2 得标
    expect(s.players[2]!.properties).toEqual([]);
  });

  it('收锤不必等最高价者本人放弃：其他竞买人一让过就成交', () => {
    const s = applyAction(applyAction(openBankAuction(3103), { type: 'AUCTION_BID', amount: 150 }), {
      type: 'AUCTION_PASS',
    }); // p2 让过
    expect(s.phase).toBe('awaiting_auction'); // 还剩 p3
    const done = applyAction(s, { type: 'AUCTION_PASS' }); // p3 让过 ⇒ 当场收锤
    expect(done.auction).toBeNull();
    expect(done.players[0]!.properties).toEqual([{ cellId: 1, grade: 1 }]); // p1 得标
    expect(done.players[0]!.cash).toBe(15000 - 150);
  });

  it('GIVE UP 是退出本场：移出竞买人，且他后面的人顶到同一个轮次', () => {
    let s = openBankAuction(3104);
    s = applyAction(s, { type: 'AUCTION_BID', amount: 150 }); // p1 出价，轮到 p2
    s = applyAction(s, { type: 'AUCTION_GIVE_UP' }); // p2 弃权
    expect(s.auction!.bidders).toEqual(['p1', 'p3']);
    expect(s.auction!.withdrawn).toEqual(['p2']);
    expect(s.auction!.turnIndex).toBe(1); // p3 顶上来，而不是又回到 p1
    s = applyAction(s, { type: 'AUCTION_GIVE_UP' }); // p3 弃权 ⇒ 场上只剩最高价者
    expect(s.auction).toBeNull();
    expect(s.players[0]!.properties).toEqual([{ cellId: 1, grade: 1 }]);
  });

  it('其余人全部弃权后，留下的人一加价就当场成交，不必再空转一轮', () => {
    let s = openBankAuction(3105);
    s = applyAction(s, { type: 'AUCTION_GIVE_UP' }); // p1 弃权（尚无人出价）
    s = applyAction(s, { type: 'AUCTION_GIVE_UP' }); // p2 弃权
    expect(s.auction!.bidders).toEqual(['p3']);
    expect(s.phase).toBe('awaiting_auction');
    s = applyAction(s, { type: 'AUCTION_BID', amount: 150 }); // p3 成为唯一且最高出价者
    expect(s.auction).toBeNull();
    expect(s.players[2]!.properties).toEqual([{ cellId: 1, grade: 1 }]); // 地权回到原主手里
  });

  it('全体弃权而无人出价 ⇒ 流拍，地权不变', () => {
    let s = openBankAuction(3106);
    for (let i = 0; i < 3 && s.auction; i++) s = applyAction(s, { type: 'AUCTION_GIVE_UP' });
    expect(s.auction).toBeNull();
    expect(s.players[2]!.properties).toEqual([{ cellId: 1, grade: 1 }]);
    expect(s.log.some((e) => e.text.includes('流拍，无人出价'))).toBe(true);
  });

  it('最高价者不能弃权（守住「得标的人一定还在场」这条不变式）', () => {
    const s = openBankAuction(3107);
    // 直接造一个「领先者被轮到」的局面：W3 之前的老存档就是这种形状（收锤要求他也放弃一次）
    s.auction!.highestBid = 150;
    s.auction!.highestBidderId = 'p1';
    expect(availableActions(s).canAuctionPass).toBe(true);
    expect(availableActions(s).canAuctionGiveUp).toBe(false);
    expect(() => applyAction(s, { type: 'AUCTION_GIVE_UP' })).toThrow('已是最高出价者，不能弃权');
  });

  it('门控报出的最低出价与引擎校验同一个数', () => {
    const s = openBankAuction(3108);
    expect(availableActions(s).auctionMinBid).toBe(nextBidAmount(s.auction!));
    const bid = applyAction(s, { type: 'AUCTION_BID', amount: s.auction!.minBid });
    expect(availableActions(bid).auctionMinBid).toBe(nextBidAmount(bid.auction!));
    expect(availableActions(bid).auctionMinBid).toBe(200);
  });

  it('bot 对跑：拍卖在少量动作内收锤（W3 死锁的回归）', () => {
    for (const seed of [77, 424242, 1007]) {
      let s = openBankAuction(seed);
      let acts = 0;
      // 每个 seed 都跑到收锤为止；上限 200 是「还收不了口」的判据，不是预期用量
      while (s.auction && acts < 200) {
        const bidderId = s.auction.bidders[s.auction.turnIndex];
        if (!bidderId) break;
        const action = botDecide(s, bidderId, () => 0.5);
        if (!action) break;
        s = applyAction(s, action);
        acts += 1;
      }
      expect(s.auction, `seed=${seed} 的拍卖没收口`).toBeNull();
      // 地价 300 的标的：AI 的必得价封顶在 300，加价又是乘性的，实际只用几个动作
      expect(acts, `seed=${seed} 的拍卖轮询过长（${acts} 个动作）`).toBeLessThan(30);
    }
  });
});

describe('落格决策窗与拍卖的交接（R4）', () => {
  it('拍卖打断落格窗：收锤后回到同一扇窗，本格那件事照样能办', () => {
    const base = newGame(2109);
    base.players[0]!.properties = [{ cellId: 1, grade: 2 }];
    const g = standAt(pinIndexOne(base), 0, 1);
    g.players[0]!.cards = ['auction'];
    expect(g.landing).toEqual({ cellId: 1, venue: null, turn: g.turn });

    const opened = applyAction(g, { type: 'USE_CARD', cardId: 'auction', cellId: 1 });
    expect(opened.phase).toBe('awaiting_auction');
    // 凭据必须跨 beginAuction / settleAuction 留着：否则窗口被拍卖吃掉，
    // 收锤之后这一格的决策就被静默跳过（玩家根本不知道自己漏了一手）
    expect(opened.landing).toEqual(g.landing);

    let s = opened;
    for (let i = 0; i < 12 && s.phase === 'awaiting_auction'; i++) s = applyAction(s, { type: 'AUCTION_PASS' });
    expect(s.phase).toBe('awaiting_action');
    expect(s.landing?.cellId).toBe(1);

    const up = applyAction(s, { type: 'UPGRADE_LAND' });
    expect(up.players[0]!.properties[0]!.grade).toBe(3);
    expect(up.phase).toBe('awaiting_roll'); // 回到窗口里办完 ⇒ 终结动作照常推进
  });
});
