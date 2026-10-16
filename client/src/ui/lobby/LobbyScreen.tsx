import { useEffect, useState } from 'react';
import type { AuthUser, ReplayRecord } from '../../net/auth.js';
import type { HotseatOptions } from '../../net/session.js';
import { AuthDialog } from './AuthDialog.js';
import { LeaderboardDialog } from './LeaderboardDialog.js';
import { MyReplaysDialog } from './MyReplaysDialog.js';
import { OnlineModeDialog, type OnlineCreate } from './OnlineModeDialog.js';
import { SingleModeDialog } from './SingleModeDialog.js';
import { Icon } from '../mp/Icon.js';
import './lobby.css';

type Panel = 'single' | 'online' | 'rank' | 'replays' | 'auth' | null;

const NAV: Array<{ panel: Exclude<Panel, null>; cls: string; icon: string; label: string; sub: string; needsUser: boolean }> = [
  { panel: 'single', cls: 'lb-nav__btn--single', icon: 'i-dice', label: '单人模式', sub: '本机开局 · 可补 AI', needsUser: true },
  { panel: 'online', cls: 'lb-nav__btn--online', icon: 'i-globe', label: '联机模式', sub: '建房 / 凭码加入', needsUser: true },
  { panel: 'rank', cls: 'lb-nav__btn--rank', icon: 'i-trophy', label: '排行榜', sub: '按账号看胜场', needsUser: false },
];

export interface LobbyProps {
  user: AuthUser | null;
  notice: string;
  connecting: boolean;
  error: string;
  canResume: boolean;
  onAuthed: (user: AuthUser) => void;
  onLogout: () => void;
  onStartSingle: (opts: HotseatOptions) => void;
  onCreateRoom: (opts: OnlineCreate) => void;
  onJoinRoom: (roomId: string) => void;
  onResume: () => void;
  onWatchReplay: (record: ReplayRecord) => void;
  onOpenSettings: () => void;
  onOpenHelp: () => void;
}

/**
 * 大厅首屏。
 *
 * 布局照背景图的留白来：上方那块近白的天空放游戏名（实测干净区在 y 0~26%、x 25~75%），
 * 左侧三个按钮压在店面那一列上（那里没有留白，所以按钮自带奶油描边与实心底才读得出来），
 * 右上角留给登录与账号。
 */
export function LobbyScreen(props: LobbyProps) {
  const { user, notice } = props;
  const [panel, setPanel] = useState<Panel>(null);
  /** 被登录打断的那件事：登录成功后接着做，不让人再点一次 */
  const [pending, setPending] = useState<{ panel: Exclude<Panel, null>; reason: string } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const open = (next: Exclude<Panel, null>, needsUser: boolean) => {
    setMenuOpen(false);
    if (needsUser && !user) {
      const label = NAV.find((n) => n.panel === next)?.label ?? '';
      setPending({ panel: next, reason: `「${label}」需要先有账号` });
      setPanel('auth');
      return;
    }
    setPanel(next);
  };

  // 面板开着的时候人如果被弹回大厅（被踢 / 房间没了），别把那条通知藏在弹层底下
  useEffect(() => {
    if (notice) setPanel(null);
  }, [notice]);

  return (
    <div className="lb-screen">
      <h1 className="lb-title">
        <span className="lb-title__cn">
          大<em>富</em>翁
        </span>
        <span className="lb-title__en">ONLINE</span>
      </h1>

      {notice && <div className="lb-note" style={{ position: 'absolute', top: '26%', left: '50%', transform: 'translateX(-50%)' }}>{notice}</div>}

      <nav className="lb-nav">
        {NAV.map((n) => (
          <button key={n.panel} type="button" className={`lb-nav__btn ${n.cls}`} onClick={() => open(n.panel, n.needsUser)}>
            <span className="lb-nav__ico">
              <Icon id={n.icon} />
            </span>
            <span className="lb-nav__txt">
              <span>{n.label}</span>
              <span className="lb-nav__sub">{n.sub}</span>
            </span>
          </button>
        ))}
      </nav>

      <div className="lb-corner">
        <button className="lb-icon" title="设置" onClick={props.onOpenSettings}>
          <Icon id="i-gear" size="s" />
        </button>
        <button className="lb-icon" title="帮助" onClick={props.onOpenHelp}>
          <Icon id="i-question" size="s" />
        </button>
        <div className="lb-user">
          <button className={`lb-chip${user ? '' : ' lb-chip--guest'}`} onClick={() => (user ? setMenuOpen((v) => !v) : open('auth', false))}>
            <span className="lb-chip__ava">
              {user ? user.username.slice(0, 1).toUpperCase() : <Icon id="i-user" size="s" />}
            </span>
            {user ? user.username : '登录 / 注册'}
          </button>
          {user && menuOpen && (
            <>
              {/* 点菜单外面就收起：一层透明全屏垫在下面，比 window 监听少一处要清理的东西 */}
              <div style={{ position: 'fixed', inset: 0, zIndex: 10 }} onClick={() => setMenuOpen(false)} />
              <div className="lb-menu">
                <div className="lb-menu__who">
                  <div className="lb-menu__name">{user.username}</div>
                  <div className="lb-menu__since">账号 #{user.id.slice(0, 8)}</div>
                </div>
                <button
                  className="lb-menu__item"
                  onClick={() => {
                    setMenuOpen(false);
                    setPanel('replays');
                  }}
                >
                  <Icon id="i-arrow-right" size="s" /> 我的回放
                </button>
                <button
                  className="lb-menu__item"
                  onClick={() => {
                    setMenuOpen(false);
                    setPanel('rank');
                  }}
                >
                  <Icon id="i-trophy" size="s" /> 我的战绩榜
                </button>
                <button
                  className="lb-menu__item lb-menu__item--danger"
                  onClick={() => {
                    setMenuOpen(false);
                    props.onLogout();
                  }}
                >
                  <Icon id="i-exit" size="s" /> 退出登录
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {panel === 'auth' && (
        <AuthDialog
          reason={pending?.reason ?? '登录后即可开局'}
          onDone={(u) => {
            props.onAuthed(u);
            const next = pending?.panel;
            setPending(null);
            setPanel(next && next !== 'auth' ? next : null);
          }}
          onClose={() => {
            setPending(null);
            setPanel(null);
          }}
        />
      )}

      {panel === 'single' && user && (
        <SingleModeDialog
          onClose={() => setPanel(null)}
          onStart={(opts) => {
            setPanel(null);
            props.onStartSingle(opts);
          }}
        />
      )}

      {panel === 'online' && user && (
        <OnlineModeDialog
          user={user}
          connecting={props.connecting}
          error={props.error}
          canResume={props.canResume}
          onClose={() => setPanel(null)}
          onCreate={(opts) => {
            setPanel(null);
            props.onCreateRoom(opts);
          }}
          onJoin={(roomId) => {
            setPanel(null);
            props.onJoinRoom(roomId);
          }}
          onResume={() => {
            setPanel(null);
            props.onResume();
          }}
        />
      )}

      {panel === 'rank' && <LeaderboardDialog user={user} onClose={() => setPanel(null)} />}

      {panel === 'replays' && user && (
        <MyReplaysDialog
          username={user.username}
          onClose={() => setPanel(null)}
          onWatch={(r) => {
            setPanel(null);
            props.onWatchReplay(r);
          }}
        />
      )}
    </div>
  );
}
