import { useState } from 'react';
import {
  availableActions,
  FACILITIES,
  facilityBuildCost,
  gameDate,
  gradeName,
  ITEMS,
  landPrice,
  landUpgradeCost,
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
  const cell = game.board[current?.position ?? 0];
  const ownedBy = current && game.players.find((p) => p.properties.some((q) => q.cellId === cell?.id));
  const myProp = ownedBy?.properties.find((q) => q.cellId === cell?.id);
  const date = gameDate(game);
  const price = cell && cell.price !== undefined ? landPrice(game, cell) : undefined;
  const upgrade = myProp && cell ? landUpgradeCost(game, cell, myProp.grade) : undefined;
  const waitingForTurn = game.phase === 'awaiting_action' || game.phase === 'awaiting_roll';
  // CORE-03：步行 1 颗骰子、机车 2 颗、汽车 3 颗；掷骰前可自选本次使用几颗（默认用满）
  const maxDice = Math.max(1, current?.diceCount ?? 1);
  const effectiveDice = diceChoice !== null && diceChoice >= 1 && diceChoice <= maxDice ? diceChoice : maxDice;
  const shownDice: (number | null)[] = game.dice ?? Array.from({ length: maxDice }, () => null);

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

      {game.phase === 'game_over' && (
        <div className="winner-banner">
          🏆 {game.players.find((p) => p.id === game.winnerId)?.name ?? '无人'} 获胜！
        </div>
      )}
    </div>
  );
}

