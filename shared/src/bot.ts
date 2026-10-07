import { availableActions } from './engine.js';
import { landPrice, landUpgradeCost } from './economy.js';
import { CARDS, SHOP_CARD_IDS } from './cards.js';
import { ITEMS, SHOP_ITEM_IDS } from './items.js';
import { MAX_HAND_CARDS, MAX_ITEM_COUNT } from './board.js';
import { facilityBuildCost } from './tiles.js';
import { isNegativeGod } from './gods.js';
import type { FacilityType, GameState, PlayerAction } from './types.js';

/** AI 建设偏好：研究所（可研发道具）优先，其次购物中心/旅馆/加油站/公园 */
const BUILD_PREFERENCE: FacilityType[] = ['lab', 'mall', 'hotel', 'gas', 'park'];



/**
 * AI 托管决策（纯函数）：
 * - 掷骰阶段：有天使卡且状态负面先解除，否则掷骰
 * - 猜杯阶段：按注入的 rng 随机选杯
 * - 决策阶段：买地/升级保留 ¥2000 安全垫；商店随机购卡；银行现金充裕买最便宜股票 10 股；否则结束回合
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
    const min = a.highestBidderId ? a.highestBid + 1 : a.minBid;
    // 保守加价：保留 ¥2000 安全垫，且不与自己抬价
    if (a.highestBidderId !== botId && me.cash >= min + 2000) {
      return { type: 'AUCTION_BID', amount: min };
    }
    return { type: 'AUCTION_PASS' };
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

  if (acts.canTradeStock && me.cash >= 8000) {
    const cheapest = [...state.stockMarket.stocks].sort((a, b) => a.price - b.price)[0];
    if (cheapest) return { type: 'BUY_STOCK', stockId: cheapest.id, quantity: 10 };
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




