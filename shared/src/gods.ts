/**
 * 神明系统（GOD-01..12，对标 `docs/gameplay/玩法系统_游戏开发文档.md` §8.1）。
 *
 * 设计要点（波 4）：
 * - **天数制**：每位神明以「天」计时（1 天 = 所有角色各行动一次），由日切钩子 `godTickHook` 递减。
 * - **对偶转化**：财/福/穷/衰 在「大 ⇄ 小」之间循环；天使 ⇄ 恶魔；死神固定 13 天且期满**自动消失**。
 * - **附身效果**：神明附身（含转化）瞬间一次性结算。
 * - **行进显灵**：附身期间移动/落格时被动生效（抵赖租金、加倍租金、免费买地、加盖/拆屋……）。
 *
 * 本模块零依赖纯数据，`shared` 纯函数不变量不受影响。
 */

export interface GodDef {
  id: string;
  name: string;
  /** 附身效果（一次性结算） */
  possession: string;
  /** 行进显灵（附身期间被动生效），无则空串 */
  travel: string;
  /** 有效期（天） */
  durationDays: number;
  /** 期满对偶转化目标 godId；不填表示期满自动离开 */
  transformsTo?: string;
}

/** 神明有效期：常规 7 天 */
export const GOD_DURATION_DAYS = 7;
/** 死神有效期：固定 13 天（GOD-12） */
export const DEATH_DURATION_DAYS = 13;

/**
 * 十二尊神明（GOD-01..12）。
 * 转化闭环：大财神⇄小财神、大福神⇄小福神、大穷神⇄小穷神、大衰神⇄小衰神、天使⇄恶魔。
 */
export const GODS: GodDef[] = [
  {
    id: 'land-god',
    name: '土地公',
    possession: '所到之地均占为己有，不必缴过路费',
    travel: '',
    durationDays: GOD_DURATION_DAYS,
  },
  {
    id: 'big-wealth',
    name: '大财神',
    possession: '意外获得四位数现金',
    travel: '抵赖所有租金',
    durationDays: GOD_DURATION_DAYS,
    transformsTo: 'small-wealth',
  },
  {
    id: 'small-wealth',
    name: '小财神',
    possession: '可向其他人收取三位数现金',
    travel: '抵赖一半租金',
    durationDays: GOD_DURATION_DAYS,
    transformsTo: 'big-wealth',
  },
  {
    id: 'big-fortune',
    name: '大福神',
    possession: '送两张卡片（内容随机）',
    travel: '买地完全免费、盖房投资铁定加倍',
    durationDays: GOD_DURATION_DAYS,
    transformsTo: 'small-fortune',
  },
  {
    id: 'small-fortune',
    name: '小福神',
    possession: '送一张卡片',
    travel: '盖房投资加倍',
    durationDays: GOD_DURATION_DAYS,
    transformsTo: 'big-fortune',
  },
  {
    id: 'big-poverty',
    name: '大穷神',
    possession: '损失四位数现金',
    travel: '踩到别人的地租金必定加倍',
    durationDays: GOD_DURATION_DAYS,
    transformsTo: 'small-poverty',
  },
  {
    id: 'small-poverty',
    name: '小穷神',
    possession: '送给其他每个人三位数现金',
    travel: '租金加倍',
    durationDays: GOD_DURATION_DAYS,
    transformsTo: 'big-poverty',
  },
  {
    id: 'big-misfortune',
    name: '大衰神',
    possession: '卡片遗失一半',
    travel: '买地绝对流标、投资注定失败',
    durationDays: GOD_DURATION_DAYS,
    transformsTo: 'small-misfortune',
  },
  {
    id: 'small-misfortune',
    name: '小衰神',
    possession: '遗失一张卡片',
    travel: '买地流标、投资失败',
    durationDays: GOD_DURATION_DAYS,
    transformsTo: 'big-misfortune',
  },
  {
    id: 'angel',
    name: '天使',
    possession: '所到之处一律加盖一层房屋',
    travel: '',
    durationDays: GOD_DURATION_DAYS,
    transformsTo: 'devil',
  },
  {
    id: 'devil',
    name: '恶魔',
    possession: '所到之处一律拆掉一层房屋',
    travel: '',
    durationDays: GOD_DURATION_DAYS,
    transformsTo: 'angel',
  },
  {
    id: 'death',
    name: '死神',
    possession: '遗失所有卡片道具，并发生一连串倒霉事',
    travel: '',
    durationDays: DEATH_DURATION_DAYS,
  },
];

/** 按 id 查神明定义 */
export function godDef(id: string): GodDef | undefined {
  return GODS.find((g) => g.id === id);
}

/** 不祥神明（穷神/衰神/死神）——AI 优先用送神卡送走 */
export function isNegativeGod(id: string | undefined): boolean {
  if (!id) return false;
  return id.includes('poverty') || id.includes('misfortune') || id === 'death';
}

/** 神明附身效果的一句话摘要（UI 用） */
export function godSummary(def: GodDef): string {
  return def.travel ? `${def.possession}；${def.travel}` : def.possession;
}