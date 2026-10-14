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
  priceIndex,
  rollDie,
  SHOP_CARD_IDS,
  SHOP_ITEM_IDS,
  viewCells,
} from '../src/index.js';
import type { GameState, PlayerDef } from '../src/index.js';
import { atLegacyStart, cellAheadOfActor, pinIndexOne } from './helpers/state.js';

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
  it('购地卡强制收购脚下他人地产（连同房屋），地价款付给原主', () => {
    let g = newGame(801);
    g.players[1]!.properties = [{ cellId: 6, grade: 2 }];
    g = pinIndexOne(g);
    g.players[0]!.cards = ['buy-land'];
    g.players[0]!.position = 6; // CARD-03 使用时机「走到别人的地时」：只能收购脚下
    g.phase = 'awaiting_action'; // 购地卡为掷骰后卡片
    const cash0 = g.players[0]!.cash;
    const cash1 = g.players[1]!.cash;
    const used = applyAction(g, { type: 'USE_CARD', cardId: 'buy-land' });
    expect(used.players[0]!.properties).toEqual([{ cellId: 6, grade: 2 }]);
    expect(used.players[1]!.properties).toHaveLength(0);
    // D-06：钱是**付给原主**的，不是凭空蒸发（旧实现只扣买方现金）
    const paid = cash0 - used.players[0]!.cash;
    expect(paid).toBeGreaterThan(0);
    expect(used.players[1]!.cash - cash1).toBe(paid);
    // D-05③：价款换成原版公式 `(层+2)/5 × 基础地价 × 物价`，不再把各级升级费累进去
    // （6 号地基础地价 500、2 级 ⇒ 500×4/5 = 400；旧口径会算成 500+一级升级费）
    expect(used.board[6]!.price).toBe(500);
    expect(paid).toBe(Math.round((500 * (2 + 2) * priceIndex(used)) / 5));
  });

  it('均富卡：拉平后，原本高于均值的人再抽超均值部分的 1% 给用卡者（D-05①）', () => {
    const g = pinIndexOne(newGame(806));
    g.players[0]!.cards = ['even-all'];
    g.players[0]!.cash = 10000;   // 用卡者是穷的那位，自己不抽自己
    g.players[1]!.cash = 30000;
    const used = applyAction(g, { type: 'USE_CARD', cardId: 'even-all' });
    // 均值 20000；小美超出 10000 ⇒ 抽 100
    expect(used.players[1]!.cash).toBe(19900);
    expect(used.players[0]!.cash).toBe(20100);
    expect(used.log.some((l) => l.text.includes('另付 100'))).toBe(true);
  });

  it('均贫卡：把对手拉平之外，对手更富时同样抽 1%（D-05②）', () => {
    const g = pinIndexOne(newGame(807));
    g.players[0]!.cards = ['even-target'];
    g.players[0]!.cash = 10000;
    g.players[1]!.cash = 30000;
    const used = applyAction(g, { type: 'USE_CARD', cardId: 'even-target', targetPlayerId: 'p2' });
    expect(used.players[1]!.cash).toBe(19900);
    expect(used.players[0]!.cash).toBe(20100);
  });

  it('均贫卡：用卡者自己更富时不倒抽（原版这条只对被平掉的那位成立）', () => {
    const g = pinIndexOne(newGame(808));
    g.players[0]!.cards = ['even-target'];
    g.players[0]!.cash = 30000;
    g.players[1]!.cash = 10000;
    const used = applyAction(g, { type: 'USE_CARD', cardId: 'even-target', targetPlayerId: 'p2' });
    expect(used.players[1]!.cash).toBe(20000);
    expect(used.players[0]!.cash).toBe(20000);
  });

  it('购地卡不能远程使用，也不能收购脚下无主地', () => {
    let g = pinIndexOne(newGame(802));
    g.players[1]!.properties = [{ cellId: 39, grade: 2 }];
    g.players[0]!.cards = ['buy-land'];
    g.players[0]!.position = 6; // 站在无主住宅上
    g.phase = 'awaiting_action';
    // 只能作用于脚下的 6 号（无主），远程的 39 号在门控就被拒
    expect(() => applyAction(g, { type: 'USE_CARD', cardId: 'buy-land', cellId: 39 })).toThrow('本卡只能作用于落脚处');
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

  it('玩家目标卡受视野限制：目标不在近景窗内直接拒绝（D-43）', () => {
    const g = pinIndexOne(newGame(806));
    g.players[0]!.position = 0;
    g.players[1]!.position = 20; // 视野只覆盖后方 7 + 当前 + 前方 8 = 16 格
    g.players[1]!.cards = []; // 排除免罪/嫁祸反制干扰
    g.players[0]!.cards = ['frame'];
    expect(() => applyAction(g, { type: 'USE_CARD', cardId: 'frame', targetPlayerId: g.players[1]!.id })).toThrow('不在视野内');

    // 拉近到视野内 ⇒ 同一张卡放行
    g.players[1]!.position = 8;
    const ok = applyAction(g, { type: 'USE_CARD', cardId: 'frame', targetPlayerId: g.players[1]!.id });
    expect(ok.players[1]!.skipTurns).toBe(5);
  });

  it('恶魔卡把整条路段的建筑夷为平地，但地权不变（D-12）', () => {
    const g = pinIndexOne(newGame(807));
    g.players[1]!.properties = [
      { cellId: 8, grade: 2 },
      { cellId: 9, grade: 1 },
      { cellId: 10, grade: 3, facility: 'mall' },
    ];
    g.players[0]!.cards = ['devil-road'];
    const used = applyAction(g, { type: 'USE_CARD', cardId: 'devil-road', cellId: 9 });
    // D-12：A 的 `FUN_004436e0` 只清层数与类型（归属字节不动），旧实现连地权一起摘走
    expect(used.players[1]!.properties.map((q) => [q.cellId, q.grade])).toEqual([
      [8, 1],
      [9, 1],
      [10, 1],
    ]);
    expect(used.players[1]!.properties.find((q) => q.cellId === 10)!.facility).toBeUndefined();
    expect(used.players[0]!.properties).toHaveLength(0); // 用卡者不取地权
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
    // 人不在 6 号格 → 即便指定 cellId 也改建不了别人的地（W1：拒在门控，措辞说清「只认脚下」）
    expect(() => applyAction(g, { type: 'USE_CARD', cardId: 'rebuild', cellId: 6 })).toThrow('本卡只能作用于落脚处');
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
    g.phase = 'awaiting_roll'; // R4：`any` 类卡片收到掷骰前
    const used = applyAction(g, { type: 'USE_CARD', cardId: 'hold' });
    expect(used.players[0]!.holdTurns).toBe(1);
    expect(used.log.some((l) => l.text.includes('对自己使用「停留卡」'))).toBe(true);
    // 显式指定他人仍照常生效
    used.players[0]!.cards = ['hold'];
    used.phase = 'awaiting_roll';
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
    g.roadblocks = [{ cellId: 3, ownerId: 'p2' }, { cellId: 20, ownerId: 'p2' }];
    const used = applyAction(g, { type: 'USE_ITEM', itemId: 'robot-doll' });
    expect(used.roadblocks).toEqual([{ cellId: 20, ownerId: 'p2' }]);
  });

  it('地雷埋设与路障放置（视野内 + 记得下放置者，UI 才说得出「谁埋的」）', () => {
    const g = newGame(903);
    g.players[0]!.items = { mine: 1, roadblock: 1 };
    // 视野限制（W1）：先把 9 号格挪到行动者正前方，否则拒绝理由会是「不在视野内」而不是本用例要验的东西
    cellAheadOfActor(g, 9);
    const mined = applyAction(g, { type: 'USE_ITEM', itemId: 'mine', cellId: 9 });
    expect(mined.mines).toEqual([{ cellId: 9, ownerId: 'p1' }]);
    cellAheadOfActor(g, 12);
    const blocked = applyAction(g, { type: 'USE_ITEM', itemId: 'roadblock', cellId: 12 });
    expect(blocked.roadblocks).toEqual([{ cellId: 12, ownerId: 'p1' }]);
  });

  it('路障 / 地雷不能放在别人站着的那一格，也不能放窗外（W1：前提进了门控）', () => {
    const g = newGame(904);
    g.players[0]!.items = { mine: 1, roadblock: 1 };
    cellAheadOfActor(g, 9);
    g.players[1]!.position = 9;
    expect(() => applyAction(g, { type: 'USE_ITEM', itemId: 'mine', cellId: 9 })).toThrow('此处有玩家停留');
    // 门控阶段就拒 ⇒ 道具没被扣掉（旧实现是先扣再抛，玩家白丢一件）
    expect(g.players[0]!.items.mine).toBe(1);
    // 视野外的那一格连候选都进不来，理由挂在 rejectedCells 上供 UI 灰显
    const actor = g.players[0]!;
    const far = g.board.find((c) => !viewCells(g, actor).includes(c.id))!;
    expect(() => applyAction(g, { type: 'USE_ITEM', itemId: 'mine', cellId: far.id })).toThrow('不在视野内');
  });

  it('遥控骰子（道具）固定点数', () => {
    const g = newGame(905);
    g.players[0]!.items = { 'remote-dice-item': 1 };
    const used = applyAction(g, { type: 'USE_ITEM', itemId: 'remote-dice-item', diceValue: 5 });
    expect(used.players[used.currentPlayerIndex]!.fixedDice).toBe(5);
  });

  it('定时炸弹是布设类：放到格上，不是自己背上（D-48）', () => {
    const g = newGame(907);
    g.players[0]!.items = { 'time-bomb': 1 };
    cellAheadOfActor(g, 9);
    const used = applyAction(g, { type: 'USE_ITEM', itemId: 'time-bomb', cellId: 9 });
    expect(used.trapBombs).toEqual([{ cellId: 9, ownerId: 'p1' }]);
    expect(used.bombs).toEqual([]);
  });

  it('飞弹轰炸范围内：房屋各拆低一级、被炸者住院 3 天（D-36）', () => {
    const g = pinIndexOne(newGame(909));
    g.players[0]!.items = { missile: 1 };
    g.players[1]!.position = 6;
    g.players[1]!.properties = [{ cellId: 6, grade: 4 }];
    const used = applyAction(g, { type: 'USE_ITEM', itemId: 'missile', cellId: 6 });
    // D-36：飞弹按决策改为**每处拆 1 级**（核弹仍是夷为平地）
    expect(used.players[1]!.properties[0]!.grade).toBe(3);
    expect(used.players[1]!.skipTurns).toBe(3);
  });

  it('换载具时旧载具收回道具栏（D-33）', () => {
    const g = applyAction(createGame(PLAYERS, 1105, { startDate: { ...MONDAY } }), { type: 'START_GAME' });
    g.players[0]!.items = { motorbike: 1, car: 1 };
    const withBike = applyAction(g, { type: 'USE_ITEM', itemId: 'motorbike' });
    expect(withBike.players[0]!.diceCount).toBe(2);
    // 机车 → 汽车：机车用掉后仍收回道具栏（1 件）
    const withCar = applyAction(withBike, { type: 'USE_ITEM', itemId: 'car' });
    expect(withCar.players[0]!.diceCount).toBe(3);
    expect(withCar.players[0]!.items.motorbike).toBe(1);
    // 汽车 → 机车：汽车收回道具栏
    const back = applyAction(withCar, { type: 'USE_ITEM', itemId: 'motorbike' });
    expect(back.players[0]!.diceCount).toBe(2);
    expect(back.players[0]!.items.car).toBe(1);
    expect(back.players[0]!.items.motorbike).toBeUndefined();
    // 已经骑在机车上时重复使用直接拒绝（A：已是機車→无效），不白烧道具
    back.players[0]!.items = { motorbike: 1 };
    expect(() => applyAction(back, { type: 'USE_ITEM', itemId: 'motorbike' })).toThrow('已经骑在机车上了');
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

  it('工程车：18 步 / 7 天双限、先付拆前过路费再夷为平地、载具暂停可恢复（D-45）', () => {
    const g = pinIndexOne(newGame(917));
    g.players[0]!.items = { car: 1, bulldozer: 1 };
    g.players[1]!.properties = [{ cellId: 6, grade: 3 }];
    const withCar = applyAction(g, { type: 'USE_ITEM', itemId: 'car' });
    expect(withCar.players[0]!.diceCount).toBe(3);

    // 开工程车：汽车暂停使用（记在 saved 里），双限 = 18 步与 7 天
    withCar.players[0]!.items = { bulldozer: 1 };
    const started = applyAction(withCar, { type: 'USE_ITEM', itemId: 'bulldozer' });
    expect(started.players[0]!.bulldozerTurns).toBe(7);
    expect(started.players[0]!.bulldozerSteps).toBe(18);
    expect(started.players[0]!.diceCount).toBe(1);
    expect(started.players[0]!.bulldozerSavedDiceCount).toBe(3);
    // 已经在开时拒绝重复启动，不白烧道具
    started.players[0]!.items = { bulldozer: 1 };
    expect(() => applyAction(started, { type: 'USE_ITEM', itemId: 'bulldozer' })).toThrow('工程车已经在开');

    // 停在他人建筑上：先按拆前等级付过路费，再夷为平地（不是拆一级）
    const cashBefore = started.players[0]!.cash;
    started.players[0]!.position = 3;
    started.players[0]!.diceCount = 1; // 单骰 + 固定 3 点 ⇒ 稳稳落在 6 号，不撞上别的事件
    started.players[started.currentPlayerIndex]!.fixedDice = 3;
    started.players[1]!.position = 20;
    const rolled = applyAction(started, { type: 'ROLL_DICE' });
    expect(rolled.players[0]!.position).toBe(6);
    expect(rolled.players[1]!.properties[0]!.grade).toBe(1);
    expect(rolled.players[0]!.cash).toBeLessThan(cashBefore);
    expect(rolled.players[1]!.deposit).toBeGreaterThan(0); // 地租进地主存款（ECON-02）
    expect(rolled.log.some((l) => l.text.includes('夷为平地'))).toBe(true);

    // 跑满 18 步即报废，并把暂停的汽车交还（把回合交回 p1 自己，好再走一手）
    rolled.currentPlayerIndex = 0;
    rolled.phase = 'awaiting_roll';
    rolled.players[0]!.bulldozerSteps = 2;
    rolled.players[0]!.position = 3;
    rolled.players[0]!.diceCount = 1;
    rolled.players[rolled.currentPlayerIndex]!.fixedDice = 3;
    const done = applyAction(rolled, { type: 'ROLL_DICE' });
    expect(done.players[0]!.bulldozerTurns).toBe(0);
    expect(done.players[0]!.bulldozerSteps).toBe(0);
    expect(done.players[0]!.diceCount).toBe(3);
    expect(done.log.some((l) => l.text.includes('跑满 18 步'))).toBe(true);
  });

  it('工程车是研究所 Lv4 非卖品，但可在商店变卖回收 135 点券（D-45）', () => {
    expect(ITEMS.bulldozer!.cost).toBeNull();
    expect(ITEMS.bulldozer!.researchLevel).toBe(4);
    expect(ITEMS.bulldozer!.sellValue).toBe(135);
    expect(SHOP_ITEM_IDS).not.toContain('bulldozer');
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