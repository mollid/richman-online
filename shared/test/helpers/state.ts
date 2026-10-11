import { totalAssets } from '../../src/index.js';
import { landingVenueOf } from '../../src/effect_ctx.js';
import type { GameState, PlayerAction } from '../../src/index.js';

/**
 * 把所有人的出生点钉回 0 号起点（SP-01 之前的默认）。
 *
 * 随机出生之后，凡「从已知格走 n 步落到哪格」的历史断言都要先钉这一手。
 * 派生出生点**不消耗 RNG 抽数**，所以钉回去之后整条轨迹与随机出生之前逐位相同，
 * 既有断言继续成立；随机出生本身的规则另有 `spawn.test.ts` 专门钉。
 *
 * 就地修改传入的 state（调用方一律已是新造或 `structuredClone` 出来的副本）。
 */
export function atLegacyStart(state: GameState): GameState {
  for (const p of state.players) p.position = 0;
  return state;
}

/**
 * 冻结物价指数为 1。
 *
 * 引擎里所有交易金额都过 `scaled()`（乘物价指数），而指数的分母是「开局总资产」。
 * 测试常直接篡改现金或无偿授予地产来搭场景，这会让总资产变化 → 指数漂移 →
 * 数值断言失真。本函数把分母就地对齐到**当前**总资产，此后只要只发生玩家之间的
 * 守恒转移，指数就恒为 1，金额断言因此可以写死数字。
 *
 * 就地修改传入的 state（调用方一律已是 `structuredClone` 出来的副本）。
 * 已倒闭者不计入分母 —— 与 `priceIndex` 的存活口径保持一致。
 */
export function pinIndexOne(state: GameState): GameState {
  let total = 0;
  for (const p of state.players) {
    if (!p.bankrupt) total += totalAssets(state, p);
  }
  state.initialCashPerPlayer = Math.max(1, total);
  state.initialPlayerCount = 1;
  return state;
}

/**
 * 把一尊神明放上棋盘（GOD 现身机制，W2）。
 *
 * 测试里「附身某人」的正路是请神卡或经过附身，两者都只看**在场**的神明，
 * 所以要先造在场。
 */
/**
 * 当前相位下「能推进的那一手」动作 —— 把拍卖 / 小游戏 / 舍弃手牌这些强制相位一并照顾到。
 *
 * 只出动作、不推状态：调用方要把它记进录像再 apply。循环里只处理 awaiting_roll / awaiting_action
 * 时，轨迹一变就会撞上「当前不能结束回合」—— 行情池从 6 支扩到 17 支之后这种撞法很常见。
 */
export function nextStepAction(state: GameState): PlayerAction {
  const mg = state.minigame;
  const open =
    mg?.kind === 'memory'
      ? mg.matched.map((m, idx) => (m || mg.revealed.includes(idx) ? -1 : idx)).find((idx) => idx >= 0) ?? 0
      : 0;
  const action =
    state.phase === 'awaiting_roll'
      ? { type: 'ROLL_DICE' as const }
      : state.phase === 'awaiting_auction'
        ? { type: 'AUCTION_PASS' as const }
        : state.phase === 'awaiting_pick'
          ? { type: 'MINIGAME_PICK' as const, hole: open }
          : state.phase === 'awaiting_discard'
            ? { type: 'DISCARD_CARD' as const, cardId: state.players[state.currentPlayerIndex]!.cards[0]! }
            : { type: 'FINISH_LANDING' as const };
  return action;
}

/**
 * 把某位玩家摆到指定格上，并**开一扇落格决策窗**（R4）。
 *
 * 给「必须踩到那一格才做得成」的动作搭场景（如 CORP-14 的原始股认购）。
 * 凭据走与引擎同一个的「格型 → venue」表：会话型格（商店 / 银行）摆出来的场景才是会话窗，
 * 里面的动作不推进回合；单步型格摆出来是单步窗，动作做完回合自己走。
 *
 * 要「走过去」也进动作日志的用例（回放类）请用真实掷骰，别拿这个抄近路 ——
 * 局外改的格子不在录像里，回放必然分叉。
 */
export function standAt(state: GameState, seat: number, cellId: number): GameState {
  state.currentPlayerIndex = seat;
  state.players[seat]!.position = cellId;
  state.phase = 'awaiting_action';
  state.landing = { cellId, venue: landingVenueOf(state.board[cellId]!), turn: state.turn };
  return state;
}

export function putGodOnBoard(state: GameState, godId: string, cellId: number, ttlDays = 3): GameState {
  state.boardGods.push({ godId, cellId, ttlDays, bornDay: state.calendar.elapsedDays });
  return state;
}
