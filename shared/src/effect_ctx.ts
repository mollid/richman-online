import type { GodDef } from './gods.js';
import type { FateCardDef } from './fate.js';
import type { NewsEventDef } from './news.js';
import type {
  AuctionTrigger,
  BoardCell,
  DisasterKind,
  GameState,
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
  cellOwner(state: GameState, cellId: number): { player: Player; property: PlayerProperty } | undefined;
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
  nearestGodFor(p: Player): GodDef;
  /** 抽一张机会卡（大/小福神显灵与机会格共用同一条抽卡管线） */
  drawChanceCard(state: GameState, p: Player, source?: string): void;
  /** 机会格 / 卡片屋 / 福神的抽卡入口（额满时挂起 awaiting_discard） */
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

/** 一处已建成建筑的引用（业主 + 地产状态 + 所在格），供命运/新闻的「随机拆房」类效果使用 */
export interface BuildingRef {
  player: Player;
  prop: PlayerProperty;
  cell: BoardCell;
}

/** 卡片效果上下文：`self` 为使用者，`action` 携带 UI 收集到的目标参数 */
export interface CardEffectCtx extends EffectKit {
  state: GameState;
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
export interface ItemEffectCtx extends EffectKit {
  state: GameState;
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
export interface FateEffectCtx extends EffectKit {
  state: GameState;
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
export interface NewsEffectCtx extends EffectKit {
  state: GameState;
  def: NewsEventDef;
  params: Partial<Record<'street' | 'player' | 'company' | 'stock' | 'amount', string>>;
}

/**
 * 神明行为上下文：神明的附身一次性结算、行进显灵（抵租 / 侵占 / 加盖 / 拆屋）、
 * 日切计时与对偶转化都读 `p.god` 并需要写日志、扣款、抽卡，故与效果族共用同一份注入。
 * 神明的**数据**（`GODS` / `GodDef`）留在 `gods.ts`，此处只补它的**行为**依赖。
 */
export interface GodEffectCtx extends EffectKit {
  state: GameState;
}
