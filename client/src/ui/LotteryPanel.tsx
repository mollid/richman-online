import { useState } from 'react';
import {
  availableActions,
  LOTTERY_MAX_NUMBER,
  LOTTERY_MIN_NUMBER,
  type GameState,
  type PlayerAction,
} from '@richman/shared';

/**
 * 乐透面板（ECON-08 / TILE-19）：自选号码 + 现金 1000 投注，每月 15 号开奖。
 * 仅在站立于乐透行且现金足够时渲染。
 */
export function LotteryPanel({
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
  const [number, setNumber] = useState(Math.floor((LOTTERY_MIN_NUMBER + LOTTERY_MAX_NUMBER) / 2));

  if (!current || !actions.canBuyLottery) return null;

  const cost = actions.lotteryTicketCost;
  const mine = game.lotteryTickets.filter((t) => t.playerId === current.id);
  const clamped = Math.min(LOTTERY_MAX_NUMBER, Math.max(LOTTERY_MIN_NUMBER, Math.floor(number) || 0));

  return (
    <div className="panel lottery-panel">
      <div className="panel-title">乐透行 · 自选号码投注</div>
      <div className="lottery-pool">
        当前奖池 <b>¥{game.lotteryPool.toLocaleString('zh-CN')}</b> · 单注 ¥{cost.toLocaleString('zh-CN')} · 每月 15 号开奖
      </div>
      <div className="bank-input-row">
        <input
          type="number"
          min={LOTTERY_MIN_NUMBER}
          max={LOTTERY_MAX_NUMBER}
          value={clamped}
          onChange={(e) => setNumber(Math.floor(Number(e.target.value) || 0))}
        />
        <button className="mini" onClick={() => onAction({ type: 'BUY_LOTTERY_TICKET', number: clamped })} disabled={!interactive}>
          投注
        </button>
      </div>
      <div className="lottery-hint">
        号码范围 {LOTTERY_MIN_NUMBER}–{LOTTERY_MAX_NUMBER}；无人中奖则奖金累积到下一期。
      </div>
      {mine.length > 0 && (
        <div className="lottery-mine">
          本期我的投注：{mine.map((t) => t.number).join('、')}
        </div>
      )}
    </div>
  );
}