import { useState } from 'react';
import {
  allAssetSummaries,
  availableActions,
  CARDS,
  FACILITIES,
  facilityBuildCost,
  gameDate,
  godDef,
  gradeName,
  ITEMS,
  landPrice,
  landUpgradeCost,
  MAX_HAND_CARDS,
  priceIndex,
  researchDef,
  type FacilityType,
  type GameState,
  type PlayerAction,
} from '@richman/shared';

/** 建设项目的示意图标（与棋盘徽章保持一致） */
const FACILITY_ICON: Record<FacilityType, string> = {
  park: '🌳',
  mall: '🛍️',
  hotel: '🏨',
  gas: '⛽',
  lab: '🔬',
};

const PHASE_LABEL: Record<GameState['phase'], string> = {
  lobby: '等待开始',
  awaiting_roll: '等待掷骰',
  awaiting_action: '等待决策',
  awaiting_pick: '小游戏进行中',
  awaiting_auction: '拍卖会竞价',
  awaiting_discard: '手牌已满·请选择舍弃',
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
  const [diceChoice, setDiceChoice] = useState<number | null>(null);
  // UI-13 认输两段式：先确认认输，再指定承接死神的复仇者
  const [surrendering, setSurrendering] = useState(false);
  const cell = game.board[current?.position ?? 0];
  const ownedBy = current && game.players.find((p) => p.properties.some((q) => q.cellId === cell?.id));
  const myProp = ownedBy?.properties.find((q) => q.cellId === cell?.id);
  const date = gameDate(game);
  // 购地价与引擎同源：一律公定地价（help[22]，商业地不设溢价）
  const price = cell && cell.price !== undefined ? landPrice(game, cell) : undefined;
  const upgrade = myProp && cell ? landUpgradeCost(game, cell, myProp.grade) : undefined;
  const waitingForTurn = game.phase === 'awaiting_action' || game.phase === 'awaiting_roll';
  // CORE-03：步行 1 颗骰子、机车 2 颗、汽车 3 颗；掷骰前可自选本次使用几颗（默认用满）
  const maxDice = Math.max(1, current?.diceCount ?? 1);
  const effectiveDice = diceChoice !== null && diceChoice >= 1 && diceChoice <= maxDice ? diceChoice : maxDice;
  const shownDice: (number | null)[] = game.dice ?? Array.from({ length: maxDice }, () => null);
  // 场上驻留的神明（W2）：日切随机现身、经过即附身，先让玩家看得见场上有谁
  const godBoard = game.boardGods.map((god) => ({
    name: godDef(god.godId)?.name ?? god.godId,
    cellName: game.board[god.cellId]?.name ?? `${god.cellId} 格`,
    ttlDays: god.ttlDays,
  }));

  return (
    <div className="panel control-panel">
      <div className="phase-row">
        <span className="phase-badge">{PHASE_LABEL[game.phase]}</span>
        <span>回合 {game.turn}</span>
      </div>

      <div className="control-meta">
        <span>
          {date.month} 月 {date.day} 日 · {date.weekdayLabel}
        </span>
        <span>第 {date.dayIndex + 1} 天</span>
        <span>物价指数 {priceIndex(game).toFixed(2)}</span>
        {date.isHoliday && <span className="badge holiday">例假·休市</span>}
      </div>

      {actions.canTradeStock && !actions.isHoliday && <div className="cell-hint">已进入银行/证交所，可存取、贷款与交易股票</div>}
      {actions.isHoliday && waitingForTurn && <div className="cell-hint holiday-hint">例假日休市：银行与股市暂停服务</div>}

      {/* 神明现身（W2）：日切现身的驻留神明，玩家经过即被附身 —— 先让玩家看得见场上有谁 */}
      {godBoard.length > 0 && (
        <div className="cell-hint">
          场上神明：
          {godBoard.map(({ name, cellName, ttlDays }) => ` ${name}（${cellName}，驻留 ${ttlDays} 天）`).join('、')}
        </div>
      )}

      {current && <div className="current-name">当前：{current.name}</div>}

      {game.phase === 'awaiting_pick' && game.minigame?.kind === 'memory' ? (
        <div className="minigame-box">
          <div className="minigame-hint">
            记忆翻牌 · 已翻 {game.minigame.flips} 次 · 配对 {game.minigame.matched.filter(Boolean).length / 2}/4
          </div>
          <div className="memory-grid">
            {game.minigame.symbols.map((sym, i) => {
              const isMatched = game.minigame!.matched[i]!;
              const isRevealed = game.minigame!.revealed.includes(i);
              const faceUp = isMatched || isRevealed;
              return (
                <button
                  key={i}
                  className={`memory-card ${faceUp ? 'up' : ''} ${isMatched ? 'matched' : ''}`}
                  disabled={!interactive || isMatched || isRevealed}
                  onClick={() => onAction({ type: 'MINIGAME_PICK', hole: i })}
                >
                  {faceUp ? ['🍎', '🍋', '🍇', '🍉'][sym] : '❓'}
                </button>
              );
            })}
          </div>
          <div className="cell-hint">奖励：配对×¥500 − 翻牌×¥100（全部配对奖励最高）</div>
        </div>
      ) : game.phase === 'awaiting_pick' && game.minigame?.kind === 'shells' ? (
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
      ) : game.phase === 'awaiting_pick' && (game.minigame?.kind === 'balloon' || game.minigame?.kind === 'penguin') ? (
        <div className="minigame-box">
          <div className="minigame-hint">
            第 {game.minigame.round + 1}/3 轮 ·{' '}
            {game.minigame.kind === 'balloon' ? '3 个气球中 1 个是炸弹，别踩到它！' : '帮企鹅挖出冰下的宝物'}
          </div>
          <div className="cup-row">
            {([0, 1, 2] as const).map((hole) => (
              <button
                key={hole}
                className="cup-btn"
                disabled={!interactive}
                onClick={() => onAction({ type: 'MINIGAME_PICK', hole })}
              >
                {game.minigame!.kind === 'balloon' ? '🎈' : '🐧'}
                <span>
                  {game.minigame!.kind === 'balloon' ? '气球' : '冰窟'} {hole + 1}
                </span>
              </button>
            ))}
          </div>
          {game.minigame.hits.length > 0 && (
            <div className="minigame-score">
              {game.minigame.hits.map((hit, i) => (
                <span key={i} className={hit ? 'up' : 'down'}>
                  {hit ? '✅' : '❌'}
                </span>
              ))}
            </div>
          )}
          <div className="cell-hint">
            {game.minigame.kind === 'balloon'
              ? '踩中炸弹立即结束并付门票 ¥300；3 轮全过 +¥1500'
              : '奖励表：0中 -200 · 1中 +200 · 2中 +800 · 3中 +2000'}
          </div>
        </div>
      ) : (
        <>
          <div className="dice-row">
            {shownDice.map((v, i) => (
              <span key={i} className={`die ${game.phase === 'awaiting_roll' ? 'ready' : ''}`}>
                {v ?? '·'}
              </span>
            ))}
          </div>

          {game.phase === 'awaiting_roll' && maxDice > 1 && (
            <div className="param-row">
              <label>本次骰子数</label>
              <select value={effectiveDice} onChange={(e) => setDiceChoice(Number(e.target.value))}>
                {Array.from({ length: maxDice }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    {n} 颗
                  </option>
                ))}
              </select>
            </div>
          )}

          {game.phase === 'awaiting_action' && cell && (
            <div className="cell-hint">
              当前位置：{cell.name}
              {price !== undefined && `（¥${price.toLocaleString('zh-CN')}）`}
              {myProp &&
                (myProp.facility
                  ? ` · 我的${FACILITIES[myProp.facility].name}（${gradeName(myProp.grade)}）`
                  : ` · 我的${cell.type === 'commercial' ? '商业用地' : `${gradeName(myProp.grade)}地产`}`)}
              {myProp?.chain && ' · 连锁店'}
              {ownedBy && !myProp && ` · ${ownedBy.name} 的${cell.type === 'commercial' ? '商业用地' : '地产'}`}
            </div>
          )}

          {game.phase === 'awaiting_action' && cell && actions.buildableFacilities.length > 0 && (
            <div className="build-row">
              <span className="build-label">建设项目</span>
              {actions.buildableFacilities.map((f) => (
                <button key={f} disabled={!interactive} onClick={() => onAction({ type: 'BUILD_FACILITY', facility: f })}>
                  {FACILITY_ICON[f]} {FACILITIES[f].name} ¥{facilityBuildCost(game, cell, f).toLocaleString('zh-CN')}
                </button>
              ))}
            </div>
          )}

          {game.phase === 'awaiting_action' && actions.researchableItems.length > 0 && (
            <div className="build-row">
              <span className="build-label">立项研发</span>
              {actions.researchableItems.map((id) => (
                <button key={id} disabled={!interactive} onClick={() => onAction({ type: 'START_RESEARCH', itemId: id })}>
                  {ITEMS[id]?.name ?? id}（{researchDef(id)?.days ?? '?'} 天）
                </button>
              ))}
            </div>
          )}

          {current?.research && (
            <div className="cell-hint">
              研发中：{ITEMS[current.research.itemId]?.name ?? current.research.itemId} · 剩余 {current.research.remainDays} 天
            </div>
          )}

          <div className="action-row">
            <button className="primary" disabled={!interactive || !actions.canRoll} onClick={() => onAction({ type: 'ROLL_DICE', diceCount: maxDice > 1 ? effectiveDice : undefined })}>
              🎲 掷骰{maxDice > 1 ? `（${effectiveDice} 颗）` : ''}
            </button>
            <button disabled={!interactive || !actions.canBuy} onClick={() => onAction({ type: 'BUY_LAND' })}>
              买地 ¥{price?.toLocaleString('zh-CN') ?? '-'}
            </button>
            <button disabled={!interactive || !actions.canUpgrade} onClick={() => onAction({ type: 'UPGRADE_LAND' })}>
              升级 ¥{upgrade?.toLocaleString('zh-CN') ?? '-'}
            </button>
            <button className="ghost" disabled={!interactive || !actions.canEnd} onClick={() => onAction({ type: 'END_TURN' })}>
              结束回合
            </button>
          </div>
        </>
      )}

      {/* CORE-04 / UI-13 认输：认输者指定一位「复仇者」承接死神（help [13]） */}
      {actions.canSurrender && !surrendering && (
        <div className="surrender-row">
          <button
            className="ghost danger"
            disabled={!interactive}
            onClick={() => {
              if (window.confirm('确定认输投降吗？你将退出对局，并把死神引向一位对手。')) {
                setSurrendering(true);
              }
            }}
          >
            认输投降
          </button>
          <span className="surrender-hint">
            你将退出对局；由你指定一位复仇者，死神会附身于他（help[13]「附身在您指定的人身上」）
          </span>
        </div>
      )}

      {/* UI-13 认输：选择把死神引向哪位复仇者 */}
      {actions.canSurrender && surrendering && (
        <div className="revenge-vote">
          <div className="revenge-title">认输投降 · 把死神引向谁？</div>
          <div className="revenge-hint">
            被指定的复仇者会被死神附身：清空全部卡片与道具、当下损失一笔现金，并陷入 13 天霉运（倒霉事加倍）。
          </div>
          <div className="revenge-list">
            {actions.revengeCandidates.map((cand) => (
              <button
                key={cand.id}
                className="mini"
                disabled={!interactive}
                onClick={() => {
                  setSurrendering(false);
                  onAction({ type: 'SURRENDER', revengeTargetId: cand.id });
                }}
              >
                {cand.name}
              </button>
            ))}
            <button className="mini ghost" disabled={!interactive} onClick={() => setSurrendering(false)}>
              取消
            </button>
          </div>
        </div>
      )}

      {/* ECON-12 手牌额满：必须选择舍弃一张才能继续 */}
      {actions.pendingCard && (
        <div className="discard-modal">
          <div className="discard-title">
            手牌已满（{MAX_HAND_CARDS} 张），请选择舍弃一张以容纳新卡
          </div>
          <div className="discard-list">
            {(current?.cards ?? []).map((cardId, i) => (
              <button
                key={`${cardId}-${i}`}
                className="mini"
                disabled={!interactive}
                onClick={() => onAction({ type: 'DISCARD_CARD', cardId })}
              >
                舍弃 {CARDS[cardId]?.name ?? cardId}
              </button>
            ))}
          </div>
        </div>
      )}

      {game.phase === 'game_over' && (
        <div className="settlement">
          <div className="winner-banner">
            <div className="winner-crown">🏆</div>
            🏆 {game.players.find((p) => p.id === game.winnerId)?.name ?? '无人'} 获胜！
          </div>
          <div className="settlement-final">
            <div className="panel-title">最终资产排名</div>
            {allAssetSummaries(game).map((a, i) => (
              <div key={a.playerId} className={`settlement-row ${a.bankrupt ? 'bankrupt' : ''}`}>
                <span className="settlement-rank">{i + 1}</span>
                <span className="settlement-name">{a.playerName}</span>
                <span className="settlement-total">¥{a.total.toLocaleString('zh-CN')}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

