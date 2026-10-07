import { useCallback, useEffect, useRef, useState } from 'react';
import { availableActions, type GameState, type PlayerAction } from '@richman/shared';
import { BoardRenderer } from './game/BoardRenderer.js';
import { sfx } from './game/sfx.js';
import {
  loadHotseatGame,
  LocalHotseatSession,
  saveHotseatGame,
  type GameSession,
} from './net/session.js';
import { ColyseusSession, hasSavedSession, type RoomSummary } from './net/remote.js';
import {
  fetchLeaderboard,
  fetchRecentRecords,
  fetchRecord,
  login as apiLogin,
  logout as apiLogout,
  register as apiRegister,
  type AuthUser,
  type LeaderboardEntry,
  type ReplayRecord,
  type ReplayRecordSummary,
} from './net/auth.js';
import { PlayerList } from './ui/PlayerList.js';
import { ControlPanel } from './ui/ControlPanel.js';
import { CompanyPanel } from './ui/CompanyPanel.js';
import { CalendarPanel } from './ui/CalendarPanel.js';
import { BankPanel } from './ui/BankPanel.js';
import { LogPanel } from './ui/LogPanel.js';
import { HandPanel } from './ui/HandPanel.js';
import { StockPanel } from './ui/StockPanel.js';
import { ShopPanel } from './ui/ShopPanel.js';
import { LotteryPanel } from './ui/LotteryPanel.js';
import { NpcPanel } from './ui/NpcPanel.js';
import { ReportPanel } from './ui/ReportPanel.js';
import { TradePanel } from './ui/TradePanel.js';
import { AuctionPanel } from './ui/AuctionPanel.js';
import { ChatPanel } from './ui/ChatPanel.js';
import { ReplayScreen } from './ui/ReplayScreen.js';
import { useGameSfx } from './ui/useGameSfx.js';
import { useHotkeys } from './ui/useHotkeys.js';
import { SettingsPanel } from './ui/SettingsPanel.js';
import { HelpPanel } from './ui/HelpPanel.js';
import { duckMusic, initMusic } from './game/bgm.js';

type SetupMode = 'local' | 'online' | 'replay';

type SidebarTab = 'status' | 'finance' | 'shop' | 'report' | 'trade' | 'log';

const SIDEBAR_TABS: Array<[SidebarTab, string]> = [
  ['status', '状态'],
  ['finance', '金融'],
  ['shop', '商店'],
  ['report', '报表'],
  ['trade', '交易'],
  ['log', '日志'],
];

export default function App() {
  const [session, setSession] = useState<GameSession | null>(null);
  const [replayRecord, setReplayRecord] = useState<ReplayRecord | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [showHelp, setShowHelp] = useState(false);

  const { registerAction } = useHotkeys();

  // UI-02：面板类热键在任何界面都可用
  useEffect(() => registerAction('open_settings', () => setShowSettings(true)), [registerAction]);
  useEffect(() => registerAction('open_help', () => setShowHelp(true)), [registerAction]);

  const startLocal = (playerCount: number) => {
    session?.destroy();
    setConnectError('');
    setSession(new LocalHotseatSession(playerCount));
  };

  // UI-03 存储 / 读取：手动存 / 读档（仅热座模式）
  const saveGame = useCallback(() => {
    if (!session || session.roomId) return;
    const ok = saveHotseatGame(session.getGame());
    setConnectError(ok ? '' : '存档失败：浏览器存储不可用');
  }, [session]);

  const loadGame = useCallback(() => {
    const restored = loadHotseatGame();
    if (!restored) {
      setConnectError('没有可读取的存档');
      return;
    }
    session?.destroy();
    setConnectError('');
    setSession(new LocalHotseatSession(restored.players.length, 0, restored));
  }, [session]);

  const resumeLast = async () => {
    setConnecting(true);
    setConnectError('');
    try {
      const restored = await ColyseusSession.resumeLast();
      if (restored) {
        session?.destroy();
        setSession(restored);
      } else {
        setConnectError('没有可恢复的对局，请重新创建或加入房间');
      }
    } catch {
      setConnectError('恢复对局失败，请重新加入房间');
    } finally {
      setConnecting(false);
    }
  };

  const connectRemote = async (playerName: string, roomId?: string) => {
    setConnecting(true);
    setConnectError('');
    try {
      const next = await ColyseusSession.connect({ playerName, roomId: roomId?.trim() || undefined });
      session?.destroy();
      setSession(next);
    } catch (e) {
      setConnectError(e instanceof Error ? e.message : '连接失败，请检查服务器是否启动以及房间码是否正确');
    } finally {
      setConnecting(false);
    }
  };

  const exit = () => {
    session?.destroy();
    setSession(null);
  };

  // 设置 / 帮助面板挂在最外层，任何界面都能通过热键或按钮打开
  const overlays = (
    <>
      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}
      {showHelp && <HelpPanel onClose={() => setShowHelp(false)} />}
    </>
  );

  if (replayRecord) {
    return (
      <>
        <ReplayScreen record={replayRecord} onExit={() => setReplayRecord(null)} />
        {overlays}
      </>
    );
  }

  if (!session) {
    return (
      <>
        <SetupScreen
          onStartLocal={startLocal}
          onConnect={connectRemote}
          onResume={resumeLast}
          onWatchReplay={async (id) => {
            setConnectError('');
            try {
              setReplayRecord(await fetchRecord(id));
            } catch (e) {
              setConnectError(e instanceof Error ? e.message : '获取回放失败');
            }
          }}
          connecting={connecting}
          error={connectError}
          onOpenSettings={() => setShowSettings(true)}
          onOpenHelp={() => setShowHelp(true)}
        />
        {overlays}
      </>
    );
  }

  return (
    <>
      <GameScreen
        key={`${session.roomId ?? 'local'}:${session.myPlayerId ?? 'hotseat'}`}
        session={session}
        onExit={exit}
        registerAction={registerAction}
        onOpenSettings={() => setShowSettings(true)}
        onOpenHelp={() => setShowHelp(true)}
        onSaveGame={saveGame}
        onLoadGame={loadGame}
      />
      {overlays}
    </>
  );
}

function SetupScreen({
  onStartLocal,
  onConnect,
  onResume,
  onWatchReplay,
  connecting,
  error,
  onOpenSettings,
  onOpenHelp,
}: {
  onStartLocal: (playerCount: number) => void;
  onConnect: (playerName: string, roomId?: string) => void;
  onResume: () => void;
  onWatchReplay: (recordId: string) => void;
  connecting: boolean;
  error: string;
  onOpenSettings: () => void;
  /** UI-03 存 / 读档（仅热座模式） */
  onSaveGame?: () => void;
  onLoadGame?: () => void;
  onOpenHelp: () => void;
}) {
  const [mode, setMode] = useState<SetupMode>('local');
  const [playerCount, setPlayerCount] = useState(2);
  const [playerName, setPlayerName] = useState('');
  const [roomId, setRoomId] = useState('');
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [canResume] = useState(() => hasSavedSession());
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authName, setAuthName] = useState('');
  const [authPass, setAuthPass] = useState('');
  const [authError, setAuthError] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [records, setRecords] = useState<ReplayRecordSummary[]>([]);

  const refreshRooms = async () => {
    try {
      setRooms(await ColyseusSession.listRooms());
    } catch {
      setRooms([]);
    }
  };

  const refreshLeaderboard = async () => {
    try {
      setLeaderboard(await fetchLeaderboard());
    } catch {
      setLeaderboard([]);
    }
  };

  const refreshRecords = async () => {
    try {
      setRecords(await fetchRecentRecords(20));
    } catch {
      setRecords([]);
    }
  };

  const handleAuth = async (mode: 'login' | 'register') => {
    setAuthBusy(true);
    setAuthError('');
    try {
      const u = mode === 'login' ? await apiLogin(authName.trim(), authPass) : await apiRegister(authName.trim(), authPass);
      setUser(u);
      setPlayerName(u.username);
      setAuthPass('');
    } catch (e) {
      setAuthError(e instanceof Error ? e.message : '操作失败');
    } finally {
      setAuthBusy(false);
    }
  };

  const handleLogout = async () => {
    await apiLogout();
    setUser(null);
  };

  useEffect(() => {
    if (mode === 'online') {
      void refreshRooms();
      void refreshLeaderboard();
    }
    if (mode === 'replay') void refreshRecords();
  }, [mode]);

  return (
    <div className="setup-screen">
      <h1>大富翁 Online</h1>
      <p className="subtitle">TypeScript · React · PixiJS · Colyseus</p>

      <div className="mode-tabs">
        <button className={mode === 'local' ? 'active' : ''} onClick={() => setMode('local')}>
          本地热座
        </button>
        <button className={mode === 'online' ? 'active' : ''} onClick={() => setMode('online')}>
          联机对战
        </button>
        <button className={mode === 'replay' ? 'active' : ''} onClick={() => setMode('replay')}>
          对局回放
        </button>
        <button className="ghost small setup-tool" title="设置" onClick={onOpenSettings}>
          ⚙️
        </button>
        <button className="ghost small setup-tool" title="帮助" onClick={onOpenHelp}>
          ❓
        </button>
      </div>

      {mode === 'local' ? (
        <div className="setup-card">
          <div className="setup-title">本地热座模式</div>
          <div className="player-count-row">
            {[2, 3, 4].map((n) => (
              <button key={n} className={playerCount === n ? 'primary' : ''} onClick={() => setPlayerCount(n)}>
                {n} 人
              </button>
            ))}
          </div>
          <button className="primary start-btn" onClick={() => onStartLocal(playerCount)}>
            开始游戏
          </button>
        </div>
      ) : mode === 'online' ? (
        <div className="setup-card">
          <div className="setup-title">联机对战模式</div>
          {user ? (
            <div className="auth-bar">
              <span>
                账号：<b>{user.username}</b>
              </span>
              <button className="small ghost" onClick={() => void handleLogout()}>
                登出
              </button>
            </div>
          ) : (
            <div className="auth-form">
              <div className="auth-row">
                <input placeholder="账号（2-16 位）" maxLength={16} value={authName} onChange={(e) => setAuthName(e.target.value)} />
                <input
                  placeholder="密码（至少 6 位）"
                  type="password"
                  value={authPass}
                  onChange={(e) => setAuthPass(e.target.value)}
                />
              </div>
              <div className="auth-row">
                <button disabled={authBusy || !authName.trim() || authPass.length < 6} onClick={() => void handleAuth('login')}>
                  登录
                </button>
                <button disabled={authBusy || !authName.trim() || authPass.length < 6} onClick={() => void handleAuth('register')}>
                  注册
                </button>
              </div>
              {authError && <div className="error-text">{authError}</div>}
              <p className="hint">登录后战绩将计入排行榜；不登录也可游客游玩</p>
            </div>
          )}
          <input
            className="name-input"
            placeholder="你的昵称（最多 8 字）"
            maxLength={8}
            value={playerName}
            onChange={(e) => setPlayerName(e.target.value)}
          />
          <button
            className="primary start-btn"
            disabled={!playerName.trim() || connecting}
            onClick={() => onConnect(playerName.trim())}
          >
            {connecting ? '连接中…' : '创建房间'}
          </button>
          <div className="join-row">
            <input
              placeholder="房间码"
              value={roomId}
              onChange={(e) => setRoomId(e.target.value.trim())}
            />
            <button
              disabled={!playerName.trim() || !roomId.trim() || connecting}
              onClick={() => onConnect(playerName.trim(), roomId)}
            >
              加入房间
            </button>
          </div>
          {canResume && (
            <button className="ghost resume-btn" disabled={connecting} onClick={onResume}>
              回到上次对局
            </button>
          )}
          {error && <div className="error-text">{error}</div>}
          <div className="room-browser">
            <div className="room-browser-header">
              <span className="panel-title">公开房间</span>
              <button className="small ghost" onClick={() => void refreshRooms()}>
                刷新
              </button>
            </div>
            {rooms.length === 0 ? (
              <div className="room-empty">暂无等待中的房间</div>
            ) : (
              rooms.map((room) => (
                <div key={room.roomId} className="room-row">
                  <span className="room-id">{room.roomId}</span>
                  <span className="room-players">
                    {room.players}/{room.maxPlayers} 人
                  </span>
                  <button
                    disabled={!playerName.trim() || connecting || room.players >= room.maxPlayers}
                    onClick={() => onConnect(playerName.trim(), room.roomId)}
                  >
                    加入
                  </button>
                </div>
              ))
            )}
          </div>
          {leaderboard.length > 0 && (
            <div className="leaderboard">
              <div className="panel-title">排行榜</div>
              {leaderboard.map((entry, i) => (
                <div key={entry.username} className="lb-row">
                  <span className="lb-rank">{i + 1}</span>
                  <span className="lb-name">{entry.username}</span>
                  <span className="lb-stats">
                    {entry.wins} 胜 / {entry.games} 局
                  </span>
                </div>
              ))}
            </div>
          )}
          <p className="hint">创建房间后把房间码发给好友，2 人即可开局（最多 4 人）</p>
        </div>
      ) : (
        <div className="setup-card replay-card">
          <div className="setup-title">已结束的对局</div>
          <div className="replay-list">
            {records.length === 0 ? (
              <div className="room-empty">暂无已结束的对局记录</div>
            ) : (
              records.map((r) => (
                <div key={r.id} className="record-row">
                  <span className="record-winner">🏆 {r.winner_name ?? '-'}</span>
                  <span className="record-meta">
                    {r.players.map((p) => p.player_name).join(' vs ')} · {r.turns} 回合
                  </span>
                  <button onClick={() => onWatchReplay(r.id)}>观看回放</button>
                </div>
              ))
            )}
          </div>
          <button className="small ghost" onClick={() => void refreshRecords()}>
            刷新
          </button>
          <p className="hint">回放基于确定性引擎：同一 seed 与动作序列可完整复现整局</p>
        </div>
      )}
    </div>
  );
}

function GameScreen({
  session,
  onExit,
  registerAction,
  onOpenSettings,
  onOpenHelp,
  onSaveGame,
  onLoadGame,
}: {
  session: GameSession;
  onExit: () => void;
  registerAction: (name: string, fn: () => void) => () => void;
  onOpenSettings: () => void;
  /** UI-03 存 / 读档（仅热座模式） */
  onSaveGame?: () => void;
  onLoadGame?: () => void;
  onOpenHelp: () => void;
}) {
  const [game, setGame] = useState<GameState>(session.getGame());
  const [netError, setNetError] = useState('');
  const [connection, setConnection] = useState<'connected' | 'reconnecting' | 'closed'>('connected');
  const [muted, setMuted] = useState(sfx.isMuted());
  const boardRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<BoardRenderer | null>(null);

  useGameSfx(game);

  useEffect(() => {
    const unsubscribe = session.subscribe(setGame);
    const unsubscribeError = session.onError?.(setNetError);
    const unsubscribeConnection = session.onConnectionChange?.(setConnection);
    return () => {
      unsubscribe();
      unsubscribeError?.();
      unsubscribeConnection?.();
    };
  }, [session]);

  useEffect(() => {
    const el = boardRef.current;
    if (!el) return;
    const renderer = new BoardRenderer(el, session.getGame().board);
    rendererRef.current = renderer;
    renderer.setState(session.getGame());
    return () => {
      renderer.destroy();
      rendererRef.current = null;
    };
  }, [session]);

  useEffect(() => {
    rendererRef.current?.setState(game);
  }, [game]);

  const current = game.players[game.currentPlayerIndex];
  const isMyTurn =
    session.myPlayerId == null || (current != null && current.id === session.myPlayerId);
  const interactive = isMyTurn && game.phase !== 'game_over';
  const isRemote = session.myPlayerId != null;

  const actions = availableActions(game);
  const [tab, setTab] = useState<SidebarTab>('status');
  const atBank = actions.canDeposit || actions.canWithdraw || actions.canLoan || actions.canRepayLoan;
  const contextTab: SidebarTab | '' = actions.canShop ? 'shop' : atBank ? 'finance' : '';
  const lastContext = useRef('');
  useEffect(() => {
    if (contextTab && contextTab !== lastContext.current) setTab(contextTab);
    lastContext.current = contextTab;
  }, [contextTab]);

  // UI-02 指令热键：把动作名绑到真实实现。
  // onAction 保持“收到就派发”的原语义（面板按钮依赖它，含强制舍弃手牌等流程）；
  // 只有热键路径才额外检查当前是否轮到自己，避免非我方回合误触发。
  const armed = useRef(false);
  useEffect(() => {
    armed.current = interactive && game.phase !== 'awaiting_discard';
  }, [interactive, game.phase]);

  const onAction = useCallback(
    (action: PlayerAction) => {
      session.dispatch(action);
    },
    [session],
  );

  const hotkeyAction = useCallback(
    (action: PlayerAction) => {
      if (!armed.current) return;
      session.dispatch(action);
    },
    [session],
  );

  const doRoll = useCallback(() => hotkeyAction({ type: 'ROLL_DICE' }), [hotkeyAction]);
  const setReportTab = useCallback(() => setTab('report'), []);
  const toggleMute = useCallback(() => {
    const next = sfx.toggleMuted();
    setMuted(next);
    // UI-11：总静音同时压低背景音乐
    duckMusic(next);
  }, []);

  // UI-11：挂载时按 OPTION 设置启动程序生成的 BGM，卸载时停止
  useEffect(() => initMusic(), []);
  useEffect(() => registerAction('roll_dice', doRoll), [registerAction, doRoll]);
  useEffect(() => registerAction('buy_land', () => hotkeyAction({ type: 'BUY_LAND' })), [registerAction, hotkeyAction]);
  useEffect(
    () => registerAction('upgrade_land', () => hotkeyAction({ type: 'UPGRADE_LAND' })),
    [registerAction, hotkeyAction],
  );
  useEffect(() => registerAction('end_turn', () => hotkeyAction({ type: 'END_TURN' })), [registerAction, hotkeyAction]);
  useEffect(() => registerAction('toggle_report', setReportTab), [registerAction, setReportTab]);
  useEffect(() => registerAction('toggle_mute', toggleMute), [registerAction, toggleMute]);

  return (
    <div className="game-screen">
      <div className="board-area" ref={boardRef}>
        {/* UI-07 地图指令：滚轮缩放 / 拖拽平移，此按钮回到自适应满屏 */}
        <button
          className="ghost small board-reset-view"
          title="回到全图（滚轮缩放 / 拖拽平移）"
          onClick={() => rendererRef.current?.resetView()}
        >
          🗺️ 全图
        </button>
        {game.phase === 'lobby' && isRemote && (
          <div className="lobby-overlay">
            <div className="lobby-card">
              <div className="room-code">
                房间码 <span className="code">{session.roomId}</span>
              </div>
              <div className="panel-title">房间玩家（{game.players.length}/4）</div>
              <div className="lobby-players">
                {game.players.map((p) => (
                  <div key={p.id} className="lobby-player">
                    {p.name}
                    {p.id === session.myPlayerId && <span className="me-tag">你</span>}
                  </div>
                ))}
              </div>
              <div className="lobby-actions">
                <button
                  className="primary"
                  disabled={game.players.length < 2}
                  onClick={() => session.startGame?.()}
                >
                  开始对局{game.players.length < 2 ? '（至少 2 人）' : ''}
                </button>
                <button
                  className="ghost"
                  disabled={game.players.length >= 4 || !session.addBot}
                  onClick={() => session.addBot?.()}
                >
                  🤖 添加 AI
                </button>
              </div>
              <p className="hint">把上方房间码发给好友即可加入</p>
            </div>
          </div>
        )}
      </div>
      <aside className="sidebar">
        <div className="sidebar-header">
          <span className="logo">大富翁 Online</span>
          <span className="mode-tag">{isRemote ? '联机' : '热座'}</span>
          <button
            className="ghost small"
            title={muted ? '开启音效' : '静音'}
            onClick={toggleMute}
          >
            {muted ? '🔇' : '🔊'}
          </button>
          <button className="ghost small" title="帮助" onClick={onOpenHelp}>
            ❓
          </button>
          <button className="ghost small" title="设置" onClick={onOpenSettings}>
            ⚙️
          </button>
          {!isRemote && (
            <>
              <button className="ghost small" title="存档" onClick={onSaveGame}>
                💾
              </button>
              <button className="ghost small" title="读档" onClick={onLoadGame}>
                📂
              </button>
            </>
          )}
          <button className="ghost small" onClick={onExit}>
            退出
          </button>
        </div>
        {connection === 'reconnecting' && (
          <div className="conn-banner">⚡ 连接已断开，正在尝试重新连接…</div>
        )}
        {netError && <div className="error-text">{netError}</div>}
        {!isMyTurn && current && !current.online && game.phase !== 'game_over' && (
          <div className="wait-banner offline">{current.name} 掉线了，稍后将自动托管…</div>
        )}
        {!isMyTurn && current?.online && game.phase !== 'lobby' && game.phase !== 'game_over' && (
          <div className="wait-banner">等待 {current.name} 操作…</div>
        )}
        <ControlPanel game={game} onAction={onAction} interactive={interactive} />
        <AuctionPanel game={game} onAction={onAction} myPlayerId={session.myPlayerId} />
        <CompanyPanel game={game} onAction={onAction} interactive={interactive} />
        <LotteryPanel game={game} onAction={onAction} interactive={interactive} />
        {/* ECON-09 help[14]：随时可买卖 → 股市常驻显示，不需切页签、不限格型 */}
        <StockPanel game={game} onAction={onAction} interactive={interactive} />
        <NpcPanel game={game} onAction={onAction} interactive={interactive} />

        <div className="sidebar-tabs">
          {SIDEBAR_TABS.map(([id, label]) => (
            <button key={id} className={`small ${tab === id ? 'primary' : ''}`} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </div>

        {tab === 'status' && (
          <>
            <CalendarPanel game={game} />
            <PlayerList game={game} myPlayerId={session.myPlayerId} />
            <HandPanel game={game} onAction={onAction} interactive={interactive} />
          </>
        )}
        {tab === 'finance' &&
          (atBank ? (
            <BankPanel game={game} onAction={onAction} interactive={interactive} />
          ) : (
            <div className="panel empty-hint">未停留在银行格</div>
          ))}
        {tab === 'shop' &&
          (actions.canShop ? (
            <ShopPanel game={game} onAction={onAction} interactive={interactive} />
          ) : (
            <div className="panel empty-hint">未停留在商店格</div>
          ))}
        {tab === 'report' && <ReportPanel game={game} myPlayerId={session.myPlayerId} />}
        {tab === 'trade' && <TradePanel game={game} onAction={onAction} interactive={interactive} />}
        {tab === 'log' && (
          <>
            <ChatPanel session={session} myPlayerId={session.myPlayerId} />
            <LogPanel game={game} />
          </>
        )}
      </aside>
    </div>
  );
}
