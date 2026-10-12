/**
 * ECON-14 三清单报表（只读查询层）。
 *
 * 数据来源：`docs/gameplay/help_entries.txt` [16]
 *「資產清單：分別把每個角色的現金、存款、土地、房屋、股票及資產總值等資料顯示出來。
 *   地產清單：查詢擁有的土地、建設等資料。股票清單：查詢持有股票的明細資料。」
 *
 * 「股票」在这里是两档（CORP-14）：上市股按市价计、有涨跌与盈亏；地图上的公司原始股按
 * **面值**计、没有价差，能看的是「锁定 / 可卖 / 经营权」这三件事。两套明细分开给，
 * 因为列不同 —— 合成一张表要么给原始股编一个假的「盈亏 +0」，要么给上市股硬塞「锁定」列。
 *
 * 全部为纯函数只读计算，不改 `GameState`、不消耗 RNG。
 */
import { FACILITIES, gradeName, vehicleLabel } from './tiles.js';
import { companySharePrice } from './stocks.js';
import { lockedSharesOf, sellableSharesOf } from './companies.js';
import { propertyValue, scaled } from './economy.js';
import type { CompanyKind, GameState, Player } from './types.js';

/** 资产清单中的一项明细 */
export interface AssetRow {
  key: 'cash' | 'deposit' | 'land' | 'house' | 'stock' | 'corp' | 'loan';
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
  /** 股票（上市股）现值合计 */
  stockValue: number;
  /** 公司原始股现值合计（按面值，CORP-14） */
  corpValue: number;
  /** 未偿贷款本金（负值展示） */
  loan: number;
  /** 资产总值 = 现金 + 存款 + 土地 + 房屋 + 股票 + 原始股 − 贷款 */
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

/** 股票清单的一行（上市股） */
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

/** 股票清单里的公司原始股一行（CORP-14：面值定价 ⇒ 没有价差盈亏，看权利与流动性） */
export interface CorpShareRow {
  cellId: number;
  kind: CompanyKind;
  name: string;
  tile: string;
  quantity: number;
  /** 面值（也就是卖出单价） */
  price: number;
  marketValue: number;
  /** 本回合认购、还没解锁的张数 */
  locked: number;
  /** 现在就能挂进股市卖的张数 */
  sellable: number;
  /** 是否为该公司的董事长（握有经营权） */
  chairman: boolean;
  /** 持股占比：占该公司全体在场股东持股合计 */
  holdingPct: number;
}

/** 股票清单汇总 */
export interface StockSummary {
  playerId: string;
  playerName: string;
  rows: StockRow[];
  /** 公司原始股明细（与 `rows` 分开：列不同） */
  corpRows: CorpShareRow[];
  /** 合计现值：上市股市价 + 原始股面值 */
  marketValue: number;
  cost: number;
  /** 只有上市股会有价差；原始股按面值恒等，盈亏恒为 0 */
  profit: number;
  corpValue: number;
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

/** 单个玩家的资产清单（现金/存款/土地/房屋/股票/原始股/贷款/总值） */
export function assetSummary(state: GameState, p: Player): AssetSummary {
  let stockValue = 0;
  for (const [stockId, qty] of Object.entries(p.stocks)) {
    const stock = state.stockMarket.stocks.find((s) => s.id === stockId);
    if (stock) stockValue += stock.price * qty;
  }
  // CORP-14 一本账：按行情价计，与 totalAssets 同一个口径（报表总值不该和结算用的总资产打架）
  const corpValue = state.companies.reduce(
    (sum, c) => sum + (c.shares[p.id] ?? 0) * companySharePrice(state, c.kind, c.sharePrice),
    0,
  );
  const { land, house } = houseValueOf(state, p);
  const loan = p.loan ? p.loan.principal : 0;
  const total = p.cash + p.deposit + land + house + stockValue + corpValue - loan;
  return {
    playerId: p.id,
    playerName: p.name,
    bankrupt: p.bankrupt,
    cash: p.cash,
    deposit: p.deposit,
    landValue: land,
    houseValue: house,
    stockValue,
    corpValue,
    loan,
    total,
    rows: [
      { key: 'cash', label: '现金', amount: p.cash },
      { key: 'deposit', label: '存款', amount: p.deposit },
      { key: 'land', label: '土地', amount: land },
      { key: 'house', label: '房屋', amount: house },
      { key: 'stock', label: '股票', amount: stockValue },
      { key: 'corp', label: '原始股', amount: corpValue },
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

/** 单个玩家的股票清单明细（上市股 + 公司原始股两套，列不同所以分开给） */
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
      // 分母取**流通股本**（§3.4 给每支都定了 floatShares）；早先硬写的 1000 与真实盘子不符
      holdingPct: Math.min(100, Math.round((quantity / Math.max(1, stock.floatShares)) * 1000) / 10),
    });
  }
  const corpRows: CorpShareRow[] = [];
  for (const company of state.companies) {
    const quantity = company.shares[p.id] ?? 0;
    if (quantity <= 0) continue;
    const outstanding = Object.values(company.shares).reduce((a, b) => a + b, 0);
    corpRows.push({
      cellId: company.cellId,
      kind: company.kind,
      name: company.name,
      tile: company.tile,
      quantity,
      price: company.sharePrice,
      marketValue: company.sharePrice * quantity,
      locked: lockedSharesOf(company, p.id),
      sellable: sellableSharesOf(company, p.id),
      chairman: company.chairmanId === p.id,
      holdingPct: Math.min(100, Math.round((quantity / Math.max(1, outstanding)) * 1000) / 10),
    });
  }
  rows.sort((a, b) => b.marketValue - a.marketValue);
  corpRows.sort((a, b) => b.marketValue - a.marketValue);
  const corpValue = corpRows.reduce((a, r) => a + r.marketValue, 0);
  const listedValue = rows.reduce((a, r) => a + r.marketValue, 0);
  const listedCost = rows.reduce((a, r) => a + r.cost, 0);
  return {
    playerId: p.id,
    playerName: p.name,
    rows,
    corpRows,
    // 原始股按面值计值 ⇒ 成本与市值相等，进两边、不进盈亏
    marketValue: listedValue + corpValue,
    cost: listedCost + corpValue,
    profit: rows.reduce((a, r) => a + r.profit, 0),
    corpValue,
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