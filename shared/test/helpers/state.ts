import { totalAssets } from '../../src/index.js';
import type { GameState } from '../../src/index.js';

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
export function putGodOnBoard(state: GameState, godId: string, cellId: number, ttlDays = 3): GameState {
  state.boardGods.push({ godId, cellId, ttlDays, bornDay: state.calendar.elapsedDays });
  return state;
}
