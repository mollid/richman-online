import { availableActions, type GameState, type PlayerAction } from '@richman/shared';

function fmtPct(pct: number): string {
  return `${pct >= 0 ? '+' : ''}${pct}%`;
}

/** 股票面板：行情 + 持仓，银行格可交易 */
export function StockPanel({ game, onAction, interactive = true }: { game: GameState; onAction: (a: PlayerAction) => void; interactive?: boolean }) {
  const current = game.players[game.currentPlayerIndex];
  const actions = availableActions(game);
  if (!current) return null;

  const portfolioValue = Object.entries(current.stocks).reduce((sum, [id, qty]) => {
    const stock = game.stockMarket.stocks.find((s) => s.id === id);
    return sum + (stock?.price ?? 0) * qty;
  }, 0);

  const trade = (stockId: string, type: 'BUY_STOCK' | 'SELL_STOCK', quantity: number) => {
    onAction({ type, stockId, quantity });
  };

  return (
    <div className="panel stock-panel">
      <div className="panel-title">股市 · 第 {game.round} 回合</div>
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
            return (
              <tr key={s.id}>
                <td>{s.name}</td>
                <td>¥{s.price}</td>
                <td className={s.lastChangePct >= 0 ? 'up' : 'down'}>{fmtPct(s.lastChangePct)}</td>
                <td>{holding}</td>
                <td className="trade-cell">
                  <button className="mini" disabled={!interactive || !actions.canTradeStock} onClick={() => trade(s.id, 'BUY_STOCK', 1)}>
                    买1
                  </button>
                  <button className="mini" disabled={!interactive || !actions.canTradeStock || current.cash < s.price * 10} onClick={() => trade(s.id, 'BUY_STOCK', 10)}>
                    买10
                  </button>
                  <button className="mini" disabled={!interactive || !actions.canTradeStock || holding < 1} onClick={() => trade(s.id, 'SELL_STOCK', 1)}>
                    卖1
                  </button>
                  <button className="mini" disabled={!interactive || !actions.canTradeStock || holding < 1} onClick={() => trade(s.id, 'SELL_STOCK', holding)}>
                    全卖
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="stock-summary">
        持仓市值 ¥{portfolioValue.toLocaleString('zh-CN')} · 现金 ¥{current.cash.toLocaleString('zh-CN')}
      </div>
      {actions.isHoliday ? (
        <div className="stock-hint holiday-hint">例假日休市，今日无法交易</div>
      ) : (
        !actions.canTradeStock && <div className="stock-hint">到达银行/证交所后可交易</div>
      )}
    </div>
  );
}

