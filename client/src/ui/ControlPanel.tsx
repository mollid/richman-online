import { availableActions, upgradeCost, type GameState, type PlayerAction } from '@richman/shared';

const PHASE_LABEL: Record<GameState['phase'], string> = {
  lobby: '等待开始',
  awaiting_roll: '等待掷骰',
  awaiting_action: '等待决策',
  awaiting_pick: '小游戏：三仙归洞',
  game_over: '游戏结束',
};

export function ControlPanel({
  game,
  onAction,
  interactive = true,
}: {
  game: GameState;
  onAction: (action: PlayerAction) => void;
  interactive?: boolean;
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

      {game.phase === 'awaiting_pick' && game.minigame ? (
        <div className="minigame-box">
          <div className="minigame-hint">
            第 {game.minigame.round + 1}/3 轮 · 猜中 +∞ 奖励
          </div>
          <div className="cup-row">
            {([0, 1, 2] as const).map((hole) => (
              <button
                key={hole}
                className="cup-btn"
                disabled={!interactive}
                onClick={() => onAction({ type: 'MINIGAME_PICK', hole })}
              >
                🥤
                <span>杯 {hole + 1}</span>
              </button>
            ))}
          </div>
          <div className="minigame-score">
            {game.minigame.hits.map((hit, i) => (
              <span key={i} className={hit ? 'up' : 'down'}>
                {hit ? '✅' : '❌'}
              </span>
            ))}
          </div>
          <div className="cell-hint">奖励表：0中 -200 · 1中 +100 · 2中 +500 · 3中 +1200</div>
        </div>
      ) : (
        <>
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
            <button className="primary" disabled={!interactive || !actions.canRoll} onClick={() => onAction({ type: 'ROLL_DICE' })}>
              🎲 掷骰
            </button>
            <button disabled={!interactive || !actions.canBuy} onClick={() => onAction({ type: 'BUY_LAND' })}>
              买地 ¥{cell?.price ?? '-'}
            </button>
            <button disabled={!interactive || !actions.canUpgrade} onClick={() => onAction({ type: 'UPGRADE_LAND' })}>
              升级 ¥{upgrade ?? '-'}
            </button>
            <button className="ghost" disabled={!interactive || !actions.canEnd} onClick={() => onAction({ type: 'END_TURN' })}>
              结束回合
            </button>
          </div>
        </>
      )}

      {game.phase === 'game_over' && (
        <div className="winner-banner">
          🏆 {game.players.find((p) => p.id === game.winnerId)?.name ?? '无人'} 获胜！
        </div>
      )}
    </div>
  );
}
