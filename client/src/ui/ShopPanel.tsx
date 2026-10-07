import { CARDS, SHOP_CARD_IDS } from '@richman/shared';
import { availableActions, type GameState, type PlayerAction } from '@richman/shared';

/** 商店面板：落地商店时可购买卡片 */
export function ShopPanel({ game, onAction }: { game: GameState; onAction: (a: PlayerAction) => void }) {
  const current = game.players[game.currentPlayerIndex];
  const actions = availableActions(game);
  if (!current || !actions.canShop) return null;

  return (
    <div className="panel shop-panel">
      <div className="panel-title">商店</div>
      {SHOP_CARD_IDS.map((cardId) => {
        const card = CARDS[cardId]!;
        const affordable = current.cash >= card.cost && current.cards.length < 6;
        return (
          <div key={cardId} className="card-row">
            <div className="card-info">
              <div className="card-name">
                {card.name} <span className="price">¥{card.cost}</span>
              </div>
              <div className="card-desc">{card.description}</div>
            </div>
            <button disabled={!affordable} onClick={() => onAction({ type: 'BUY_CARD', cardId })}>
              购买
            </button>
          </div>
        );
      })}
    </div>
  );
}
