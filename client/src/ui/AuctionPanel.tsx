import { useState } from 'react';
import { availableActions, type GameState, type PlayerAction } from '@richman/shared';

/**
 * 拍卖面板（ECON-13）：有现金者可参与，价高者得，无现金不得参与。
 * 由 `availableActions(game).auction` 驱动；热座模式所有人可操作，联机模式只有轮到的竞买人可操作。
 */
export function AuctionPanel({
  game,
  onAction,
  myPlayerId = null,
}: {
  game: GameState;
  onAction: (a: PlayerAction) => void;
  myPlayerId?: string | null;
}) {
  const actions = availableActions(game);
  const a = actions.auction;
  const [amount, setAmount] = useState(0);

  if (!a) return null;

  const cell = game.board[a.cellId];
  const bidderId = a.bidders[a.turnIndex] ?? null;
  const bidder = game.players.find((p) => p.id === bidderId);
  const seller = a.sellerId ? game.players.find((p) => p.id === a.sellerId) : undefined;
  const min = a.highestBidderId ? a.highestBid + 1 : a.minBid;
  const interactive = myPlayerId == null || bidderId === myPlayerId;
  const maxBid = bidder?.cash ?? 0;
  const value = Math.floor(amount) || 0;
  const clampValue = Math.min(maxBid, Math.max(min, value));

  return (
    <div className="panel auction-panel">
      <div className="panel-title">拍卖会 · {cell?.name ?? `#${a.cellId}`}</div>
      <div className="auction-info">
        <span>起拍价 ¥{a.minBid.toLocaleString('zh-CN')}</span>
        <span>当前价 {a.highestBidderId ? `¥${a.highestBid.toLocaleString('zh-CN')}` : '（尚无人出价）'}</span>
        <span>所得归 {seller ? seller.name : '银行'}</span>
      </div>
      <div className="auction-turn">
        轮到 <b>{bidder?.name ?? '—'}</b> 出价（现金 ¥{maxBid.toLocaleString('zh-CN')}）
      </div>
      <div className="bank-input-row">
        <input
          type="number"
          min={min}
          max={maxBid}
          value={clampValue}
          onChange={(e) => setAmount(Math.floor(Number(e.target.value) || 0))}
        />
        <button className="mini" onClick={() => setAmount(min)}>
          最低 ¥{min}
        </button>
      </div>
      <div className="bank-action-row">
        <button disabled={!interactive || maxBid < min} onClick={() => onAction({ type: 'AUCTION_BID', amount: clampValue })}>
          出价 ¥{clampValue.toLocaleString('zh-CN')}
        </button>
        <button className="ghost" disabled={!interactive} onClick={() => onAction({ type: 'AUCTION_PASS' })}>
          放弃
        </button>
      </div>
      <div className="bank-hint">竞买人 {a.bidders.length} 位；一轮内全部放弃即收锤，价高者得。</div>
    </div>
  );
}