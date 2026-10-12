import type { BoardCell, GameState, Player, PlayerProperty } from './types.js';
import { companySharePrice } from './stocks.js';

/**
 * 经济系统（ECON-01..06）与物价指数。
 *
 * 设计要点（打断自指循环）：
 * - `propertyValue` 只按**基础价**计价（购地价 + 各级升级基础成本），绝不乘物价指数；
 * - 物价指数 = Σ玩家总资产 / (单人初始资金 × 开局人数)，分母开局冻结；
 * - 所有「交易金额」（买地、升级、租金、缴税、事件赔付…）统一过 `scaled()`，单点取整避免误差累积。
 */

/** 单次升级的基础成本（不含指数） */
export function upgradeCost(price: number, grade: number): number {
  return grade === 1 ? Math.round(price * 0.6) : Math.round(price * 0.8);
}

/** 基础租金（不含指数）：租金 = 级数 × 基数 */
export function rentOf(baseRent: number, grade: number): number {
  return baseRent * grade;
}

/** 地产账面价值：基础地价 + 已投入的升级成本（不含指数） */
export function propertyValue(state: GameState, prop: PlayerProperty): number {
  const cell = state.board[prop.cellId];
  const base = cell?.price ?? 0;
  let upgrades = 0;
  for (let g = 1; g < prop.grade; g++) upgrades += upgradeCost(base, g);
  return base + upgrades;
}

/**
 * 玩家总资产：现金 + 存款 + 股票现值 + 公司原始股面值 + 不动产现值 − 贷款本金。
 *
 * 公司股按**面值**计（CORP-14 起它随时能按面值卖回股市，是实打实的流动资产），
 * 早先漏算这一项会让「把钱换成原始股」凭空压低物价指数、也让你在 W4 的总资产结算里吃亏。
 */
export function totalAssets(state: GameState, p: Player): number {
  let sum = p.cash + p.deposit;
  for (const [stockId, qty] of Object.entries(p.stocks)) {
    const stock = state.stockMarket.stocks.find((s) => s.id === stockId);
    if (stock) sum += stock.price * qty;
  }
  // CORP-14 一本账：持股按行情价计（面板与踩格进的是同一本股东账，转手都按市价）
  for (const company of state.companies)
    sum += (company.shares[p.id] ?? 0) * companySharePrice(state, company.kind, company.sharePrice);
  for (const prop of p.properties) sum += propertyValue(state, prop);
  if (p.loan) sum -= p.loan.principal;
  return sum;
}

const MAX_INDEX = 107374;

/**
 * 物价指数：全体存活玩家总资产 / 开局货币总量，clamp [0.01, 107374]。
 * 纯函数不缓存（客户端可用 useMemo 做表现层缓存）。
 */
export function priceIndex(state: GameState): number {
  // 开局前（phase = lobby）分母还没冻结：initialCashPerPlayer / initialPlayerCount 都是 START_GAME
  // 才写进去的 0。原来靠 Math.max(1, …) 兜除零，结果把「还没开局」算成 ×15000 的荒谬指数
  // （联机大厅帧就挂在这一屏上）。没有分母就没有物价可言，按基准 1 返回。
  if (!state.initialCashPerPlayer || !state.initialPlayerCount) return 1;
  const denom = state.initialCashPerPlayer * state.initialPlayerCount;
  let total = 0;
  for (const p of state.players) {
    if (!p.bankrupt) total += totalAssets(state, p);
  }
  const idx = total / denom;
  return Math.min(MAX_INDEX, Math.max(0.01, idx));
}

/** 按物价指数缩放一个基础金额（单点取整） */
export function scaled(state: GameState, amount: number): number {
  return Math.round(amount * priceIndex(state));
}

/**
 * 街道地价乘数（EVT-01 事件 6/14）：{街}公告地价调涨 30% / 闹鬼下跌 30%，永久生效于买地价与租金。
 * 缺省 1（未受事件影响的街道恒为 1，既有数值不受影响）。
 */
export function streetFactor(state: GameState, cell: BoardCell): number {
  if (!cell.street) return 1;
  return state.streetPriceFactors[cell.street] ?? 1;
}

/** 地价（含指数与街道乘数），UI 与引擎同源 */
export function landPrice(state: GameState, cell: BoardCell): number {
  return scaled(state, Math.round((cell.price ?? 0) * streetFactor(state, cell)));
}

/**
 * 一座城的当前地价 = 城里最贵那块地的**街价**（标价 × 街道乘数，不含全局物价指数）。
 *
 * 股票的那根锚读的是这个数（见 `stocks.stockAnchor`）：地价公告调涨 / 闹鬼下跌这类事件
 * 改的是街道乘数，于是这座城里那家绑定公司的股价锚跟着抬或压 —— 指数不进来看，
 * 否则全图一起通胀，锚就等于没锚。
 * 同名格在原版图上就是同一座城（地产格与那家的公司格同名）；一座城也没有时返回 0，调用方按「无绑定」处理。
 */
export function cityLandPrice(state: GameState, cityName?: string): number {
  if (!cityName) return 0;
  let best = 0;
  for (const cell of state.board) {
    if (cell.name !== cityName || !cell.price) continue;
    best = Math.max(best, Math.round(cell.price * streetFactor(state, cell)));
  }
  return best;
}

/** 升级价（含指数） */
export function landUpgradeCost(state: GameState, cell: BoardCell, grade: number): number {
  return scaled(state, upgradeCost(cell.price ?? 0, grade));
}

/** 租金（含指数与街道乘数） */
export function landRent(state: GameState, cell: BoardCell, grade: number): number {
  return scaled(state, Math.round(rentOf(cell.baseRent ?? 0, grade) * streetFactor(state, cell)));
}