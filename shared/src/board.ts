import type { BoardCell, Stock } from './types.js';

/**
 * 64 格环形棋盘（17x17 网格外圈，顺时针行走；波 3 由 40 格扩至 64 格）。
 *
 * 布局数据与渲染解耦：客户端负责把 cellId 映射到等距坐标。
 * 0–39 号格沿用波 1/2 的地名与编号不变（测试与既有语义稳定）；
 * 40–63 号格为波 3 新增，承载商业用地（TILE-02）、点券格（TILE-14/15/16）、
 * 免费卡片格（TILE-13）、新闻格（TILE-18）、魔法屋（TILE-11）、乐透行（TILE-19）、
 * 宝箱（TILE-31）与 11 家公司企业（TILE-20..30，经营系统归波 5）。
 */
export const BOARD_SIZE = 64;

export const STARTING_CASH = 15000;
export const PASS_START_SALARY = 2000;
/** 手牌上限（CARD 通用规则：每人最多持有 15 张，额满须舍弃） */
export const MAX_HAND_CARDS = 15;
/** 每种道具的持有上限（ITEM 通用规则：最多 9 个） */
export const MAX_ITEM_COUNT = 9;

/** 点券初始值（用户规则：开局 **0** 点券；产出只来自宝箱/点券格/小游戏/商店变卖） */
export const POINTS_START = 0;
/** 单笔贷款上限 */
export const MAX_LOAN = STARTING_CASH;
/** 贷款期限（月）：到期强制全额归还 */
export const LOAN_TERM_MONTHS = 3;
/** 存款月末利率（有贷款者当月不计息） */
export const DEPOSIT_MONTHLY_INTEREST = 0.1;
/** 游戏厅小游戏每命中一次奖励的点券 */
export const MINIGAME_POINTS_PER_HIT = 100;

/** TILE-31 宝箱点数（公开攻略值，游戏内未在 help.mkf 明文，标注为待验证） */
export const TREASURE_POINTS = 500;

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
  cell(56, 'treasure', '宝箱'),
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
 * 股票初始定义（每局价格随机波动）。
 * `floatShares` 是流通股本，只用作冲击成本与背景成交量的分母：按「各支市值相当」定标，
 * 于是高价股（金融）股数少、同样一笔成交推动更大，低价股（食品）反之。
 */
export const STOCK_DEFS: Array<Pick<Stock, 'id' | 'name'> & { initialPrice: number; floatShares: number }> = [
  { id: 'tech', name: '科技股', initialPrice: 120, floatShares: 1600 },
  { id: 'food', name: '食品股', initialPrice: 80, floatShares: 2400 },
  { id: 'estate', name: '地产股', initialPrice: 200, floatShares: 1000 },
  { id: 'energy', name: '能源股', initialPrice: 150, floatShares: 1400 },
  { id: 'media', name: '传媒股', initialPrice: 100, floatShares: 2000 },
  { id: 'finance', name: '金融股', initialPrice: 260, floatShares: 900 },
];

// 神明定义（GOD-01..12）已迁至 `./gods.ts`（波 4 起改为天数制 + 对偶转化）。