import type { GameState } from './types.js';

/**
 * 给 `GameState` 幂等地补齐**新增字段的默认值**。
 *
 * 铁律：本项目所有新机制一律「字段缺失 ⇒ 在任何 `nextRandom` 之前短路 ⇒ 零抽数」，
 * 老录像因此能逐帧复现。本函数是这条铁律的统一兜底处 —— 以后给 `GameState`
 * 加字段，只在这里补默认值，并保证默认值对应的行为就是「该机制未启用」。
 *
 * 只在**外部 GameState 进入内存**的两个入口调用：
 * - `client/src/net/session.ts` 的 `loadHotseatGame`（本地存档可能是重构前存的）；
 * - `shared/src/replay.ts` 的 `ReplayEngine`（外部传入的录像记录）。
 * 引擎内部构造的状态本就带齐全部字段，无需再走这里。
 */
export function normalizeGameState(state: GameState): GameState {
  // 回放铁律：新机制字段的默认值必须是「机制关闭」，而不是「开启但为空」。
  // 神明现身会在日切消耗 RNG 抽数，老录像若开启就无法逐帧复现 ⇒ 缺失一律补 null。
  if (state.boardGods === undefined) state.boardGods = null;
  if (!state.godPairBanUntil) state.godPairBanUntil = {};

  // 老状态没有回合子阶段：按可见相位反推一个合理值（该字段不参与任何规则判定）
  if (!state.turnStage) {
    state.turnStage =
      state.phase === 'game_over' ? 'end' : state.phase === 'awaiting_roll' || state.phase === 'lobby' ? 'start' : 'tile_resolve';
  }
  return state;
}
