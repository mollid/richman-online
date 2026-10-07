import type { CompanyKind, CompanyState, GameState, Player } from './types.js';
import { scaled } from './economy.js';

/**
 * 公司企业系统（CORP-01..13 / TILE-20..30，波 5）。
 *
 * 本模块只放**数据 + 纯函数**（不抽 RNG、不依赖引擎内部函数），由 `engine.ts` 调用：
 * - 11 家公司定义（格位、股面值、消费方式）；
 * - 各公司消费金额基数（转轮盘结果由引擎抽取后传入）；
 * - 经营权（董事长）判定：最大持股 + 同票先到先得；
 * - 累计盈余与 15 号分红由引擎的日切钩子处理。
 *
 * 通用规则（文档 §5.1）：
 * 1. 公司在地图固定格位，开局即存在，各公司股面值不同；
 * 2. 停靠时若**经营权属他人** → 按消费方式缴费，费用充作**累积盈余**；付费后可认购股份（单次 ≤1000 张）；
 * 3. **持股最多**者取得经营权（董事长），享**免付费**特权；他人反超则自动移交；
 * 4. 持股相同 → 经营权归**先入股者**；
 * 5. 每月 15 号按持股比例分配盈余；亏损由股东按比例承担。
 */

/** 单次认购股份上限（CORP-01） */
export const MAX_SHARES_PER_BUY = 1000;

/** 房地产公司加盖施工费 = 该地地价 × 比例（CORP-13） */
export const ESTATE_BUILD_RATIO = 0.5;

/** CORP-05 电脑使用费（定额） */
export const COMPUTER_FEE = 800;
/** CORP-10 水费单价（每笔土地） */
export const WATER_FEE_PER_LAND = 200;
/** CORP-11 电费单价（每级建筑） */
export const POWER_FEE_PER_LEVEL = 150;
/** CORP-07 汽车保养费（持有车辆才收） */
export const CAR_MAINTENANCE_FEE = 600;
/** CORP-08 石油公司加油费（持有车辆才收） */
export const OIL_FEE = 700;
/** CORP-03 航空公司：出国旅游每日费用（转轮盘 1..3 天） */
export const AIRLINE_FEE_PER_DAY = 600;
/** CORP-04 饭店：每日消费（转轮盘 1..3 天） */
export const RESTAURANT_FEE_PER_DAY = 500;
/** CORP-06 保险公司：每日保费（转轮盘 1..3 天） */
export const INSURANCE_FEE_PER_DAY = 400;

/** 公司定义 */
export interface CompanyDef {
  kind: CompanyKind;
  /** 棋盘格 id（须与 board.ts 中 companyKind 一致） */
  cellId: number;
  /** 文档对标编号 */
  tile: string;
  name: string;
  /** 股票面值（每股价格；不随物价指数变化，同股价处理） */
  sharePrice: number;
  /** 消费方式文案 */
  charge: string;
}

export const COMPANY_LIST: CompanyDef[] = [
  { kind: 'airline', cellId: 51, tile: 'TILE-20', name: '航空公司', sharePrice: 500, charge: '转轮盘决定出国天数并付费，出国期间不能收租' },
  { kind: 'restaurant', cellId: 55, tile: 'TILE-21', name: '大饭店', sharePrice: 300, charge: '转轮盘决定休息天数与消费金额' },
  { kind: 'computer', cellId: 43, tile: 'TILE-22', name: '电脑公司', sharePrice: 400, charge: '付电脑使用费（定额）' },
  { kind: 'insurance', cellId: 47, tile: 'TILE-23', name: '保险公司', sharePrice: 350, charge: '强制签约，转轮盘决定投保天数与保费' },
  { kind: 'car', cellId: 57, tile: 'TILE-24', name: '汽车公司', sharePrice: 450, charge: '付保养费（没开车不用给）' },
  { kind: 'bank', cellId: 58, tile: 'TILE-26', name: '企业银行', sharePrice: 480, charge: '同公立银行；董事长可特别融资周转' },
  { kind: 'oil', cellId: 59, tile: 'TILE-25', name: '石油公司', sharePrice: 420, charge: '付加油费（没开车不用给）' },
  { kind: 'water', cellId: 60, tile: 'TILE-27', name: '水力公司', sharePrice: 260, charge: '按拥有土地总笔数付水费' },
  { kind: 'power', cellId: 61, tile: 'TILE-28', name: '电力公司', sharePrice: 280, charge: '按房屋/连锁店/建设的级数总和付电费' },
  { kind: 'department', cellId: 62, tile: 'TILE-29', name: '百货公司', sharePrice: 520, charge: '同公立百货；董事长进入获赠一张卡片或一项道具' },
  { kind: 'estate', cellId: 63, tile: 'TILE-30', name: '房地产公司', sharePrice: 600, charge: '可任选一处加盖一层房屋，按该地地价收取施工费' },
];

export const COMPANIES: Record<CompanyKind, CompanyDef> = COMPANY_LIST.reduce((acc, def) => {
  acc[def.kind] = def;
  return acc;
}, {} as Record<CompanyKind, CompanyDef>);

/** 需转轮盘（1..3）决定天数/费用的公司（CORP-03/04/06） */
export const WHEEL_KINDS: ReadonlySet<CompanyKind> = new Set<CompanyKind>(['airline', 'restaurant', 'insurance']);

export function companyDef(kind: CompanyKind): CompanyDef {
  return COMPANIES[kind];
}

/** 查找某格对应的公司经营状态 */
export function companyAtCell(state: GameState, cellId: number): CompanyState | undefined {
  return state.companies.find((c) => c.cellId === cellId);
}

/** 建造级数总和（CORP-11：房屋 + 连锁店 + 建设的级数；连锁店按其等级计） */
export function buildingLevels(p: Player): number {
  return p.properties.reduce((sum, q) => sum + q.grade, 0);
}

/**
 * 公司消费金额（含物价指数）。`roll` 为转轮盘结果（1..3），仅 airline/restaurant/insurance 使用。
 * 汽车/石油公司在没开车（未持有机车/汽车，`diceCount <= 1`）时免费（CORP-07/08）。
 * 银行/百货/房地产不按此计费（银行百货无费用，房地产按所选地价单独结算）。
 */
export function companyFee(state: GameState, kind: CompanyKind, payer: Player, roll: number): number {
  const days = Math.max(1, Math.min(3, roll));
  switch (kind) {
    case 'computer':
      return scaled(state, COMPUTER_FEE);
    case 'water':
      return scaled(state, WATER_FEE_PER_LAND * payer.properties.length);
    case 'power':
      return scaled(state, POWER_FEE_PER_LEVEL * buildingLevels(payer));
    case 'car':
      return payer.diceCount > 1 ? scaled(state, CAR_MAINTENANCE_FEE) : 0;
    case 'oil':
      return payer.diceCount > 1 ? scaled(state, OIL_FEE) : 0;
    case 'airline':
      return scaled(state, AIRLINE_FEE_PER_DAY * days);
    case 'restaurant':
      return scaled(state, RESTAURANT_FEE_PER_DAY * days);
    case 'insurance':
      return scaled(state, INSURANCE_FEE_PER_DAY * days);
    case 'bank':
    case 'department':
    case 'estate':
      return 0;
  }
}

/**
 * 经营权判定（CORP-02）：持股最多者；持股相同取**先入股**者；
 * 再相同则按玩家座次先后。破产玩家不参与计算。无持股则经营权空缺（null）。
 */
export function majorityHolderId(company: CompanyState, players: Player[]): string | null {
  const order = new Map(players.map((p, i) => [p.id, i]));
  let best: string | null = null;
  let bestShares = 0;
  let bestSince = Number.MAX_SAFE_INTEGER;
  let bestRank = Number.MAX_SAFE_INTEGER;
  for (const [id, shares] of Object.entries(company.shares)) {
    if (shares <= 0) continue;
    const owner = players.find((p) => p.id === id);
    if (!owner || owner.bankrupt) continue;
    const since = company.firstHeldDayIndex[id] ?? Number.MAX_SAFE_INTEGER;
    const rank = order.get(id) ?? Number.MAX_SAFE_INTEGER;
    const better =
      best === null ||
      shares > bestShares ||
      (shares === bestShares && since < bestSince) ||
      (shares === bestShares && since === bestSince && rank < bestRank);
    if (better) {
      best = id;
      bestShares = shares;
      bestSince = since;
      bestRank = rank;
    }
  }
  return best;
}