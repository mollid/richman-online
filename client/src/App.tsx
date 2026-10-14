import { useCallback, useEffect, useRef, useState } from 'react';
import { CHARACTERS, MAP_CHOICES, MAX_DAY_CHOICES, ONLINE_DEFAULT_MAX_DAYS, type GameState, type PlayerAction } from '@richman/shared';
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
import { ReplayScreen } from './ui/ReplayScreen.js';
import { AcHudLayer } from './ui/AcHudLayer.js';
import { confirmAction } from './ui/landingExit.js';
import { useGameSfx } from './ui/useGameSfx.js';
import { useHotkeys } from './ui/useHotkeys.js';
import { SettingsPanel } from './ui/SettingsPanel.js';
import { HelpPanel } from './ui/HelpPanel.js';
import { duckMusic, initMusic } from './game/bgm.js';

type SetupMode = 'local' | 'online' | 'replay';

/** 天数上限的显示文案（`null` = 不限，只靠「对手全破产」收场） */
function dayLimitLabel(days: number | null): string {
  return days === null ? '不限' : `${days} 天`;
}

/**
 * 天数上限选择（CORE-04 / 玩法文档 §14 第 2 项）。
 * 热座默认「不限」（复刻原版的唯一结束条件），联机默认 60 天（长局收得了口）。
 */
function DayLimitRow({ value, onChange }: { value: number | null; onChange: (days: number | null) => void }) {
  return (
    <div className="player-count-row day-limit-row">
      <span className="setup-title">天数上限</span>
      {MAX_DAY_CHOICES.map((days) => (
        <button key={days ?? 'none'} className={value === days ? 'primary' : ''} onClick={() => onChange(days)}>
          {dayLimitLabel(days)}
        </button>
      ))}
    </div>
  );
}

/**
 * 地图选择（R5-b）。`null` = 自建的 64 格环（默认图），其余是解自 map.mkf 的原版图。
 * 只在建局时生效：棋盘随状态一起下发，中途换图等于开另一局。
 */
function MapRow({ value, onChange }: { value: number | null; onChange: (mapId: number | null) => void }) {
  return (
    <div className="player-count-row day-limit-row">
      <span className="setup-title">地图</span>
      {MAP_CHOICES.map((m) => (
        <button key={m.id ?? 'default'} className={value === m.id ? 'primary' : ''} onClick={() => onChange(m.id)}>
          {m.name} · {m.cells} 格
        </button>
      ))}
    </div>
  );
}

/**
 * 角色选择行（热座开局）。
 *
 * 为什么要有这一行：波 3 之前角色是**按座位静默分配**的，玩家根本不知道自己在操作谁 ——
 * 决策人要的是"可选，不是随机"。默认仍替前 N 个座位填好（角色表是男女交替排的，
 * 见 `characters.ts`），所以不 care 的人照样一键开局，care 的人点卡片换。
 *
 * 交互取"点击顺序即座位号"而不是"每座一个下拉"：下拉要把 10 个名字藏进 N 层点击，
 * 而棋盘上真正想知道的是"这一号位是谁"，卡片上的座位徽章一眼就能看完。
 */
function CharacterRow({ count, picks, onChange }: { count: number; picks: string[]; onChange: (next: string[]) => void }) {
  const seatOf = (id: string) => picks.indexOf(id);
  const toggle = (id: string) => {
    if (seatOf(id) >= 0) return onChange(picks.filter((p) => p !== id));
    // 满了不吃点击：座位数由上面那排「N 人」决定，这里只负责"谁来坐"
    if (picks.length >= count) return;
    onChange([...picks, id]);
  };
  return (
    <div className="char-row">
      <div className="char-row__hint">点角色卡按点击顺序占座 · 再点一次腾出位子</div>
      <div className="char-grid">
        {CHARACTERS.map((c) => {
          const seat = seatOf(c.id);
          return (
            <button
              key={c.id}
              type="button"
              className={`char-card${seat >= 0 ? ' char-card--on' : ''}`}
              title={c.blurb}
              aria-pressed={seat >= 0}
              onClick={() => toggle(c.id)}
            >
              <span className="char-card__face">{c.avatar}</span>
              <span className="char-card__name">{c.name}</span>
              <span className="char-card__meta">
                {c.gender === 'male' ? '男' : '女'} · {c.age} 岁
              </span>
              {seat >= 0 && <span className="char-card__seat">{seat + 1} 号位</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

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

  const startLocal = (playerCount: number, maxDays: number | null, mapId: number | null, characterIds?: string[]) => {
    session?.destroy();
    setConnectError('');
    setSession(new LocalHotseatSession(playerCount, undefined, null, maxDays, mapId, characterIds));
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

  const connectRemote = async (playerName: string, roomId?: string, maxDays?: number | null, mapId?: number | null) => {
    setConnecting(true);
    setConnectError('');
    try {
      const next = await ColyseusSession.connect({ playerName, roomId: roomId?.trim() || undefined, maxDays, mapId });
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
  onStartLocal: (playerCount: number, maxDays: number | null, mapId: number | null, characterIds?: string[]) => void;
  onConnect: (playerName: string, roomId?: string, maxDays?: number | null, mapId?: number | null) => void;
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
  // 已选角色（按座位序）。默认填前 N 个座位 ⇒ 一键开局仍然成立，改动才是玩家自己的选择
  const [localPicks, setLocalPicks] = useState<string[]>(CHARACTERS.slice(0, 2).map((c) => c.id));

  /** 改人数时同步 picks：减就砍尾，加就按座位序补没被占的角色 */
  const setLocalCount = (n: number) => {
    setPlayerCount(n);
    setLocalPicks((prev) => {
      if (prev.length > n) return prev.slice(0, n);
      const taken = new Set(prev);
      return [...prev, ...CHARACTERS.filter((c) => !taken.has(c.id)).slice(0, n - prev.length).map((c) => c.id)];
    });
  };
  // 天数上限（CORE-04 / §14 第 2 项）：热座默认不限，联机默认 60 天
  const [localMaxDays, setLocalMaxDays] = useState<number | null>(null);
  const [onlineMaxDays, setOnlineMaxDays] = useState<number | null>(ONLINE_DEFAULT_MAX_DAYS);
  // 地图（R5-b）：null = 自建的 64 格环。热座与联机各记一份，只有建房者/开局者说了算
  const [localMap, setLocalMap] = useState<number | null>(null);
  const [onlineMap, setOnlineMap] = useState<number | null>(null);
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
              <button key={n} className={playerCount === n ? 'primary' : ''} onClick={() => setLocalCount(n)}>
                {n} 人
              </button>
            ))}
          </div>
          <CharacterRow count={playerCount} picks={localPicks} onChange={setLocalPicks} />
          <DayLimitRow value={localMaxDays} onChange={setLocalMaxDays} />
          <MapRow value={localMap} onChange={setLocalMap} />
          <button
            className="primary start-btn"
            disabled={localPicks.length !== playerCount}
            onClick={() => onStartLocal(playerCount, localMaxDays, localMap, localPicks)}
          >
            {localPicks.length === playerCount ? '开始游戏' : `还差 ${playerCount - localPicks.length} 个角色`}
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
          <DayLimitRow value={onlineMaxDays} onChange={setOnlineMaxDays} />
          <MapRow value={onlineMap} onChange={setOnlineMap} />
          <button
            className="primary start-btn"
            disabled={!playerName.trim() || connecting}
            onClick={() => onConnect(playerName.trim(), undefined, onlineMaxDays, onlineMap)}
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

  const current = game.players[game.currentPlayerIndex];
  const isMyTurn =
    session.myPlayerId == null || (current != null && current.id === session.myPlayerId);
  const interactive = isMyTurn && game.phase !== 'game_over';
  const isRemote = session.myPlayerId != null;

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
  /* R4：回车 = 「只推进流程、不花钱」。落格窗里走出去品，否则掷骰。
     绝不让回车顺手把地买了 —— 那是玩家最不想被代劳的一次支出。 */
  useEffect(
    () => registerAction('confirm', () => hotkeyAction(confirmAction(game))),
    [registerAction, hotkeyAction, game],
  );
  useEffect(() => registerAction('toggle_mute', toggleMute), [registerAction, toggleMute]);

  return (
    <AcHudLayer
      game={game}
      myPlayerId={session.myPlayerId}
      isRemote={isRemote}
      interactive={interactive}
      muted={muted}
      connection={connection}
      netError={netError}
      roomId={session.roomId}
      onAction={onAction}
      onToggleMute={toggleMute}
      onOpenSettings={onOpenSettings}
      onOpenHelp={onOpenHelp}
      onSaveGame={onSaveGame}
      onLoadGame={onLoadGame}
      onExit={onExit}
      onStartGame={() => session.startGame?.()}
      onAddBot={() => session.addBot?.()}
    />
  );
}
