import { useState } from 'react';
import { CARDS } from '@richman/shared';
import { availableActions, type GameState, type PlayerAction } from '@richman/shared';

/** 手牌面板：展示当前玩家卡片并提供使用入口（含目标/股票/骰子参数选择） */
export function HandPanel({ game, onAction }: { game: GameState; onAction: (a: PlayerAction) => void }) {
  const [targetId, setTargetId] = useState('');
  const [stockId, setStockId] = useState('tech');
  const [diceValue, setDiceValue] = useState(6);

  const current = game.players[game.currentPlayerIndex];
  const actions = availableActions(game);
  if (!current || current.cards.length === 0) return null;

  const others = game.players.filter((p) => p.id !== current.id && !p.bankrupt);
  const effectiveTarget = targetId && others.some((p) => p.id === targetId) ? targetId : others[0]?.id ?? '';
  const effectiveStock = game.stockMarket.stocks.some((s) => s.id === stockId) ? stockId : game.stockMarket.stocks[0]?.id ?? '';

  const useCard = (cardId: string) => {
    const card = CARDS[cardId]!;
    onAction({
      type: 'USE_CARD',
      cardId,
      targetPlayerId: card.needsTarget ? effectiveTarget : undefined,
      stockId: card.needsStock ? effectiveStock : undefined,
      diceValue: card.needsDiceValue ? diceValue : undefined,
    });
  };

  return (
    <div className="panel hand-panel">
      <div className="panel-title">手牌（{current.cards.length}/6）</div>
      {current.cards.map((cardId, i) => {
        const card = CARDS[cardId]!;
        const usable = actions.usableCards.includes(cardId);
        const needsTarget = card.needsTarget && others.length > 0;
        return (
          <div key={i} className={`card-row ${usable ? '' : 'disabled'}`}>
            <div className="card-info">
              <div className="card-name">{card.name}</div>
              <div className="card-desc">{card.description}</div>
            </div>
            <button disabled={!usable || needsTarget === false && card.needsTarget} onClick={() => useCard(cardId)}>
              使用
            </button>
          </div>
        );
      })}
      {current.cards.some((id) => CARDS[id]?.needsTarget) && others.length > 0 && (
        <div className="param-row">
          <label>目标</label>
          <select value={effectiveTarget} onChange={(e) => setTargetId(e.target.value)}>
            {others.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      )}
      {current.cards.some((id) => CARDS[id]?.needsStock) && (
        <div className="param-row">
          <label>股票</label>
          <select value={effectiveStock} onChange={(e) => setStockId(e.target.value)}>
            {game.stockMarket.stocks.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
      )}
      {current.cards.some((id) => CARDS[id]?.needsDiceValue) && (
        <div className="param-row">
          <label>骰点</label>
          <select value={diceValue} onChange={(e) => setDiceValue(Number(e.target.value))}>
            {[1, 2, 3, 4, 5, 6].map((v) => (
              <option key={v} value={v}>
                {v} 点
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}
