import type { GameState } from '@richman/shared';

function toCssColor(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}

export function PlayerList({ game }: { game: GameState }) {
  const currentId = game.players[game.currentPlayerIndex]?.id;
  return (
    <div className="panel player-list">
      {game.players.map((p) => (
        <div key={p.id} className={`player-card ${p.id === currentId ? 'current' : ''} ${p.bankrupt ? 'bankrupt' : ''}`}>
          <span className="dot" style={{ background: toCssColor(p.color) }} />
          <div className="player-info">
            <div className="player-name">
              {p.name}
              {!p.online && <span className="badge off">离线</span>}
              {p.skipTurns > 0 && <span className="badge skip">停留{p.skipTurns}</span>}
              {p.bankrupt && <span className="badge bankrupt">破产</span>}
            </div>
            <div className="player-sub">
              现金 ¥{p.cash.toLocaleString('zh-CN')} · 地产 {p.properties.length} 处
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
