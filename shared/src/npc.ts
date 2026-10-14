/**
 * 特殊单位数据（波 8，NPC-01..06）。
 *
 * 数据来源：`docs/gameplay/玩法系统_游戏开发文档.md` §8.2 特殊单位、help [34]/[38]：
 * - NPC-01 小偷：偷取来往路人的点券及路上物品，交给替他保释的人；
 * - NPC-02 收保护费：依土地地价收保护费，交给保释人；
 * - NPC-03 行抢：抢夺来往路人的一张卡片或道具，交给保释人；
 * - NPC-04 窃取租金：走到土地窃取该地上次收取的租金；走到公司企业盗领所有累积红利；
 * - NPC-05 恶犬：随机出没（见 engine 的 dogActivityHook）；
 * - NPC-06 女巫：进入魔法屋格，水晶球随机给出目标条件，玩家自选一档魔法，符合条件者全部中招。
 *
 * 恶人的金额与天数原版未逐条核实，标注为推断值；魔法屋的条件表与效果表已按 exe 拆解定案，
 * 权威记录见 `docs/玩法拆解_魔法屋.md` 与 `docs/玩法拆解_魔法屋对账决策表.md` §七。
 */
import type { MagicCondition, MagicEffectKind, VillainKind } from './types.js';

/** 四大恶人（NPC-01..04），被保释出狱后在路上为保释人效力 */
export type { VillainKind };

export const VILLAIN_KINDS: readonly VillainKind[] = ['thief', 'protection', 'robber', 'rent-thief'];

export interface VillainDef {
  kind: VillainKind;
  name: string;
  desc: string;
}

export const VILLAINS: Record<VillainKind, VillainDef> = {
  thief: { kind: 'thief', name: '小偷', desc: '偷取来往路人的点券与路上物品，收益归保释人' },
  protection: { kind: 'protection', name: '收保护费', desc: '依土地地价收取保护费，收益归保释人' },
  robber: { kind: 'robber', name: '行抢', desc: '抢夺来往路人的一张卡片或道具，收益归保释人' },
  'rent-thief': { kind: 'rent-thief', name: '窃取租金', desc: '窃取途经土地的租金或公司累积红利，收益归保释人' },
};

/**
 * 特殊单位的展示名（HUD 与面板共用一份）。
 *
 * 为什么单独列：恶犬不在 `VILLAINS` 那张表里（它不由保释产生），但表现层要能一句话
 * 说清「这格上蹲着什么」。两处各写各的名字，迟早出一格两个说法。
 */
export const NPC_NAMES: Record<string, string> = {
  ...Object.fromEntries(VILLAIN_KINDS.map((k) => [k, VILLAINS[k].name])),
  dog: '恶犬',
};

/**
 * 保释金（D-50：改为**点券**支付，且**不随物价指数缩放**）。
 *
 * 决策人口述的点券账本里，出账就是「买卡片、买道具、保释恶人」三件 —— 旧实现花现金
 * （5000 × 物价）与这份账不符。定价取 100：点券那一侧全是固定标价（卡片 10~40、道具 25~150），
 * 而小偷单次行窃上限 500、恶人效力 7 天，100 点券换 7 天赃物既不至于白送也还买得起。
 */
export const BAIL_FEE = 100;
/** 四大恶人出狱后活动天数 */
export const VILLAIN_DAYS = 7;
/** NPC-01 小偷每次行窃的点券上限 */
export const THIEF_POINTS_TAKE = 500;
/** NPC-02 收保护费比例（按土地地价计） */
export const PROTECTION_FEE_RATE = 0.05;

/**
 * TILE-31 宝箱点券（公开攻略值，游戏内未在 help.mkf 明文，标注为待验证）。
 * 宝箱是按月随机驻留的实体，投放与拾取逻辑见 engine 的 `treasureRefreshHook` 与移动循环。
 */
export const TREASURE_POINTS = 500;

/** 魔法屋施法条件：水晶球随机报一条标语，决定这一局魔法落在谁头上 */
export interface MagicConditionDef {
  kind: MagicCondition;
  /** 屏幕标语原文。只报这一句，**不报命中名单**（决策表 §7.6） */
  label: string;
}

/**
 * A §三 的 12 条标语，波 1 只上 10 条：「所有男生 / 所有女生」要角色性别字段，
 * 那条挪到波 3（Q-06 定：字段没落地前不进随机池，而不是进池恒不命中）。
 */
export const MAGIC_CONDITIONS: MagicConditionDef[] = [
  { kind: 'richest', label: '财产最多的人' },
  { kind: 'most-land', label: '土地最多的人' },
  { kind: 'most-house', label: '房屋最多的人' },
  { kind: 'richest-cash', label: '现金最多的人' },
  { kind: 'richest-deposit', label: '存款最多的人' },
  { kind: 'richest-points', label: '点券最多的人' },
  { kind: 'walker', label: '走路的人' },
  { kind: 'motorbike', label: '骑机车的人' },
  { kind: 'car', label: '开汽车的人' },
  { kind: 'godded', label: '神明附身的人' },
];

export const MAGIC_CONDITION_LABEL: Record<MagicCondition, string> = Object.fromEntries(
  MAGIC_CONDITIONS.map((c) => [c.kind, c.label]),
) as Record<MagicCondition, string>;

/** 玩家自选的魔法档（A §四） */
export interface MagicEffectDef {
  kind: MagicEffectKind;
  name: string;
  /** 面板据此分叉样式：好事档不该长得像诅咒（M-10 的影响列） */
  polarity: 'bad' | 'good' | 'neutral';
  /** jail / hospital 档的停留天数 */
  days?: number;
}

/**
 * A §四 的 11 档（6 坏 / 3 好 / 1 中性）+ 原本"隐藏"的拍卖档（M-24 定其进池、可被玩家选）。
 * `MAGIC_EFFECT_ORDER` 同时是**可选集**：不在表里的效果号一律拒绝。
 *
 * 拍卖档记 `neutral`：它夺走地权，但成交价照付给被施法者本人（不是净损失），
 * 好坏取决于他缺不缺现金 —— A 把它列在「隐藏」而没给极性，这里按同一理由不替它定性。
 */
export const MAGIC_EFFECTS: Record<MagicEffectKind, MagicEffectDef> = {
  'sell-cards': { kind: 'sell-cards', name: '变卖所有卡片', polarity: 'bad' },
  'fate-x3': { kind: 'fate-x3', name: '抽取命运三张', polarity: 'bad' },
  jail: { kind: 'jail', name: '立刻坐牢三天', polarity: 'bad', days: 3 },
  hold: { kind: 'hold', name: '原地停留一回合', polarity: 'bad' },
  demolish: { kind: 'demolish', name: '就地拆除房屋', polarity: 'bad' },
  hospital: { kind: 'hospital', name: '住院检查三天', polarity: 'bad', days: 3 },
  'gain-card': { kind: 'gain-card', name: '得一张卡片', polarity: 'good' },
  'build-up': { kind: 'build-up', name: '就地加盖房屋', polarity: 'good' },
  'to-deposit': { kind: 'to-deposit', name: '存入所有现金', polarity: 'good' },
  'turn-back': { kind: 'turn-back', name: '向后转', polarity: 'neutral' },
  'auction-cell': { kind: 'auction-cell', name: '拍卖当格土地', polarity: 'neutral' },
};

export const MAGIC_EFFECT_ORDER: MagicEffectKind[] = [
  'sell-cards',
  'fate-x3',
  'jail',
  'hold',
  'demolish',
  'hospital',
  'gain-card',
  'build-up',
  'to-deposit',
  'turn-back',
  'auction-cell',
];

/**
 * AI 自保（M-25，A §二「电脑」段）：候选名单含自己时，效果号强制改成「得一张卡片」。
 * 单独钉一个常量，是为了让"自保改的是哪一档"这件事只有一处说法。
 */
export const MAGIC_AI_SELF_GUARD_EFFECT: MagicEffectKind = 'gain-card';

/**
 * 保险理赔（M-15 / Q-01）：被魔法判入狱或住院时，**身上有有效保单**的人按现金领这笔，
 * 归他自己 —— 与命运卡「领取保险金」同一套 `p.insurance` 判定。
 */
export const MAGIC_INSURANCE_CLAIM = 10000;

export function villainByKind(kind: VillainKind): VillainDef {
  return VILLAINS[kind];
}