import { useEffect, useState } from 'react';
import { fetchLeaderboard, type AuthUser, type LeaderboardEntry } from '../../net/auth.js';
import { LbDialog } from './LbDialog.js';

function lastLabel(iso: string | null): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '—';
  const days = Math.floor((Date.now() - t) / 86_400_000);
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  if (days < 30) return `${days} 天前`;
  return new Date(iso).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

/** 排行榜：按账号排，只列真打过局的人（服务端已经把空账号滤掉了） */
export function LeaderboardDialog({ user, onClose }: { user: AuthUser | null; onClose: () => void }) {
  const [rows, setRows] = useState<LeaderboardEntry[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');

  const refresh = async () => {
    setState('loading');
    try {
      setRows(await fetchLeaderboard());
      setState('ready');
    } catch {
      setState('failed');
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  return (
    <LbDialog title="排行榜" sub="胜场 / 总局 / 胜率" tone="orange" onClose={onClose}>
      <div className="lb-list__hd">
        <span className="lb-list__title">共 {rows.length} 个账号打过对局</span>
        <button className="lb-mini" onClick={() => void refresh()}>
          刷新
        </button>
      </div>
      {state === 'loading' && <div className="lb-empty">读取中…</div>}
      {state === 'failed' && <div className="lb-err">取不到排行榜：服务器未启动或数据库未连接</div>}
      {state === 'ready' && rows.length === 0 && <div className="lb-empty">还没有人打完过一局</div>}
      {state === 'ready' && rows.length > 0 && (
        <div className="lb-list lb-scroll">
          {rows.map((r, i) => {
            const rate = r.games > 0 ? Math.round((r.wins / r.games) * 100) : 0;
            const me = r.username === user?.username;
            return (
              <div key={r.username} className={`lb-item${me ? ' lb-item--win' : ''}`}>
                <span className={`lb-rank${i < 3 ? ` lb-rank--${i + 1}` : ''}`}>{i + 1}</span>
                <span className="lb-item__main">
                  <span className="lb-item__name">
                    {r.username}
                    {me && ' （你）'}
                  </span>
                  <span className="lb-item__sub">
                    {r.wins} 胜 / {r.games} 局 · 胜率 {rate}%
                  </span>
                </span>
                <span className="lb-item__tag">{lastLabel(r.last_played)}</span>
              </div>
            );
          })}
        </div>
      )}
      <p className="lb-hint">只统计联机对局：单人模式打完不进服务器，所以也不上榜 —— 一个人刷 AI 堆出来的胜场不是成绩。</p>
    </LbDialog>
  );
}
