/**
 * ECON-14 三清单报表（只读查询层）。
 *
 * 数据来源：`docs/gameplay/help_entries.txt` [16]
 *「資產清單：分別把每個角色的現金、存款、土地、房屋、股票及資產總值等資料顯示出來。
 *   地產清單：查詢擁有的土地、建設等資料。股票清單：查詢持有股票的明細資料。」
 *
 * 全部为纯函数只读计算，不改 `GameState`、不消耗 RNG。
 */
import { FACILITIES, gradeName, vehicleLabel } from './tiles.js';
import { propertyValue, scaled } from './economy.js';
import type { GameState, Player } from './types.js';

/** 资产清单中的一项明细 */
export interface AssetRow {
  key: 'cash' | 'deposit' | 'land' | 'house' | 'stock' | 'loan';
  label: string;
  amount: number;
}

/** 单个玩家的资产汇总（ECON-14 资产清单） */
export interface AssetSummary {
  playerId: string;
  playerName: string;
  bankrupt: boolean;
  cash: number;
  deposit: number;
  /** 土地（地皮）现值合计 */
  landValue: number;
  /** 房屋（加盖层数 + 建设设施）现值合计 */
  houseValue: number;
  /** 股票现值合计 */
  stockValue: number;
  /** 未偿贷款本金（负值展示） */
  loan: number;
  /** 资产总值 = 现金 + 存款 + 土地 + 房屋 + 股票 − 贷款 */
  total: number;
  rows: AssetRow[];
}

/** 地产清单的一行 */
export interface EstateRow {
  cellId: number;
  cellName: string;
  /** 所在街道名（同一街道可整段升级，EST-06） */
  streetName: string;
  grade: number;
  gradeLabel: string;
  facility: string | null;
  isChain: boolean;
  /** 地皮现值 */
  landValue: number;
  /** 房屋/建设现值（含加盖与设施） */
  houseValue: number;
  totalValue: number;
}

/** 地产清单（按街道分组） */
export interface EstateGroup {
  streetName: string;
  rows: EstateRow[];
  totalValue: number;
}

/** 股票清单的一行 */
export interface StockRow {
  stockId: string;
  stockName: string;
  quantity: number;
  /** 当前单价（不随物价指数缩放，同股价处理） */
  price: number;
  /** 累计买入成本（含费用），用于算盈亏 */
  cost: number;
  marketValue: number;
  profit: number;
  lastChangePct: number;
  /** 持股比例（占该股流通股） */
  holdingPct: number;
}

/** 股票清单汇总 */
export interface StockSummary {
  playerId: string;
  playerName: string;
  rows: StockRow[];
  marketValue: number;
  cost: number;
  profit: number;
}

/** 某玩家名下属于「房屋」范畴的现值：加盖层数 + 建设设施 */
function houseValueOf(state: GameState, p: Player): { land: number; house: number } {
  let land = 0;
  let house = 0;
  for (const prop of p.properties) {
    const cell = state.board[prop.cellId];
    const base = cell?.price ?? 0;
    land += base;
    // propertyValue 含地皮，减去地皮即为加盖层数部分
    house += Math.max(0, propertyValue(state, prop) - base);
    if (prop.facility) {
      const ratio = FACILITIES[prop.facility]?.buildRatio ?? 0;
      house += scaled(state, base * ratio);
    }
  }
  return { land, house };
}

/** 单个玩家的资产清单（现金/存款/土地/房屋/股票/贷款/总值） */
export function assetSummary(state: GameState, p: Player): AssetSummary {
  let stockValue = 0;
  for (const [stockId, qty] of Object.entries(p.stocks)) {
    const stock = state.stockMarket.stocks.find((s) => s.id === stockId);
    if (stock) stockValue += stock.price * qty;
  }
  const { land, house } = houseValueOf(state, p);
  const loan = p.loan ? p.loan.principal : 0;
  const total = p.cash + p.deposit + land + house + stockValue - loan;
  return {
    playerId: p.id,
    playerName: p.name,
    bankrupt: p.bankrupt,
    cash: p.cash,
    deposit: p.deposit,
    landValue: land,
    houseValue: house,
    stockValue,
    loan,
    total,
    rows: [
      { key: 'cash', label: '现金', amount: p.cash },
      { key: 'deposit', label: '存款', amount: p.deposit },
      { key: 'land', label: '土地', amount: land },
      { key: 'house', label: '房屋', amount: house },
      { key: 'stock', label: '股票', amount: stockValue },
      { key: 'loan', label: '贷款', amount: -loan },
    ],
  };
}

/** 全员资产清单（按总值降序） */
export function allAssetSummaries(state: GameState): AssetSummary[] {
  return state.players
    .map((p) => assetSummary(state, p))
    .sort((a, b) => b.total - a.total);
}

/** 街道可读名：以该街道首格（最小 id）的地名代表，如「淮海路 / 南京路 / 王府井」 */
function streetLabelOf(state: GameState, cellId: number): string {
  const anchor = state.board[cellId];
  if (!anchor?.street) return anchor?.name ?? '独立地块';
  const first = state.board
    .filter((c) => c.street === anchor.street)
    .reduce((min, c) => (c.id < min.id ? c : min), anchor);
  return first.name;
}

/** 单个玩家的地产清单（按街道分组，组内按格号升序） */
export function estateGroups(state: GameState, p: Player): EstateGroup[] {
  const byStreet = new Map<string, EstateRow[]>();
  for (const prop of [...p.properties].sort((a, b) => a.cellId - b.cellId)) {
    const cell = state.board[prop.cellId];
    if (!cell) continue;
    const base = cell.price ?? 0;
    const landValue = base;
    const houseValue = Math.max(0, propertyValue(state, prop) - base);
    const row: EstateRow = {
      cellId: cell.id,
      cellName: cell.name,
      streetName: streetLabelOf(state, cell.id),
      grade: prop.grade,
      gradeLabel: gradeName(prop.grade),
      facility: prop.facility ? (FACILITIES[prop.facility]?.name ?? prop.facility) : null,
      isChain: prop.chain === true,
      landValue,
      houseValue,
      totalValue: landValue + houseValue,
    };
    const list = byStreet.get(row.streetName) ?? [];
    list.push(row);
    byStreet.set(row.streetName, list);
  }
  return [...byStreet.entries()]
    .map(([streetName, rows]) => ({
      streetName,
      rows,
      totalValue: rows.reduce((a, r) => a + r.totalValue, 0),
    }))
    .sort((a, b) => b.totalValue - a.totalValue);
}

/** 单支股票流通股数（用于算持股比例） */
const TOTAL_STOCK_SHARES = 1000;

/** 单个玩家的股票清单明细 */
export function stockSummary(state: GameState, p: Player): StockSummary {
  const rows: StockRow[] = [];
  for (const [stockId, quantity] of Object.entries(p.stocks)) {
    if (quantity <= 0) continue;
    const stock = state.stockMarket.stocks.find((s) => s.id === stockId);
    if (!stock) continue;
    const cost = p.stockCost?.[stockId] ?? 0;
    const marketValue = stock.price * quantity;
    rows.push({
      stockId,
      stockName: stock.name,
      quantity,
      price: stock.price,
      cost,
      marketValue,
      profit: marketValue - cost,
      lastChangePct: stock.lastChangePct,
      holdingPct: Math.min(100, Math.round((quantity / TOTAL_STOCK_SHARES) * 1000) / 10),
    });
  }
  rows.sort((a, b) => b.marketValue - a.marketValue);
  return {
    playerId: p.id,
    playerName: p.name,
    rows,
    marketValue: rows.reduce((a, r) => a + r.marketValue, 0),
    cost: rows.reduce((a, r) => a + r.cost, 0),
    profit: rows.reduce((a, r) => a + r.profit, 0),
  };
}

/** 全员股票清单 */
export function allStockSummaries(state: GameState): StockSummary[] {
  return state.players.map((p) => stockSummary(state, p));
}

/** 玩家当前交通工具描述（资产清单附注，EST-11） */
export function vehicleOf(p: Player): string {
  return p.diceCount > 1 ? vehicleLabel(p.diceCount) : '步行';
}