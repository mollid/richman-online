import { totalAssets } from '../../src/index.js';
import type { GameState } from '../../src/index.js';

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
