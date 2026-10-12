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
 *   种类按 mkf 自己的枚举给（见 `ORIGINAL_COMPANY_KINDS`），面值 = 企业子表那一列股价。
 *   另外原版地图上还有 銀行 与 百貨公司 两种企业节点 —— 它们**不发股**（股价列恒 0），
 *   所以按功能格落成 bank / shop，不进公司表。
 */
import { COMPANIES, type CompanyDef } from '../companies.js';
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

export const ORIGINAL_MAPS: OriginalMap[] = [map0, map1, map2, map3] as unknown as OriginalMap[];

/** 可选地图：`null` = 我们自建的 64 格环（默认图，也是全部既有测试与录像的基线） */
export const MAP_CHOICES: Array<{ id: number | null; name: string; cells: number }> = [
  { id: null, name: '本岛环线（默认）', cells: 64 },
  ...ORIGINAL_MAPS.map((m) => ({ id: m.mapId, name: m.name, cells: m.nodeCount })),
];

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
 */
export function companiesFromMap(mapId: number): CompanyDef[] {
  const map = ORIGINAL_MAPS.find((m) => m.mapId === mapId);
  if (!map) throw new Error(`没有地图 ${mapId}`);
  return map.companies.map((g) => {
    const kind = companyKindOf(map, g.sid);
    return {
      kind,
      cellId: g.cells[0]!,
      footprint: [...g.cells],
      tile: `mkf ${mapId}/${g.sid}`,
      name: g.name,
      sharePrice: g.sharePrice,
      charge: COMPANIES[kind].charge,
    };
  });
}
