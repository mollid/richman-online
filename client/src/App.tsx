import { useEffect, useRef, useState } from 'react';
import type { GameState, PlayerAction } from '@richman/shared';
import { BoardRenderer } from './game/BoardRenderer.js';
import { LocalHotseatSession, type GameSession } from './net/session.js';
import { PlayerList } from './ui/PlayerList.js';
import { ControlPanel } from './ui/ControlPanel.js';
import { LogPanel } from './ui/LogPanel.js';

export default function App() {
  const [session, setSession] = useState<GameSession | null>(null);
  const [playerCount, setPlayerCount] = useState(2);

  const start = () => {
    session?.destroy();
    setSession(new LocalHotseatSession(playerCount));
  };

  if (!session) {
    return (
      <div className="setup-screen">
        <h1>大富翁 Online</h1>
        <p className="subtitle">TypeScript · React · PixiJS · Colyseus</p>
        <div className="setup-card">
          <div className="setup-title">本地热座模式（M1 原型）</div>
          <div className="player-count-row">
            {[2, 3, 4].map((n) => (
              <button key={n} className={playerCount === n ? 'primary' : ''} onClick={() => setPlayerCount(n)}>
                {n} 人
              </button>
            ))}
          </div>
          <button className="primary start-btn" onClick={start}>
            开始游戏
          </button>
          <p className="hint">联机模式（Colyseus 房间）将在 M3 里程碑接入此界面</p>
        </div>
      </div>
    );
  }

  return <GameScreen key={session.getGame().turn === 0 ? 'lobby' : 'game'} session={session} onExit={() => {
    session.destroy();
    setSession(null);
  }} />;
}

function GameScreen({ session, onExit }: { session: GameSession; onExit: () => void }) {
  const [game, setGame] = useState<GameState>(session.getGame());
  const boardRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<BoardRenderer | null>(null);

  useEffect(() => {
    const unsubscribe = session.subscribe(setGame);
    return () => {
      unsubscribe();
    };
  }, [session]);

  useEffect(() => {
    const el = boardRef.current;
    if (!el) return;
    const renderer = new BoardRenderer(el, session.getGame().board);
    rendererRef.current = renderer;
    void renderer.init().then(() => {
      renderer.setState(session.getGame());
    });
    return () => {
      renderer.destroy();
      rendererRef.current = null;
    };
  }, [session]);

  useEffect(() => {
    rendererRef.current?.setState(game);
  }, [game]);

  const onAction = (action: PlayerAction) => session.dispatch(action);

  return (
    <div className="game-screen">
      <div className="board-area" ref={boardRef} />
      <aside className="sidebar">
        <div className="sidebar-header">
          <span className="logo">大富翁 Online</span>
          <button className="ghost small" onClick={onExit}>
            退出
          </button>
        </div>
        <PlayerList game={game} />
        <ControlPanel game={game} onAction={onAction} />
        <LogPanel game={game} />
      </aside>
    </div>
  );
}
