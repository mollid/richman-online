import { useState } from 'react';
import {
  allAssetSummaries,
  estateGroups,
  stockSummary,
  vehicleOf,
  type GameState,
} from '@richman/shared';

/**
 * 三清单报表（ECON-14 / help [16]）：
 * - 资产清单：每位角色的现金、存款、土地、房屋、股票、原始股及资产总值；
 * - 地产清单：查询拥有的土地、等级、建设与现值；
 * - 股票清单：上市股明细（数量/单价/成本/市值/盈亏/持股比例）+ 公司原始股明细
 *   （面值/锁定/可卖/经营权，CORP-14）。两套并排给：原始股按面值计值，编不出「盈亏」这一列。
 */
type ReportTab = 'asset' | 'estate' | 'stock';

const REPORT_TABS: Array<[ReportTab, string]> = [
  ['asset', '资产清单'],
  ['estate', '地产清单'],
  ['stock', '股票清单'],
];

function fmt(n: number): string {
  return n.toLocaleString('zh-CN');
}

function signed(n: number): string {
  return `${n >= 0 ? '+' : ''}${fmt(n)}`;
}

export function ReportPanel({ game, myPlayerId }: { game: GameState; myPlayerId?: string | null }) {
  const [tab, setTab] = useState<ReportTab>('asset');
  const [scope, setScope] = useState<'all' | 'mine'>('all');

  const me = game.players.find((p) => p.id === myPlayerId);
  const players = scope === 'mine' && me ? [me] : game.players;
  const assets = allAssetSummaries(game).filter((a) => players.some((p) => p.id === a.playerId));

  return (
    <div className="panel report-panel">
      <div className="panel-title">三清单报表</div>

      <div className="report-tabs">
        {REPORT_TABS.map(([id, label]) => (
          <button key={id} className={`small ${tab === id ? 'primary' : ''}`} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      <div className="report-tabs">
        <button className={`small ${scope === 'all' ? 'primary' : ''}`} onClick={() => setScope('all')}>
          全体
        </button>
        <button className={`small ${scope === 'mine' ? 'primary' : ''}`} onClick={() => setScope('mine')}>
          只看我的
        </button>
      </div>

      {tab === 'asset' && (
        <div className="report-body">
          {assets.map((a) => (
            <div key={a.playerId} className={`report-card ${a.bankrupt ? 'bankrupt' : ''}`}>
              <div className="report-card-head">
                <b>{a.playerName}</b>
                {a.bankrupt && <span className="badge">已倒闭</span>}
                <span className="report-total">总值 ¥{fmt(a.total)}</span>
              </div>
              <table className="report-table">
                <tbody>
                  {a.rows
                    .filter((r) => r.amount !== 0 || r.key === 'cash' || r.key === 'deposit')
                    .map((r) => (
                      <tr key={r.key}>
                        <td>{r.label}</td>
                        <td className={r.key === 'loan' ? 'down' : ''}>{r.key === 'loan' ? signed(r.amount) : fmt(r.amount)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}

      {tab === 'estate' && (
        <div className="report-body">
          {players.map((p) => {
            const groups = estateGroups(game, p);
            return (
              <div key={p.id} className="report-card">
                <div className="report-card-head">
                  <b>{p.name}</b>
                  <span className="report-total">
                    {groups.reduce((s, g) => s + g.rows.length, 0)} 块地
                  </span>
                </div>
                {groups.length === 0 && <div className="report-empty">暂无地产</div>}
                {groups.map((g) => (
                  <div key={g.streetName} className="report-street">
                    <div className="report-street-head">
                      <span>{g.streetName}</span>
                      <span className="report-street-total">¥{fmt(g.totalValue)}</span>
                    </div>
                    <table className="report-table">
                      <tbody>
                        {g.rows.map((r) => (
                          <tr key={r.cellId}>
                            <td>{r.cellName}</td>
                            <td>{r.gradeLabel}</td>
                            <td>{r.facility ?? (r.isChain ? '连锁店' : '—')}</td>
                            <td>¥{fmt(r.totalValue)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}

      {tab === 'stock' && (
        <div className="report-body">
          {players.map((p) => {
            const sum = stockSummary(game, p);
            return (
              <div key={p.id} className="report-card">
                <div className="report-card-head">
                  <b>{p.name}</b>
                  <span className="report-total">市值 ¥{fmt(sum.marketValue)}</span>
                  <span className={`report-total ${sum.profit >= 0 ? 'up' : 'down'}`}>
                    盈亏 {signed(sum.profit)}
                  </span>
                </div>
                {sum.rows.length === 0 && sum.corpRows.length === 0 && <div className="report-empty">暂无持股</div>}
                {sum.rows.length > 0 && (
                  <table className="report-table">
                    <thead>
                      <tr>
                        <th>股票</th>
                        <th>数量</th>
                        <th>单价</th>
                        <th>市值</th>
                        <th>盈亏</th>
                        <th>持股</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sum.rows.map((r) => (
                        <tr key={r.stockId}>
                          <td>
                            {r.stockName}
                            {r.lastChangePct !== 0 && (
                              <span className={`report-change ${r.lastChangePct >= 0 ? 'up' : 'down'}`}>
                                {r.lastChangePct >= 0 ? '↑' : '↓'}
                                {Math.abs(r.lastChangePct).toFixed(1)}%
                              </span>
                            )}
                          </td>
                          <td>{r.quantity}</td>
                          <td>{r.price}</td>
                          <td>¥{fmt(r.marketValue)}</td>
                          <td className={r.profit >= 0 ? 'up' : 'down'}>{signed(r.profit)}</td>
                          <td>{r.holdingPct}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {/* CORP-14：原始股没有价差，要看的是流动性（锁定 / 可卖）与经营权 */}
                {sum.corpRows.length > 0 && (
                  <table className="report-table report-table-corp">
                    <thead>
                      <tr>
                        <th>公司原始股</th>
                        <th>数量</th>
                        <th>面值</th>
                        <th>市值</th>
                        <th>锁定 / 可卖</th>
                        <th>持股</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sum.corpRows.map((r) => (
                        <tr key={r.cellId}>
                          <td>
                            {r.name}
                            <span className="report-tile">{r.tile}</span>
                            {r.chairman && <span className="badge">董事长</span>}
                          </td>
                          <td>{r.quantity}</td>
                          <td>{r.price}</td>
                          <td>¥{fmt(r.marketValue)}</td>
                          <td>
                            {r.locked > 0 ? <span className="down">{r.locked}</span> : '0'} / {r.sellable}
                          </td>
                          <td>{r.holdingPct}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {sum.corpValue > 0 && <div className="report-subtotal">原始股小计 ¥{fmt(sum.corpValue)}</div>}
              </div>
            );
          })}
        </div>
      )}

      {me && tab === 'asset' && <div className="report-foot">我的交通工具：{vehicleOf(me)}</div>}
    </div>
  );
}