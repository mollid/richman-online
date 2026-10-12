/**
 * 神明现身与驻留（GOD-01..12 的「出现方式」，重构波 W2）。
 *
 * 原版规则（`docs/gameplay/GAP调研记录_2026-09-24.md` §3，官方 Wiki 与 3DM 攻略交叉验证）：
 * - 神明在**日切（天数变更）**时随机现身，**驻留固定格**，玩家**经过即附身**；
 * - 对偶神（大/小财神、大/小福神、大/小穷神、大/小衰神、天使/恶魔）**轮流现身，
 *   同对不会同时在场**；被清退或附身期满后，对偶另一尊才可现身；
 * - 棋盘同时最多 3-4 尊（本作落地取 4）。
 *
 * 原版未给「现身概率」与「位置选择算法」，所以下面每一项都是**可调常量**，
 * 改数值不需要动逻辑。另外：
 * - **落格次序已经定死**（R4）：经过神明驻留的格子 = **先附身，再照常结算那一格**。
 *   这条一确定，「必触发格不能停神明」的旧限制就不成立了 —— 商店 / 银行 / 公司 / 医院 /
 *   游戏厅一律开放，神明因此能停在几乎所有格子上，棋盘的随机性不再被格型筛掉一半；
 * - 只排除两格，且各有各的理由：**起点**是「经过即领薪水」的仪式格，让一尊神钉在起点站
 *   既不直观，也会与薪水播报挤进同一帧；**神庙**自己就会摇出一尊神附身，再驻留一尊变成
 *   「同一格两尊神先后附身同一人」，而 `attachGod` 是覆盖式的 —— 后一尊直接把前一尊的
 *   剩余天数作废。这两格从源头挡掉，比在附身路径上补例外分支干净。
 * - **死神不参与随机现身**：它只由认输投降与魔法屋渠道降临（help[51] / GOD-12）。
 */

import { graphDistance } from './board.js';
import type { GodEffectCtx } from './effect_ctx.js';
import { GODS, currentMonthIndex, godDef, godPairKey, presentGodPairKeys, type GodDef } from './gods.js';
import { nextRandom } from './rng.js';
import type { BoardCell, CellType, GameState } from './types.js';

/** 日切时一尊神明现身的概率 */
export const GOD_SPAWN_CHANCE = 0.45;
/** 棋盘同时最多驻留几尊（原版 3-4，落地取 4） */
export const GOD_MAX_ON_BOARD = 4;
/** 单尊神明的驻留天数（到期离开，并让对偶进入冷却） */
export const GOD_TTL_DAYS = 3;
/** 对偶神的再现身冷却天数（同对不共现的时间维度） */
export const GOD_PAIR_REST_DAYS = 2;
/** 神明之间、神明与玩家之间的最小格距（避免一格里挤两尊、或一出现就被人踩走） */
export const GOD_MIN_GAP_CELLS = 5;

/**
 * 允许驻留的格型（R4 起为「除起点与神庙之外的全部格型」）。
 * 开放的前提是次序已定：先附身、再结算那一格，所以每一格都有确定的答案，不存在歧义分支。
 */
export const GOD_SPAWN_ELIGIBLE_TYPES: readonly CellType[] = [
  'property',
  'commercial',
  'chance',
  'news',
  'free-card',
  'points',
  'lottery',
  'magic',
  'tax',
  'hospital',
  'jail',
  'game',
  'shop',
  'bank',
  'company',
];

/** 不参与随机现身的godId（死神只由认输投降 / 魔法屋降临） */
export const GOD_NEVER_SPAWNS: readonly string[] = ['death'];

/** 棋盘上两格的最短步数：环上即 `min(d, n - d)`，带支路的图上是 BFS */
export function boardDistance(board: BoardCell[], a: number, b: number): number {
  return graphDistance(board, a, b);
}

/** 某格上驻留的神明（无则 undefined） */
export function boardGodAt(state: GameState, cellId: number) {
  return state.boardGods.find((g) => g.cellId === cellId);
}

/** 可现身的候选神明：排除死神、同对在场、对偶冷却中、土地公隔月冷却 */
export function spawnableGodDefs(state: GameState): GodDef[] {
  const present = presentGodPairKeys(state);
  const today = state.calendar.elapsedDays;
  const month = currentMonthIndex(state);
  return GODS.filter((def) => {
    if (GOD_NEVER_SPAWNS.includes(def.id)) return false;
    if (present.has(godPairKey(def.id))) return false;
    if ((state.godPairBanUntil[godPairKey(def.id)] ?? 0) > today) return false;
    // GOD-01 土地公「隔月才会再出现」：复用附身路径已有的同一个月冷却
    if (def.id === 'land-god' && state.landGodCooldownMonth === month) return false;
    return true;
  });
}

/** 可选的驻留格：排除已驻留格，以及与在场神明 / 任一玩家距离过近的格 */
export function spawnCellCandidates(state: GameState): BoardCell[] {
  const taken = new Set(state.boardGods.map((g) => g.cellId));
  const occupied = [...new Set([...taken, ...state.players.map((p) => p.position)])];
  return state.board.filter(
    (c) =>
      GOD_SPAWN_ELIGIBLE_TYPES.includes(c.type) &&
      !taken.has(c.id) &&
      occupied.every((at) => boardDistance(state.board, c.id, at) >= GOD_MIN_GAP_CELLS),
  );
}

/**
 * 日切钩子：先让在场神明计时并清退（清退即触发对偶冷却），再按概率现一尊。
 *
 * 抽数纪律：`spawnGods` 关闭时**零抽数**（数值断言型测试用它隔离这条随机源）；
 * 开启时最多消耗 3 次抽数（现身判定 1 次 + 选人 1 次 + 选位 1 次）。
 * 选人之后若已无合格格，本次放弃且**已消耗的抽数不回滚** —— 回滚等于伪造一条
 * 从未发生的随机序列，回放时会出现「同样的 seed 走出不同局面」。
 */
export function godSpawnHook(ctx: GodEffectCtx): void {
  const { state } = ctx;
  if (!state.spawnGods) return; // 必须在任何 nextRandom 之前短路

  for (const god of [...state.boardGods]) {
    god.ttlDays -= 1;
    if (god.ttlDays > 0) continue;
    removeBoardGod(ctx, god.cellId, '期满回坛');
  }
  if (state.boardGods.length >= GOD_MAX_ON_BOARD) return;

  const chance = nextRandom(state.rngState);
  state.rngState = chance.nextState;
  if (chance.value >= GOD_SPAWN_CHANCE) return;

  const pool = spawnableGodDefs(state);
  if (pool.length === 0) return;
  const pick = nextRandom(state.rngState);
  state.rngState = pick.nextState;
  const def = pool[Math.floor(pick.value * pool.length)]!;

  const cells = spawnCellCandidates(state);
  if (cells.length === 0) return;
  const spot = nextRandom(state.rngState);
  state.rngState = spot.nextState;
  const cell = cells[Math.floor(spot.value * cells.length)]!;

  state.boardGods.push({ godId: def.id, cellId: cell.id, ttlDays: GOD_TTL_DAYS, bornDay: state.calendar.elapsedDays });
  if (def.id === 'land-god') state.landGodCooldownMonth = currentMonthIndex(state);
  ctx.log(state, `【神明】${def.name} 现身「${cell.name}」，驻留 ${GOD_TTL_DAYS} 天`);
}

/**
 * 摘除一尊驻留神明（清退 / 期满）。
 *
 * 顺带写下对偶冷却：原版「被清退或附身期满后，对偶另一尊才可现身」。
 * 被附身而离场**不算清退**，走 `detachGodForPossession` —— 那尊神只是换了个在场方式，
 * 它的对偶仍由 `presentPairs` 挡住，不该额外进入冷却。
 */
export function removeBoardGod(ctx: GodEffectCtx, cellId: number, reason: string): boolean {
  const { state } = ctx;
  const idx = state.boardGods.findIndex((g) => g.cellId === cellId);
  if (idx < 0) return false;
  const [god] = state.boardGods.splice(idx, 1);
  const def = godDef(god!.godId);
  const rest = banRivalPair(ctx, god!.godId);
  ctx.log(
    state,
    `【神明】${def?.name ?? god!.godId} 离开「${state.board[cellId]?.name ?? ''}」（${reason}）` +
      (rest > 0 ? `，对偶神 ${rest} 天内不再现身` : ''),
  );
  return true;
}

/** 被附身而离场：不写对偶冷却、不播报离开（附身本身另有一条日志） */
export function detachGodForPossession(state: GameState, cellId: number): string | null {
  const idx = state.boardGods.findIndex((g) => g.cellId === cellId);
  if (idx < 0) return null;
  const [god] = state.boardGods.splice(idx, 1);
  return god!.godId;
}

/** 给对偶神写冷却；返回冷却天数（无对偶者为 0） */
function banRivalPair(ctx: GodEffectCtx, godId: string): number {
  const def = godDef(godId);
  if (!def?.transformsTo) return 0;
  const key = godPairKey(godId);
  ctx.state.godPairBanUntil[key] = ctx.state.calendar.elapsedDays + GOD_PAIR_REST_DAYS;
  return GOD_PAIR_REST_DAYS;
}

/** 清退指定格集合上的驻留神明（机器娃娃的 9 步清扫、送神卡的请离都走这里） */
export function clearBoardGodsOnCells(ctx: GodEffectCtx, cellIds: readonly number[], reason: string): number {
  let cleared = 0;
  for (const cellId of cellIds) {
    if (removeBoardGod(ctx, cellId, reason)) cleared += 1;
  }
  return cleared;
}

/**
 * 请神卡（CARD-23）的额外前提：棋盘上一尊神明都没有时，这张卡无物可请。
 * 门控与 `apply` 共用这一个判断，因此不会出现「列在可用手牌里、用了却报错」。
 */
export function godSummonRefusal(state: GameState): string | null {
  return state.boardGods.length === 0 ? '棋盘上此刻没有可请的神明' : null;
}
