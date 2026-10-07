import { useState } from 'react';
import {
  availableActions,
  describeTarget,
  type GameState,
  type PlayerAction,
  type TradeKind,
} from '@richman/shared';

/**
 * 公布栏交易面板（UI-06 / help [11]）。
 * 玩家可在自己的回合挂出地产 / 股票 / 卡片 / 道具公开求售，
 * 其他玩家随时可用现金买下；卖方可撤下未成交的挂牌。
 */
const KIND_LABEL: Record<TradeKind, string> = {
  land: '地产',
  stock: '股票',
  card: '卡片',
  item: '道具',
};

function fmt(n: number): string {
  return n.toLocaleString('zh-CN');
}

export function TradePanel({
  game,
  onAction,
  interactive = true,
}: {
  game: GameState;
  onAction: (a: PlayerAction) => void;
  interactive?: boolean;
}) {
  const [posting, setPosting] = useState(false);
  const [selected, setSelected] = useState('');
  const [price, setPrice] = useState(0);

  const current = game.players[game.currentPlayerIndex];
  const actions = availableActions(game);
  if (!current) return null;

  const tradable = actions.tradableAssets;
  const listings = game.trades;
  const mine = listings.filter((t) => t.sellerId === current.id);
  const others = listings.filter((t) => t.sellerId !== current.id);

  const startPost = (index: number) => {
    const asset = tradable[index];
    if (!asset) return;
    setSelected(`${asset.kind}:${asset.targetId}`);
    setPrice(asset.suggestPrice);
    setPosting(true);
  };

  const submitPost = () => {
    const sep = selected.indexOf(':');
    if (sep <= 0) return;
    const kind = selected.slice(0, sep) as TradeKind;
    const targetId = selected.slice(sep + 1);
    onAction({ type: 'POST_TRADE', kind, targetId, price });
    setPosting(false);
    setSelected('');
  };

  return (
    <div className="panel trade-panel">
      <div className="panel-title">公布栏 · 公开交易</div>

      {/* 我的挂牌 */}
      {mine.length > 0 && (
        <>
          <div className="trade-section-title">我挂出的标的</div>
          <div className="trade-list">
            {mine.map((t) => (
              <div key={t.id} className="trade-row">
                <span className="trade-kind">{KIND_LABEL[t.kind]}</span>
                <span className="trade-label">{describeTarget(game, t.kind, t.targetId)}</span>
                <span className="trade-price">¥{fmt(t.price)}</span>
                <button
                  className="mini"
                  disabled={!interactive}
                  onClick={() => onAction({ type: 'CANCEL_TRADE', listingId: t.id })}
                >
                  撤下
                </button>
              </div>
            ))}
          </div>
        </>
      )}

      {/* 他人的挂牌 */}
      <div className="trade-section-title">他人挂牌（{others.length}）</div>
      {others.length === 0 && <div className="trade-empty">暂无他人挂牌</div>}
      {others.length > 0 && (
        <div className="trade-list">
          {others.map((t) => {
            const seller = game.players.find((p) => p.id === t.sellerId);
            const afford = current.cash >= t.price;
            return (
              <div key={t.id} className="trade-row">
                <span className="trade-kind">{KIND_LABEL[t.kind]}</span>
                <span className="trade-label">{describeTarget(game, t.kind, t.targetId)}</span>
                <span className="trade-seller">{seller?.name ?? '未知'}</span>
                <span className="trade-price">¥{fmt(t.price)}</span>
                <button
                  className="mini"
                  disabled={!interactive || !afford}
                  title={afford ? '' : '现金不足'}
                  onClick={() => onAction({ type: 'BUY_TRADE', listingId: t.id })}
                >
                  买下
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* 我要挂出 */}
      <div className="trade-section-title">我要挂出（我的现金 ¥{fmt(actions.tradeCash)}）</div>
      {!posting && (
        <>
          {tradable.length === 0 ? (
            <div className="trade-empty">暂无可挂出的地产 / 股票 / 卡片 / 道具</div>
          ) : (
            <div className="trade-assets">
              {tradable.map((a, i) => (
                <button key={`${a.kind}:${a.targetId}`} className="mini" disabled={!interactive} onClick={() => startPost(i)}>
                  挂出 {a.label}
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {posting && (
        <div className="trade-form">
          <div className="trade-form-label">
            {tradable.find((a) => `${a.kind}:${a.targetId}` === selected)?.label}
          </div>
          <div className="bank-input-row">
            <input
              type="number"
              min={0}
              step={100}
              value={price}
              onChange={(e) => setPrice(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
            />
            <button className="mini primary" disabled={!interactive} onClick={submitPost}>
              确认挂出
            </button>
            <button className="mini" onClick={() => setPosting(false)}>
              取消
            </button>
          </div>
          <div className="trade-hint">公开挂牌后，任何玩家都可以用现金买下；成交前你可以随时撤下。</div>
        </div>
      )}

      {game.tradeHistory.length > 0 && (
        <>
          <div className="trade-section-title">最近成交（{game.tradeHistory.length}）</div>
          <div className="trade-history">
            {game.tradeHistory
              .slice(-5)
              .reverse()
              .map((r, i) => {
                const buyer = game.players.find((p) => p.id === r.buyerId)?.name ?? r.buyerId;
                const seller = game.players.find((p) => p.id === r.sellerId)?.name ?? r.sellerId;
                return (
                  <div key={`${r.listingId}-${i}`} className="trade-history-row">
                    {buyer} ← {seller} · {describeTarget(game, r.kind, r.targetId)} · ¥{fmt(r.price)}
                  </div>
                );
              })}
          </div>
        </>
      )}
    </div>
  );
}