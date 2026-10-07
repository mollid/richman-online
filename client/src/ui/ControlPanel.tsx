import { availableActions, upgradeCost, type GameState, type PlayerAction } from '@richman/shared';

const PHASE_LABEL: Record<GameState['phase'], string> = {
  lobby: '等待开始',
  awaiting_roll: '等待掷骰',
  awaiting_action: '等待决策',
  game_over: '游戏结束',
};

export function ControlPanel({
  game,
  onAction,
}: {
  game: GameState;
  onAction: (action: PlayerAction) => void;
}) {
  const actions = availableActions(game);
  const current = game.players[game.currentPlayerIndex];
  const cell = game.board[current?.position ?? 0];
  const ownedBy = current && game.players.find((p) => p.properties.some((q) => q.cellId === cell?.id));
  const myProp = ownedBy?.properties.find((q) => q.cellId === cell?.id);
  const upgrade = myProp && cell?.price !== undefined ? upgradeCost(cell.price, myProp.grade) : undefined;

  return (
    <div className="panel control-panel">
      <div className="phase-row">
        <span className="phase-badge">{PHASE_LABEL[game.phase]}</span>
        <span>回合 {game.turn}</span>
      </div>

      {current && <div className="current-name">当前：{current.name}</div>}

      <div className="dice-row">
        <span className={`die ${game.phase === 'awaiting_roll' ? 'ready' : ''}`}>{game.dice?.[0] ?? '·'}</span>
        <span className={`die ${game.phase === 'awaiting_roll' ? 'ready' : ''}`}>{game.dice?.[1] ?? '·'}</span>
      </div>

      {game.phase === 'awaiting_action' && cell && (
        <div className="cell-hint">
          当前位置：{cell.name}
          {cell.price !== undefined && `（¥${cell.price}）`}
          {myProp && ` · 我的 ${myProp.grade} 级地产`}
          {ownedBy && !myProp && ` · ${ownedBy.name} 的地产`}
        </div>
      )}

      <div className="action-row">
        <button className="primary" disabled={!actions.canRoll} onClick={() => onAction({ type: 'ROLL_DICE' })}>
          🎲 掷骰
        </button>
        <button disabled={!actions.canBuy} onClick={() => onAction({ type: 'BUY_LAND' })}>
          买地 ¥{cell?.price ?? '-'}
        </button>
        <button disabled={!actions.canUpgrade} onClick={() => onAction({ type: 'UPGRADE_LAND' })}>
          升级 ¥{upgrade ?? '-'}
        </button>
        <button className="ghost" disabled={!actions.canEnd} onClick={() => onAction({ type: 'END_TURN' })}>
          结束回合
        </button>
      </div>

      {game.phase === 'game_over' && (
        <div className="winner-banner">
          🏆 {game.players.find((p) => p.id === game.winnerId)?.name ?? '无人'} 获胜！
        </div>
      )}
    </div>
  );
}
