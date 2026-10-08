/**
 * 道具系统（ITEM-01 – ITEM-13，对标 `docs/gameplay/玩法系统_游戏开发文档.md` §7）。
 *
 * 通用规则：
 * - 每一种道具最多拥有 9 个（`MAX_ITEM_COUNT`），额满无法再容纳；
 * - 道具以**点券购买**；
 * - ITEM-09..13 为研究所**非卖品**（`researchLevel` 非空）：波 2 先入库并实现效果，
 *   波 3 开放研究所后才可获得，故不进商店货架。
 */

import type { CardPhase } from './cards.js';

/** 道具目标类型（决定 UI 需要收集哪些参数） */
/**
 * 道具目标类型：
 * - none 无目标；
 * - cell 需选地图格；
 * - land 需选己方土地；
 * - player 需选一名对手（可留空表示不指定，用于炸弹留给自己 / 传送机只移自己）。
 */
export type ItemTarget = 'none' | 'cell' | 'land' | 'player';

export interface ItemDef {
  id: string;
  name: string;
  description: string;
  /** 商店售价（点券）；非卖品为 null */
  cost: number | null;
  phase: CardPhase;
  target: ItemTarget;
  /** 需要指定骰子点数（遥控骰子） */
  needsDiceValue?: boolean;
  /** 研究所研发等级；null 表示商店可售 */
  researchLevel: number | null;
}

export const ITEMS: Record<string, ItemDef> = {
  'robot-doll': {
    id: 'robot-doll',
    name: '机器娃娃',
    description: '踢除前方 9 步内的一切障碍物（路障 / 地雷 / 定时炸弹）',
    // 原价文档标注「待确认」，此处取 INTERIM 估值 60 点
    cost: 60,
    phase: 'any',
    target: 'none',
    researchLevel: null,
  },
  roadblock: {
    id: 'roadblock',
    name: '路障',
    description: '在选定道路放置路障，经过者被截停',
    cost: 30,
    phase: 'any',
    target: 'cell',
    researchLevel: null,
  },
  mine: {
    id: 'mine',
    name: '地雷',
    description: '在选定道路埋设地雷，踩中者住院 3 天（也可能害到自己）',
    cost: 25,
    phase: 'any',
    target: 'cell',
    researchLevel: null,
  },
  'time-bomb': {
    id: 'time-bomb',
    name: '定时炸弹',
    description: '附身后走满 38 步自动爆炸，威力范围内人住院 5 天、房屋倒塌；也可直接丢给对手',
    cost: 25,
    phase: 'any',
    target: 'player',
    researchLevel: null,
  },
  motorbike: {
    id: 'motorbike',
    name: '机车',
    description: '骰子数增加至 2 个（前进更远）',
    cost: 80,
    phase: 'any',
    target: 'none',
    researchLevel: null,
  },
  car: {
    id: 'car',
    name: '汽车',
    description: '骰子数增加至 3 个（前进更远）',
    cost: 150,
    phase: 'any',
    target: 'none',
    researchLevel: null,
  },
  missile: {
    id: 'missile',
    name: '飞弹',
    description: '轰炸目标格范围，人屋俱毁，被炸者住院 3 天',
    cost: 100,
    phase: 'any',
    target: 'cell',
    researchLevel: null,
  },
  'remote-dice-item': {
    id: 'remote-dice-item',
    name: '遥控骰子',
    description: '控制下一次掷骰的点数（1-6）',
    cost: 30,
    phase: 'pre_roll',
    target: 'none',
    needsDiceValue: true,
    researchLevel: null,
  },
  'robot-worker': {
    id: 'robot-worker',
    name: '机器工人',
    description: '在选定土地上免费加盖一级房屋',
    cost: null,
    phase: 'any',
    target: 'land',
    researchLevel: 1,
  },
  'time-machine': {
    id: 'time-machine',
    name: '时光机',
    description: '回到过去：所有人回复为上一回合的状态',
    cost: null,
    phase: 'any',
    target: 'none',
    researchLevel: 2,
  },
  teleporter: {
    id: 'teleporter',
    name: '传送机',
    description: '瞬间移动到地图上的指定格；也可把对手一并传送过去',
    cost: null,
    phase: 'any',
    target: 'cell',
    researchLevel: 3,
  },
  bulldozer: {
    id: 'bulldozer',
    name: '工程车',
    description: '开动 7 回合，走到哪拆到哪（拆除他人房屋一个等级）',
    cost: null,
    phase: 'any',
    target: 'none',
    researchLevel: 4,
  },
  nuke: {
    id: 'nuke',
    name: '核子飞弹',
    description: '大范围轰炸，人屋俱毁，被炸者住院 3 天',
    cost: null,
    phase: 'any',
    target: 'cell',
    researchLevel: 5,
  },
};

/** 全部道具 id */
export const ALL_ITEM_IDS = Object.keys(ITEMS);

/** 商店在售道具（研究所非卖品除外） */
export const SHOP_ITEM_IDS = ALL_ITEM_IDS.filter((id) => ITEMS[id]!.researchLevel === null);

/**
 * 开局赠送的道具（用户规则：玩家初始各持 1 件）。
 * 「炸弹」取地雷（ITEM-03，可埋设的爆炸物）；机器工人为研究所非卖品，开局直接持有。
 */
export const STARTING_ITEMS: Readonly<Record<string, number>> = {
  'robot-doll': 1,
  'remote-dice-item': 1,
  roadblock: 1,
  'time-bomb': 1,
  mine: 1,
  'robot-worker': 1,
};