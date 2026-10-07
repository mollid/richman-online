import { useEffect, useRef, useState } from 'react';
import type { GameState, PlayerAction } from '@richman/shared';
import { BoardRenderer } from './game/BoardRenderer.js';
import { LocalHotseatSession, type GameSession } from './net/session.js';
import { ColyseusSession } from './net/remote.js';
import { PlayerList } from './ui/PlayerList.js';
import { ControlPanel } from './ui/ControlPanel.js';
import { LogPanel } from './ui/LogPanel.js';
import { HandPanel } from './ui/HandPanel.js';
import { StockPanel } from './ui/StockPanel.js';
import { ShopPanel } from './ui/ShopPanel.js';

export default function App() {
  const [session, setSession] = useState<GameSession | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState('');

  const startLocal = (playerCount: number) => {
    session?.destroy();
    setConnectError('');
    setSession(new LocalHotseatSession(playerCount));
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

  if (!session) {
    return (
      <SetupScreen
        onStartLocal={startLocal}
        onConnect={connectRemote}
        connecting={connecting}
        error={connectError}
      />
    );
  }

  return (
    <GameScreen
      key={`${session.roomId ?? 'local'}:${session.myPlayerId ?? 'hotseat'}`}
      session={session}
      onExit={exit}
    />
  );
}

function SetupScreen({
  onStartLocal,
  onConnect,
  connecting,
  error,
}: {
  onStartLocal: (playerCount: number) => void;
  onConnect: (playerName: string, roomId?: string) => void;
  connecting: boolean;
  error: string;
}) {
  const [mode, setMode] = useState<'local' | 'online'>('local');
  const [playerCount, setPlayerCount] = useState(2);
  const [playerName, setPlayerName] = useState('');
  const [roomId, setRoomId] = useState('');

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
      ) : (
        <div className="setup-card">
          <div className="setup-title">联机对战模式</div>
          <input
            className="name-input"
            placeholder="输入你的昵称（最多 8 字）"
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
          {error && <div className="error-text">{error}</div>}
          <p className="hint">创建房间后把房间码发给好友，2 人即可开局（最多 4 人）</p>
        </div>
      )}
    </div>
  );
}

function GameScreen({ session, onExit }: { session: GameSession; onExit: () => void }) {
  const [game, setGame] = useState<GameState>(session.getGame());
  const [netError, setNetError] = useState('');
  const boardRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<BoardRenderer | null>(null);

  useEffect(() => {
    const unsubscribe = session.subscribe(setGame);
    const unsubscribeError = session.onError?.(setNetError);
    return () => {
      unsubscribe();
      unsubscribeError?.();
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

  const onAction = (action: PlayerAction) => session.dispatch(action);
  const current = game.players[game.currentPlayerIndex];
  const isMyTurn =
    session.myPlayerId == null || (current != null && current.id === session.myPlayerId);
  const interactive = isMyTurn && game.phase !== 'game_over';
  const isRemote = session.myPlayerId != null;

  return (
    <div className="game-screen">
      <div className="board-area" ref={boardRef}>
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
              <button
                className="primary"
                disabled={game.players.length < 2}
                onClick={() => session.startGame?.()}
              >
                开始对局{game.players.length < 2 ? '（至少 2 人）' : ''}
              </button>
              <p className="hint">把上方房间码发给好友即可加入</p>
            </div>
          </div>
        )}
      </div>
      <aside className="sidebar">
        <div className="sidebar-header">
          <span className="logo">大富翁 Online</span>
          <span className="mode-tag">{isRemote ? '联机' : '热座'}</span>
          <button className="ghost small" onClick={onExit}>
            退出
          </button>
        </div>
        {netError && <div className="error-text">{netError}</div>}
        {!isMyTurn && game.phase !== 'lobby' && game.phase !== 'game_over' && (
          <div className="wait-banner">等待 {current?.name ?? '对方'} 操作…</div>
        )}
        <PlayerList game={game} myPlayerId={session.myPlayerId} />
        <HandPanel game={game} onAction={onAction} interactive={interactive} />
        <ControlPanel game={game} onAction={onAction} interactive={interactive} />
        <ShopPanel game={game} onAction={onAction} interactive={interactive} />
        <StockPanel game={game} onAction={onAction} interactive={interactive} />
        <LogPanel game={game} />
      </aside>
    </div>
  );
}
