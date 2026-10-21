import { useCallback, useEffect, useRef, useState } from 'react';
import type { GameState, PlayerAction } from '@richman/shared';
import { sfx } from './game/sfx.js';
import { loadHotseatGame, LocalHotseatSession, type GameSession, type HotseatOptions } from './net/session.js';
import { ColyseusSession, hasSavedSession } from './net/remote.js';
import { fetchMe, logout as apiLogout, type AuthUser, type ReplayRecord } from './net/auth.js';
import { getLocalReplay, listLocalReplays, saveLocalReplay } from './net/localReplays.js';
import { ReplayScreen } from './ui/ReplayScreen.js';
import { AcHudLayer } from './ui/AcHudLayer.js';
import { confirmAction } from './ui/landingExit.js';
import { useGameSfx } from './ui/useGameSfx.js';
import { useHotkeys } from './ui/useHotkeys.js';
import { SettingsPanel } from './ui/SettingsPanel.js';
import { HelpPanel } from './ui/HelpPanel.js';
import { LobbyScreen } from './ui/lobby/LobbyScreen.js';
import type { OnlineCreate } from './ui/lobby/OnlineModeDialog.js';
import { duckMusic, initMusic } from './game/bgm.js';

export default function App() {
  const [session, setSession] = useState<GameSession | null>(null);
  const [replayRecord, setReplayRecord] = useState<ReplayRecord | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState('');
  /** 被弹回大厅时的一句话（`connectError` 只在联机面板里渲染，被踢时人可能早关了那个面板） */
  const [connectNotice, setConnectNotice] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [canResume] = useState(() => hasSavedSession());

  const { registerAction } = useHotkeys();

  // UI-02：面板类热键在任何界面都可用
  useEffect(() => registerAction('open_settings', () => setShowSettings(true)), [registerAction]);
  useEffect(() => registerAction('open_help', () => setShowHelp(true)), [registerAction]);

  /* 票一直存在 localStorage 里（联机握手与 /api 都带着它），丢的只是这份 React state。
     挂载时拿票换回登录态，否则每次刷新都要重新登录。 */
  useEffect(() => {
    void fetchMe().then((u) => {
      if (u) setUser(u);
    });
  }, []);

  /** 热座「再来一局」的凭据：记住上次的开局配置，终局面板里原样重开（FE-26） */
  const lastLocalOptsRef = useRef<HotseatOptions | null>(null);

  const startLocal = (opts: HotseatOptions) => {
    lastLocalOptsRef.current = opts;
    session?.destroy();
    setConnectError('');
    setConnectNotice('');
    setSession(new LocalHotseatSession(opts));
  };

  /** 终局面板「再来一局」。联机对局没有这个语义（重开要走服务端），按钮在联机时隐藏 */
  const restartLocal = () => {
    const opts = lastLocalOptsRef.current;
    if (opts) startLocal(opts);
  };

  /** 终局面板「看回放」：单人局在终局那一刻已落本地回放（见 GameScreen 的 effect），
     取该账号最新的一条 —— 就是刚打完的这局。联机局回放不在本地，按钮隐藏 */
  const watchLastReplay = () => {
    if (!user) return;
    const latest = listLocalReplays(user.username)[0];
    if (!latest) return;
    setReplayRecord(getLocalReplay(user.username, latest.id));
  };

  // UI-03 存储 / 读取：手动存 / 读档（仅单人模式）
  const saveGame = useCallback(() => {
    if (!session?.saveToBrowser) return;
    setConnectError(session.saveToBrowser() ? '' : '存档失败：浏览器存储不可用');
  }, [session]);

  const loadGame = useCallback(() => {
    const restored = loadHotseatGame();
    if (!restored) {
      setConnectError('没有可读取的存档');
      return;
    }
    session?.destroy();
    setConnectError('');
    setConnectNotice('');
    setSession(new LocalHotseatSession({ resume: restored }));
  }, [session]);

  const resumeLast = async () => {
    setConnecting(true);
    setConnectError('');
    setConnectNotice('');
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

  /** 建房与凭码加入走两条路：天数、金额、地图、可见性是建房者的参数，加入者说了不算 */
  const connectRemote = async (opts: { playerName: string; roomId?: string }) => {
    setConnecting(true);
    setConnectError('');
    setConnectNotice('');
    try {
      const next = await ColyseusSession.connect(opts);
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

  const handleLogout = async () => {
    await apiLogout();
    setUser(null);
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
        <LobbyScreen
          user={user}
          notice={connectNotice}
          connecting={connecting}
          error={connectError}
          canResume={canResume}
          onAuthed={setUser}
          onLogout={() => void handleLogout()}
          onStartSingle={startLocal}
          onCreateRoom={(o) => void connectRemote({ ...o, roomId: undefined })}
          onJoinRoom={(roomId) => void connectRemote({ playerName: user?.username ?? '', roomId })}
          onResume={() => void resumeLast()}
          onWatchReplay={setReplayRecord}
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
        userName={user?.username ?? null}
        onExit={exit}
        onNotice={setConnectNotice}
        registerAction={registerAction}
        onOpenSettings={() => setShowSettings(true)}
        onOpenHelp={() => setShowHelp(true)}
        onSaveGame={saveGame}
        onLoadGame={loadGame}
        onRestart={restartLocal}
        onWatchReplay={watchLastReplay}
      />
      {overlays}
    </>
  );
}

function GameScreen({
  session,
  userName,
  onExit,
  onNotice,
  registerAction,
  onOpenSettings,
  onOpenHelp,
  onSaveGame,
  onLoadGame,
  onRestart,
  onWatchReplay,
}: {
  session: GameSession;
  /** 登录账号：单人局打完用它当本地回放的归属键 */
  userName: string | null;
  onExit: () => void;
  /** 终局「再来一局」：热座才有；联机传 null（重开要走服务端，另一回事） */
  onRestart?: (() => void) | null;
  /** 终局「看回放」：联机传 null（联机回放不在本地） */
  onWatchReplay?: (() => void) | null;
  /** 被弹回大厅时带一句话（被踢）；不传就只是安静地退出 */
  onNotice?: (text: string) => void;
  registerAction: (name: string, fn: () => void) => () => void;
  onOpenSettings: () => void;
  /** UI-03 存 / 读档（仅单人模式） */
  onSaveGame?: () => void;
  onLoadGame?: () => void;
  onOpenHelp: () => void;
}) {
  const [game, setGame] = useState<GameState>(session.getGame());
  const [netError, setNetError] = useState('');
  const [connection, setConnection] = useState<'connected' | 'reconnecting' | 'closed' | 'kicked'>('connected');
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

  /* 被踢不是「留在原地看一条横幅」：这块棋盘已经没有你的位置了，
     人和话一起送回大厅。 */
  useEffect(() => {
    if (connection !== 'kicked') return;
    onNotice?.('👋 你被房主请出了房间 · 拿到房间码还可以再进来');
    onExit();
  }, [connection, onExit, onNotice]);

  const current = game.players[game.currentPlayerIndex];
  /* AI 座位由会话层自己代打（单人模式补位那几席）。这一层不看住，人就能替 AI 掷骰 ——
     引擎只认「轮到谁」，不认「谁在点」，于是那一步会照常生效。 */
  const autoPlayed = !!current && (session.autoPlayerIds?.has(current.id) ?? false);
  const isMyTurn = session.myPlayerId == null ? !autoPlayed : current != null && current.id === session.myPlayerId;
  const interactive = isMyTurn && game.phase !== 'game_over';
  const isRemote = session.myPlayerId != null;

  /* 单人局只在终局那一刻落一份本地回放：中途落盘会把「打到一半」也收成一局。
     拿 session 本身当已存标记，重渲染与同一会话里的后续动作都不会再写。 */
  const replaySavedFor = useRef<GameSession | null>(null);
  useEffect(() => {
    if (game.phase !== 'game_over' || isRemote || !userName || !session.toReplayRecord) return;
    if (replaySavedFor.current === session) return;
    replaySavedFor.current = session;
    saveLocalReplay(userName, session.toReplayRecord());
  }, [game.phase, isRemote, session, userName]);

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
      onRestart={isRemote ? null : onRestart}
      onWatchReplay={isRemote ? null : onWatchReplay}
      onStartGame={() => session.startGame?.()}
      onAddBot={() => session.addBot?.()}
      onSetReady={(ready) => session.setReady?.(ready)}
      onSetCharacter={(id) => session.setCharacter?.(id)}
      onKick={(id) => session.kick?.(id)}
    />
  );
}
