import { useEffect, useState } from 'react';
import { fetchMyRecords, fetchRecord, type ReplayRecord } from '../../net/auth.js';
import { getLocalReplay, listLocalReplays, type ReplayListItem } from '../../net/localReplays.js';
import { Icon } from '../mp/Icon.js';
import { LbDialog } from './LbDialog.js';

function when(iso: string): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return iso;
  return t.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/**
 * 我的回放：联机局从服务端按账号取，单人局从这台浏览器的本地缓冲取，两张来源并成一列。
 *
 * 原来这是大厅上的第三个页签，谁都能翻全服每局的完整动作日志。收进登录后的用户菜单之后，
 * 服务端那两条路由也跟着改成带票 + 核归属（见 `server/src/index.ts`）。
 */
export function MyReplaysDialog({ username, onWatch, onClose }: { username: string; onWatch: (r: ReplayRecord) => void; onClose: () => void }) {
  const [rows, setRows] = useState<ReplayListItem[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [picking, setPicking] = useState('');

  const refresh = async () => {
    setState('loading');
    try {
      const remote = (await fetchMyRecords()).map((r) => ({ ...r, local: false }));
      setRows([...remote, ...listLocalReplays(username)].sort((a, b) => b.finished_at.localeCompare(a.finished_at)));
      setState('ready');
    } catch {
      setRows([]);
      setState('failed');
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [username]);

  const watch = async (row: ReplayListItem) => {
    setPicking(row.id);
    try {
      const full = row.local ? getLocalReplay(username, row.id) : await fetchRecord(row.id);
      if (full) onWatch(full);
      else setState('failed');
    } catch {
      setState('failed');
    } finally {
      setPicking('');
    }
  };

  return (
    <LbDialog title="我的回放" sub={`${username} 打过的对局`} onClose={onClose}>
      <div className="lb-list__hd">
        <span className="lb-list__title">共 {rows.length} 局</span>
        <button className="lb-mini" onClick={() => void refresh()}>
          刷新
        </button>
      </div>
      {state === 'loading' && <div className="lb-empty">读取中…</div>}
      {state === 'failed' && <div className="lb-err">取不到回放：服务器未启动、数据库未连接，或这局不在本机</div>}
      {state === 'ready' && rows.length === 0 && <div className="lb-empty">还没有打完的对局</div>}
      {state === 'ready' && rows.length > 0 && (
        <div className="lb-list lb-scroll">
          {rows.map((r) => (
            <div key={`${r.local ? 'l' : 's'}-${r.id}`} className="lb-item">
              <span className="lb-item__main">
                <span className="lb-item__name">
                  <Icon id="i-trophy" size="s" /> {r.winner_name ?? '无人胜出'}
                </span>
                <span className="lb-item__sub">
                  {r.players.map((p) => p.player_name).join(' vs ')} · {r.turns} 回合 · {when(r.finished_at)}
                </span>
              </span>
              {r.local && <span className="lb-item__tag lb-item__tag--local">本机</span>}
              <button className="lb-mini" disabled={picking === r.id} onClick={() => void watch(r)}>
                {picking === r.id ? '载入…' : '观看'}
              </button>
            </div>
          ))}
        </div>
      )}
      <p className="lb-hint">回放基于确定性引擎：同一 seed、建局参数与动作序列可完整复现整局。标「本机」的单人局只存在这台浏览器，清缓存就没了。</p>
    </LbDialog>
  );
}
