import type { BoardCell, FacilityType, GameState, PlayerProperty } from './types.js';
import { landPrice, scaled } from './economy.js';
import { BOARD_SIZE } from './board.js';

/**
 * 格型数据表与纯计算（波 3）：对标文档 §4 EST 与 §9 TILE。
 *
 * 本模块只放**数据 + 纯函数**（不依赖引擎内部函数），供落格 handler 与 `engine.ts` 调用，
 * 以免 `engine.ts` 因格型扩张而膨胀。
 *
 * 落格分派在 `cell_handlers.ts`（按 `CellType` 查表的 handler map，重构波 R2 落地）；
 * 本模块提供它需要的价格、设施与等级计算。
 */

/** 等级上限（EST-02：住宅加盖 5 个等级；EST-07：商业建设除公园/加油站外 5 级） */
export const MAX_GRADE = 5;

/** 等级名称（1 级 = 只买了地/空地） */
export const GRADE_NAMES: Record<number, string> = {
  1: '空地',
  2: '平房',
  3: '洋房',
  4: '大楼',
  5: '大厦',
};

export function gradeName(grade: number): string {
  return GRADE_NAMES[grade] ?? `${grade} 级`;
}

// ---------------------------------------------------------------------------
// 商业用地设施（EST-07..12 / TILE-03..07）
// ---------------------------------------------------------------------------

export interface FacilityDef {
  id: FacilityType;
  /** 文档对标编号 */
  tile: string;
  name: string;
  /** 是否可继续升级（公园 EST-08 / 加油站 EST-11 不可升级） */
  upgradeable: boolean;
  /** 是否向路过者收费 */
  charges: boolean;
  /** 建造成本相对地价的比例 */
  buildRatio: number;
  description: string;
}

export const FACILITIES: Record<FacilityType, FacilityDef> = {
  park: {
    id: 'park',
    tile: 'TILE-03',
    name: '公园',
    upgradeable: false,
    charges: false,
    buildRatio: 0.4,
    description: '公共开放设施：不向使用者收取任何费用，且不能再升级（安全落脚点）',
  },
  mall: {
    id: 'mall',
    tile: 'TILE-06',
    name: '购物中心',
    upgradeable: true,
    charges: true,
    buildRatio: 0.8,
    description: '转轮盘决定消费金额',
  },
  hotel: {
    id: 'hotel',
    tile: 'TILE-07',
    name: '旅馆',
    upgradeable: true,
    charges: true,
    buildRatio: 1,
    description: '强制休息若干天，转轮盘决定消费金额与休息天数',
  },
  gas: {
    id: 'gas',
    tile: 'TILE-05',
    name: '加油站',
    upgradeable: false,
    charges: true,
    buildRatio: 0.5,
    description: '按行走步数 × 交通工具等级支付加油费，无法升级',
  },
  lab: {
    id: 'lab',
    tile: 'TILE-04',
    name: '研究所',
    upgradeable: true,
    charges: false,
    buildRatio: 0.9,
    description: '私人研究机构：不向路过者收费；每升一级多开发一种道具',
  },
};

/** 设施枚举顺序（改建卡切换与 UI 列表用） */
export const FACILITY_ORDER: FacilityType[] = ['park', 'mall', 'hotel', 'gas', 'lab'];

/** 建造成本（含物价指数）：地价 × 设施比例（EST-07 各项目建费不同） */
export function facilityBuildCost(state: GameState, cell: BoardCell, facility: FacilityType): number {
  return scaled(state, Math.round((cell.price ?? 0) * FACILITIES[facility].buildRatio));
}

// ---------------------------------------------------------------------------
// 研究所研发（EST-09 / EST-10）
// ---------------------------------------------------------------------------

export interface ResearchDef {
  /** 所需的所等级（Lv1 起依次解锁） */
  level: number;
  itemId: string;
  /** 研发天数（不同项目研发时间不同） */
  days: number;
}

/** EST-10 固定映射：Lv1 机器工人 → Lv2 时光机 → Lv3 传送机 → Lv4 工程车 → Lv5 核子飞弹 */
export const RESEARCH_ORDER: ResearchDef[] = [
  { level: 1, itemId: 'robot-worker', days: 3 },
  { level: 2, itemId: 'time-machine', days: 5 },
  { level: 3, itemId: 'teleporter', days: 4 },
  { level: 4, itemId: 'bulldozer', days: 6 },
  { level: 5, itemId: 'nuke', days: 8 },
];

export function researchDef(itemId: string): ResearchDef | undefined {
  return RESEARCH_ORDER.find((r) => r.itemId === itemId);
}

// ---------------------------------------------------------------------------
// 路段（EST-03）与连锁店（EST-05）
// ---------------------------------------------------------------------------

/** 同一路段的全部格 id（EST-03：同路段产业租金联合计算） */
export function streetCells(state: GameState, cellId: number): number[] {
  const anchor = state.board[cellId];
  if (!anchor?.street) return [cellId];
  return state.board.filter((c) => c.street === anchor.street).map((c) => c.id);
}

// ---------------------------------------------------------------------------
// 视窗（在线版以 4×4 区域近似原版「视窗」）与购地价
// ---------------------------------------------------------------------------

/** 视窗大小：4×4 = 16 格（后方 7 格 + 当前格 + 前方 8 格，环形回绕） */
export const VIEWPORT_SIZE = 16;

/** 以玩家当前位置为中心的视窗格集合（换地/换屋卡等「视窗内」目标用） */
export function viewportCells(position: number): number[] {
  const out: number[] = [];
  for (let d = -7; d <= 8; d++) out.push((position + d + BOARD_SIZE) % BOARD_SIZE);
  return out;
}

/** 商业用地购地溢价倍数（用户规则：商业地要比原价贵——按自身标价 ×1.5 收购） */
export const COMMERCIAL_PRICE_MULTIPLIER = 1.5;

/**
 * 购地价（引擎与 UI 同源）：住宅 = 公定地价；
 * 商业用地 = 自身标价 ×1.5（用户规则：商业地要比原价贵）。
 */
export function landPurchasePrice(state: GameState, cell: BoardCell): number {
  if (cell.type !== 'commercial') return landPrice(state, cell);
  return scaled(state, Math.round((cell.price ?? 0) * COMMERCIAL_PRICE_MULTIPLIER));
}

/**
 * 是否「买下整路段」（黄金路线）：路段至少 2 格且该玩家全部持有。
 * 单格路段不算联合（无联合意义）。
 */
export function holdsWholeStreet(state: GameState, ownerId: string, cellId: number): boolean {
  const cells = streetCells(state, cellId);
  if (cells.length < 2) return false;
  const owner = state.players.find((p) => p.id === ownerId);
  if (!owner) return false;
  return cells.every((id) => owner.properties.some((q) => q.cellId === id));
}

/** 连锁店单店营收基数（EST-05：单店营收远低于其他建筑，开店越多收益越大） */
export const CHAIN_RENT_BASE = 200;

/** 连锁店租金：以店面总数计算，不与同路段联合计算（EST-05） */
export function chainRent(state: GameState, ownerId: string): number {
  const owner = state.players.find((p) => p.id === ownerId);
  if (!owner) return 0;
  const count = owner.properties.filter((q) => q.chain).length;
  return scaled(state, CHAIN_RENT_BASE * count);
}

// ---------------------------------------------------------------------------
// 交通工具（CORE-03 / EST-11）
// ---------------------------------------------------------------------------

/** 交通工具等级：步行 1 / 机车 2 / 汽车 3 */
export function vehicleLevel(p: { diceCount: number }): number {
  return Math.max(1, Math.min(3, p.diceCount));
}

export function vehicleLabel(level: number): string {
  return level >= 3 ? '汽车' : level === 2 ? '机车' : '步行';
}

/** 每步每级加油费基数（EST-11） */
export const GAS_FEE_PER_STEP = 50;

/** 加油费：行走步数 × 交通工具等级（EST-11） */
export function gasFee(state: GameState, steps: number, level: number): number {
  return scaled(state, Math.max(0, steps) * Math.max(1, level) * GAS_FEE_PER_STEP);
}

// ---------------------------------------------------------------------------
// 商业设施消费（EST-12）
// ---------------------------------------------------------------------------

/** 购物中心 / 旅馆的消费基数（相对地价与等级） */
export function facilitySpendBase(cell: BoardCell, grade: number): number {
  return Math.round((cell.price ?? 0) * 0.25) * grade;
}

/** 旅馆强制休息天数上限（转轮盘 1..3 天） */
export const HOTEL_MAX_DAYS = 3;

/** 设施是否可升级（含「未建设不可升级」与公园/加油站特例） */
export function facilityUpgradeable(prop: PlayerProperty): boolean {
  if (!prop.facility) return false;
  return FACILITIES[prop.facility].upgradeable;
}

// 公司企业（TILE-20..30）的定义与规则已迁至 companies.ts（波 5 开放经营）。