import { useState } from 'react';
import {
  actionRefusal,
  availableActions,
  companyAtCell,
  COMPANIES,
  ESTATE_BUILD_RATIO,
  lockedSharesOf,
  MAX_SHARES_PER_BUY,
  scaled,
  sellableSharesOf,
  type GameState,
  type PlayerAction,
} from '@richman/shared';

/**
 * 公司企业面板（CORP-01..13）：仅在停留公司格时显示。
 * 认购股份 + 房地产公司加盖（CORP-13）+ 企业银行董事长特别融资（CORP-09）。
 * 转手（卖出）不在这里做：原始股要经股市面板，见 StockPanel 的公司分区。
 */
export function CompanyPanel({
  game,
  onAction,
  interactive = true,
}: {
  game: GameState;
  onAction: (a: PlayerAction) => void;
  interactive?: boolean;
}) {
  const actions = availableActions(game);
  const current = game.players[game.currentPlayerIndex];
  const [quantity, setQuantity] = useState(10);
  const [estateCell, setEstateCell] = useState<number | null>(null);
  const [financing, setFinancing] = useState(1000);

  if (!current) return null;
  const cell = game.board[current.position];
  if (!cell || cell.type !== 'company' || !cell.companyKind) return null;
  const company = companyAtCell(game, cell.id);
  const def = COMPANIES[cell.companyKind];
  if (!company || !def) return null;

  const chairman = company.chairmanId ? game.players.find((p) => p.id === company.chairmanId) : undefined;
  const myShares = company.shares[current.id] ?? 0;
  const locked = lockedSharesOf(company, current.id);
  const sellable = sellableSharesOf(company, current.id);
  // 卖不卖得掉问注册表（休市/停牌与锁定期都在引擎那一侧），面板只复述原因
  const sellBlocked = sellable > 0 ? actionRefusal(game, { type: 'SELL_SHARES', cellId: cell.id, quantity: 1 }) : null;
  const holdings = Object.entries(company.shares).filter(([, n]) => n > 0);

  const buy = () => {
    const q = Math.floor(quantity);
    if (q <= 0) return;
    onAction({ type: 'BUY_SHARES', cellId: cell.id, quantity: q });
  };

  const estateTarget = estateCell !== null ? game.board[estateCell] : undefined;
  const estateCost =
    estateTarget && estateTarget.price !== undefined ? scaled(game, Math.round(estateTarget.price * ESTATE_BUILD_RATIO)) : 0;

  return (
    <div className="panel company-panel">
      <div className="panel-title">
        {company.name} · {company.tile}
      </div>
      <div className="company-hint">{def.charge}</div>

      <div className="company-meta">
        <span>股票面值 ¥{company.sharePrice}/张</span>
        <span>董事长：{chairman?.name ?? '经营权空缺'}</span>
        <span>累积盈余 ¥{company.surplus.toLocaleString('zh-CN')}</span>
      </div>

      <div className="company-shareholders">
        {holdings.length === 0 ? (
          <span className="hint">暂无股东，认购即可取得经营权</span>
        ) : (
          holdings.map(([id, n]) => (
            <span key={id} className="badge">
              {game.players.find((p) => p.id === id)?.name ?? id} {n} 张
              {company.chairmanId === id ? '（董事长）' : ''}
            </span>
          ))
        )}
      </div>

      <div className="company-row">
        <span className="company-label">我的持股</span>
        <span>
          {myShares} 张
          {locked > 0 && <em className="company-locked">（其中 {locked} 张待解锁，下次行动后可在股市卖出）</em>}
          {locked === 0 && sellable > 0 && (
            <em className="company-locked">{sellBlocked ?? '可在股市面板按面值卖出，换回现金'}</em>
          )}
        </span>
      </div>

      {actions.canBuyShares && (
        <div className="company-buy">
          <input
            type="number"
            min={1}
            max={Math.max(1, actions.shareQuantityLimit)}
            value={quantity}
            onChange={(e) => setQuantity(Math.max(1, Math.floor(Number(e.target.value) || 0)))}
          />
          <button className="mini" onClick={() => setQuantity(10)}>
            10
          </button>
          <button className="mini" onClick={() => setQuantity(100)}>
            100
          </button>
          <button className="mini" onClick={() => setQuantity(Math.max(1, actions.shareQuantityLimit))}>
            满额
          </button>
          <button
            disabled={!interactive || !actions.canBuyShares}
            title={`以现金按面值认购 ${Math.max(1, Math.floor(quantity))} 张；本次认购的要到下次行动才能在股市转手（按当日市价，收入进存款）`}
            onClick={buy}
          >
            认购 ¥{(company.sharePrice * Math.max(0, Math.floor(quantity))).toLocaleString('zh-CN')}
          </button>
        </div>
      )}
      {!actions.canBuyShares && (
        <div className="company-hint">
          （踩到这一格才有的<b>面值认购</b>窗口：用<b>现金</b>按面值，单次上限 {MAX_SHARES_PER_BUY} 张 ——
          比面板上的市价便宜多少，就是踩点的奖励多少。手上没现金就去股市转手（按<b>当日市价</b>卖、收入进<b>存款</b>）。
          两边进的是<b>同一本股东名册</b>：经营权与 15 号盈余分配不分渠道，本回合到手的先进锁定期）
        </div>
      )}

      {cell.companyKind === 'estate' && (
        <div className="company-estate">
          <div className="company-label">房地产加盖（施工费 = 地价 {Math.round(ESTATE_BUILD_RATIO * 100)}%）</div>
          {actions.estateBuildCells.length === 0 ? (
            <div className="company-hint">暂无可加盖的自有地产</div>
          ) : (
            <div className="company-buy">
              <select
                value={estateCell ?? actions.estateBuildCells[0]!}
                onChange={(e) => setEstateCell(Number(e.target.value))}
              >
                {actions.estateBuildCells.map((id) => (
                  <option key={id} value={id}>
                    {game.board[id]?.name ?? `格 ${id}`}
                  </option>
                ))}
              </select>
              <button
                disabled={!interactive || !actions.canBuildEstate || current.cash < estateCost}
                onClick={() => onAction({ type: 'BUILD_ESTATE', cellId: estateCell ?? actions.estateBuildCells[0]! })}
              >
                加盖 ¥{estateCost.toLocaleString('zh-CN')}
              </button>
            </div>
          )}
        </div>
      )}

      {cell.companyKind === 'bank' && company.chairmanId === current.id && (
        <div className="company-financing">
          <div className="company-label">董事长特别融资（周转期间存款不计息）</div>
          <div className="company-hint">剩余额度 ¥{actions.financingRemaining.toLocaleString('zh-CN')}</div>
          <div className="company-buy">
            <input
              type="number"
              min={1}
              max={Math.max(1, actions.financingRemaining)}
              value={financing}
              onChange={(e) => setFinancing(Math.max(1, Math.floor(Number(e.target.value) || 0)))}
            />
            <button
              disabled={!interactive || !actions.canFinancing || financing > actions.financingRemaining}
              onClick={() => onAction({ type: 'SPECIAL_FINANCING', amount: Math.floor(financing) })}
            >
              融资
            </button>
          </div>
        </div>
      )}
    </div>
  );
}