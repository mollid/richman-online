import { availableActions, upgradeCost } from './engine.js';
import { CARDS, SHOP_CARD_IDS } from './cards.js';
import type { GameState, PlayerAction } from './types.js';



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
  if (state.players[state.currentPlayerIndex]?.id !== botId) return null;

  if (state.phase === 'awaiting_roll') {
    if (me.cards.includes('angel') && (me.skipTurns > 0 || me.god?.godId === 'poverty')) {
      return { type: 'USE_CARD', cardId: 'angel' };
    }
    return { type: 'ROLL_DICE' };
  }

  if (state.phase === 'awaiting_pick') {
    return { type: 'MINIGAME_PICK', hole: Math.floor(rng() * 3) };
  }

  // awaiting_action
  const acts = availableActions(state);
  const cell = state.board[me.position]!;

  if (me.cards.includes('angel') && me.god?.godId === 'poverty') {
    return { type: 'USE_CARD', cardId: 'angel' };
  }

  if (acts.canBuy && cell.price !== undefined && me.cash >= cell.price + 2000) {
    return { type: 'BUY_LAND' };
  }

  if (acts.canUpgrade && cell.price !== undefined) {
    const prop = me.properties.find((q) => q.cellId === cell.id);
    if (prop) {
      const cost = upgradeCost(cell.price, prop.grade);
      if (me.cash >= cost + 2000) return { type: 'UPGRADE_LAND' };
    }
  }

  if (acts.canShop && me.cards.length < 6) {
    const affordable = SHOP_CARD_IDS.filter(
      (id) => !me.cards.includes(id) && me.cash >= (CARDS[id]?.cost ?? Infinity) + 2500,
    );
    if (affordable.length > 0) {
      const pick = affordable[Math.floor(rng() * affordable.length)]!;
      return { type: 'BUY_CARD', cardId: pick };
    }
  }

  if (acts.canTradeStock && me.cash >= 8000) {
    const cheapest = [...state.stockMarket.stocks].sort((a, b) => a.price - b.price)[0];
    if (cheapest) return { type: 'BUY_STOCK', stockId: cheapest.id, quantity: 10 };
  }

  if (acts.canEnd) return { type: 'END_TURN' };
  return null;
}




