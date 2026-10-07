/**
 * 卡片系统（CARD-01 – CARD-30，对标 `docs/gameplay/玩法系统_游戏开发文档.md` §6）。
 *
 * 通用规则：
 * - 全游戏共 30 种卡片，每人最多持有 15 张（`MAX_HAND_CARDS`）；
 * - 卡片**只能以点券购买**（`cost` 单位为点券），不能以现金购买；
 * - 「自动」卡片（复仇/嫁祸/免费/免罪）不主动使用，由反制栈在受击时自动触发。
 *
 * 反制关系（§6.1）：免罪 → 陷害/梦游/乌龟/牢狱；嫁祸/复仇 → 陷害/梦游；查封 ⇄ 涨价；红卡 ⇄ 黑卡。
 */

/** 卡片可用时机 */
export type CardPhase = 'pre_roll' | 'post_roll' | 'any';

/** 卡片目标类型（决定 UI 需要收集哪些参数） */
export type CardTarget = 'none' | 'player' | 'land' | 'building' | 'stock';

export interface CardDef {
  id: string;
  name: string;
  description: string;
  /** 商店售价（点券） */
  cost: number;
  phase: CardPhase;
  target: CardTarget;
  /** 需要选择股票（红卡/黑卡） */
  needsStock?: boolean;
  /** 自动触发（不可主动使用） */
  auto?: boolean;
  /** 反制它的卡片 id（仅用于 UI 提示） */
  counteredBy?: string[];
  /**
   * 是否已开放。拍卖卡依赖波 6 的拍卖系统，当前入库但不开放
   * （不进商店货架、不进机会池）。
   */
  available: boolean;
}

export const CARDS: Record<string, CardDef> = {
  // ---- CARD-01..05 现金属性 + 地产置换 ----
  'even-all': {
    id: 'even-all',
    name: '均富卡',
    description: '将所有人的现金平分（余数归使用者）',
    cost: 200,
    phase: 'any',
    target: 'none',
    available: true,
  },
  'even-target': {
    id: 'even-target',
    name: '均贫卡',
    description: '将指定对手与自己的现金平分（余数归使用者）',
    cost: 200,
    phase: 'any',
    target: 'player',
    available: true,
  },
  'buy-land': {
    id: 'buy-land',
    name: '购地卡',
    description: '以市价强制收购脚下他人的土地（连同房屋一并取得）',
    cost: 35,
    phase: 'post_roll',
    target: 'land',
    available: true,
  },
  'swap-land': {
    id: 'swap-land',
    name: '换地卡',
    description: '以脚下土地换取同类型（住宅换住宅 / 商业换商业）的其他土地',
    cost: 25,
    phase: 'post_roll',
    target: 'land',
    available: true,
  },
  'swap-house': {
    id: 'swap-house',
    name: '换屋卡',
    description: '以脚下房屋换取同类型的其他房屋（仅房屋等级互换，地权不变）',
    cost: 20,
    phase: 'post_roll',
    target: 'land',
    available: true,
  },
  // ---- CARD-06..08 移动 / 改建 / 拍卖 ----
  turnaround: {
    id: 'turnaround',
    name: '转向卡',
    description: '所有玩家行进方向 180° 反转',
    cost: 20,
    phase: 'any',
    target: 'none',
    available: true,
  },
  rebuild: {
    id: 'rebuild',
    name: '改建卡',
    description: '住宅：一般建筑 ⇄ 连锁店互转（改建后不能再加盖）；商业用地：变更设施项目',
    cost: 15,
    phase: 'post_roll',
    target: 'land',
    available: true,
  },
  auction: {
    id: 'auction',
    name: '拍卖卡',
    description: '拍卖脚下土地，所得归使用者（待拍卖系统开放）',
    cost: 20,
    phase: 'post_roll',
    target: 'land',
    available: false,
  },
  // ---- CARD-09..13 路段 / 建筑 / 抢夺 ----
  'angel-road': {
    id: 'angel-road',
    name: '天使卡',
    description: '指定路段的所有房屋各加盖一层',
    cost: 160,
    phase: 'any',
    target: 'land',
    available: true,
  },
  'devil-road': {
    id: 'devil-road',
    name: '恶魔卡',
    description: '指定路段夷为平地',
    cost: 180,
    phase: 'any',
    target: 'land',
    available: true,
  },
  monster: {
    id: 'monster',
    name: '怪兽卡',
    description: '彻底摧毁一栋建筑，还原为平地',
    cost: 60,
    phase: 'any',
    target: 'building',
    available: true,
  },
  demolish: {
    id: 'demolish',
    name: '拆除卡',
    description: '建筑拆除一个等级；也可拆除路面道具（地雷 / 路障）',
    cost: 15,
    phase: 'any',
    target: 'building',
    available: true,
  },
  snatch: {
    id: 'snatch',
    name: '抢夺卡',
    description: '抢走对手的一张卡片或一个道具',
    cost: 25,
    phase: 'any',
    target: 'player',
    available: true,
  },
  // ---- CARD-14..21 停留 / 睡眠 / 陷害 / 反制 ----
  hold: {
    id: 'hold',
    name: '停留卡',
    description: '使对手下一次前进时停留在原地',
    cost: 20,
    phase: 'any',
    target: 'player',
    available: true,
  },
  hibernate: {
    id: 'hibernate',
    name: '冬眠卡',
    description: '所有对手睡眠 5 天，丧失收租权利',
    cost: 100,
    phase: 'any',
    target: 'none',
    available: true,
  },
  sleepwalk: {
    id: 'sleepwalk',
    name: '梦游卡',
    description: '指定对手梦游 5 天：丧失收租与买地权利',
    cost: 25,
    phase: 'any',
    target: 'player',
    counteredBy: ['absolve', 'shift-blame', 'revenge'],
    available: true,
  },
  frame: {
    id: 'frame',
    name: '陷害卡',
    description: '使指定对手坐牢 5 天，丧失收租权利',
    cost: 20,
    phase: 'any',
    target: 'player',
    counteredBy: ['absolve', 'shift-blame', 'revenge'],
    available: true,
  },
  revenge: {
    id: 'revenge',
    name: '复仇卡',
    description: '被害入狱、被陷害、被催眠时自动拖害你的人一起下水',
    cost: 20,
    phase: 'any',
    target: 'none',
    auto: true,
    available: true,
  },
  'shift-blame': {
    id: 'shift-blame',
    name: '嫁祸卡',
    description: '遭遇灾难时自动转嫁给他人，让其代为受过',
    cost: 40,
    phase: 'any',
    target: 'none',
    auto: true,
    available: true,
  },
  'free-pass': {
    id: 'free-pass',
    name: '免费卡',
    description: '租金 / 罚金 / 税金超过 2000 × 物价指数（或超过剩余资金）时自动抵用一次',
    cost: 25,
    phase: 'any',
    target: 'none',
    auto: true,
    available: true,
  },
  absolve: {
    id: 'absolve',
    name: '免罪卡',
    description: '自动抵消一次牢狱之灾（含陷害 / 梦游 / 乌龟卡）',
    cost: 25,
    phase: 'any',
    target: 'none',
    auto: true,
    available: true,
  },
  // ---- CARD-22..25 神明 / 股价 ----
  'send-god': {
    id: 'send-god',
    name: '送神卡',
    description: '送走附身的神明；也可拆走身上的定时炸弹',
    cost: 10,
    phase: 'any',
    target: 'none',
    available: true,
  },
  'invite-god': {
    id: 'invite-god',
    name: '请神卡',
    description: '请来最靠近自己的神明附身',
    cost: 20,
    phase: 'any',
    target: 'none',
    available: true,
  },
  'red-card': {
    id: 'red-card',
    name: '红卡',
    description: '炒作指定公司股价，其股票涨停板 3 天',
    cost: 60,
    phase: 'any',
    target: 'stock',
    needsStock: true,
    counteredBy: ['black-card'],
    available: true,
  },
  'black-card': {
    id: 'black-card',
    name: '黑卡',
    description: '打压指定公司股价，其股票跌停板 3 天',
    cost: 30,
    phase: 'any',
    target: 'stock',
    needsStock: true,
    counteredBy: ['red-card'],
    available: true,
  },
  // ---- CARD-26..30 税务 / 路租 / 同盟 / 乌龟 ----
  'tax-audit': {
    id: 'tax-audit',
    name: '查税卡',
    description: '强制收取指定者 20% 的现金税',
    cost: 35,
    phase: 'any',
    target: 'player',
    counteredBy: ['free-pass', 'shift-blame'],
    available: true,
  },
  'raise-rent': {
    id: 'raise-rent',
    name: '涨价卡',
    description: '5 天内整条街加倍收取过路费',
    cost: 35,
    phase: 'any',
    target: 'land',
    counteredBy: ['seal-rent'],
    available: true,
  },
  'seal-rent': {
    id: 'seal-rent',
    name: '查封卡',
    description: '5 天内整条街免收过路费',
    cost: 35,
    phase: 'any',
    target: 'land',
    counteredBy: ['raise-rent'],
    available: true,
  },
  alliance: {
    id: 'alliance',
    name: '同盟卡',
    description: '与指定对手同盟 7 天：互相不收过路费',
    cost: 40,
    phase: 'any',
    target: 'player',
    available: true,
  },
  turtle: {
    id: 'turtle',
    name: '乌龟卡',
    description: '所有人 3 天内一次只走一步',
    cost: 70,
    phase: 'any',
    target: 'none',
    counteredBy: ['absolve'],
    available: true,
  },
};

/** 全部卡片 id（含未开放） */
export const ALL_CARD_IDS = Object.keys(CARDS);

/** 商店在售卡片（已开放的全部卡片，含自动触发类） */
export const SHOP_CARD_IDS = ALL_CARD_IDS.filter((id) => CARDS[id]!.available);

/**
 * 机会格抽卡池：排除重型的路段卡（天使/恶魔）与纯自动反制卡（复仇/嫁祸），
 * 以及未开放的拍卖卡，保证机会格产出均衡。
 */
export const CHANCE_CARD_POOL = [
  'even-all',
  'even-target',
  'buy-land',
  'swap-land',
  'swap-house',
  'turnaround',
  'rebuild',
  'monster',
  'demolish',
  'snatch',
  'hold',
  'hibernate',
  'sleepwalk',
  'frame',
  'absolve',
  'free-pass',
  'send-god',
  'invite-god',
  'red-card',
  'black-card',
  'tax-audit',
  'raise-rent',
  'seal-rent',
  'alliance',
  'turtle',
];