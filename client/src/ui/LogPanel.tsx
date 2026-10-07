import { useEffect, useRef } from 'react';
import type { GameState } from '@richman/shared';

export function LogPanel({ game }: { game: GameState }) {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [game.log.length]);

  return (
    <div className="panel log-panel">
      <div className="panel-title">对局日志</div>
      <div className="log-list" ref={listRef}>
        {game.log.map((entry, i) => (
          <div key={i} className="log-entry">
            <span className="log-turn">[{entry.turn}]</span> {entry.text}
          </div>
        ))}
      </div>
    </div>
  );
}
