import type { BoardCell, CompanyKind, FacilityType, GameState, PlayerProperty } from './types.js';
import { scaled } from './economy.js';

/**
 * 格型数据表与纯计算（波 3）：对标文档 §4 EST 与 §9 TILE。
 *
 * 本模块只放**数据 + 纯函数**（不依赖引擎内部函数），由 `engine.ts` 的落格分派调用，
 * 避免 `engine.ts` 因格型扩张而膨胀（计划 §六 风险表：波 3 抽 tiles handler map）。
 *
 * 降级声明（波 3 授权，后续波次替换）：
 * - TILE-11 魔法屋 → 波 8；TILE-18 新闻格 → 波 7 的 36 条事件池；TILE-19 乐透行 → 波 6；
 *   TILE-20..30 公司企业 → 波 5。以上格子已在棋盘就位，波 3 仅给可玩的最小结算。
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

// ---------------------------------------------------------------------------
// 公司企业（TILE-20..30）：波 3 仅展示与标识，经营权/累积盈余归波 5
// ---------------------------------------------------------------------------

export interface CompanyDef {
  tile: string;
  name: string;
  /** 消费方式（波 5 结算用，波 3 仅 UI/日志展示） */
  charge: string;
}

export const COMPANIES: Record<CompanyKind, CompanyDef> = {
  airline: { tile: 'TILE-20', name: '航空公司', charge: '轮盘定出国天数与费用，出国期间不能收租' },
  restaurant: { tile: 'TILE-21', name: '饭店', charge: '轮盘定休息天数与消费金额' },
  computer: { tile: 'TILE-22', name: '电脑公司', charge: '付电脑使用费' },
  insurance: { tile: 'TILE-23', name: '保险公司', charge: '强制签约，轮盘定投保天数与保费' },
  car: { tile: 'TILE-24', name: '汽车公司', charge: '付保养费（没开车不用给）' },
  oil: { tile: 'TILE-25', name: '石油公司', charge: '付加油费（没开车不用给）' },
  bank: { tile: 'TILE-26', name: '企业银行', charge: '同公立银行；董事长可特别融资周转' },
  water: { tile: 'TILE-27', name: '水力公司', charge: '按拥有土地总笔数付水费' },
  power: { tile: 'TILE-28', name: '电力公司', charge: '按房屋/连锁店/建设级数总和付电费' },
  department: { tile: 'TILE-29', name: '百货公司', charge: '同公立百货；董事长进入获赠卡片或道具' },
  estate: { tile: 'TILE-30', name: '房地产公司', charge: '可任选一处加盖一层房屋，按地价收施工费' },
};