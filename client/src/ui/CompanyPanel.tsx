import { useState } from 'react';
import {
  availableActions,
  companyAtCell,
  COMPANIES,
  ESTATE_BUILD_RATIO,
  MAX_SHARES_PER_BUY,
  scaled,
  type GameState,
  type PlayerAction,
} from '@richman/shared';

/**
 * 公司企业面板（CORP-01..13）：仅在停留公司格时显示。
 * 认购股份 + 房地产公司加盖（CORP-13）+ 企业银行董事长特别融资（CORP-09）。
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
        {def.name} · {def.tile}
      </div>
      <div className="company-hint">{def.charge}</div>

      <div className="company-meta">
        <span>股票面值 ¥{def.sharePrice}/张</span>
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
        <span>{myShares} 张</span>
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
          <button disabled={!interactive || !actions.canBuyShares} onClick={buy}>
            认购 ¥{(def.sharePrice * Math.max(0, Math.floor(quantity))).toLocaleString('zh-CN')}
          </button>
        </div>
      )}
      {!actions.canBuyShares && <div className="company-hint">（单次认购上限 {MAX_SHARES_PER_BUY} 张，现金不足或已非公司格）</div>}

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