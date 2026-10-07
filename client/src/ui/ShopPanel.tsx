import { useState } from 'react';
import { availableActions, CARDS, ITEMS, MAX_HAND_CARDS, MAX_ITEM_COUNT, SHOP_CARD_IDS, SHOP_ITEM_IDS } from '@richman/shared';
import type { GameState, PlayerAction } from '@richman/shared';

/** 商店面板：落地商店时进入卡片店，可切往道具店；两者均以【点券】结算（ECON-11） */
export function ShopPanel({ game, onAction, interactive = true }: { game: GameState; onAction: (a: PlayerAction) => void; interactive?: boolean }) {
  const [rack, setRack] = useState<'card' | 'item'>('card');
  const current = game.players[game.currentPlayerIndex];
  const actions = availableActions(game);
  if (!current || !actions.canShop) return null;

  const handFull = current.cards.length >= MAX_HAND_CARDS;

  return (
    <div className="panel shop-panel">
      <div className="panel-title">商店 · 点券 {current.points.toLocaleString('zh-CN')}</div>

      <div className="sidebar-tabs">
        <button className={`small ${rack === 'card' ? 'primary' : ''}`} onClick={() => setRack('card')}>
          卡片店（{current.cards.length}/{MAX_HAND_CARDS}）
        </button>
        <button className={`small ${rack === 'item' ? 'primary' : ''}`} onClick={() => setRack('item')}>
          道具店
        </button>
      </div>

      {rack === 'card' &&
        SHOP_CARD_IDS.map((cardId) => {
          const card = CARDS[cardId]!;
          const affordable = interactive && current.points >= card.cost && !handFull;
          const reason = handFull ? '手牌已满（可先舍弃卡片）' : current.points < card.cost ? '点券不足' : '';
          return (
            <div key={cardId} className={`card-row ${affordable ? '' : 'disabled'}`}>
              <div className="card-info">
                <div className="card-name">
                  {card.name} <span className="price">{card.cost} 点券</span>
                </div>
                <div className="card-desc">{card.description}</div>
              </div>
              <button disabled={!affordable} title={reason} onClick={() => onAction({ type: 'BUY_CARD', cardId })}>
                购买
              </button>
            </div>
          );
        })}

      {rack === 'item' &&
        SHOP_ITEM_IDS.map((itemId) => {
          const item = ITEMS[itemId]!;
          const cost = item.cost ?? 0;
          const owned = current.items[itemId] ?? 0;
          const capped = owned >= MAX_ITEM_COUNT;
          const affordable = interactive && current.points >= cost && !capped;
          const reason = capped ? `已达上限（${MAX_ITEM_COUNT} 个）` : current.points < cost ? '点券不足' : '';
          return (
            <div key={itemId} className={`card-row ${affordable ? '' : 'disabled'}`}>
              <div className="card-info">
                <div className="card-name">
                  {item.name} <span className="price">{cost} 点券</span>
                  {owned > 0 && <span className="owned">已持 ×{owned}</span>}
                </div>
                <div className="card-desc">{item.description}</div>
              </div>
              <button disabled={!affordable} title={reason} onClick={() => onAction({ type: 'BUY_ITEM', itemId })}>
                购买
              </button>
            </div>
          );
        })}
    </div>
  );
}