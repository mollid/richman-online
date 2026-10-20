import type { BoardCell, StockPoolDef } from './types.js';

/**
 * 64 格环形棋盘（17x17 网格外圈，顺时针行走；波 3 由 40 格扩至 64 格）。
 *
 * 布局数据与渲染解耦：客户端负责把 cellId 映射到等距坐标。
 * 0–39 号格沿用波 1/2 的地名与编号不变（测试与既有语义稳定）；
 * 40–63 号格为波 3 新增，承载商业用地（TILE-02）、点券格（TILE-14/15/16）、
 * 免费卡片格（TILE-13）、新闻格（TILE-18）、魔法屋（TILE-11）、乐透行（TILE-19）
 * 与 11 家公司企业（TILE-20..30，经营系统归波 5）。
 * 56 号格原本是宝箱（TILE-31）：宝箱改成按月随机驻留的实体后，那一格退回空地。
 */
export const BOARD_SIZE = 64;

export const STARTING_CASH = 15000;
export const PASS_START_SALARY = 2000;
/** 手牌上限（CARD 通用规则：每人最多持有 15 张，额满须舍弃） */
export const MAX_HAND_CARDS = 15;
/** 每种道具的持有上限（ITEM 通用规则：最多 9 个） */
export const MAX_ITEM_COUNT = 9;

/**
 * 点券初始值（用户规则：开局 **0** 点券）。
 * 产出只有四个渠道：宝箱驻留实体、点券格、小游戏、商店变卖卡片/道具。
 */
export const POINTS_START = 0;
/**
 * 单笔贷款上限的**默认值** —— 开局面板可以把起始资金改成别的档位，那一局的实际上限
 * 跟着 `state.initialCashPerPlayer` 走（见 `maxLoanOf`）。留这个常量是因为
 * 「不设初始金额时就是它」，测试与缺省路径都取这一档。
 */
export const MAX_LOAN = STARTING_CASH;
/** 贷款期限（月）：到期强制全额归还 */
export const LOAN_TERM_MONTHS = 3;
/** 存款月末利率（有贷款者当月不计息） */
export const DEPOSIT_MONTHLY_INTEREST = 0.1;
/** 游戏厅小游戏每命中一次奖励的点券 */
export const MINIGAME_POINTS_PER_HIT = 100;

function cell(id: number, type: BoardCell['type'], name: string, extra: Partial<BoardCell> = {}): BoardCell {
  return { id, type, name, ...extra };
}

/** 住宅用地（TILE-01）：可购地、可加盖 5 级 */
const P = (id: number, name: string, price: number, baseRent: number, group: BoardCell['group'], street: string): BoardCell =>
  cell(id, 'property', name, { price, baseRent, group, street });

/** 商业用地（TILE-02）：首次只买地，再次走到可选 5 种建设 */
const C = (id: number, name: string, price: number): BoardCell =>
  cell(id, 'commercial', name, { price, group: 'commercial', street: `street-${id}` });

/** 公司企业格（TILE-20..30，波 5 开放经营） */
const CO = (id: number, name: string, companyKind: BoardCell['companyKind']): BoardCell =>
  cell(id, 'company', name, { companyKind });

export const DEFAULT_BOARD: BoardCell[] = [
  cell(0, 'start', '起点'),
  P(1, '桃园路', 300, 80, 'residential', 'street-1'),
  cell(2, 'shop', '商店'),
  cell(3, 'chance', '机会'),
  P(4, '成都路', 350, 90, 'residential', 'street-4'),
  cell(5, 'god', '神庙'),
  P(6, '南京路', 500, 130, 'commercial', 'street-6'),
  cell(7, 'chance', '机会'),
  P(8, '淮海路', 520, 135, 'commercial', 'street-8'),
  P(9, '王府井', 550, 140, 'commercial', 'street-8'),
  P(10, '铜锣湾', 580, 150, 'commercial', 'street-8'),
  cell(11, 'chance', '机会'),
  P(12, '铁西区', 450, 110, 'industrial', 'street-12'),
  P(13, '经开区', 470, 115, 'industrial', 'street-12'),
  cell(14, 'hospital', '医院'),
  P(15, '高新区', 500, 125, 'industrial', 'street-15'),
  P(16, '科学城', 520, 130, 'industrial', 'street-15'),
  cell(17, 'game', '游戏厅'),
  P(18, '中关村', 700, 180, 'tech', 'street-18'),
  P(19, '张江', 720, 185, 'tech', 'street-18'),
  P(20, '深圳湾', 750, 195, 'tech', 'street-18'),
  cell(21, 'tax', '缴税'),
  P(22, '光谷', 780, 200, 'tech', 'street-22'),
  cell(23, 'chance', '机会'),
  P(24, '鼓浪屿', 650, 165, 'coastal', 'street-24'),
  P(25, '亚龙湾', 680, 170, 'coastal', 'street-24'),
  cell(26, 'jail', '监狱'),
  P(27, '金石滩', 700, 175, 'coastal', 'street-27'),
  P(28, '银滩', 720, 180, 'coastal', 'street-27'),
  cell(29, 'chance', '机会'),
  P(30, '陆家嘴', 900, 230, 'financial', 'street-30'),
  P(31, '金融街', 880, 225, 'financial', 'street-30'),
  P(32, '中环', 920, 235, 'financial', 'street-30'),
  P(33, '曼哈顿', 950, 240, 'financial', 'street-30'),
  cell(34, 'chance', '机会'),
  cell(35, 'bank', '银行', { bankKind: 'public' }),
  P(36, '西门町', 340, 88, 'residential', 'street-36'),
  cell(37, 'shop', '百货'),
  cell(38, 'bank', '证交所', { bankKind: 'exchange' }),
  P(39, '迪化街', 380, 95, 'residential', 'street-39'),

  // ---- 波 3 新增：40–63 ----
  C(40, '世贸天阶', 600),
  cell(41, 'points', '点券站', { pointsGain: 10 }),
  cell(42, 'free-card', '卡片屋'),
  CO(43, '电脑公司', 'computer'),
  cell(44, 'news', '报社'),
  C(45, '环球中心', 700),
  cell(46, 'points', '游乐场', { pointsGain: 30 }),
  CO(47, '保险公司', 'insurance'),
  cell(48, 'magic', '魔法屋'),
  C(49, '金融塔', 800),
  cell(50, 'news', '电视台'),
  CO(51, '航空公司', 'airline'),
  cell(52, 'points', '嘉年华', { pointsGain: 50 }),
  C(53, '商贸城', 650),
  cell(54, 'lottery', '乐透行'),
  CO(55, '大饭店', 'restaurant'),
  cell(56, 'blank', '空地'),
  CO(57, '汽车公司', 'car'),
  CO(58, '企业银行', 'bank'),
  CO(59, '石油公司', 'oil'),
  CO(60, '水力公司', 'water'),
  CO(61, '电力公司', 'power'),
  CO(62, '百货公司', 'department'),
  CO(63, '房地产公司', 'estate'),
];

/** 服务器/旧存档兜底：棋盘缺格时补默认格 */
export function fallbackBoard(): BoardCell[] {
  return DEFAULT_BOARD.map((c) => ({ ...c }));
}

/**
 * 邻接表：格子上写了 `neighbors` 就用它，没写就按「定长环」推。
 *
 * 环因此只是图的一个特例，而不是代码里另开的一条分支 —— 自建图与老数据一行都不用改，
 * 原版地图（主闭环 + 分支）则靠节点记录自带的邻接走同一段逻辑。
 */
export function boardNeighbors(board: BoardCell[], cellId: number): number[] {
  const c = board[cellId];
  if (!c) return [];
  if (c.neighbors?.length) return c.neighbors;
  const size = board.length;
  return [(cellId + size - 1) % size, (cellId + 1) % size];
}

/**
 * 往前挪一步，并给出到了下一格之后该用的朝向。
 *
 * `heading` 是**邻接表下标**而不是「上一步站过哪格」的绝对格号 —— 这一点很要紧：
 * 测试与场景搭建常直接改写 `position`，存绝对格号的话那份朝向会变成随机残留值，
 * 万一它恰好是脚下这格的邻居，前进方向就静悄悄翻到另一侧。存下标则 `heading = 1`
 * 在任何环上都恒等于顺时针（邻接表按 `[前一格, 后一格]` 生成），与旧的 `direction = 1` 同义。
 *
 * 到了下一格之后：能继续前进的是「不是刚离开那格」的那些邻居；**死端**只剩回头路，于是原路返回；
 * **岔路口**（还剩多条）交给 `pick` —— 玩家移动传抽 RNG 的「随机拐」，前瞻传定序，
 * 所以只有真出现岔口才消耗抽数，环上一律零消耗。
 */
export function stepAlong(
  board: BoardCell[],
  from: number,
  heading: number,
  pick: (options: number[]) => number,
): { next: number; heading: number } {
  const ways = boardNeighbors(board, from);
  if (ways.length === 0) return { next: from, heading: 0 };
  const next = ways[Math.min(ways.length - 1, Math.max(0, heading))]!;
  const onwardWays = boardNeighbors(board, next);
  const onward = onwardWays.filter((n) => n !== from);
  const chosen = (onward.length > 0 ? onward : onwardWays);
  const taken = chosen.length === 1 ? chosen[0]! : pick(chosen);
  return { next, heading: Math.max(0, onwardWays.indexOf(taken)) };
}

/** 从 from 起的前瞻路径（送神卡 / 机器娃娃的「前方 9 步」；岔口取定序，不消耗 RNG） */
export function pathAhead(
  board: BoardCell[],
  from: number,
  heading: number,
  steps: number,
): number[] {
  const out: number[] = [];
  let cur = from;
  let h = heading;
  for (let i = 0; i < steps; i++) {
    const stepped = stepAlong(board, cur, h, (o) => o[0]!);
    out.push(stepped.next);
    cur = stepped.next;
    h = stepped.heading;
  }
  return out;
}

/**
 * 「身后 back 格 + 脚下 + 前方 forward 格」这一段连续格，**按从后到前的顺序**返回。
 *
 * 爆炸范围与换地视窗原本都是 `(center + d + 64) % 64` 这种环上偏移写出来的，返回顺序还被
 * 播报文案（`cellNames` 拼接）依赖，所以这里按同样的顺序吐：环上 `back=7, forward=8` 逐格等于
 * 旧写法。图上的「身后 / 前方」就是邻接表的两个方向 —— 环上 `[前一格, 后一格]`，
 * 故 heading 0 向后、1 向前；支路则顺着「不回头的那条路」往外走。
 */
export function walkWindow(board: BoardCell[], center: number, back: number, forward: number): number[] {
  const behind = pathAhead(board, center, 0, back).reverse();
  return [...behind, center, ...pathAhead(board, center, 1, forward)];
}

/**
 * 棋盘几何：把地图自带的原始坐标换算成世界坐标。
 *
 * 产品里四张地图（103 / 144 / 110 / 118 格）**每张都自带坐标**，所以棋盘形状一律按图走：
 * 没有「64 格环」这回事。返回 `null` 只剩两种情况 —— 空棋盘，或坐标混用/退化
 * （引擎里那份 64 格自建盘 `DEFAULT_BOARD` 就是无坐标的，仅作单测夹具）。
 * 渲染层拿到 `null` 应当**不画棋盘**，而不是伪造一个环出来：形状是数据的一部分，
 * 画布不该替数据做决定（旧版那个方环兜底已经删掉了）。
 *
 * 放在 shared 而不是各写一份在 `world.js` / `hud.js` 里，有两个理由：
 * 1. 3D 场景、小地图、回放盘**必须**用同一份几何，否则取景框与格子会错位；
 * 2. 这份换算是可以断言的（质心归零、邻距定标、缺坐标时干净退回 null），散在脚本里就没人测得到。
 *
 * 缩放按**邻接边的中位长度**定标，让相邻两格的台座正好相距 `spacing`。
 * 不能按包围盒缩放：台座与描边环的尺寸是按 `spacing` 的上限设计的（见 `world.js` 里 TILE 那段注释），
 * 把 100+ 格的图硬塞进同一个包围盒里，格子会互相穿插成一团。
 */
export interface BoardLayout {
  /** 下标即 cellId */
  cells: Array<{ x: number; z: number }>;
  /** 最远格到中心的距离（世界单位）：岛体大小与镜头上限按它推 */
  radius: number;
}

export function boardLayout(board: BoardCell[], spacing = 2): BoardLayout | null {
  if (board.length === 0) return null;
  if (board.some((c) => !Number.isFinite(c.x) || !Number.isFinite(c.y))) return null; // 混用 ⇒ 整体退回 null，避免半张图错位

  const lens: number[] = [];
  for (const c of board) {
    for (const n of c.neighbors ?? []) {
      if (n <= c.id) continue; // 每条边只量一次
      const other = board[n];
      if (!other) continue;
      lens.push(Math.hypot((c.x ?? 0) - (other.x ?? 0), (c.y ?? 0) - (other.y ?? 0)));
    }
  }
  if (lens.length === 0) return null;
  lens.sort((a, b) => a - b);
  const step = lens[Math.floor(lens.length / 2)]!;
  if (!(step > 0)) return null;

  const k = spacing / step;
  const cx = board.reduce((s, c) => s + (c.x ?? 0), 0) / board.length;
  const cy = board.reduce((s, c) => s + (c.y ?? 0), 0) / board.length;
  const cells = board.map((c) => ({ x: ((c.x ?? 0) - cx) * k, z: ((c.y ?? 0) - cy) * k }));
  return { cells, radius: Math.max(...cells.map((p) => Math.hypot(p.x, p.z))) };
}

/** 图上最短步数（环上的 `min(d, size - d)` 是它的特例） */
export function graphDistance(board: BoardCell[], a: number, b: number): number {
  if (a === b) return 0;
  const dist = new Map<number, number>([[a, 0]]);
  let frontier = [a];
  while (frontier.length) {
    const next: number[] = [];
    for (const u of frontier) {
      for (const v of boardNeighbors(board, u)) {
        if (dist.has(v)) continue;
        dist.set(v, (dist.get(u) ?? 0) + 1);
        if (v === b) return dist.get(v)!;
        next.push(v);
      }
    }
    frontier = next;
  }
  return Number.MAX_SAFE_INTEGER;
}

/**
 * 股票初始定义（每局价格随机波动）。
 * `floatShares` 是流通股本，只用作冲击成本与背景成交量的分母：按「各支市值相当」定标，
 * 于是高价股（金融）股数少、同样一笔成交推动更大，低价股（食品）反之。
 */
export const STOCK_DEFS: StockPoolDef[] = [
  { id: 'tech', name: '科技股', initialPrice: 120, floatShares: 1600 },
  { id: 'food', name: '食品股', initialPrice: 80, floatShares: 2400 },
  { id: 'estate', name: '地产股', initialPrice: 200, floatShares: 1000 },
  { id: 'energy', name: '能源股', initialPrice: 150, floatShares: 1400 },
  { id: 'media', name: '传媒股', initialPrice: 100, floatShares: 2000 },
  { id: 'finance', name: '金融股', initialPrice: 260, floatShares: 900 },
];

// 神明定义（GOD-01..12）已迁至 `./gods.ts`（波 4 起改为天数制 + 对偶转化）。