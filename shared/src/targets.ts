import type { FacilityType, GameState, Player, PlayerProperty } from './types.js';
import { pathAhead } from './board.js';
import { playersInViewport, streetCells, viewportCells } from './tiles.js';

/**
 * 目标选取的同源层（W1，见 `大富翁Online-棋盘目标选取交互规格.md` §2）。
 *
 * 为什么要有它：目标合法性原本只写在每张卡 / 每件道具的 `apply` 里（抛异常），
 * 于是门控查不到目标这一维 —— `checkUseCard` 只能说「这张卡在手里、时机对」，
 * 玩家按下去却因「目标不在视野内 / 不是同类地块」被引擎打回。项目一直守着
 * 「门控与引擎校验同源」这条不变式，目标维度是它唯一的破口。
 *
 * 这里把**一个谓词两用**：
 * - 不带目标字段调用 ⇒ 回答「此刻有没有任何合法目标」（门控列表 / 候选枚举）；
 * - 带目标字段调用 ⇒ 逐条校验（派单）。
 * `TargetSpec` 里的 `cells` / `players` 只说明**去哪儿找候选**（枚举的搜索范围），
 * 不构成第二套规则 —— 能不能选一律由同一个 `check` 裁决，所以两边不可能各说各话。
 *
 * 硬约束：纯计算、**不得消耗 `state.rngState`**，否则 golden 逐帧基线会因查询而漂移。
 */

/** `USE_CARD` / `USE_ITEM` 派单参数里与目标有关的公共字段 */
export interface TargetFields {
  cellId?: number;
  targetPlayerId?: string;
  stockId?: string;
  diceValue?: number;
  facility?: FacilityType;
}

/**
 * 目标合法性唯一来源：`null` = 放行，字符串 = 拒绝理由（这句会同时出现在门控返回值、
 * 引擎异常文本与 UI 的 tooltip 里 —— 同源的含义就是只有一份措辞）。
 */
export type TargetCheck = (state: GameState, actor: Player, want: TargetFields) => string | null;

/** 候选格的搜索范围（只是"去哪儿找"，不是"能不能选"） */
export type CellPool =
  | 'foot'                 // 只有脚下那一格
  | 'any'                  // 全图任意格
  | 'view'                 // 视野内的任意格（近景窗 16 格）—— 路障 / 地雷这类布设道具
  | 'land'                 // 全图住宅 / 商业地块
  | 'street'               // 所在路段的全部格（涨价 / 查封 / 天使 / 恶魔按街作用）
  | 'land-or-obstacle'     // 地块 ∪ 路障 / 地雷所在格（拆除卡）
  | 'own-land';            // 自己名下的地块（机器工人）

/** 候选玩家的搜索范围 */
export type PlayerPool = 'visible' | 'visible-or-self';

/** 挂在 `CardDef` / `ItemDef` 上的目标声明 */
export interface TargetSpec {
  cells?: CellPool;
  players?: PlayerPool;
  /** 需要指定股票（红卡 / 黑卡） */
  stocks?: boolean;
  /** 需要指定设施项目（改建卡变更商业设施） */
  facilities?: boolean;
  /** 需要指定骰点（遥控骰子） */
  dice?: boolean;
  /**
   * 目标谓词。省略 = 本动作不需要任何目标，直接放行（时机 / 持有等通用项由引擎门控判）。
   */
  check?: TargetCheck;
}

/** 一次查询的结果：可选候选 + 被拒候选及其理由，供 UI 高亮与灰显 */
export interface TargetSet {
  cells: number[];
  rejectedCells: { id: number; reason: string }[];
  players: string[];
  rejectedPlayers: { id: string; reason: string }[];
  stocks: string[];
  facilities: FacilityType[];
  diceValues: number[];
}

/** 空集：语义是「本动作不需要目标」，UI 据此直接派单而不进选态 */
export function emptyTargets(): TargetSet {
  return { cells: [], rejectedCells: [], players: [], rejectedPlayers: [], stocks: [], facilities: [], diceValues: [] };
}

/** 视野内的存活候选玩家；`visible-or-self` 时把自己也算进来（停留卡） */
export function candidatePlayers(state: GameState, actor: Player, pool: PlayerPool): Player[] {
  const others = playersInViewport(state, actor);
  if (pool !== 'visible-or-self') return others;
  return actor.bankrupt ? others : [...others, actor];
}

/**
 * 枚举用的玩家池：所有存活玩家（`visible` 时排除自己）。
 *
 * 为什么不直接用 `candidatePlayers` 当枚举池：那样视野外的对手**根本不会被遍历到**，
 * UI 就只知道"没这个人"而不知道"为什么不能选他"。棋盘要把窗外的人淡掉并给出
 * 「不在视野内」，就必须让他们进 `rejectedPlayers` —— 裁决仍在 `needPlayer` 里，
 * 这里只放宽"去哪儿找候选"。
 */
export function probePlayers(state: GameState, actor: Player, pool: PlayerPool): Player[] {
  return state.players.filter((q) => !q.bankrupt && (pool === 'visible-or-self' || q.id !== actor.id));
}

/** 按 `pool` 取出候选格（纯数据筛选，不做规则判断） */
export function candidateCells(state: GameState, actor: Player, pool: CellPool): number[] {
  const land = state.board.filter((c) => c.type === 'property' || c.type === 'commercial').map((c) => c.id);
  switch (pool) {
    case 'foot':
      return [actor.position];
    case 'any':
      return state.board.map((c) => c.id);
    case 'view':
      return viewportCells(state.board, actor.position);
    case 'land':
    case 'street':
      // 街是「同路段」概念的载体：先给全部地块，由 check 把不满足路段条件的筛掉
      return land;
    case 'own-land':
      return actor.properties.map((q) => q.cellId);
    case 'land-or-obstacle':
      return [...new Set([...land, ...state.roadblocks.map((o) => o.cellId), ...state.mines.map((o) => o.cellId)])];
  }
}

/**
 * 枚举候选并用同一个 `check` 逐个裁决 —— `actionTargets` 的全部工作。
 * 每个候选都只往 `check` 里填**该维度的那一个字段**，所以多目标动作（例如既要选格又要选人的
 * 传送机）会把各维度分开报错，UI 也就能分开提示。
 */
export function actionTargets(state: GameState, actor: Player, spec: TargetSpec): TargetSet {
  const set = emptyTargets();
  const refuse = (want: TargetFields): string | null => spec.check?.(state, actor, want) ?? null;

  if (spec.cells) {
    for (const id of candidateCells(state, actor, spec.cells)) {
      const reason = refuse({ cellId: id });
      if (reason === null) set.cells.push(id);
      else set.rejectedCells.push({ id, reason });
    }
  }
  if (spec.players) {
    // 枚举池放宽到「所有存活玩家」：视野外的对手要落进 rejectedPlayers 并带上理由，
    // UI 才能把那个人淡掉、hover 出「不在视野内」，而不是让人凭空消失。
    for (const q of probePlayers(state, actor, spec.players)) {
      const reason = refuse({ targetPlayerId: q.id });
      if (reason === null) set.players.push(q.id);
      else set.rejectedPlayers.push({ id: q.id, reason });
    }
  }
  if (spec.stocks) set.stocks = state.stockMarket.stocks.map((s) => s.id);
  if (spec.facilities) set.facilities = FACILITIES_TO_OFFER;
  if (spec.dice) set.diceValues = [1, 2, 3, 4, 5, 6];
  return set;
}

/** 改建卡可变更成的设施项目（公园/加油站也允许改成，故与新建同池） */
const FACILITIES_TO_OFFER: FacilityType[] = ['park', 'mall', 'hotel', 'gas', 'lab'];

// ---------------------------------------------------------------------------
// 谓词积木：卡片与道具用它拼出自己的 check，措辞统一由这里出
// ---------------------------------------------------------------------------

/** 必须选一名视野内玩家（`pool` 决定是否允许选自己） */
export function needPlayer(pool: PlayerPool = 'visible'): TargetCheck {
  return (state, actor, want) => {
    if (want.targetPlayerId === undefined) return '请选择目标玩家';
    const t = state.players.find((q) => q.id === want.targetPlayerId);
    if (!t || t.bankrupt || (pool === 'visible' && t.id === actor.id)) return '请选择有效的目标玩家';
    if (!candidatePlayers(state, actor, pool).some((q) => q.id === t.id)) return `${t.name} 不在视野内`;
    return null;
  };
}

/** 目标格必须在给定候选池内 */
export function needCell(pool: CellPool): TargetCheck {
  return (state, actor, want) => {
    if (want.cellId === undefined) return '请选择目标格';
    const cell = state.board[want.cellId];
    if (!cell) return '请选择有效的目标格';
    if (pool === 'foot' && want.cellId === actor.position) return null;
    if (candidateCells(state, actor, pool).includes(want.cellId)) return null;
    // 视野外的说法要单独给：UI 拿这句话做灰显文案，玩家看见「不在视野内」才知道要走近一点
    if (pool === 'view') return `「${cell.name}」不在视野内`;
    return `「${cell.name}」不是本卡可作用的目标`;
  };
}

/** 只认脚下那一格（购地 / 改建）：显式拒绝远程，不再靠"忽略 cellId"暗改目标 */
export function footOnly(state: GameState, actor: Player, want: TargetFields): string | null {
  if (want.cellId !== undefined && want.cellId !== actor.position) {
    return `「${state.board[want.cellId]?.name ?? want.cellId}」不是脚下这一格，本卡只能作用于落脚处`;
  }
  return null;
}

/** 组合若干谓词，返回第一条拒绝理由 */
export function allOf(...checks: TargetCheck[]): TargetCheck {
  return (state, actor, want) => {
    for (const check of checks) {
      const reason = check(state, actor, want);
      if (reason !== null) return reason;
    }
    return null;
  };
}

/** 「或」：任一放行即放行，全拒时取第一条理由 */
export function anyOf(...checks: TargetCheck[]): TargetCheck {
  return (state, actor, want) => {
    let first: string | null = null;
    for (const check of checks) {
      const reason = check(state, actor, want);
      if (reason === null) return null;
      first ??= reason;
    }
    return first;
  };
}

// ---------------------------------------------------------------------------
// 供各 def 复用的具体规则（原本散在 apply 里，搬到这里才能被枚举看见）
// ---------------------------------------------------------------------------

/** 该格的地权（业主与地产状态），无主时 undefined */
export function ownerOfCell(state: GameState, cellId: number): { player: Player; property: PlayerProperty } | undefined {
  for (const p of state.players) {
    const property = p.properties.find((q) => q.cellId === cellId);
    if (property) return { player: p, property };
  }
  return undefined;
}

/** 该格所在路段的全部格（街为空时只有它自己） */
export function streetOf(state: GameState, cellId: number): number[] {
  return streetCells(state, cellId);
}

/** 视野内的格集合（16 格近景窗） */
export function viewCells(state: GameState, actor: Player): number[] {
  return viewportCells(state.board, actor.position);
}

/**
 * 把某一格挪到行动者**正前方 n 步**处，返回那个「行动者的新位置」。
 *
 * 用途有两处，都不该各自手抄一遍偏移算术：
 * - 测试：路障 / 地雷现在只能布在视野内（决策人定案，与 help [88][95] 的「視窗範圍內」一致），
 *   而出生点是随机的，所以用例要先保证目标格在窗内；
 * - 表现层（W2）：HUD 把镜头对准待确认的那一格时走同一条口径。
 */
export function standBeforeCell(state: GameState, fromCellId: number, steps = 2): number {
  const behind = pathAhead(state.board, fromCellId, 0, Math.max(1, steps));
  return behind[behind.length - 1]!;
}
