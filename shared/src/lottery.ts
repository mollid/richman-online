/**
 * 乐透系统（ECON-08 / TILE-19）。
 *
 * 规则（对标 `docs/gameplay/玩法系统_游戏开发文档.md` §4 ECON-08、§9 TILE-19）：
 * - 自选号码，现金 **1000 元**投注；
 * - **每月 15 号**开奖（与股东分红同日）；
 * - 无人中奖则奖金**累积**到下一期；
 * - 运气/事件等意外损失的钱也**汇总进奖池**（由 `engine.pay` 的罚金钩子累加）。
 */

import { nextRandom } from './rng.js';

/** 号码区间（含端点）：0–99 共 100 个号码 */
export const LOTTERY_MIN_NUMBER = 0;
export const LOTTERY_MAX_NUMBER = 99;
/** 号码总数 */
export const LOTTERY_NUMBER_COUNT = LOTTERY_MAX_NUMBER - LOTTERY_MIN_NUMBER + 1;
/** 单注价格（现金，不随物价指数缩放） */
export const LOTTERY_TICKET_COST = 1000;

export function isValidLotteryNumber(n: number): boolean {
  return Number.isInteger(n) && n >= LOTTERY_MIN_NUMBER && n <= LOTTERY_MAX_NUMBER;
}

/**
 * 由 RNG 状态**只读派生**开奖号码：消耗随机数会打乱日切时股市波动/新闻的抽数序列，
 * 破坏既有确定性回放与单测。因此开奖不推进 `rngState`，只取当前状态的一个确定性映射。
 */
export function drawWinningNumber(rngState: number): number {
  const { value } = nextRandom(rngState);
  return LOTTERY_MIN_NUMBER + Math.floor(value * LOTTERY_NUMBER_COUNT);
}