import { describe, expect, it } from 'vitest';
import {
  ALL_CARD_IDS,
  ALL_ITEM_IDS,
  applyAction,
  availableActions,
  CARDS,
  CHANCE_CARD_POOL,
  createGame,
  ITEMS,
  MAX_HAND_CARDS,
  MAX_ITEM_COUNT,
  rollDie,
  SHOP_CARD_IDS,
  SHOP_ITEM_IDS,
} from '../src/index.js';
import type { GameState, PlayerDef } from '../src/index.js';
import { atLegacyStart, pinIndexOne } from './helpers/state.js';

/**
 * 波 2 卡片 / 道具系统测试：
 * - 卡片 30 张完全替换（点券购买 + 手牌上限 15）；
 * - 道具 13 种（商店货架 8 种 + 研究所非卖品 5 种，每种上限 9）；
 * - 反制栈（免罪 → 嫁祸 → 复仇）；
 * - 日切定时效果递减；
 * - CORE-03 移动力（步行 1 颗 / 机车 2 颗 / 汽车 3 颗）。
 */

const PLAYERS: PlayerDef[] = [
  { id: 'p1', name: '阿福', color: 0xef5350 },
  { id: 'p2', name: '小美', color: 0x42a5f5 },
];

/** 周一、非 15 号、非月末：隔离日切钩子 */
const MONDAY = { year: 2026, month: 1, day: 5 } as const;

/** 与 engine.test 一致的迁移：测试玩家统一配机车（diceCount=2），历史断言基于两骰之和 */
function newGame(seed = 42): GameState {
  const g = applyAction(createGame(PLAYERS, seed, { startDate: { ...MONDAY } }), { type: 'START_GAME' });
  atLegacyStart(g); // SP-01 出生点随机：道具用例的「前方 n 步」要能从已知格起算
  for (const p of g.players) p.diceCount = 2;
  return g;
}

function seedForSum(target: number): number {
  for (let s = 1; s <= 200000; s++) {
    const a = rollDie(s);
    const b = rollDie(a.nextState);
    if (a.value + b.value === target) return s;
  }
  throw new Error(`找不到和为 ${target} 的种子`);
}

/** 把 p1 直接摆到商店格并进入决策阶段 */
function atShop(seed = 42): GameState {
  const g = newGame(seed);
  g.players[0]!.position = 2; // 2 号商店
  g.phase = 'awaiting_action';
  return g;
}

describe('波 2 卡片清单（CARD-01..30）', () => {
  it('共 30 张；商店 30 张（拍卖卡波 6 开放）；机会池 25 张', () => {
    expect(ALL_CARD_IDS).toHaveLength(30);
    expect(Object.keys(CARDS)).toHaveLength(30);
    expect(SHOP_CARD_IDS).toHaveLength(30);
    expect(SHOP_CARD_IDS).toContain('auction');
    expect(CHANCE_CARD_POOL).toHaveLength(25);
    // 机会池排除重型路段卡与纯自动反制卡、以及需选目标土地的拍卖卡
    for (const id of ['angel-road', 'devil-road', 'revenge', 'shift-blame', 'auction']) {
      expect(CHANCE_CARD_POOL).not.toContain(id);
    }
  });

  it('自动触发类卡片（复仇/嫁祸/免费/免罪）不可主动使用', () => {
    for (const id of ['revenge', 'shift-blame', 'free-pass', 'absolve']) {
      expect(CARDS[id]!.auto).toBe(true);
    }
  });
});

describe('波 2 道具清单（ITEM-01..13）', () => {
  it('共 13 种；商店 8 种；研究所非卖品 5 种', () => {
    expect(ALL_ITEM_IDS).toHaveLength(13);
    expect(SHOP_ITEM_IDS).toHaveLength(8);
    const research = ALL_ITEM_IDS.filter((id) => ITEMS[id]!.researchLevel !== null);
    expect(research).toEqual(['robot-worker', 'time-machine', 'teleporter', 'bulldozer', 'nuke']);
    for (const id of research) expect(SHOP_ITEM_IDS).not.toContain(id);
  });
});

describe('波 2 商店与持有上限', () => {
  it('满手 15 张时购买被拒并提示舍弃', () => {
    const g = atShop(601);
    g.players[0]!.cards = Array.from({ length: MAX_HAND_CARDS }, () => 'hold');
    expect(() => applyAction(g, { type: 'BUY_CARD', cardId: 'demolish' })).toThrow('手牌已满');
  });

  it('单个道具达上限 9 时购买被拒', () => {
    const g = atShop(603);
    g.players[0]!.items = { roadblock: MAX_ITEM_COUNT };
    expect(() => applyAction(g, { type: 'BUY_ITEM', itemId: 'roadblock' })).toThrow('已达上限');
  });

  it('可主动舍弃手牌腾位', () => {
    const g = newGame(605);
    g.players[0]!.cards = ['hold', 'demolish'];
    const used = applyAction(g, { type: 'DISCARD_CARD', cardId: 'hold' });
    expect(used.players[0]!.cards).toEqual(['demolish']);
  });
});

describe('波 2 反制栈（免罪 → 嫁祸 → 复仇）', () => {
  it('免罪卡抵消陷害', () => {
    const g = newGame(701);
    g.players[0]!.cards = ['frame'];
    g.players[1]!.cards = ['absolve'];
    const used = applyAction(g, { type: 'USE_CARD', cardId: 'frame', targetPlayerId: 'p2' });
    expect(used.players[1]!.skipTurns).toBe(0);
    expect(used.players[1]!.cards).not.toContain('absolve');
    expect(used.log.some((e) => e.text.includes('免罪卡'))).toBe(true);
  });

  it('嫁祸卡把灾难转嫁他人（两人局转回加害者）', () => {
    const g = newGame(703);
    g.players[0]!.cards = ['frame'];
    g.players[1]!.cards = ['shift-blame'];
    const used = applyAction(g, { type: 'USE_CARD', cardId: 'frame', targetPlayerId: 'p2' });
    expect(used.players[1]!.skipTurns).toBe(0);
    expect(used.players[0]!.skipTurns).toBe(5);
  });

  it('复仇卡拖加害者一起下水（受击方仍中招）', () => {
    const g = newGame(705);
    g.players[0]!.cards = ['frame'];
    g.players[1]!.cards = ['revenge'];
    const used = applyAction(g, { type: 'USE_CARD', cardId: 'frame', targetPlayerId: 'p2' });
    expect(used.players[1]!.skipTurns).toBe(5);
    expect(used.players[0]!.skipTurns).toBe(5);
  });

  it('免费卡自动抵免缴税', () => {
    const g = newGame(707);
    g.players[0]!.cards = ['free-pass'];
    g.players[0]!.cash = 30000;
    g.players[0]!.position = 18; // 18 + 3 = 21 号缴税
    g.rngState = seedForSum(3);
    const rolled = applyAction(g, { type: 'ROLL_DICE' });
    expect(rolled.players[0]!.cash).toBe(30000); // 税金被免费卡抵免
    expect(rolled.players[0]!.cards).not.toContain('free-pass');
  });
});

describe('波 2 卡片效果', () => {
  it('购地卡强制收购脚下他人地产（连同房屋）', () => {
    let g = newGame(801);
    g.players[1]!.properties = [{ cellId: 6, grade: 2 }];
    g = pinIndexOne(g);
    g.players[0]!.cards = ['buy-land'];
    g.players[0]!.position = 6; // CARD-03 使用时机「走到别人的地时」：只能收购脚下
    g.phase = 'awaiting_action'; // 购地卡为掷骰后卡片
    const used = applyAction(g, { type: 'USE_CARD', cardId: 'buy-land' });
    expect(used.players[0]!.properties).toEqual([{ cellId: 6, grade: 2 }]);
    expect(used.players[1]!.properties).toHaveLength(0);
  });

  it('购地卡不能远程使用，也不能收购脚下无主地', () => {
    let g = pinIndexOne(newGame(802));
    g.players[1]!.properties = [{ cellId: 39, grade: 2 }];
    g.players[0]!.cards = ['buy-land'];
    g.players[0]!.position = 6; // 站在无主住宅上
    g.phase = 'awaiting_action';
    // 只能收购脚下的 6 号（无主）而非远程的 39 号
    expect(() => applyAction(g, { type: 'USE_CARD', cardId: 'buy-land', cellId: 39 })).toThrow('无主');
  });

  it('换屋卡互换同类型房屋等级', () => {
    const g = pinIndexOne(newGame(803));
    g.players[0]!.properties = [{ cellId: 4, grade: 1 }]; // 住宅
    g.players[1]!.properties = [{ cellId: 8, grade: 3 }]; // 住宅（视窗内：与 4 相距 4 格）
    g.players[0]!.position = 4;
    g.phase = 'awaiting_action';
    g.players[0]!.cards = ['swap-house'];
    const used = applyAction(g, { type: 'USE_CARD', cardId: 'swap-house', cellId: 8 });
    expect(used.players[0]!.properties.find((q) => q.cellId === 4)!.grade).toBe(3);
    expect(used.players[1]!.properties.find((q) => q.cellId === 8)!.grade).toBe(1);
  });

  it('换屋卡目标超出视窗（4×4）被拒', () => {
    const g = pinIndexOne(newGame(804));
    g.players[0]!.properties = [{ cellId: 4, grade: 1 }];
    g.players[1]!.properties = [{ cellId: 39, grade: 3 }]; // 与 4 相距 35 格
    g.players[0]!.position = 4;
    g.phase = 'awaiting_action';
    g.players[0]!.cards = ['swap-house'];
    expect(() => applyAction(g, { type: 'USE_CARD', cardId: 'swap-house', cellId: 39 })).toThrow('视窗');
  });

  it('怪兽卡把建筑还原为平地', () => {
    const g = pinIndexOne(newGame(805));
    g.players[1]!.properties = [{ cellId: 6, grade: 3 }];
    g.players[0]!.cards = ['monster'];
    const used = applyAction(g, { type: 'USE_CARD', cardId: 'monster', cellId: 6 });
    expect(used.players[1]!.properties[0]!.grade).toBe(1);
  });

  it('恶魔卡夷平整条路段（连续同类 group）', () => {
    const g = pinIndexOne(newGame(807));
    g.players[1]!.properties = [
      { cellId: 8, grade: 2 },
      { cellId: 9, grade: 1 },
      { cellId: 10, grade: 3 },
    ];
    g.players[0]!.cards = ['devil-road'];
    const used = applyAction(g, { type: 'USE_CARD', cardId: 'devil-road', cellId: 9 });
    expect(used.players[1]!.properties).toHaveLength(0);
  });

  it('天使卡给整条路段各加盖一层', () => {
    const g = pinIndexOne(newGame(809));
    g.players[0]!.properties = [
      { cellId: 8, grade: 1 },
      { cellId: 9, grade: 2 },
    ];
    g.players[0]!.cards = ['angel-road'];
    const used = applyAction(g, { type: 'USE_CARD', cardId: 'angel-road', cellId: 8 });
    expect(used.players[0]!.properties.find((q) => q.cellId === 8)!.grade).toBe(2);
    expect(used.players[0]!.properties.find((q) => q.cellId === 9)!.grade).toBe(3);
  });

  it('改建卡把脚下住宅改为连锁店（EST-04，改建后不能再加盖）', () => {
    const g = newGame(811);
    g.players[0]!.properties = [{ cellId: 4, grade: 2 }];
    g.players[0]!.position = 4; // CARD-07 使用时机「走到任何有建筑的土地上」：改建脚下
    g.players[0]!.cards = ['rebuild'];
    g.phase = 'awaiting_action'; // 改建卡为掷骰后卡片
    const used = applyAction(g, { type: 'USE_CARD', cardId: 'rebuild' });
    expect(used.players[0]!.properties[0]!.chain).toBe(true);
    // 再改一次可改回一般建筑
    used.players[0]!.cards = ['rebuild'];
    used.phase = 'awaiting_action';
    const back = applyAction(used, { type: 'USE_CARD', cardId: 'rebuild' });
    expect(back.players[0]!.properties[0]!.chain).toBe(false);
  });

  it('改建卡不能远程使用（目标固定为脚下）', () => {
    const g = newGame(811);
    g.players[1]!.properties = [{ cellId: 6, grade: 2 }];
    g.players[0]!.cards = ['rebuild'];
    g.phase = 'awaiting_action';
    // 人不在 6 号格 → 即便指定 cellId 也改建不了别人的地
    expect(() => applyAction(g, { type: 'USE_CARD', cardId: 'rebuild', cellId: 6 })).toThrow('没有建筑');
  });

  it('改建卡可变更脚下商业用地设施项目（EST-07）', () => {
    const g = newGame(812);
    g.players[0]!.properties = [{ cellId: 40, grade: 1, facility: 'park' }];
    g.players[0]!.position = 40;
    g.players[0]!.cards = ['rebuild'];
    g.phase = 'awaiting_action';
    const used = applyAction(g, { type: 'USE_CARD', cardId: 'rebuild', facility: 'hotel' });
    expect(used.players[0]!.properties[0]!.facility).toBe('hotel');
  });

  it('查税卡强制收取 20% 现金税', () => {
    const g = pinIndexOne(newGame(813));
    g.players[1]!.cash = 10000;
    g.players[0]!.cards = ['tax-audit'];
    const used = applyAction(g, { type: 'USE_CARD', cardId: 'tax-audit', targetPlayerId: 'p2' });
    expect(used.players[1]!.cash).toBe(8000);
  });

  it('同盟卡互免过路费', () => {
    const g = pinIndexOne(newGame(815));
    g.players[0]!.cards = ['alliance'];
    g.players[1]!.properties = [{ cellId: 6, grade: 1 }];
    const allied = applyAction(g, { type: 'USE_CARD', cardId: 'alliance', targetPlayerId: 'p2' });
    expect(allied.players[0]!.alliance).toEqual({ with: 'p2', daysLeft: 7 });
    // p0 落到 p1 的 6 号地产 → 同盟免租
    allied.players[0]!.position = 3;
    allied.rngState = seedForSum(3);
    const rolled = applyAction(allied, { type: 'ROLL_DICE' });
    expect(rolled.players[0]!.cash).toBe(15000);
  });

  it('停留卡使对手下一次原地不动', () => {
    const g = newGame(817);
    g.players[0]!.cards = ['hold'];
    const used = applyAction(g, { type: 'USE_CARD', cardId: 'hold', targetPlayerId: 'p2' });
    expect(used.players[1]!.holdTurns).toBe(1);
    used.currentPlayerIndex = 1;
    used.players[1]!.position = 6;
    used.rngState = seedForSum(5);
    const rolled = applyAction(used, { type: 'ROLL_DICE' });
    expect(rolled.players[1]!.position).toBe(6);
  });

  it('停留卡可对自己使用（缺省目标=自己，原地再停留）', () => {
    const g = newGame(818);
    g.players[0]!.cards = ['hold'];
    g.phase = 'awaiting_action';
    const used = applyAction(g, { type: 'USE_CARD', cardId: 'hold' });
    expect(used.players[0]!.holdTurns).toBe(1);
    expect(used.log.some((l) => l.text.includes('对自己使用「停留卡」'))).toBe(true);
    // 显式指定他人仍照常生效
    used.players[0]!.cards = ['hold'];
    used.phase = 'awaiting_action';
    const again = applyAction(used, { type: 'USE_CARD', cardId: 'hold', targetPlayerId: 'p2' });
    expect(again.players[1]!.holdTurns).toBe(1);
    expect(again.players[0]!.holdTurns).toBe(1);
  });

  it('原地停留后可再次加盖自有商业设施（用户规则：升级需再次停留）', () => {
    const g = newGame(820);
    g.players[0]!.position = 40;
    g.players[0]!.properties = [{ cellId: 40, grade: 1, facility: 'mall' }];
    g.players[0]!.holdTurns = 1;
    g.phase = 'awaiting_roll';
    const rolled = applyAction(g, { type: 'ROLL_DICE' });
    expect(rolled.players[0]!.position).toBe(40); // 原地不动
    expect(rolled.phase).toBe('awaiting_action');
    expect(availableActions(rolled).canUpgrade).toBe(true);
    const up = applyAction(rolled, { type: 'UPGRADE_LAND' });
    expect(up.players[0]!.properties[0]!.grade).toBe(2);
  });

  it('冬眠卡使所有对手睡眠 5 天', () => {
    const g = newGame(819);
    g.players[0]!.cards = ['hibernate'];
    const used = applyAction(g, { type: 'USE_CARD', cardId: 'hibernate' });
    expect(used.players[1]!.skipTurns).toBe(5);
    expect(used.players[1]!.rentBlockedTurns).toBe(5);
    expect(used.players[0]!.skipTurns).toBe(0);
  });
});

describe('波 2 道具效果', () => {
  it('机器娃娃清除前方 9 步内的路障', () => {
    const g = newGame(901);
    g.players[0]!.items = { 'robot-doll': 1 };
    g.roadblocks = [3, 20];
    const used = applyAction(g, { type: 'USE_ITEM', itemId: 'robot-doll' });
    expect(used.roadblocks).toEqual([20]);
  });

  it('地雷埋设与路障放置', () => {
    const g = newGame(903);
    g.players[0]!.items = { mine: 1, roadblock: 1 };
    const mined = applyAction(g, { type: 'USE_ITEM', itemId: 'mine', cellId: 9 });
    expect(mined.mines).toEqual([9]);
    const blocked = applyAction(g, { type: 'USE_ITEM', itemId: 'roadblock', cellId: 12 });
    expect(blocked.roadblocks).toEqual([12]);
  });

  it('遥控骰子（道具）固定点数', () => {
    const g = newGame(905);
    g.players[0]!.items = { 'remote-dice-item': 1 };
    const used = applyAction(g, { type: 'USE_ITEM', itemId: 'remote-dice-item', diceValue: 5 });
    expect(used.pendingFixedDice).toBe(5);
  });

  it('定时炸弹附身（38 步后爆炸）', () => {
    const g = newGame(907);
    g.players[0]!.items = { 'time-bomb': 1 };
    const used = applyAction(g, { type: 'USE_ITEM', itemId: 'time-bomb' });
    expect(used.bombs).toEqual([{ playerId: 'p1', stepsLeft: 38 }]);
  });

  it('飞弹轰炸范围内人屋俱毁', () => {
    const g = pinIndexOne(newGame(909));
    g.players[0]!.items = { missile: 1 };
    g.players[1]!.position = 6;
    g.players[1]!.properties = [{ cellId: 6, grade: 2 }];
    const used = applyAction(g, { type: 'USE_ITEM', itemId: 'missile', cellId: 6 });
    expect(used.players[1]!.properties[0]!.grade).toBe(1);
    expect(used.players[1]!.skipTurns).toBe(3);
  });

  it('机器工人免费加盖一级', () => {
    const g = pinIndexOne(newGame(911));
    g.players[0]!.items = { 'robot-worker': 1 };
    g.players[0]!.properties = [{ cellId: 4, grade: 1 }];
    const used = applyAction(g, { type: 'USE_ITEM', itemId: 'robot-worker', cellId: 4 });
    expect(used.players[0]!.properties[0]!.grade).toBe(2);
  });

  it('传送机瞬移到指定空道路', () => {
    const g = newGame(913);
    g.players[0]!.items = { teleporter: 1 };
    const used = applyAction(g, { type: 'USE_ITEM', itemId: 'teleporter', cellId: 20 });
    expect(used.players[0]!.position).toBe(20);
  });

  it('时光机把所有人拉回上一回合快照', () => {
    const g = newGame(915);
    g.players[0]!.items = { 'time-machine': 1 };
    g.players[0]!.position = 5;
    g.players[0]!.cash = 9000;
    g.lastRoundSnapshot = {
      players: [
        { id: 'p1', position: 0, cash: 15000, deposit: 0, properties: [], stocks: {} },
        { id: 'p2', position: 3, cash: 15000, deposit: 0, properties: [], stocks: {} },
      ],
    };
    const used = applyAction(g, { type: 'USE_ITEM', itemId: 'time-machine' });
    expect(used.players[0]!.position).toBe(0);
    expect(used.players[0]!.cash).toBe(15000);
    expect(used.players[1]!.position).toBe(3);
  });

  it('工程车启动后 7 回合内走到哪拆到哪', () => {
    const g = pinIndexOne(newGame(917));
    g.players[0]!.items = { bulldozer: 1 };
    g.players[1]!.properties = [{ cellId: 6, grade: 3 }];
    const started = applyAction(g, { type: 'USE_ITEM', itemId: 'bulldozer' });
    expect(started.players[0]!.bulldozerTurns).toBe(7);
    // p0 走到 p1 的 6 号地产 → 自动拆除一级
    started.players[0]!.position = 3;
    started.rngState = seedForSum(3);
    const rolled = applyAction(started, { type: 'ROLL_DICE' });
    expect(rolled.players[1]!.properties[0]!.grade).toBe(2);
  });
});

describe('波 2 日切定时效果递减', () => {
  it('乌龟 / 同盟 / 涨跌停剩余天数随时间递减', () => {
    const g = newGame(1001);
    g.players[0]!.turtleTurns = 3;
    g.players[0]!.alliance = { with: 'p2', daysLeft: 3 };
    g.players[1]!.alliance = { with: 'p1', daysLeft: 3 };
    g.stockHalts = [{ stockId: 'tech', kind: 'up', daysLeft: 3 }];

    let s = g;
    // 双方各走一步（乌龟生效 → 只走 1 步，落到 3 号机会格自动结算）→ 推进一天
    s.players[0]!.position = 2;
    s.rngState = seedForSum(3);
    s = applyAction(s, { type: 'ROLL_DICE' });
    s.players[1]!.position = 2;
    s.rngState = seedForSum(3);
    s = applyAction(s, { type: 'ROLL_DICE' });

    expect(s.players[0]!.turtleTurns).toBe(2);
    expect(s.players[0]!.alliance!.daysLeft).toBe(2);
    expect(s.stockHalts[0]!.daysLeft).toBe(2);
  });
});

describe('CORE-03 移动力（骰子数）', () => {
  it('步行默认 1 颗骰子', () => {
    const g = applyAction(createGame(PLAYERS, 1101, { startDate: { ...MONDAY } }), { type: 'START_GAME' });
    expect(g.players[0]!.diceCount).toBe(1);
    const rolled = applyAction(g, { type: 'ROLL_DICE' });
    expect(rolled.dice).toHaveLength(1);
  });

  it('机车 2 颗、汽车 3 颗，且可自选本次使用几颗', () => {
    const g = applyAction(createGame(PLAYERS, 1103, { startDate: { ...MONDAY } }), { type: 'START_GAME' });
    g.players[0]!.items = { car: 1 };
    const withCar = applyAction(g, { type: 'USE_ITEM', itemId: 'car' });
    expect(withCar.players[0]!.diceCount).toBe(3);

    // 自选 2 颗
    const two = applyAction(withCar, { type: 'ROLL_DICE', diceCount: 2 });
    expect(two.dice).toHaveLength(2);

    // 机车：上限 2 颗，请求 3 颗被拒
    const bike = applyAction(g, { type: 'USE_ITEM', itemId: 'car' });
    expect(bike.players[0]!.diceCount).toBe(3);
    expect(() => applyAction(bike, { type: 'ROLL_DICE', diceCount: 4 })).toThrow('骰子数');
  });
});