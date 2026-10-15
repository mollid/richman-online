import type { CSSProperties } from 'react';
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
          {/* 原版六芒星盘面（event_018.png）：12 档落在 6 个星尖与 6 个内交点上，
              标签一律不旋转 —— 转 60° 的中文读不了。窄屏由 CSS 退回换行流。
              名单不显示是规则本身，不是 UI 缺了一块：引擎压根没把 candidateIds 放进状态（决策表 §7.6）。 */}
          <div className="magic-wheel" role="group" aria-label="施法效果轮盘">
            <svg className="magic-wheel__star" viewBox="0 0 100 100" aria-hidden="true" focusable="false">
              <circle cx="50" cy="50" r="47" />
              <polygon points="50,7 87,71 13,71" />
              <polygon points="50,93 13,29 87,29" />
            </svg>
            <div className="magic-wheel__core">
              <span className="magic-wheel__cond">{MAGIC_CONDITION_LABEL[magic.condition]}</span>
              <span className="magic-wheel__ask">选一档施放</span>
            </div>
            {MAGIC_EFFECT_ORDER.map((kind, slot) => {
              const def = MAGIC_EFFECTS[kind];
              // 好事档不能和诅咒长得一样（M-10「面板要能表达增益」）。
              // 类名走 pol-* 三态：先前写的 `danger` 在整份 CSS 里根本没有定义，等于没分色。
              return (
                <button
                  key={kind}
                  className={`mini magic-wheel__slot pol-${def.polarity}`}
                  // 偶数位上星尖、奇数位进内交点，与原版盘面交替排布的读法一致；
                  // 角度按数组序推进，所以 Tab 走的顺序就是眼睛扫的顺序。
                  style={{ '--a': `${slot * 30}deg`, '--r': slot % 2 === 0 ? '41%' : '26%' } as CSSProperties}
                  disabled={!interactive}
                  aria-label={`施放「${def.name}」`}
                  title={def.polarity === 'good' ? '这一档对命中者是好事' : def.polarity === 'bad' ? '这一档对命中者是惩罚' : '中性：好坏取决于局面'}
                  onClick={() => onAction({ type: 'CAST_MAGIC', effect: kind })}
                >
                  {def.name}
                </button>
              );
            })}
          </div>
          <div className="npc-magic-hint">水晶球只报一句标语 —— 谁对得上要自己判断，符合条件的人一个都跑不掉。</div>
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