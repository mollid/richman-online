import { useState } from 'react';
import { availableActions, gameDate, type GameState, type PlayerAction } from '@richman/shared';

function fmtPct(pct: number): string {
  return `${pct >= 0 ? '+' : ''}${pct}%`;
}

function fmt(n: number): string {
  return n.toLocaleString('zh-CN');
}

/**
 * 股市面板（ECON-09 / help[14]「股票是一項不錯的投資，**您可以隨時進行買賣**」）。
 *
 * - **不绑定任何格型**：玩家在自己回合的任意决策点（掷骰前 / 决策后）都能买卖；
 * - 唯一限制是星期例假日休市（TIME-02）与新闻事件导致的全市场 / 个股停牌；
 * - 支持 1 / 5 / 10 / 全部 / 自定义数量买入，卖出同理；
 * - ECON-10：独立展示总市值（现值）、成本（投资成本）、经营权（控股公司数）。
 */
export function StockPanel({
  game,
  onAction,
  interactive = true,
}: {
  game: GameState;
  onAction: (a: PlayerAction) => void;
  interactive?: boolean;
}) {
  const [customQty, setCustomQty] = useState(1);
  const current = game.players[game.currentPlayerIndex];
  const actions = availableActions(game);
  const date = gameDate(game);
  if (!current) return null;

  const portfolioValue = Object.entries(current.stocks).reduce((sum, [id, qty]) => {
    const stock = game.stockMarket.stocks.find((s) => s.id === id);
    return sum + (stock?.price ?? 0) * qty;
  }, 0);
  const portfolioCost = Object.values(current.stockCost ?? {}).reduce((sum, v) => sum + v, 0);
  const profit = portfolioValue - portfolioCost;
  const controlled = game.companies.filter((c) => c.chairmanId === current.id).length;
  // 原版规则：股票只能用存款买（现金仅用于买地与升级建筑）
  const funds = current.deposit;

  // 停牌原因诊断（用于给玩家明确提示）
  const haltAll = game.stockHaltAllDays > 0;
  const suspendedIds = new Set(
    game.stockHalts.filter((h) => h.kind === 'suspend').map((h) => h.stockId),
  );

  const trade = (stockId: string, type: 'BUY_STOCK' | 'SELL_STOCK', quantity: number) => {
    if (quantity <= 0) return;
    onAction({ type, stockId, quantity });
  };

  const maxBuy = (price: number) => (price > 0 ? Math.floor(funds / price) : 0);
  const affordable = funds > 0;

  return (
    <div className="panel stock-panel">
      <div className="panel-title">股市 · 第 {game.round} 回合</div>

      {/* 市场状态条 */}
      <div className="stock-market-bar">
        <span className={`badge weekday ${date.isHoliday ? 'holiday' : ''}`}>{date.weekdayLabel}</span>
        {actions.canTradeStock && !affordable ? (
          <span className="stock-closed">存款不足，暂无法买股（现金不能炒股）</span>
        ) : actions.canTradeStock ? (
          <span className="stock-open">● 交易中 · 随时可买卖（用存款）</span>
        ) : haltAll ? (
          <span className="stock-closed">全市场停牌（剩余 {game.stockHaltAllDays} 天）</span>
        ) : date.isHoliday ? (
          <span className="stock-closed">例假日休市</span>
        ) : (
          <span className="stock-closed">当前阶段不可交易</span>
        )}
      </div>

      <table className="stock-table">
        <thead>
          <tr>
            <th>股票</th>
            <th>价格</th>
            <th>涨跌</th>
            <th>持仓</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {game.stockMarket.stocks.map((s) => {
            const holding = current.stocks[s.id] ?? 0;
            const suspended = suspendedIds.has(s.id);
            const canTrade = interactive && actions.canTradeStock && !suspended;
            const cap = maxBuy(s.price);
            const qty = Math.max(1, Math.min(customQty, Math.max(1, cap)));
            return (
              <tr key={s.id} className={suspended ? 'suspended' : ''}>
                <td>
                  {s.name}
                  {suspended && <span className="stock-flag">停牌</span>}
                </td>
                <td>¥{fmt(s.price)}</td>
                <td className={s.lastChangePct >= 0 ? 'up' : 'down'}>{fmtPct(s.lastChangePct)}</td>
                <td>
                  {holding > 0 ? holding : '—'}
                  {holding > 0 && (
                    <span className="stock-pl">
                      市值 ¥{fmt(s.price * holding)}
                    </span>
                  )}
                </td>
                <td className="trade-cell">
                  <button
                    className="mini"
                    disabled={!canTrade || cap < 1}
                    title={cap < 1 ? '存款不足（股票只能用存款购买）' : `以存款买入 ${qty} 张（需 ¥${fmt(s.price * qty)}）`}
                    onClick={() => trade(s.id, 'BUY_STOCK', qty)}
                  >
                    买{qty}
                  </button>
                  <button
                    className="mini"
                    disabled={!canTrade || cap < 1}
                    title={`全部买入（约 ${Math.floor(cap / qty) * qty} 张）`}
                    onClick={() => trade(s.id, 'BUY_STOCK', cap)}
                  >
                    全买
                  </button>
                  <button
                    className="mini"
                    disabled={!canTrade || holding < 1}
                    title={holding < 1 ? '无持仓' : `卖出 ${Math.min(qty, holding)} 张`}
                    onClick={() => trade(s.id, 'SELL_STOCK', Math.min(qty, holding))}
                  >
                    卖{Math.min(qty, holding)}
                  </button>
                  <button
                    className="mini"
                    disabled={!canTrade || holding < 1}
                    title="清仓"
                    onClick={() => trade(s.id, 'SELL_STOCK', holding)}
                  >
                    清仓
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {/* 数量档位：满足「自由购买」——可一次买任意张 */}
      <div className="stock-qty-row">
        <label>数量</label>
        {[1, 5, 10, 50].map((n) => (
          <button
            key={n}
            className={`small ${customQty === n ? 'primary' : ''}`}
            onClick={() => setCustomQty(n)}
          >
            {n} 张
          </button>
        ))}
        <input
          type="number"
          min={1}
          value={customQty}
          onChange={(e) => setCustomQty(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
        />
      </div>

      {/* ECON-10：总市值 / 成本 / 经营权三项独立展示 */}
      <div className="stock-summary">
        <div className="stock-summary-row">
          <span>总市值</span>
          <b>¥{fmt(portfolioValue)}</b>
        </div>
        <div className="stock-summary-row">
          <span>成本</span>
          <b>¥{fmt(portfolioCost)}</b>
        </div>
        <div className="stock-summary-row">
          <span>浮动盈亏</span>
          <b className={profit >= 0 ? 'up' : 'down'}>
            {profit >= 0 ? '+' : ''}
            {fmt(profit)}
          </b>
        </div>
        <div className="stock-summary-row">
          <span>经营权</span>
          <b>{controlled} 家</b>
        </div>
        <div className="stock-summary-row">
          <span>可用存款（炒股）</span>
          <b className={affordable ? '' : 'down'}>¥{fmt(current.deposit)}</b>
        </div>
        <div className="stock-summary-row">
          <span>现金（仅买地/升级）</span>
          <b>¥{fmt(current.cash)}</b>
        </div>
      </div>

      <div className="stock-hint">
        <b>股票只能用存款买卖</b>，现金仅用于购买土地与升级建筑；现金不足时无法买地或升级。
        支付租金等支出时只会依次扣除<b>现金</b>与<b>存款</b>，<b>不会自动变卖你的股票或建筑</b>——
        若两者用尽仍付不出就会直接破产；想提前兑现股票，只能在股市面板主动卖出，或等随机事件（如「变卖所有股票求现」）。
        本面板在任何格型均可交易。
      </div>
    </div>
  );
}