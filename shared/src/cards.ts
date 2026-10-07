/** 卡片使用阶段 */
export type CardPhase = 'pre_roll' | 'post_roll' | 'any';

export interface CardDef {
  id: string;
  name: string;
  description: string;
  /** 商店售价 */
  cost: number;
  phase: CardPhase;
  /** 是否需要选择目标玩家 */
  needsTarget: boolean;
  /** 是否需要选择股票（红卡/黑卡） */
  needsStock?: boolean;
  /** 是否需要选择骰子点数（遥控骰子） */
  needsDiceValue?: boolean;
}

export const CARDS: Record<string, CardDef> = {
  equalize: {
    id: 'equalize',
    name: '均富卡',
    description: '所有存活玩家现金平均分配',
    cost: 1800,
    phase: 'any',
    needsTarget: false,
  },
  swap: {
    id: 'swap',
    name: '换屋卡',
    description: '与目标玩家交换各自最值钱的地产',
    cost: 1600,
    phase: 'any',
    needsTarget: true,
  },
  demolish: {
    id: 'demolish',
    name: '拆屋卡',
    description: '拆除目标玩家最高等级地产一级',
    cost: 1200,
    phase: 'any',
    needsTarget: true,
  },
  'remote-dice': {
    id: 'remote-dice',
    name: '遥控骰子',
    description: '指定下一次掷骰的点数（1-6）',
    cost: 1500,
    phase: 'pre_roll',
    needsTarget: false,
    needsDiceValue: true,
  },
  seize: {
    id: 'seize',
    name: '强占卡',
    description: '夺取当前所在格子的地产',
    cost: 2000,
    phase: 'post_roll',
    needsTarget: false,
  },
  'red-card': {
    id: 'red-card',
    name: '红卡',
    description: '指定股票上涨 25%',
    cost: 900,
    phase: 'any',
    needsTarget: false,
    needsStock: true,
  },
  'black-card': {
    id: 'black-card',
    name: '黑卡',
    description: '指定股票下跌 25%',
    cost: 900,
    phase: 'any',
    needsTarget: false,
    needsStock: true,
  },
  'god-summon': {
    id: 'god-summon',
    name: '请神卡',
    description: '随机召唤一位神仙附身',
    cost: 1400,
    phase: 'any',
    needsTarget: false,
  },
  roadblock: {
    id: 'roadblock',
    name: '路障卡',
    description: '在当前格放置路障，其他玩家经过必须停下',
    cost: 800,
    phase: 'post_roll',
    needsTarget: false,
  },
  turnaround: {
    id: 'turnaround',
    name: '转向卡',
    description: '反转自己的行进方向',
    cost: 600,
    phase: 'pre_roll',
    needsTarget: false,
  },
  turtle: {
    id: 'turtle',
    name: '乌龟卡',
    description: '目标玩家接下来 2 次掷骰步数减半',
    cost: 1000,
    phase: 'any',
    needsTarget: true,
  },
  'rent-free': {
    id: 'rent-free',
    name: '免租卡',
    description: '接下来 1 次进入他人地产免付租金',
    cost: 900,
    phase: 'any',
    needsTarget: false,
  },
  angel: {
    id: 'angel',
    name: '天使卡',
    description: '立即出狱/出院，并送走穷神',
    cost: 1100,
    phase: 'any',
    needsTarget: false,
  },
};

/** 商店在售卡片 */
export const SHOP_CARD_IDS = [
  'equalize',
  'swap',
  'demolish',
  'remote-dice',
  'seize',
  'red-card',
  'black-card',
  'roadblock',
  'turnaround',
  'turtle',
  'rent-free',
  'angel',
];

/** 机会格抽卡池（请神卡只能抽取，不在商店出售） */
export const CHANCE_CARD_POOL = [
  'equalize',
  'swap',
  'demolish',
  'remote-dice',
  'seize',
  'red-card',
  'black-card',
  'god-summon',
  'roadblock',
  'rent-free',
  'angel',
];

