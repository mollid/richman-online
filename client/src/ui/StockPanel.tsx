import { useState } from 'react';
import {
  actionRefusal,
  availableActions,
  gameDate,
  lockedSharesOf,
  maxAffordableShares,
  sellableSharesOf,
  stockExecPrice,
  stockLimitState,
  stockImpactPct,
  type CompanyState,
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
 * 面板里是一张行情表：6 支虚拟股 + **这张图上的**公司股（`corp-*`，CORP-14；自建图 11 家，原版图按 mkf 自带 1~4 家），
 * 同一套行情机器（日切游走、日 K 线、冲击成本、停牌 / 休市），**买卖都走存款**。
 *
 * 公司股是**一本账**：面板买进去的持股与踩到公司格按**面值**（现金）认购的，记在同一本
 * 股东名册（`CompanyState.shares`）上，一起吃经营权与 15 号盈余分配。两个渠道的差别只有价格：
 * 面板按当日市价自由买卖，踩格按原始股面值 —— 省下的那一截就是踩点的奖励。
 * 本回合到手的（不论哪个渠道）先进锁定期，下次行动才可转手。
 *
 * - **不绑定任何格型**：玩家在自己回合的任意决策点（掷骰前 / 决策后）都能交易；
 * - 唯一限制是星期例假日休市（TIME-02）与新闻事件导致的全市场 / 个股停牌；
 *   原始股的**卖出**同样要对手盘（受休市与停牌约束）；认购不看盘口，但只能在地图上踩到那家公司时发生。
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

  const stockPrice = (id: string, fallback = 0) => game.stockMarket.stocks.find((s) => s.id === id)?.price ?? fallback;
  const listedValue = Object.entries(current.stocks).reduce((sum, [id, qty]) => sum + stockPrice(id) * qty, 0);
  // 一本账：上市股的持仓记在 `p.stocks`，公司股的持仓记在 `CompanyState.shares`，两边都按**市价**计。
  // 成本那条账现在含「面板买上市股 + 面板买公司股 + 踩格按面值认购」三笔，市值只数上市股
  // 就会凭空多出一整截假亏损。
  const origValue = game.companies.reduce(
    (sum, c) => sum + (c.shares[current.id] ?? 0) * stockPrice(`corp-${c.kind}`, c.sharePrice),
    0,
  );
  const portfolioValue = listedValue + origValue;
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
  // 行情表里的 `corp-<kind>` 行 ↔ 那家公司：持股、锁定期、转手动作都问它（CORP-14 一本账）
  const corpOf: Map<string, CompanyState> = new Map(game.companies.map((c) => [`corp-${c.kind}`, c]));

  return (
    <div className="panel stock-panel">
      {/* 口径与 HUD 顶栏一致：turn 才是「回合」，round 是转完一圈。原来这里把 round 写成回合，
          于是顶栏「第 15 回合」和面板「第 8 回合」同屏打架。 */}
      <div className="panel-title">股市 · 第 {game.turn} 回合</div>

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
          <span className="stock-closed">落格窗里不交易 · 回到掷骰前那一段随时可买卖</span>
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
            // 公司股读股东名册（一本账）；其余读纸面持仓
            const company = corpOf.get(s.id);
            const holding = company ? company.shares[current.id] ?? 0 : current.stocks[s.id] ?? 0;
            // 公司股只能卖已解锁的那部分；锁着多少由引擎那侧算，面板只复述
            const sellable = company ? sellableSharesOf(company, current.id) : holding;
            const locked = company ? holding - sellable : 0;
            const sell = (n: number) =>
              company ? onAction({ type: 'SELL_SHARES', cellId: company.cellId, quantity: n }) : trade(s.id, 'SELL_STOCK', n);
            const suspended = suspendedIds.has(s.id);
            const canTrade = interactive && actions.canTradeStock && !suspended;
            // 闸门问引擎（涨停买不进、跌停卖不出、锁定期、停牌都在那一侧），面板只复述理由 ——
            // 自己判一遍就是第二套口径，正是「按钮亮着、点了报错」那个老 bug 类。
            const limit = stockLimitState(s);
            const buyGate = actionRefusal(game, { type: 'BUY_STOCK', stockId: s.id, quantity: 1 });
            const sellGate = actionRefusal(
              game,
              company ? { type: 'SELL_SHARES', cellId: company.cellId, quantity: 1 } : { type: 'SELL_STOCK', stockId: s.id, quantity: 1 },
            );
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
                  {company && (
                    <span className="stock-tile" title="地图上的公司挂进股市：买它 = 进股东名册（经营权 + 分红）。踩到那一格还能按面值用现金认购">
                      公司股
                    </span>
                  )}
                  {suspended && <span className="stock-flag">停牌</span>}
                  {!suspended && limit !== 'flat' && (
                    <span className="stock-flag" title={limit === 'up' ? '涨停：今日无法买进' : '跌停：今日无法卖出'}>
                      {limit === 'up' ? '涨停' : '跌停'}
                    </span>
                  )}
                </td>
                <td>¥{fmt(s.price)}</td>
                <td className={s.lastChangePct >= 0 ? 'up' : 'down'}>{fmtPct(s.lastChangePct)}</td>
                <td>
                  {holding > 0 ? holding : '—'}
                  {locked > 0 && <span className="stock-lock">锁定 {fmt(locked)}</span>}
                  {holding > 0 && (
                    <span className="stock-pl">
                      市值 ¥{fmt(s.price * holding)}
                    </span>
                  )}
                </td>
                <td className="trade-cell">
                  <button
                    className="mini"
                    disabled={!canTrade || !!buyGate || cap < 1}
                    title={
                      buyGate
                        ?? (cap < 1
                          ? '存款不足（股票只能用存款购买）'
                          : `买入 ${qty} 张：成交均价 ¥${fmt(buyUnit)}，共 ¥${fmt(buyUnit * qty)}；买盘把盘口推高约 ${impactPctText}`)
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
                    disabled={!canTrade || !!buyGate || cap < 1}
                    title={buyGate ?? `存款最多能吃下 ${cap} 张（含冲击成本，买得越多均价越高）`}
                    onClick={(e) => {
                      e.stopPropagation();
                      trade(s.id, 'BUY_STOCK', cap);
                    }}
                  >
                    全买
                  </button>
                  <button
                    className="mini"
                    disabled={!canTrade || sellable < 1 || !!sellGate}
                    title={
                      sellable < 1
                        ? locked > 0
                          ? `本回合到手的 ${fmt(locked)} 张要等下次行动才能转手`
                          : '无持仓'
                        : sellGate
                          ?? `卖出 ${Math.min(qty, sellable)} 张：成交均价 ¥${fmt(sellUnit)}，收入进存款，抛压把盘口压低约 ${impactPctText}`
                    }
                    onClick={(e) => {
                      e.stopPropagation();
                      sell(Math.min(qty, sellable));
                    }}
                  >
                    卖{Math.min(qty, sellable)}
                  </button>
                  <button
                    className="mini"
                    disabled={!canTrade || sellable < 1 || !!sellGate}
                    title={sellGate ?? `清仓 ${sellable} 张（均价随抛压递减，一次倒完比分批卖更亏）`}
                    onClick={(e) => {
                      e.stopPropagation();
                      sell(sellable);
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

      {/* CORP-14 一本账：持股与经营权都在 `CompanyState.shares` 上。
          交易全在上方那张行情表里做（公司股就是其中 11 行），这里只把「权益」摊开看：
          面值 vs 现价、谁当董事长、多少张还锁着。 */}
      <div className="stock-section-title">
        <span>我的股东权益 · 面值与经营权</span>
        <span className="stock-section-note">
          持股与踩格认购记在同一本账上（买卖去上方行情表）；本回合到手的先进锁定期，下次行动起才能转手
        </span>
      </div>
      <table className="stock-table share-table">
        <thead>
          <tr>
            <th>公司</th>
            <th>面值 / 现价</th>
            <th>经营权</th>
            <th>我的持股</th>
            <th>可卖</th>
          </tr>
        </thead>
        <tbody>
          {game.companies.map((c) => {
            const holding = c.shares[current.id] ?? 0;
            const locked = lockedSharesOf(c, current.id);
            const sellable = sellableSharesOf(c, current.id);
            const market = game.stockMarket.stocks.find((x) => x.id === `corp-${c.kind}`)?.price ?? c.sharePrice;
            const chairman = c.chairmanId ? game.players.find((p) => p.id === c.chairmanId)?.name ?? '—' : '空缺';
            return (
              <tr key={c.cellId} className={locked > 0 ? 'locked' : ''}>
                <td>
                  {c.name}
                  <span className="stock-tile">{c.tile}</span>
                </td>
                <td>
                  ¥{fmt(c.sharePrice)} / <b className={market >= c.sharePrice ? 'up' : 'down'}>¥{fmt(market)}</b>
                </td>
                <td>{chairman}</td>
                <td>
                  {holding > 0 ? `${fmt(holding)} 张` : '—'}
                  {locked > 0 && <span className="stock-lock">锁定 {fmt(locked)}</span>}
                </td>
                <td>{sellable > 0 ? `${fmt(sellable)} 张` : '—'}</td>
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
          <span>原始股市值（按市价）</span>
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
        <b>股票只能用存款买卖</b>（含 {game.companies.length} 支公司股），现金用于买地、升级，以及踩到公司格时按<b>面值</b>认购。
        支付租金等支出时只会依次扣除<b>现金</b>与<b>存款</b>，<b>不会自动变卖你的股票或建筑</b>——
        若两者用尽仍付不出就会直接破产；想提前兑现，只能在股市面板主动卖出，或等随机事件（如「变卖所有股票求现」）。
        本面板在任何格型均可交易。
        <br />
        <b>成交有冲击成本</b>（仅上市股）：买盘推高、抛压压低，力度按「成交股数 ÷ 流通股本」算，结算价取冲击前后之中点
        （所以买完立刻卖不赚差价）。上方 K 线的量柱里，亮色那段是你自己打进去的成交量。
        <br />
        <b>公司股是一本账</b>：带「公司股」标记的那 11 行就是地图上的那 11 家公司 —— 在面板里买卖走
        <b>当日市价 + 存款</b>，踩到那一格则可用<b>现金按面值</b>认购，两者进的是<b>同一本股东名册</b>，
        一起吃经营权与 15 号盈余分配。省下的那一截差价，就是踩点的奖励。
        本回合到手的（不论哪个渠道）先进锁定期，<b>下次行动</b>起才可转手；卖光即退出名册，
        再进场时经营权的「先到先得」重新起算。休市与全市场停牌期间不能转手。
      </div>
    </div>
  );
}