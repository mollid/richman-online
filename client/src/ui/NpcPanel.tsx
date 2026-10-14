import {
  availableActions,
  MAGIC_CONDITION_LABEL,
  MAGIC_EFFECTS,
  MAGIC_EFFECT_ORDER,
  VILLAINS,
  type GameState,
  type PlayerAction,
} from '@richman/shared';

/**
 * NPC 特殊单位面板（波8b）：
 * - TILE-10 监狱：落地门外安全，可花保释金保释在押恶人（收益归保释人）；
 * - TILE-11 魔法屋：水晶球随机报一条目标标语，玩家自选一档魔法降下（名单不显示，自己判断谁中招）。
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

  // 保释花点券（D-50），出院仍花现金 —— 两个 afford 不能混用同一个余额
  const affordable = current.points >= actions.bailFee;
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
          {/* 名单不显示是规则本身，不是 UI 缺了一块：引擎压根没把 candidateIds 放进状态（决策表 §7.6） */}
          <div className="npc-magic-hint">水晶球只报这一句 —— 谁对得上要自己判断，符合条件的人一个都跑不掉。</div>
          <div className="npc-magic-targets">
            {MAGIC_EFFECT_ORDER.map((kind) => {
              const def = MAGIC_EFFECTS[kind];
              // 好事档不套 danger 红：轮盘上六坏三好一中性，全涂红就等于告诉玩家"这盘没有选择"
              return (
                <button
                  key={kind}
                  className={def.polarity === 'bad' ? 'mini danger' : 'mini'}
                  disabled={!interactive}
                  onClick={() => onAction({ type: 'CAST_MAGIC', effect: kind })}
                >
                  施放「{def.name}」
                </button>
              );
            })}
          </div>
          <div className="npc-magic-hint">拆除 / 加盖 / 拍卖都作用于各人脚下那一格，落点不成立的人自动跳过。</div>
          <div className="npc-magic-hint">不施法可直接结束回合，水晶球机会随即消散。</div>
        </>
      )}

      {bailable.length > 0 && (
        <>
          {magic && <div className="npc-section-gap" />}
          <div className="panel-title">监狱 · 保释在押恶人</div>
          <div className="npc-bail-hint">
            保释金 {actions.bailFee} 点券（保释者点券 {current.points.toLocaleString('zh-CN')}）
            {!affordable && <span className="error-text"> · 点券不足</span>}
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