import { actionRefusal, availableActions, nextBidAmount } from './engine.js';
import { landPrice, landUpgradeCost } from './economy.js';
import { CARDS, SHOP_CARD_IDS } from './cards.js';
import { ITEMS, SHOP_ITEM_IDS } from './items.js';
import { MAX_HAND_CARDS, MAX_ITEM_COUNT } from './board.js';
import { sellableSharesOf } from './companies.js';
import { facilityBuildCost } from './tiles.js';
import { isNegativeGod } from './gods.js';
import type { CompanyState, FacilityType, GameState, Player, PlayerAction } from './types.js';

/** AI 建设偏好：研究所（可研发道具）优先，其次购物中心/旅馆/加油站/公园 */
const BUILD_PREFERENCE: FacilityType[] = ['lab', 'mall', 'hotel', 'gas', 'park'];

/** AI 炒股时保留的存款安全垫（股票只能用存款买入，help[07]） */
const STOCK_RESERVE_DEPOSIT = 5000;

/** AI 现金低于此线就先变现原始股救急（CORP-14） */
const SHARES_CASH_FLOOR = 3000;

/**
 * CORP-14：现金告急时把公司原始股卖回股市。
 *
 * 改口径之后这笔卖出的收入进的是**存款**（面板上的股票交易一律走存款），不是现金 ——
 * 但它照样是救急：租金、罚款那类支出在现金用尽后会自动接着扣存款，所以把持股变成存款
 * 仍然能把「付不出就破产」这条路堵住。真正买地、买道具那种只认现金的开销，得靠收租与事件。
 *
 * 两条自律：
 * - **不动经营权在自己手里的那家** —— 董事长免付费是每天都能兑现的实惠，卖股只换一次现金；
 *   真被反超了才把那家的股份套现，反正特权已经不是自己的了。
 * - 只卖**已解锁**的部分，并且数量交给注册表复核（`actionRefusal`）—— 「面板/bot 算出来的数量
 *   被引擎拒绝」正是本项目反复踩过的 bug 类，门控与引擎必须同源。
 */
/** 一家公司的原始股按**行情**值多少（`corp-*` 已进行情池；缺行时退回面值） */
function marketValue(state: GameState, c: CompanyState): number {
  return state.stockMarket.stocks.find((x) => x.id === `corp-${c.kind}`)?.price ?? c.sharePrice;
}

function liquidateShares(state: GameState, me: Player): PlayerAction | null {
  if (me.cash >= SHARES_CASH_FLOOR) return null;
  const best = state.companies
    .filter((c) => c.chairmanId !== me.id)
    .map((c) => ({ c, sellable: sellableSharesOf(c, me.id) }))
    .filter((x) => x.sellable > 0)
    .sort((a, b) => b.sellable * marketValue(state, b.c) - a.sellable * marketValue(state, a.c))[0];
  if (!best) return null;
  const action: PlayerAction = { type: 'SELL_SHARES', cellId: best.c.cellId, quantity: best.sellable };
  return actionRefusal(state, action) === null ? action : null;
}

/**
 * AI 参与拍卖的必得价：公定地价 ×（1 + 每级建筑 20%）。
 *
 * 拍卖标的常带着房子（倒闭清算保留等级），所以光比地价会低估；但 AI 不打算为了赌气
 * 付到市价以上 —— 原版没有给出任何「理性上限」，这条纯粹是为了让拍卖一定收得了口。
 */
function auctionValueCeiling(state: GameState, cellId: number): number {
  const cell = state.board[cellId];
  if (!cell) return 0;
  const grade = state.players.flatMap((p) => p.properties).find((prop) => prop.cellId === cellId)?.grade ?? 1;
  return Math.floor(landPrice(state, cell) * (1 + 0.2 * Math.max(0, grade - 1)));
}



/**
 * AI 托管决策（纯函数）：
 * - 掷骰阶段：有天使卡且状态负面先解除，否则掷骰
 * - 猜杯阶段：按注入的 rng 随机选杯
 * - 决策阶段：买地/升级保留 ¥2000 安全垫；商店随机购卡；现金告急先按面值卖回原始股（CORP-14）；
 *   银行现金充裕买最便宜股票 10 股；否则结束回合
 * 返回 null 表示当前无可执行动作
 */
export function botDecide(state: GameState, botId: string, rng: () => number): PlayerAction | null {
  if (state.phase === 'lobby' || state.phase === 'game_over') return null;
  const me = state.players.find((p) => p.id === botId);
  if (!me || me.bankrupt) return null;

  // ECON-13：拍卖会由竞买人轮流主拍，不受 currentPlayerIndex 约束
  if (state.phase === 'awaiting_auction') {
    const a = state.auction;
    if (!a || a.bidders[a.turnIndex] !== botId) return null;
    const min = nextBidAmount(a);
    // 已经是最高出价者：等着别人加价，自己不动钱也不弃权（弃权对领先者无意义）
    if (a.highestBidderId === botId) return { type: 'AUCTION_PASS' };
    // 只在「这块地连同上面的房子值多少」以内跟价，并保留 ¥2000 安全垫。
    // 旧实现没有价值上限：只要现金够就永远跟最低加价，两个 bot 对峙时拍卖收不了口
    // （实测 200 回合窗口烧完 2400 个动作仍停在 awaiting_auction）。
    if (min <= auctionValueCeiling(state, a.cellId) && me.cash >= min + 2000) {
      return { type: 'AUCTION_BID', amount: min };
    }
    // 出不起、或已超过心理价位 ⇒ 直接弃权退场，而不是每轮都回来让过一次：
    // PASS 会保留资格，于是这场拍卖每次轮到它都要空转一次「放弃」。
    return { type: 'AUCTION_GIVE_UP' };
  }

  if (state.players[state.currentPlayerIndex]?.id !== botId) return null;

  if (state.phase === 'awaiting_roll') {
    // 身上有不祥神明（穷神/衰神/死神）时优先用送神卡送走
    if (me.cards.includes('send-god') && isNegativeGod(me.god?.godId)) {
      return { type: 'USE_CARD', cardId: 'send-god' };
    }
    return { type: 'ROLL_DICE' };
  }

  if (state.phase === 'awaiting_pick') {
    // 记忆翻牌是 8 张牌（下标 0-7），且已翻开 / 已配对的不能再翻。
    // 旧实现一律 `Math.floor(rng()*3)`，在这局里会反复撞上同一张已翻开的牌：
    // 引擎每次都以「这张牌已经翻开」拒绝，而兜底逻辑只在 awaiting_action 下退化为
    // END_TURN ⇒ 整局卡在 awaiting_pick 死循环（实测一局刷出两千多个被拒动作）。
    const mg = state.minigame;
    if (mg?.kind === 'memory') {
      const open = mg.matched.map((matched, i) => (matched || mg.revealed.includes(i) ? -1 : i)).filter((i) => i >= 0);
      if (open.length === 0) return null;
      return { type: 'MINIGAME_PICK', hole: open[Math.floor(rng() * open.length)]! };
    }
    return { type: 'MINIGAME_PICK', hole: Math.floor(rng() * 3) };
  }

  // awaiting_action
  const acts = availableActions(state);
  const cell = state.board[me.position]!;

  if (me.cards.includes('send-god') && isNegativeGod(me.god?.godId)) {
    return { type: 'USE_CARD', cardId: 'send-god' };
  }

  if (acts.canBuy && cell.price !== undefined && me.cash >= landPrice(state, cell) + 2000) {
    return { type: 'BUY_LAND' };
  }

  if (acts.canUpgrade && cell.price !== undefined) {
    const prop = me.properties.find((q) => q.cellId === cell.id);
    if (prop) {
      const cost = landUpgradeCost(state, cell, prop.grade);
      if (me.cash >= cost + 2000) return { type: 'UPGRADE_LAND' };
    }
  }

  // 商业用地建设（EST-07）：按偏好选择，保留 ¥2000 安全垫
  if (acts.buildableFacilities.length > 0 && cell.price !== undefined) {
    for (const f of BUILD_PREFERENCE) {
      if (!acts.buildableFacilities.includes(f)) continue;
      if (me.cash >= facilityBuildCost(state, cell, f) + 2000) return { type: 'BUILD_FACILITY', facility: f };
    }
  }

  // 研究所研发（EST-09/10）：优先开发最高阶项目
  if (acts.researchableItems.length > 0 && !me.research) {
    return { type: 'START_RESEARCH', itemId: acts.researchableItems[acts.researchableItems.length - 1]! };
  }

  if (acts.canShop) {
    // 卡片：点券结算，保留 100 点安全垫
    if (me.cards.length < MAX_HAND_CARDS) {
      const affordable = SHOP_CARD_IDS.filter(
        (id) => !me.cards.includes(id) && me.points >= (CARDS[id]?.cost ?? Infinity) + 100,
      );
      if (affordable.length > 0) {
        const pick = affordable[Math.floor(rng() * affordable.length)]!;
        return { type: 'BUY_CARD', cardId: pick };
      }
    }
    // 道具：点券结算，每种上限 9
    const affordableItems = SHOP_ITEM_IDS.filter(
      (id) => (me.items[id] ?? 0) < MAX_ITEM_COUNT && me.points >= (ITEMS[id]?.cost ?? Infinity) + 100,
    );
    if (affordableItems.length > 0) {
      const pick = affordableItems[Math.floor(rng() * affordableItems.length)]!;
      return { type: 'BUY_ITEM', itemId: pick };
    }
  }

  // CORP-14：现金告急 ⇒ 先把原始股按市价卖回，换成「能自动扣款」的那笔存款，再谈投资
  const liquidate = liquidateShares(state, me);
  if (liquidate) return liquidate;

  // 股票只能用**存款**买入（help[07]）。行情池现在是 17 支（6 支虚拟 + 11 家公司挂进来的
  // `corp-*`，CORP-14），旧实现那种按 `me.cash` 推测买得起的写法每回都会撞上引擎的拒绝
  // ——买哪只、买几只一律问注册表。
  if (acts.canTradeStock) {
    const sorted = [...state.stockMarket.stocks].sort((a, b) => a.price - b.price);
    for (const stock of sorted) {
      for (const quantity of [10, 5, 1]) {
        if (me.deposit < stock.price * quantity + STOCK_RESERVE_DEPOSIT) continue;
        if (actionRefusal(state, { type: 'BUY_STOCK', stockId: stock.id, quantity }) !== null) continue;
        return { type: 'BUY_STOCK', stockId: stock.id, quantity };
      }
    }
  }

  // ECON-08：乐透行自选号码投注（保留 ¥2000 安全垫）
  if (acts.canBuyLottery && me.cash >= acts.lotteryTicketCost + 2000) {
    return { type: 'BUY_LOTTERY_TICKET', number: Math.floor(rng() * 100) };
  }

  // CORP-01：现金充裕时认购所在公司股份（保留 ¥2000 安全垫）
  if (acts.canBuyShares && acts.shareQuantityLimit >= 10 && me.cash >= acts.sharePrice * 10 + 2000) {
    return { type: 'BUY_SHARES', cellId: cell.id, quantity: 10 };
  }

  if (acts.canEnd) return { type: 'END_TURN' };
  return null;
}




