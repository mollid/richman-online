import type { CellType, FacilityType, VillainKind } from './types.js';

/**
 * 界面图标 id —— 马卡龙派对皮肤那套 SVG symbol 的键（`client/public/mp/sprite.svg`）。
 *
 * 为什么这张表必须在 `shared` 而不是留在渲染脚本里：
 * `hud.js` 自己带着 `CELL` / `ITEM_EMOJI` / `GOD_EMOJI` 三张表，与 `shared` 的 id 没有任何
 * 编译期牵连，而它又不参与 typecheck —— 漂移是**静默**的。实测已经漂了：
 * `ITEM_EMOJI` 里 7 个键（`pass-card-item` / `winter-item` / `farmer-item` 等）在 `ITEMS`
 * 里根本不存在，而 `motorbike` / `car` / `missile` / `time-machine` / `teleporter` /
 * `bulldozer` / `nuke` 这 7 个真道具它一个都没有，于是全渲染成兜底的 🧰。
 * 换成 `<use href="#i-x">` 之后风险更高：指不到 symbol 是**什么都不画**，连兜底都没有。
 *
 * 所以：联合类型能穷举的（格型 / 设施 / 恶人）一律 `satisfies` 逼编译器盯；
 * `ITEMS` 与 `GODS` 是按 `string` 开的索引、类型上穷举不了，改由
 * `shared/test/icons.test.ts` 拿运行时 keys 来断言全覆盖。
 */

/** 格型 → 图标。18 项，新增格型不给图标会直接编译不过。 */
export const CELL_ICON = {
  start: 'i-flag',
  property: 'i-house',
  commercial: 'i-store',
  chance: 'i-chance',
  news: 'i-news',
  'free-card': 'i-cards',
  points: 'i-ticket',
  lottery: 'i-slot',
  magic: 'i-crystal',
  tax: 'i-case',
  hospital: 'i-med',
  jail: 'i-jail',
  game: 'i-pad',
  shop: 'i-cart',
  bank: 'i-bank',
  god: 'i-shrine',
  company: 'i-office',
  blank: 'i-blank',
} as const satisfies Record<CellType, string>;

/** 商业用地可建的设施（EST-07） */
export const FACILITY_ICON = {
  park: 'i-park',
  mall: 'i-mall',
  hotel: 'i-hotel',
  gas: 'i-gas',
  lab: 'i-lab',
} as const satisfies Record<FacilityType, string>;

/**
 * 四大恶人。底形同一枚面具，靠 `color` 分极性、靠手持小徽分种类 ——
 * 所以这里四个键指向同一个 symbol 是刻意的，不是忘了区分。
 */
export const NPC_ICON = {
  thief: 'i-mask',
  protection: 'i-mask',
  robber: 'i-mask',
  'rent-thief': 'i-mask',
} as const satisfies Record<VillainKind, string>;

/** 三币。`bell` 铃钱 / `mile` 机票 / `turnip` 大头菜 */
export const CURRENCY_ICON = { bell: 'i-bell', mile: 'i-plane', turnip: 'i-turnip' } as const;

/**
 * 道具 → 图标。`Record<string,…>` 是因为 `ITEMS` 本身就是按 string 开的索引；
 * 完整性由测试保证（`icons.test.ts` 会拿 `ALL_ITEM_IDS` 逐个查）。
 */
export const ITEM_ICON: Record<string, string> = {
  'robot-doll': 'i-robot',
  'remote-dice-item': 'i-remote',
  roadblock: 'i-cone',
  'time-bomb': 'i-bomb',
  mine: 'i-mine',
  'robot-worker': 'i-worker',
  motorbike: 'i-motorbike',
  car: 'i-car',
  missile: 'i-missile',
  'time-machine': 'i-clock',
  teleporter: 'i-teleport',
  bulldozer: 'i-bulldozer',
  nuke: 'i-nuke',
};

/**
 * 神明 → 图标。12 位共用 7 个底形：财 / 福 / 穷 / 厄 四个底形靠 `color` 分福祸、
 * 靠「大 / 小」的轮廓环分强度，再加天使 / 恶魔 / 死神三个独立底形。
 */
export const GOD_ICON: Record<string, string> = {
  'land-god': 'i-shrine',
  'big-wealth': 'i-god-wealth',
  'small-wealth': 'i-god-wealth',
  'big-fortune': 'i-god-fortune',
  'small-fortune': 'i-god-fortune',
  'big-poverty': 'i-god-poverty',
  'small-poverty': 'i-god-poverty',
  'big-misfortune': 'i-god-misfortune',
  'small-misfortune': 'i-god-misfortune',
  angel: 'i-god-angel',
  devil: 'i-god-devil',
  death: 'i-god-death',
};

/** 神明福祸极性：福神薄荷、祸神草莓，由 CSS 的 `color` 喂给 symbol 里的 currentColor */
export function godTone(godId: string): 'good' | 'bad' {
  return /^(big|small)-(poverty|misfortune)$/.test(godId) || godId === 'death' || godId === 'devil' ? 'bad' : 'good';
}

/** 涨跌箭头。平盘也要有图标 —— 原来用「＝」字符，在圆体里跟数字混成一片 */
export const TREND_ICON = { up: 'i-up', down: 'i-down', flat: 'i-flat' } as const;

/** 播报日志分类：按文案挑一枚，挑不到给叶子（原版 🍃 那一条） */
export function logIcon(text: string): string {
  if (/^【新闻】/.test(text)) return 'i-news';
  if (/掷出|来到|路过|进入|经过/.test(text)) return 'i-dice';
  if (/买下|盖|升级|建设|动工/.test(text)) return 'i-house';
  if (/租金|付|收|扣|卖|买|投注/.test(text)) return 'i-bell';
  if (/神|附身|显灵|驻留/.test(text)) return 'i-spark';
  if (/拍卖|流拍|收锤/.test(text)) return 'i-gavel';
  if (/股票|停牌|涨|跌/.test(text)) return 'i-chart';
  return 'i-leaf';
}
