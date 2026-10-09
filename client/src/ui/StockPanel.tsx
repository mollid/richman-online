import { useState } from 'react';
import {
  actionRefusal,
  availableActions,
  COMPANIES,
  gameDate,
  lockedSharesOf,
  maxAffordableShares,
  maxCashShares,
  sellableSharesOf,
  stockExecPrice,
  stockImpactPct,
  type GameState,
  type PlayerAction,
} from '@richman/shared';
import { StockChart } from './StockChart.js';

function fmtPct(pct: number): string {
  return `${pct >= 0 ? '+' : ''}${pct}%`;
}

function fmt(n: number): string {
  return n.toLocaleString('zh-CN');
}

/**
 * 股市面板（ECON-09 / help[14]「股票是一項不錯的投資，**您可以隨時進行買賣**」）。
 *
 * 面板里是**两档市场**：
 * - 上半：6 支上市股 —— 市价波动 + 日 K 线 + 冲击成本，只能用**存款**买卖；
 * - 下半：地图上的 11 家公司（CORP-14）—— **面值**定价、无涨跌，用**现金**买卖，
 *   踩到公司格认购与在这里申购是同一个动作；本回合认购的要到**下次行动**才能转手。
 *
 * - **不绑定任何格型**：玩家在自己回合的任意决策点（掷骰前 / 决策后）都能交易；
 * - 唯一限制是星期例假日休市（TIME-02）与新闻事件导致的全市场 / 个股停牌；
 *   原始股例外：**认购**是向公司申购（不看盘口，休市照买），**卖出**才需要对手盘；
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
  // 图表看哪一支：默认第一支，点表格行切换
  const [chartId, setChartId] = useState('tech');
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

  // CORP-14：原始股三项独立展示（市值 / 可卖 / 待解锁）
  const origValue = game.companies.reduce((sum, c) => sum + (c.shares[current.id] ?? 0) * c.sharePrice, 0);
  const origSellable = game.companies.reduce((sum, c) => sum + sellableSharesOf(c, current.id), 0);
  const origLocked = game.companies.reduce((sum, c) => sum + lockedSharesOf(c, current.id), 0);

  const trade = (stockId: string, type: 'BUY_STOCK' | 'SELL_STOCK', quantity: number) => {
    if (quantity <= 0) return;
    onAction({ type, stockId, quantity });
  };

  // 「全部买入」必须按含冲击的结算价算，否则点下去必被引擎以「存款不足」拒绝
  const maxBuy = (stockId: string, price: number) => {
    const stock = game.stockMarket.stocks.find((s) => s.id === stockId);
    return stock ? maxAffordableShares(stock, funds) : Math.floor(funds / Math.max(1, price));
  };
  const affordable = funds > 0;
  const chartStock = game.stockMarket.stocks.find((s) => s.id === chartId) ?? game.stockMarket.stocks[0]!;

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

      <StockChart stock={chartStock} />

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
            const cap = maxBuy(s.id, s.price);
            const qty = Math.max(1, Math.min(customQty, Math.max(1, cap)));
            // 冲击提示：按结算价报数，玩家点之前就知道这笔会把价格推到哪里
            const buyUnit = stockExecPrice(s, qty, 'buy');
            const sellUnit = stockExecPrice(s, qty, 'sell');
            const impactPctText = `±${(stockImpactPct(s, qty) * 100).toFixed(1)}%`;
            return (
              <tr
                key={s.id}
                className={`${suspended ? 'suspended ' : ''}${s.id === chartStock.id ? 'charting' : ''}`}
                onClick={() => setChartId(s.id)}
              >
                <td>
                  {s.id === chartStock.id && <span className="chart-mark">📈</span>} {s.name}
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
                    title={
                      cap < 1
                        ? '存款不足（股票只能用存款购买）'
                        : `买入 ${qty} 张：成交均价 ¥${fmt(buyUnit)}，共 ¥${fmt(buyUnit * qty)}；买盘把盘口推高约 ${impactPctText}`
                    }
                    onClick={(e) => {
                      e.stopPropagation();
                      trade(s.id, 'BUY_STOCK', qty);
                    }}
                  >
                    买{qty}
                  </button>
                  <button
                    className="mini"
                    disabled={!canTrade || cap < 1}
                    title={`存款最多能吃下 ${cap} 张（含冲击成本，买得越多均价越高）`}
                    onClick={(e) => {
                      e.stopPropagation();
                      trade(s.id, 'BUY_STOCK', cap);
                    }}
                  >
                    全买
                  </button>
                  <button
                    className="mini"
                    disabled={!canTrade || holding < 1}
                    title={`卖出 ${Math.min(qty, holding)} 张：成交均价 ¥${fmt(sellUnit)}，抛压把盘口压低约 ${impactPctText}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      trade(s.id, 'SELL_STOCK', Math.min(qty, holding));
                    }}
                  >
                    卖{Math.min(qty, holding)}
                  </button>
                  <button
                    className="mini"
                    disabled={!canTrade || holding < 1}
                    title={`清仓 ${holding} 张（均价随抛压递减，一次倒完比分批卖更亏）`}
                    onClick={(e) => {
                      e.stopPropagation();
                      trade(s.id, 'SELL_STOCK', holding);
                    }}
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

      {/* CORP-14：地图上的公司都挂在这里 —— 面值定价、现金买卖，与上市股两档并行 */}
      <div className="stock-section-title">
        <span>公司原始股 · 面值 · 现金</span>
        <span className="stock-section-note">
          {haltAll || date.isHoliday ? '休市中：可认购，暂不能卖出' : '认购不看盘口；本回合认购的，下次行动起才能转手'}
        </span>
      </div>
      <table className="stock-table share-table">
        <thead>
          <tr>
            <th>公司</th>
            <th>面值</th>
            <th>经营权</th>
            <th>我的持股</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {game.companies.map((c) => {
            const def = COMPANIES[c.kind];
            const holding = c.shares[current.id] ?? 0;
            const locked = lockedSharesOf(c, current.id);
            const sellable = sellableSharesOf(c, current.id);
            // 「满额」与引擎同一个口径：现金 ÷ 面值，再受单次上限截断
            const cap = maxCashShares(c.sharePrice, current.cash);
            const qty = Math.max(1, Math.min(customQty, Math.max(1, cap)));
            const buyErr = actionRefusal(game, { type: 'BUY_SHARES', cellId: c.cellId, quantity: qty });
            const sellQty = Math.min(customQty, sellable);
            const sellErr =
              sellQty > 0 ? actionRefusal(game, { type: 'SELL_SHARES', cellId: c.cellId, quantity: sellQty }) : '无可卖的原始股';
            const clearErr =
              sellable > 0 ? actionRefusal(game, { type: 'SELL_SHARES', cellId: c.cellId, quantity: sellable }) : '无可卖的原始股';
            const chairman = c.chairmanId ? game.players.find((p) => p.id === c.chairmanId)?.name ?? '—' : '空缺';
            return (
              <tr key={c.cellId} className={locked > 0 ? 'locked' : ''}>
                <td>
                  {def.name}
                  <span className="stock-tile">{def.tile}</span>
                </td>
                <td>¥{fmt(c.sharePrice)}</td>
                <td>{chairman}</td>
                <td>
                  {holding > 0 ? `${fmt(holding)} 张` : '—'}
                  {locked > 0 && <span className="stock-lock">锁定 {fmt(locked)}</span>}
                </td>
                <td className="trade-cell">
                  <button
                    className="mini"
                    disabled={!interactive || buyErr !== null}
                    title={buyErr ?? `以现金认购 ${qty} 张（需 ¥${fmt(c.sharePrice * qty)}），下次行动后可在此卖出`}
                    onClick={() => onAction({ type: 'BUY_SHARES', cellId: c.cellId, quantity: qty })}
                  >
                    买{qty}
                  </button>
                  <button
                    className="mini"
                    disabled={!interactive || cap < 1 || buyErr !== null}
                    title={cap < 1 ? '现金不足（原始股只能用现金认购）' : `现金能吃的上限 ${cap} 张`}
                    onClick={() => onAction({ type: 'BUY_SHARES', cellId: c.cellId, quantity: cap })}
                  >
                    满额
                  </button>
                  <button
                    className="mini"
                    disabled={!interactive || sellErr !== null}
                    title={sellErr ?? `按面值卖出 ${sellQty} 张（回笼现金 ¥${fmt(c.sharePrice * sellQty)}）`}
                    onClick={() => sellQty > 0 && onAction({ type: 'SELL_SHARES', cellId: c.cellId, quantity: sellQty })}
                  >
                    卖{Math.max(1, sellQty)}
                  </button>
                  <button
                    className="mini"
                    disabled={!interactive || clearErr !== null}
                    title={
                      sellable < 1
                        ? locked > 0
                          ? `待解锁 ${fmt(locked)} 张要到下次行动才能转手`
                          : '无可卖的原始股'
                        : `清仓 ${fmt(sellable)} 张（回笼现金 ¥${fmt(c.sharePrice * sellable)}）`
                    }
                    onClick={() => sellable > 0 && onAction({ type: 'SELL_SHARES', cellId: c.cellId, quantity: sellable })}
                  >
                    清仓
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

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
          <span>原始股市值（按面值）</span>
          <b>¥{fmt(origValue)}</b>
        </div>
        <div className="stock-summary-row">
          <span>原始股 可卖 / 待解锁</span>
          <b>
            {fmt(origSellable)} / {fmt(origLocked)} 张
          </b>
        </div>
        <div className="stock-summary-row">
          <span>可用存款（炒股）</span>
          <b className={affordable ? '' : 'down'}>¥{fmt(current.deposit)}</b>
        </div>
        <div className="stock-summary-row">
          <span>现金（买地/升级/原始股）</span>
          <b className={current.cash > 0 ? '' : 'down'}>¥{fmt(current.cash)}</b>
        </div>
      </div>

      <div className="stock-hint">
        <b>上市股只能用存款买卖</b>，现金用于买地、升级与认购原始股。
        支付租金等支出时只会依次扣除<b>现金</b>与<b>存款</b>，<b>不会自动变卖你的股票或建筑</b>——
        若两者用尽仍付不出就会直接破产；想提前兑现，只能在股市面板主动卖出，或等随机事件（如「变卖所有股票求现」）。
        本面板在任何格型均可交易。
        <br />
        <b>成交有冲击成本</b>（仅上市股）：买盘推高、抛压压低，力度按「成交股数 ÷ 流通股本」算，结算价取冲击前后之中点
        （所以买完立刻卖不赚差价）。上方 K 线的量柱里，亮色那段是你自己打进去的成交量。
        <br />
        <b>公司原始股走现金</b>：面值定价、不随行情涨跌，踩到公司格与在此申购是同一个动作（<b>没有现金就买不成</b>）。
        刚认购的那些要等<b>下次行动</b>才进得了股市——持股栏里的「锁定」就是还没解锁的张数；卖光即退出股东名册，
        再进场时经营权的「先到先得」重新起算。休市与全市场停牌期间仍可认购，但不能转手卖出。
      </div>
    </div>
  );
}