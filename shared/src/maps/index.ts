/**
 * 原版《大富翁4 · 超时空之旅》地图 0~3 的数据入口。
 *
 * 数据由 `python tools/decode_map_mkf.py` 从 `docs/assets/raw/map.mkf` 解出，
 * 逐节点与 `docs/assets/board-svg/mapN.svg` 对拍过（格数、连线、坐标残差 ≤0.1px）。
 * 地图 4~7 的节点表不在这个 mkf 里，拿到源文件后往这个数组追加即可。
 *
 * 三处口径说明：
 * - **租金**：原版每块地给的是七档阶梯价（`rents`），我们的模型是 `grade × baseRent`。
 *   这里先取第一档当 `baseRent`，阶梯价原样留在 JSON 里等规则层决定，不做静默换算。
 * - **`group`**：只有渲染层读它（`world.js` 的 GROUP_HEX），不参与任何规则，
 *   因此按地价从低到高轮转六个色档，纯粹为了让地图有价格分布的层次感。
 * - **公司**：原版每图自带 1~4 家**发股票的公司**（`companies`，一家占相邻两格），
 *   种类按 mkf 自己的枚举给（见 `ORIGINAL_COMPANY_KINDS`）。
 *   **面值取 EXE 股票表的 `par`，不取 mkf 企业子表那一列** —— 那一列原先被我当面值用，
 *   拿 `par` 去除 mkf 的资本额得到 8000 这类像总股本的数（ＳＥＧＡ 2400000/300、
 *   喬治亞人壽 440000/55、中國人壽 288000/36），拿它去除只得到 48~790，所以它不是股价。
 *   地图上 銀行 与 百貨公司 那两种企业节点在 mkf 的这一列恒 0，按功能格落成 bank / shop；
 *   它们在股票表里照样有行、有面值、有波动（花旗銀行 / 三越百貨 那几支），进行情池但不进公司表。
 * - **股票**：每图 12 支在 `stocks.json`（EXE `0x47f072` 的 dump，字段口径写在那个文件的
 *   `_fields` 里）。棋盘上的公司**不另开一行**：它的名字本来就在那 12 支里。
 */
import { COMPANIES, companyStockId, type CompanyDef } from '../companies.js';
import type { BoardCell, CompanyKind, PropertyGroup } from '../types.js';

interface RawCell {
  id: number;
  name: string;
  type: string;
  x: number;
  y: number;
  neighbors: number[];
  sid: number;
  kind: number;
  flags: number;
  group?: string;
  sidName?: string;
  price?: number;
  rents?: number[];
  pointsGain?: number;
  minigame?: string;
  scenery?: boolean;
}

export interface MapCompany {
  sid: number;
  name: string;
  /** mkf 企业子表自带的种类枚举 */
  companyId: number;
  /** 股票面值（mkf 的股价列，只有发股公司为非 0） */
  sharePrice: number;
  /** 建筑图块号（渲染层将来按它贴图） */
  buildingId: number;
  /** 资本额（mkf 里一律整千） */
  capital: number;
  cells: number[];
}

export interface OriginalMap {
  mapId: number;
  name: string;
  source: string;
  nodeCount: number;
  startCellId: number;
  companies: MapCompany[];
  cells: RawCell[];
}

import map0 from './map0.json';
import map1 from './map1.json';
import map2 from './map2.json';
import map3 from './map3.json';
import stockTableJson from './stocks.json';

export const ORIGINAL_MAPS: OriginalMap[] = [map0, map1, map2, map3] as unknown as OriginalMap[];

/**
 * 开局可选地图：只有四张原版图。
 *
 * 这里曾经还挂着一个 `{ id: null, name: '本岛环线（默认）' }` —— 我们自己排的 64 格方环。
 * 它不是地图：没有坐标、形状是硬摊出来的 17×17 外圈，回放盘与小地图都得为它各写一份
 * 假几何。四张原版图各有 103 / 144 / 110 / 118 格和真实坐标，棋盘形状该由数据决定，
 * 所以那个选项被删了。`createGame()` 仍接受 `mapId: null`（无坐标的自建盘），
 * 那是引擎单测的夹具，产品入口不再提供。
 */
export const MAP_CHOICES: Array<{ id: number; name: string; cells: number }> =
  ORIGINAL_MAPS.map((m) => ({ id: m.mapId, name: m.name, cells: m.nodeCount }));

/** 开局缺省地图：产品里不存在「不选图」，一律落到第一张原版图 */
export const DEFAULT_MAP_ID = MAP_CHOICES[0]!.id;

const GROUP_CYCLE: PropertyGroup[] = ['residential', 'coastal', 'industrial', 'commercial', 'tech', 'financial'];

/** 地名段 → 色档：同一段地产共用一个 group，只影响配色 */
function groupTiers(cells: RawCell[]): Map<string, PropertyGroup> {
  const byStreet = new Map<string, number>();
  for (const c of cells) {
    if (c.type !== 'property' || !c.group) continue;
    const best = Math.max(byStreet.get(c.group) ?? 0, c.price ?? 0);
    byStreet.set(c.group, best);
  }
  const ordered = [...byStreet.entries()].sort((a, b) => a[1] - b[1]);
  const out = new Map<string, PropertyGroup>();
  ordered.forEach(([street], i) => out.set(street, GROUP_CYCLE[i % GROUP_CYCLE.length]!));
  return out;
}

/** 地图数据 → 引擎棋盘。坐标原样带上（渲染层据此摆格），邻接表交给 `board.boardNeighbors` */
export function boardFromMap(mapId: number): BoardCell[] {
  const map = ORIGINAL_MAPS.find((m) => m.mapId === mapId);
  if (!map) throw new Error(`没有地图 ${mapId}`);
  const tiers = groupTiers(map.cells);
  return map.cells.map((c) => {
    const cell: BoardCell = {
      id: c.id,
      type: c.type as BoardCell['type'],
      name: c.name || '空白格',
      x: c.x,
      y: c.y,
      neighbors: [...c.neighbors],
    };
    if (c.type === 'property') {
      cell.price = c.price;
      cell.baseRent = c.rents?.[0];
      cell.group = tiers.get(c.group ?? '') ?? 'residential';
      cell.street = `m${mapId}s${c.group ?? c.id}`;
    } else if (c.type === 'commercial') {
      cell.price = c.price;
      cell.baseRent = c.rents?.[0];
      cell.group = 'commercial';
      // 原版一块商业用地占两格（两个不相邻的节点），同 sid 即同一段 ⇒ 租金按整段联合计算
      cell.street = `m${mapId}c${c.sid}`;
    } else if (c.type === 'points') {
      cell.pointsGain = c.pointsGain;
    } else if (c.type === 'company') {
      cell.companyKind = companyKindOf(map, c.sid);
      // 公司格没有地价：踩上去是认购股票，不是买地（面值在公司表上，不在格子上）
    }
    return cell;
  });
}

/**
 * mkf 企业子表自带的种类枚举 → 本作的 `CompanyKind`。
 *
 * 逐条与 19 家公司的名字对拍过：1 航空（聯合航空）、3 电脑（ＳＥＧＡ / ＩＢＭ）、
 * 4 保险（汕頭人壽 / 中國人壽 / 三井生命 / 喬治亞人壽）、5 汽车（豐田 / 福特）、
 * 6 石油（中國石油）、11 建设（日產建設）。
 * 枚举里的 7 与 10 是 銀行 / 百货公司 —— 它们在 mkf 的股价列恒为 0，也就是**不发股票**，
 * 所以落成 bank / shop 功能格，不走这张表。
 */
const ORIGINAL_COMPANY_KINDS: Record<number, CompanyKind> = {
  1: 'airline',
  3: 'computer',
  4: 'insurance',
  5: 'car',
  6: 'oil',
  11: 'estate',
};

function companyOf(map: OriginalMap, sid: number): MapCompany {
  const g = map.companies.find((c) => c.sid === sid);
  if (!g) throw new Error(`地图 ${map.mapId} 的节点 ${sid} 找不到企业子表行`);
  return g;
}

/** 枚举没解出来过就抛，别默默把一家陌生公司塞进股市 */
function companyKindOf(map: OriginalMap, sid: number): CompanyKind {
  const kind = ORIGINAL_COMPANY_KINDS[companyOf(map, sid).companyId];
  if (!kind) throw new Error(`地图 ${map.mapId}：企业枚举 ${companyOf(map, sid).companyId} 还没对上 CompanyKind`);
  return kind;
}

/**
 * 这张图的公司表：建局时的 `CompanyState[]` 与股市里的 `corp-*` 行都由它派生。
 *
 * 名字用 mkf 的原名（中國石油、ＳＥＧＡ），不套我们那 11 家的通用名 —— 玩家在格子上、
 * 股市里、分红播报里看到的必须是同一个名字。消费方式的文案仍按种类走（同一套规则）。
 *
 * 每家都必须在股票表里对上一支（`mapStockPool`）：对不上就抛，不要默默让一家公司没有行情 ——
 * 那会让「一本股东账」断成两条（面板买不到、经营权只能靠踩格认购夺）。
 */
export function companiesFromMap(mapId: number): CompanyDef[] {
  const map = ORIGINAL_MAPS.find((m) => m.mapId === mapId);
  if (!map) throw new Error(`没有地图 ${mapId}`);
  return map.companies.map((g) => {
    const kind = companyKindOf(map, g.sid);
    const listed = stocksFromMap(mapId).find((s) => s.name === g.name);
    if (!listed) throw new Error(`地图 ${mapId}：棋盘上的「${g.name}」在股票表里没有同名的一支`);
    return {
      kind,
      cellId: g.cells[0]!,
      footprint: [...g.cells],
      tile: `mkf ${mapId}/${g.sid}`,
      name: g.name,
      sharePrice: listed.par,
      charge: COMPANIES[kind].charge,
    };
  });
}

/** 本作的口径：`local` 归成布尔，`shares = 0` 那行见下 */
export interface MapStock {
  /** 表内序号 0~11，也是行情池里的显示顺序 */
  idx: number;
  name: string;
  /** 本地股：均值回归的基准挂这张图的地价水平；非本地股基准 = 面值本身 */
  local: boolean;
  shares: number;
  /** 面值 = 开局价（表 +0x0c，dump 出来 anchor == par） */
  par: number;
  /** 波动系数（表 +0x18，原版是 f32，一位小数） */
  volatility: number;
}

/** JSON 里的原始行：`local` 是 dump 照抄的 1 / 0 */
type StockRow = Omit<MapStock, 'local'> & { mapId: number; local: number };

const STOCK_TABLE = stockTableJson.stocks as StockRow[];

/**
 * 这张图的 12 支，原样照表。
 *
 * `shares` 有一行是 0（中國石油）—— 那是**原盘的数**，不是没初始化（用户 2026-10-12 拍的）。
 * 这张票于是两条渠道都拿不到：行情池里没有流通量，公司格的认购也吃同一个池。代码不替它垫数。
 */
export function stocksFromMap(mapId: number): MapStock[] {
  const rows = STOCK_TABLE.filter((r) => r.mapId === mapId);
  if (rows.length !== 12) throw new Error(`地图 ${mapId} 的股票表有 ${rows.length} 行，不是 12`);
  return rows.map((r) => ({
    idx: r.idx,
    name: r.name,
    local: r.local === 1,
    shares: r.shares,
    par: r.par,
    volatility: r.volatility,
  }));
}

/**
 * 原版图的行情池 = 股票表那 12 支，按表序。
 *
 * 棋盘上有公司的那一支**沿用 `corp-<kind>` 这个 id**（不是 `s<图>-<序>`）：经营权判定、
 * 认购锁定、分红、面板与 bot 找「这支股票是哪家公司」整套关联都是按 kind 拼 id 做的
 * （`companies.companyStockId`），换 id 就得在十几处加一层查表，而换来的只是命名整齐。
 * 表序仍然保留，所以公司在面板里不会顶在末尾。
 */
export function mapStockPool(mapId: number, companyDefs: readonly CompanyDef[]) {
  const byName = new Map(companyDefs.map((c) => [c.name, c]));
  return stocksFromMap(mapId).map((s) => {
    const company = byName.get(s.name);
    if (company && company.sharePrice !== s.par) {
      throw new Error(`「${s.name}」的公司在建局时被改了面值（${company.sharePrice} ≠ 股票表 ${s.par}）`);
    }
    return {
      id: company ? companyStockId(company.kind) : `s${mapId}-${s.idx}`,
      name: s.name,
      initialPrice: s.par,
      floatShares: s.shares,
      volatility: s.volatility,
      followsLandPrice: s.local,
    };
  });
}
