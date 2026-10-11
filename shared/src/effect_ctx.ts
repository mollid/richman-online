import type { GodDef } from './gods.js';
import type { FateCardDef } from './fate.js';
import type { NewsEventDef } from './news.js';
import type {
  AuctionTrigger,
  BoardCell,
  DisasterKind,
  GameState,
  LandingVenue,
  MagicCondition,
  PayReason,
  Player,
  PlayerAction,
  PlayerProperty,
  Stock,
} from './types.js';

/**
 * 效果上下文：卡片 / 道具 / 命运 / 新闻的**效果体**所需的引擎能力集合。
 *
 * 为什么需要它：这些效果原本内联在 `engine.ts` 的 `useCard`/`useItem` switch 里，
 * 与它们的数据定义（`cards.ts`/`items.ts`）分居两处 —— 加一张卡要改「表 + switch + 门控」
 * 三个文件，而门控与引擎校验不同源的 bug 正由此而来。把效果体搬回定义所在的数据模块后，
 * 数据模块不能反过来 import `engine.ts`（会形成循环依赖），于是由 `engine.ts` 在调用时
 * 注入这份能力集合。
 *
 * 约定：各 helper 的**签名与 `engine.ts` 内部函数完全一致**（含首参 `state`），
 * 使搬迁过去的效果体可以逐字保持不变 —— 纯搬迁应当由 golden 逐帧基线证明零行为漂移，
 * 签名越像「重排参数」，搬迁越容易手滑改到语义。
 */
export interface EffectKit {
  log(state: GameState, text: string): void;
  pay(
    state: GameState,
    from: Player,
    amount: number,
    to: Player | null,
    opts?: { toDeposit?: boolean; reason?: PayReason },
  ): number;
  payCash(state: GameState, from: Player, amount: number, to: Player | null, reason?: PayReason): void;
  cellAt(state: GameState, position: number): BoardCell;
  /** 某格的地权：业主与其地产状态；无主时为 undefined */
  cellOwner(state: GameState, cellId: number): CellOwner | undefined;
  propOf(p: Player, cellId: number): PlayerProperty | undefined;
  consumeCard(p: Player, cardId: string): boolean;
  consumeItem(p: Player, itemId: string): boolean;
  randomIndex(state: GameState, n: number): number;
  routeSegment(state: GameState, cellId: number): number[];
  blockRent(p: Player, days: number): void;
  applyDisaster(
    state: GameState,
    target: Player,
    kind: DisasterKind,
    source: Player | null,
    apply: (victim: Player) => void,
  ): void;
  stockById(state: GameState, stockId: string): Stock | undefined;
  activePlayers(state: GameState): Player[];
  isShopCell(c: BoardCell): boolean;
  isBankCell(c: BoardCell): boolean;
  detonate(state: GameState, center: number, radius: number, hospitalDays: number, label: string): number;
  beginAuction(
    state: GameState,
    opts: { cellId: number; sellerId: string | null; trigger: AuctionTrigger; afterComplete: 'resume' | 'advance' },
  ): boolean;
  attachGod(state: GameState, p: Player, def: GodDef): void;
  /** 请神卡用：取此刻在场、离自己最近的一尊神明；棋盘上没有神明时返回 null */
  nearestGodFor(state: GameState, p: Player): GodDef | null;
  /** 请神卡的前提（GOD 现身机制，W2）：无神可请时给出拒绝理由，门控与 apply 共用 */
  godSummonRefusal(state: GameState): string | null;
  /** 清退指定格上的驻留神明，返回清退数（机器娃娃与送神卡共用一条口径） */
  clearBoardGods(state: GameState, cellIds: readonly number[], reason: string): number;
  /**
   * 把某尊驻留神明请到玩家身上（请神卡用）：从棋盘摘走，但**不算清退**，
   * 因此不写对偶冷却 —— 它只是换了个在场方式，对偶仍由「同对不共现」挡着。
   */
  claimBoardGod(state: GameState, godId: string): boolean;
  /** 行进方向上前方 n 步的格号（机器娃娃 / 送神卡的「前方 9 步」同源口径） */
  cellsAhead(state: GameState, from: number, dir: 1 | -1, steps: number): number[];
  /** 神庙摇籤：随机召唤一位神明附身（走 RNG） */
  summonGod(state: GameState, p: Player): void;
  /** 行进显灵·租金类（GOD-02/03/06/07）：返回调整后的应付过路费，0 表示完全抵赖 */
  applyGodRentModifier(state: GameState, p: Player, rent: number, cellName: string): number;
  /** 霉运倍率（GOD-12）：1 = 无霉运，2 = 加倍 */
  unluckyMultiplier(p: Player): number;
  /** 抽一张机会卡（大/小福神显灵、机会格与卡片屋共用的同一条管线，额满时挂起 awaiting_discard） */
  drawChanceCard(state: GameState, p: Player, source?: string): void;
  /** 在列表中确定性随机取一项（消耗一次抽数） */
  randomPick<T>(state: GameState, items: T[]): T | undefined;
  /** 全盘所有已建成（grade > 1）的建筑引用 */
  builtProperties(state: GameState): BuildingRef[];
  /** 把一处建筑夷为平地（降回 1 级） */
  destroyBuilding(ref: BuildingRef): void;
  isGameOver(state: GameState): boolean;
  /** 路段的展示名 */
  streetLabel(state: GameState, street: string): string;
  /** 至少被一名玩家持有的路段列表 */
  ownedStreets(state: GameState): string[];
  /** 全部无主可购地格 */
  unownedLandCells(state: GameState): BoardCell[];
  /** 持有至少一块地的存活玩家 */
  playersWithLand(state: GameState): Player[];
  /** 持有至少一股的存活玩家 */
  playersWithShares(state: GameState): Player[];
  /** 某玩家的总持股数 */
  totalSharesOf(state: GameState, p: Player): number;
  isStockSuspended(state: GameState, stockId: string): boolean;
}

export type CardAction = Extract<PlayerAction, { type: 'USE_CARD' }>;
export type ItemAction = Extract<PlayerAction, { type: 'USE_ITEM' }>;

/** 能力集合 + 当前对局状态：所有注入上下文的最 common 形态 */
export interface EngineCtx extends EffectKit {
  state: GameState;
}

/** 某格的地权：业主玩家 + 该业主名下的地产状态 */
export interface CellOwner {
  player: Player;
  property: PlayerProperty;
}

/** 一处已建成建筑的引用（业主 + 地产状态 + 所在格），供命运/新闻的「随机拆房」类效果使用 */
export interface BuildingRef {
  player: Player;
  prop: PlayerProperty;
  cell: BoardCell;
}

/** 卡片效果上下文：`self` 为使用者，`action` 携带 UI 收集到的目标参数 */
export interface CardEffectCtx extends EngineCtx {
  self: Player;
  action: CardAction;
  /** 当前卡片的定义（效果体需要自述名称、并按 id 区分红卡/黑卡等成对卡） */
  card: { id: string; name: string };
  /** 必须显式指定目标格的动作参数（换地/换屋），缺失即报错 */
  requireCellId(): number;
  /** 任意土地/建筑目标，缺省取脚下 */
  anyCellId(): number;
  /** 目标对手（排除自己与已倒闭者） */
  targetPlayer(): Player;
}

/** 道具效果上下文 */
export interface ItemEffectCtx extends EngineCtx {
  self: Player;
  action: ItemAction;
  item: { id: string; name: string };
  /** 目标格，缺省取脚下 */
  anyCellId(): number;
}

/**
 * 命运卡效果上下文。
 *
 * `renderParams` / `money` 由 `applyFateEffect` 预先算好并传入：牌面文本里的 `{amount}`
 * 默认按物价指数缩放，但百分比类效果（挪用存款比例、损失持股比例）要在效果体内把
 * `renderParams.amount` 改回名义值 —— 所以它是可变的，效果体直接写它。
 * 效果体的返回值即日志尾部的补充说明文本（`extra`）。
 */
export interface FateEffectCtx extends EngineCtx {
  self: Player;
  def: FateCardDef;
  renderParams: Record<string, string | number>;
  /** 已按物价指数缩放的金额（`scaled(state, def.amount ?? 0)`） */
  money: number;
}

/**
 * 新闻事件上下文。新闻作用于全盘或随机玩家，没有「使用者」概念，故不含 `self`；
 * 目标由效果体自己用 `randomPick` 选取。
 *
 * `params` 是牌面文本的占位符表（`{street}` / `{player}` / `{company}` / `{stock}` /
 * `{amount}`），效果体往里填，最后由 `renderNewsText` 渲染。
 * 效果体返回日志括弧里的补充说明；**返回 null 表示对局已结束**，引擎据此跳过这条
 * 新闻日志 —— 税收类事件逐人征收时若有人因此破产倒闭，原实现就是在中途 return
 * 而不再播报，这个语义必须保住。
 */
export interface NewsEffectCtx extends EngineCtx {
  def: NewsEventDef;
  params: Partial<Record<'street' | 'player' | 'company' | 'stock' | 'amount', string>>;
}

/**
 * 神明行为上下文：附身一次性结算、行进显灵（抵租 / 侵占 / 加盖 / 拆屋）、日切计时与对偶转化
 * 都要写日志、扣款、抽卡，与效果族共用同一份注入。结构与 `EngineCtx` 相同，
 * 单独命名只为在 `gods.ts` 的签名里读得出意图。
 */
export type GodEffectCtx = EngineCtx;

/**
 * 落格结算的走向（R2 的落格 handler 协议）：
 * - `advance`：本格结算完毕，由 `rollDice` 统一 `advanceTurn`；
 * - `hold`：本格把相位切到 `awaiting_action` / `awaiting_pick`，等玩家当场决策，不推进；
 * - `stop`：什么都不做 —— 对局已结束，或该格已自行安排后续（拍卖会接管回合）。
 */
export type LandingResult = 'advance' | 'hold' | 'stop';

/**
 * 格型 → 会话型场所。商店格与百货公司同为 `shop`，公立银行与企业银行同为 `bank`，
 * 其余格子当场决策一次即走（`null`）。
 *
 * 这张表是**唯一的**一份：引擎的 `isShopCell` / `isBankCell` 由它派生，
 * `normalizeGameState` 给老存档回填 `landing` 也读它 —— 两处各写一遍就会出现
 * 「面板按一套口径给出口、引擎按另一套口径放行」的老 bug 类。
 */
export function landingVenueOf(cell: BoardCell): LandingVenue | null {
  if (cell.type === 'shop' || (cell.type === 'company' && cell.companyKind === 'department')) return 'shop';
  if (cell.type === 'bank' || (cell.type === 'company' && cell.companyKind === 'bank')) return 'bank';
  return null;
}

/**
 * 开一扇落格决策窗（R4）：**唯一**的开窗入口。
 *
 * 为什么只留一个门：软锁的形状就是「相位切到了 `awaiting_action`，但那格没有任何合法动作，
 * 而 UI 不知道该给什么出口」。集中在这里之后，`state.landing` 与相位必然同时成立，
 * 出口（`FINISH_LANDING`）也就必然存在。
 *
 * `venue` 默认从格子派生；只有明确要压成单步窗时才传 `null`（目前没有这种格子）。
 */
export function holdLanding(ctx: EngineCtx, cell: BoardCell, venue: LandingVenue | null = landingVenueOf(cell)): LandingResult {
  ctx.state.phase = 'awaiting_action';
  ctx.state.landing = { cellId: cell.id, venue, turn: ctx.state.turn };
  return 'hold';
}

/**
 * 落格结算上下文（`cell_handlers.ts`）：`self` 为落格玩家，`cell` 为落脚格，
 * `moved` 为本次实际行走步数（加油站按步数计费）。
 *
 * `CELL_HANDLERS` 之所以要注入这一整份能力集合而非直接 import `engine.ts`：落格行为
 * 属于「格子」这个系统，应与棋盘数据（`tiles.ts` / `board.ts`）就近维护，而引擎不能被
 * 反向依赖。`tryFreePass`（免费卡反制）留在引擎，因为它要消耗反制卡并走反制栈。
 */
export interface CellLandingCtx extends EngineCtx {
  self: Player;
  cell: BoardCell;
  moved: number;
  /** 免费卡（CARD-21）自动抵用：金额超限或付不起时抵掉这一次 */
  tryFreePass(state: GameState, p: Player, amount: number): boolean;
  /** 住宅地产的应收租金（含路段倍数 / 等级 / 物价指数） */
  propertyRent(state: GameState, cell: BoardCell, owned: CellOwner): number;
  /** 监狱保释金（随物价指数） */
  bailFee(state: GameState): number;
  /** 机会格的命运卡抽签 + 结算 */
  resolveFateCard(state: GameState, p: Player): void;
  /** 新闻格的游标轮询选事件并结算 */
  resolveNewsEvent(state: GameState): void;
  /** 魔法屋：给定施法条件，列出可选的受罚者 id */
  magicCandidates(state: GameState, caster: Player, condition: MagicCondition): string[];
}
