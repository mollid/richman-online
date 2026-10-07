import {
  availableActions,
  CURSES,
  MAGIC_CONDITION_LABEL,
  VILLAINS,
  type GameState,
  type PlayerAction,
} from '@richman/shared';

/**
 * NPC 特殊单位面板（波8b）：
 * - TILE-10 监狱：落地门外安全，可花保释金保释在押恶人（收益归保释人）；
 * - TILE-11 魔法屋：女巫水晶球给出施法条件与诅咒，由玩家指定受罚对象。
 */
export function NpcPanel({
  game,
  onAction,
  interactive = true,
}: {
  game: GameState;
  onAction: (a: PlayerAction) => void;
  interactive?: boolean;
}) {
  const actions = availableActions(game);
  const current = game.players[game.currentPlayerIndex];
  const magic = actions.magic;
  const bailable = actions.bailableVillains;
  const patients = actions.dischargeablePatients;
  if (!current) return null;
  if (!magic && bailable.length === 0 && patients.length === 0) return null;

  const affordable = current.cash >= actions.bailFee;
  const dischargeable = current.cash >= actions.dischargeFee;

  return (
    <div className="panel npc-panel">
      {/* TILE-09 医院门外办理出院（help [37]） */}
      {patients.length > 0 && (
        <>
          <div className="panel-title">医院 · 办理出院</div>
          <div className="npc-bail-hint">
            出院费 ¥{actions.dischargeFee.toLocaleString('zh-CN')}（当前现金 ¥
            {current.cash.toLocaleString('zh-CN')}）
            {!dischargeable && <span className="error-text"> · 现金不足</span>}
          </div>
          <div className="npc-bail-list">
            {patients.map((id) => {
              const target = game.players.find((p) => p.id === id);
              if (!target) return null;
              const days = target.custody?.daysLeft ?? target.skipTurns;
              return (
                <button
                  key={id}
                  className="mini"
                  disabled={!interactive || !dischargeable}
                  onClick={() => onAction({ type: 'DISCHARGE_PATIENT', targetPlayerId: id })}
                >
                  替 {target.name} 出院（还需住院 {days} 天）
                </button>
              );
            })}
          </div>
        </>
      )}

      {magic && (
        <>
          <div className="panel-title">魔法屋 · 女巫的水晶球</div>
          <div className="npc-magic-condition">{MAGIC_CONDITION_LABEL[magic.condition]}</div>
          <div className="npc-magic-curse">
            若施法，将降下「{CURSES[magic.curse].name}」
            {magic.curse === 'fine' && `（¥${magic.amount.toLocaleString('zh-CN')}）`}
            {(magic.curse === 'jail' || magic.curse === 'hospital' || magic.curse === 'abroad') && `（${magic.days} 天）`}
          </div>
          {magic.candidateIds.length === 0 ? (
            <div className="npc-magic-hint">当前没有符合条件的受罚对象，只能放弃施法。</div>
          ) : (
            <div className="npc-magic-targets">
              {magic.candidateIds.map((id) => {
                const target = game.players.find((p) => p.id === id);
                if (!target) return null;
                return (
                  <button
                    key={id}
                    className="mini danger"
                    disabled={!interactive}
                    onClick={() => onAction({ type: 'CAST_MAGIC', targetPlayerId: id })}
                  >
                    诅咒 {target.name}
                  </button>
                );
              })}
            </div>
          )}
          <div className="npc-magic-hint">不施法可直接结束回合，水晶球机会随即消散。</div>
        </>
      )}

      {bailable.length > 0 && (
        <>
          {magic && <div className="npc-section-gap" />}
          <div className="panel-title">监狱 · 保释在押恶人</div>
          <div className="npc-bail-hint">
            保释金 ¥{actions.bailFee.toLocaleString('zh-CN')}（保释者现金 ¥{current.cash.toLocaleString('zh-CN')}）
            {!affordable && <span className="error-text"> · 现金不足</span>}
          </div>
          <div className="npc-bail-list">
            {bailable.map((kind) => (
              <button
                key={kind}
                className="mini"
                disabled={!interactive || !affordable}
                title={VILLAINS[kind].desc}
                onClick={() => onAction({ type: 'BAIL_PRISONER', npcKind: kind })}
              >
                保释 {VILLAINS[kind].name}
              </button>
            ))}
          </div>
          <div className="npc-bail-hint">恶人出狱后会为保释人效力 7 天，所获收益归保释人。</div>
        </>
      )}
    </div>
  );
}