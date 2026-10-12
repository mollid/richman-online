/**
 * 特殊单位数据（波 8，NPC-01..06）。
 *
 * 数据来源：`docs/gameplay/玩法系统_游戏开发文档.md` §8.2 特殊单位、help [34]/[38]：
 * - NPC-01 小偷：偷取来往路人的点券及路上物品，交给替他保释的人；
 * - NPC-02 收保护费：依土地地价收保护费，交给保释人；
 * - NPC-03 行抢：抢夺来往路人的一张卡片或道具，交给保释人；
 * - NPC-04 窃取租金：走到土地窃取该地上次收取的租金；走到公司企业盗领所有累积红利；
 * - NPC-05 恶犬：随机出没（见 engine 的 dogActivityHook）；
 * - NPC-06 女巫：进入魔法屋格，水晶球给出施法条件，由玩家决定惩罚哪些人。
 *
 * 金额与天数原版未在拆解报告中逐条核实，标注为推断值。
 */
import type { CurseKind, MagicCondition, VillainKind } from './types.js';

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

/** 保释金（固定金额，随物价指数缩放） */
export const BAIL_FEE = 5000;
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

/** 魔法屋施法条件：决定候选受罚者 */
export interface MagicConditionDef {
  kind: MagicCondition;
  label: string;
}

export const MAGIC_CONDITIONS: MagicConditionDef[] = [
  { kind: 'all', label: '水晶球浮现红光：可惩罚任意一名对手' },
  { kind: 'ahead', label: '水晶球浮现金光：可惩罚总资产高于自己的对手' },
  { kind: 'behind', label: '水晶球浮现白光：可惩罚总资产低于自己的对手' },
  { kind: 'vehicle', label: '水晶球浮现车轮：可惩罚拥有交通工具（机车/汽车）的对手' },
  { kind: 'landowner', label: '水晶球浮现地契：可惩罚拥有土地的对手' },
];

export const MAGIC_CONDITION_LABEL: Record<MagicCondition, string> = Object.fromEntries(
  MAGIC_CONDITIONS.map((c) => [c.kind, c.label]),
) as Record<MagicCondition, string>;

/** 女巫的惩罚（诅咒）种类 */
export interface CurseDef {
  kind: CurseKind;
  name: string;
  /** fine 类使用 */
  amount?: number;
  /** hospital / jail / abroad 类使用 */
  days?: number;
}

export const CURSES: Record<CurseKind, CurseDef> = {
  fine: { kind: 'fine', name: '恶魔税', amount: 3000 },
  jail: { kind: 'jail', name: '牢狱之灾', days: 2 },
  hospital: { kind: 'hospital', name: '怪病缠身', days: 3 },
  abroad: { kind: 'abroad', name: '放逐异界', days: 3 },
  'lose-card': { kind: 'lose-card', name: '卡片失窃' },
};

/** 魔法屋可抽的诅咒池（顺序固定，抽签走 state.rngState） */
export const CURSE_ORDER: CurseKind[] = ['fine', 'jail', 'hospital', 'abroad', 'lose-card'];

export function villainByKind(kind: VillainKind): VillainDef {
  return VILLAINS[kind];
}