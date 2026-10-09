import { useState } from 'react';
import { availableActions, type GameState, type PlayerAction } from '@richman/shared';

/**
 * 拍卖面板（ECON-13）：有现金者可参与，价高者得，无现金不得参与。
 * 由 `availableActions(game)` 驱动；热座模式所有人可操作，联机模式只有轮到的竞买人可操作。
 *
 * 「让过」（PASS，下一轮仍可加价）与「弃权」（GIVE UP，退出本场）是两条规则，
 * 原版就是这么分的：合成一个按钮会出现「想让过却被踢出局」。加价下限也一律取门控的
 * `auctionMinBid`，面板自己算就会与引擎的 `出价不得低于 ¥N` 漂移。
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
  const leader = a.highestBidderId ? game.players.find((p) => p.id === a.highestBidderId) : undefined;
  const min = actions.auctionMinBid;
  const interactive = myPlayerId == null || bidderId === myPlayerId;
  const maxBid = bidder?.cash ?? 0;
  const value = Math.floor(amount) || 0;
  const clampValue = Math.min(maxBid, Math.max(min, value));
  const withdrawnNames = a.withdrawn
    .map((id) => game.players.find((p) => p.id === id)?.name ?? id)
    .join('、');

  return (
    <div className="panel auction-panel">
      <div className="panel-title">拍卖会 · {cell?.name ?? `#${a.cellId}`}</div>
      <div className="auction-info">
        <span>起拍价 ¥{a.minBid.toLocaleString('zh-CN')}</span>
        <span>当前价 {leader ? `¥${a.highestBid.toLocaleString('zh-CN')}（${leader.name}）` : '（尚无人出价）'}</span>
        <span>所得归 {seller ? seller.name : '银行'}</span>
      </div>
      <div className="auction-turn">
        轮到 <b>{bidder?.name ?? '—'}</b> 出价（现金 ¥{maxBid.toLocaleString('zh-CN')}，最低 ¥{min.toLocaleString('zh-CN')}）
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
        <button className="ghost" disabled={!interactive || !actions.canAuctionPass} onClick={() => onAction({ type: 'AUCTION_PASS' })}>
          让过
        </button>
        <button className="ghost" disabled={!interactive || !actions.canAuctionGiveUp} onClick={() => onAction({ type: 'AUCTION_GIVE_UP' })}>
          弃权
        </button>
      </div>
      <div className="bank-hint">
        在场竞买人 {a.bidders.length} 位{withdrawnNames ? `（已弃权：${withdrawnNames}）` : ''}；
        除最高价者外全部让过即收锤，价高者得。让过保留下一轮加价的权利，弃权则退出本场。
      </div>
    </div>
  );
}