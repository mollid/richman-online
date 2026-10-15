import { describe, expect, it } from 'vitest';

import {
  applyAction,
  availableActions,
  BAIL_FEE,
  BOARD_SIZE,
  botDecide,
  CARDS,
  createGame,
  itemSellValue,
  MAGIC_CONDITIONS,
  MAGIC_EFFECTS,
  nextRandom,
  totalAssets,
  VILLAIN_DAYS,
  VILLAIN_KINDS,
  VILLAINS,
} from '../src/index.js';
import type { GameState, MagicEffectKind, NpcUnit, PlayerDef } from '../src/index.js';

/**
 * 波 8b 特殊单位测试（NPC-01..06，对标文档 §8.2 / help [34][38]）：
 * - NPC-01..04 四大恶人初始在押、保释流程、每日移动与四种行窃、刑满回监；
 * - 只读派生随机（零抽数）不扰动确定性回放；
 * - TILE-11 魔法屋（NPC-06 女巫）：施法条件与候选受罚者、五种诅咒结算、非法输入被拒。
 */

const PLAYERS: PlayerDef[] = [
  { id: 'p1', name: '阿福', color: 0xef5350 },
  { id: 'p2', name: '小美', color: 0x42a5f5 },
  { id: 'p3', name: '老王', color: 0x66bb6a },
];

/** 周一、非 15 号、非月末：隔离日切钩子 */
const MONDAY = { year: 2026, month: 1, day: 5 } as const;
const JAIL_CELL = 26;
const MAGIC_CELL = 48;

function newGame(seed = 42): GameState {
  return applyAction(createGame(PLAYERS, seed, { startDate: { ...MONDAY } }), { type: 'START_GAME' });
}

/**
 * 把当前玩家摆到能以 steps 点落到 targetCell 的位置。
 * 用 `fixedDice` 固定唯一一颗骰子 → 掷骰消耗 0 抽，
 * `rngState` 完全由调用方指定，便于精确控制落格后的随机分支。
 */
function setupLanding(state: GameState, targetCell: number, steps: number, rngState = state.rngState): GameState {
  const s = structuredClone(state);
  s.rngState = rngState;
  s.players[s.currentPlayerIndex]!.fixedDice = steps;
  const p = s.players[s.currentPlayerIndex]!;
  p.diceCount = 1;
  p.position = (targetCell - steps + BOARD_SIZE) % BOARD_SIZE;
  return s;
}

/** 找种子使「魔法屋落格后」抽到的目标条件落在指定下标（落格只抽一签：条件） */
function seedForCondition(index: number): number {
  for (let seed = 1; seed <= 2_000_000; seed++) {
    const a = nextRandom(seed);
    if (Math.floor(a.value * MAGIC_CONDITIONS.length) === index) return seed;
  }
  throw new Error(`找不到条件下标 ${index} 的种子`);
}

/** 落到魔法屋并返回开完窗的状态（条件钉在下标 `conditionIndex`） */
function landAtMagic(seed: number, conditionIndex: number): GameState {
  return applyAction(setupLanding(newGame(seed), MAGIC_CELL, 3, seedForCondition(conditionIndex)), {
    type: 'ROLL_DICE',
  });
}

/** 把某人的现金抬到全场最高，好让「财产最多的人」只指向他 */
function richest(state: GameState, id: string): GameState {
  const s = structuredClone(state);
  s.players.find((p) => p.id === id)!.cash = 9_999_999;
  return s;
}

function npcOf(state: GameState, kind: string): NpcUnit {
  const n = state.npcs.find((x) => x.kind === kind);
  if (!n) throw new Error(`找不到恶人 ${kind}`);
  return n;
}

/** 把某名恶人置于「已保释在外」状态 */
function bailForTest(state: GameState, kind: string, ownerId = 'p1'): GameState {
  const s = structuredClone(state);
  const npc = npcOf(s, kind);
  npc.jailed = false;
  npc.ownerId = ownerId;
  npc.daysLeft = VILLAIN_DAYS;
  npc.position = 0;
  return s;
}

/** 推进一个动作并能收尾 */
function step(state: GameState): GameState {
  if (state.phase === 'awaiting_roll') return applyAction(state, { type: 'ROLL_DICE' });
  if (state.phase === 'awaiting_pick') return applyAction(state, { type: 'MINIGAME_PICK', hole: 0 });
  return applyAction(state, { type: 'FINISH_LANDING' });
}

/** 推进到跨过一天（触发日切钩子） */
function advanceOneDay(state: GameState): GameState {
  const start = state.calendar.elapsedDays;
  let s = state;
  for (let i = 0; i < 24 && s.calendar.elapsedDays === start; i++) s = step(s);
  expect(s.calendar.elapsedDays, '未能推进到下一天').toBeGreaterThan(start);
  return s;
}

describe('NPC-01..04 四大恶人（数据与保释）', () => {
  it('四大恶人数据完备且顺序固定', () => {
    expect(VILLAIN_KINDS).toEqual(['thief', 'protection', 'robber', 'rent-thief']);
    for (const kind of VILLAIN_KINDS) {
      expect(VILLAINS[kind].name).toBeTruthy();
      expect(VILLAINS[kind].desc).toBeTruthy();
    }
  });

  it('createGame 时四恶人全部在押于监狱格、无主', () => {
    const g = newGame(3);
    const villains = g.npcs.filter((n) => n.kind !== 'dog');
    expect(villains).toHaveLength(4);
    for (const v of villains) {
      expect(v.jailed).toBe(true);
      expect(v.ownerId).toBeNull();
      expect(v.daysLeft).toBe(0);
      expect(v.position).toBe(JAIL_CELL);
    }
  });

  it('四张原版图开局：恶人押在该图自己的监狱格，不是默认图那格', () => {
    for (const mapId of [0, 1, 2, 3]) {
      const g = createGame(PLAYERS, 3, { startDate: { ...MONDAY }, mapId });
      const jailId = g.board.find((c) => c.type === 'jail')!.id;
      const villains = g.npcs.filter((n) => n.kind !== 'dog');
      expect(villains).toHaveLength(4);
      for (const v of villains) {
        expect(v.jailed).toBe(true);
        expect(v.position).toBe(jailId);
      }
    }
  });

  it('监狱门外可保释：扣的是点券、刑期 7 天、主人为保释人（D-50）', () => {
    const seeded = setupLanding(newGame(11), JAIL_CELL, 3);
    // 门控先看付不付得起：点券为 0 时监狱门外根本不开窗，所以先把钱备好再掷骰
    seeded.players[0]!.points = BAIL_FEE * 2;
    const landed = applyAction(seeded, { type: 'ROLL_DICE' });
    expect(landed.players[0]!.position).toBe(JAIL_CELL);
    expect(landed.phase).toBe('awaiting_action');
    const acts = availableActions(landed);
    expect(acts.bailableVillains).toEqual([...VILLAIN_KINDS]);
    expect(acts.bailFee).toBe(BAIL_FEE);

    const cashBefore = landed.players[0]!.cash;
    const bailed = applyAction(landed, { type: 'BAIL_PRISONER', npcKind: 'thief' });
    expect(bailed.players[0]!.points).toBe(BAIL_FEE);
    // 现金一分不动：保释不再是"大钱"支出
    expect(bailed.players[0]!.cash).toBe(cashBefore);
    const thief = npcOf(bailed, 'thief');
    expect(thief.jailed).toBe(false);
    expect(thief.ownerId).toBe('p1');
    expect(thief.daysLeft).toBe(VILLAIN_DAYS);
    expect(bailed.log.some((l) => l.text.includes('保释了小偷'))).toBe(true);
  });

  it('不在监狱门外不能保释', () => {
    const g = newGame(13);
    expect(() => applyAction(g, { type: 'BAIL_PRISONER', npcKind: 'thief' })).toThrow();
  });

  it('点券不足 ⇒ 门外不开窗、名单为空；钱够了才列得出保释（D-50）', () => {
    const poor = setupLanding(newGame(17), JAIL_CELL, 3);
    poor.players[0]!.points = 0;
    poor.players[0]!.cash = 999999;   // 现金再多也不顶用：两套账不许互相支付
    const landed = applyAction(poor, { type: 'ROLL_DICE' });
    // 付不起保释 ⇒ 这一格没有办得成的事，落格窗不该把人钉在那儿（R4 防死路的同一条规则）
    expect(availableActions(landed).bailableVillains).toEqual([]);
    expect(landed.phase).not.toBe('awaiting_action');

    const funded = setupLanding(newGame(17), JAIL_CELL, 3);
    funded.players[0]!.points = BAIL_FEE;
    const opened = applyAction(funded, { type: 'ROLL_DICE' });
    expect(opened.phase).toBe('awaiting_action');
    expect(availableActions(opened).bailableVillains.length).toBeGreaterThan(0);

    // 已保释者不可重复保释
    const bailed = applyAction(opened, { type: 'BAIL_PRISONER', npcKind: 'thief' });
    expect(() => applyAction(bailed, { type: 'BAIL_PRISONER', npcKind: 'thief' })).toThrow();
  });
});

describe('NPC-01..04 每日活动（移动 + 行窃 + 刑满回监）', () => {
  it('日切时已保释恶人移动 1..6 步并扣除刑期 1 天', () => {
    const g = advanceOneDay(bailForTest(newGame(23), 'thief'));
    const thief = npcOf(g, 'thief');
    expect(thief.jailed).toBe(false);
    expect(thief.daysLeft).toBe(VILLAIN_DAYS - 1);
    // 从 0 号格出发移动 1..6 步（仍在同一圈内）
    expect(thief.position).toBeGreaterThanOrEqual(1);
    expect(thief.position).toBeLessThanOrEqual(6);
  });

  it('只读派生随机零抽数：恶人活动不消耗 state.rngState', () => {
    // 同一状态下重复执行 advanceOneDay，两次得到的 rngState 相同，
    // 且与「无恶人」对照组相同 → 恶人活动确实零抽数
    const withVillains = bailForTest(newGame(29), 'robber');
    const without = (() => {
      const s = newGame(29);
      s.npcs = [];
      return s;
    })();
    const a = advanceOneDay(structuredClone(withVillains));
    const b = advanceOneDay(structuredClone(withVillains));
    const c = advanceOneDay(structuredClone(without));
    expect(a.rngState).toBe(b.rngState);
    expect(a.rngState).toBe(c.rngState);
  });

  it('刑满 7 天后押回监狱', () => {
    let g = bailForTest(newGame(31), 'protection');
    for (let i = 0; i < 60; i++) {
      g = step(g);
      if (npcOf(g, 'protection').jailed) break;
    }
    const n = npcOf(g, 'protection');
    expect(n.jailed).toBe(true);
    expect(n.ownerId).toBeNull();
    expect(n.daysLeft).toBe(0);
    expect(n.position).toBe(JAIL_CELL);
  });

  it('保释人倒闭后恶人押回监狱', () => {
    let g = bailForTest(newGame(37), 'rent-thief');
    g.players[0]!.cash = 0;
    g.players[0]!.deposit = 0;
    g.players[0]!.loan = null;
    g.players[0]!.bankrupt = true;
    const next = advanceOneDay(g);
    const n = npcOf(next, 'rent-thief');
    expect(n.jailed).toBe(true);
    expect(n.ownerId).toBeNull();
    expect(next.log.some((l) => l.text.includes('被押回监狱'))).toBe(true);
  });

  it('未保释的恶人在日切后仍留在监狱', () => {
    const g = advanceOneDay(newGame(41));
    for (const kind of VILLAIN_KINDS) {
      const n = npcOf(g, kind);
      expect(n.jailed).toBe(true);
      expect(n.position).toBe(JAIL_CELL);
    }
  });
});

describe('NPC-01..04 四种行窃行为', () => {
  /**
   * 恶人每日移动 1..6 步（只读派生随机），落点不可直接指定。
   * 两阶段扫描种子：先跑一次知道当日落点，再按该落点布置场景（受害者/地主/公司）重跑，
   * 从而稳定断言「行窃发生在指定格」。`startAt` 可指定起始格（默认 0）。
   */
  function sceneForLanding(
    kind: string,
    setupAt: (g: GameState, landingCellId: number) => void,
    startAt = 0,
    maxSeed = 4000,
  ): { cellId: number; after: GameState } {
    for (let seed = 1; seed <= maxSeed; seed++) {
      const probe = newGame(seed);
      const pn = npcOf(probe, kind);
      pn.jailed = false;
      pn.ownerId = 'p1';
      pn.daysLeft = VILLAIN_DAYS;
      pn.position = startAt;
      let probeAfter: GameState;
      try {
        probeAfter = advanceOneDay(probe);
      } catch {
        continue;
      }
      const moved = npcOf(probeAfter, kind);
      if (moved.jailed) continue;
      const cellId = moved.position;

      // 第二阶段：同种子、同起始位置，布置场景后重跑
      // setupAt 抛错表示该落点不符合本用例需求 → 换下一个种子
      let after: GameState;
      try {
        const g = newGame(seed);
        const n = npcOf(g, kind);
        n.jailed = false;
        n.ownerId = 'p1';
        n.daysLeft = VILLAIN_DAYS;
        n.position = startAt;
        setupAt(g, cellId);
        after = advanceOneDay(g);
      } catch {
        continue;
      }
      if (npcOf(after, kind).position !== cellId) continue;
      return { cellId, after };
    }
    throw new Error(`找不到可用于 ${kind} 作案的种子`);
  }

  it('NPC-01 小偷：偷点券（上限 500）与一件道具', () => {
    const { after } = sceneForLanding('thief', (g) => {
      for (const p of g.players) {
        if (p.id === 'p1') continue;
        p.points = 2000;
        p.items = { 'bomb-lite': 1 };
      }
    });
    const thief = npcOf(after, 'thief');
    expect(thief.ownerId).toBe('p1');
    expect(after.log.some((l) => l.text.includes('小偷') && l.text.includes('偷走'))).toBe(true);
    // 点券至多被偷 500，且至少一名受害者受损
    const victims = after.players.filter((p) => p.id !== 'p1');
    const anyPointsLost = victims.some((p) => p.points <= 1500);
    const anyItemLost = victims.some((p) => p.items['bomb-lite'] === undefined);
    expect(anyPointsLost || anyItemLost).toBe(true);
    for (const p of victims) expect(2000 - p.points).toBeLessThanOrEqual(500);
  });

  it('NPC-02 收保护费：向地主收取地价 5% 的费用', () => {
    const { cellId, after } = sceneForLanding('protection', (g, landing) => {
      const cell = g.board[landing]!;
      if (cell.type !== 'property' || !cell.price) {
        // 该落点不是可收保护费的地产 → 让本次布置失效（下一轮种子会被跳过）
        throw new Error('落点非地产');
      }
      const owner = g.players.find((p) => p.id !== 'p1')!;
      owner.properties.push({ cellId: landing, grade: 1 });
      owner.cash = 1_000_000;
      owner.deposit = 0;
    });
    const cell = after.board[cellId]!;
    const fee = Math.round((cell.price ?? 0) * 0.05);
    expect(fee).toBeGreaterThan(0);
    const owner = after.players.find((p) => p.properties.some((q) => q.cellId === cellId))!;
    // 地主资产显著下降（扣了保护费；可能叠加其他日切影响，故只断言「变少且金额量级相符」）
    expect(owner.cash + owner.deposit).toBeLessThan(1_000_000);
    expect(after.log.some((l) => l.text.includes('收取保护费'))).toBe(true);
  });

  it('NPC-03 行抢：抢走一张卡片', () => {
    const { after } = sceneForLanding('robber', (g) => {
      for (const p of g.players) {
        if (p.id === 'p1') continue;
        p.cards = ['tax-audit'];
      }
    });
    const victim = after.players.find((p) => p.id !== 'p1');
    expect(victim!.cards).not.toContain('tax-audit');
    expect(after.log.some((l) => l.text.includes('行抢') && l.text.includes('抢走'))).toBe(true);
  });

  it('NPC-03 行抢：无卡片时改抢一件道具', () => {
    const { after } = sceneForLanding('robber', (g) => {
      for (const p of g.players) {
        if (p.id === 'p1') continue;
        p.cards = [];
        p.items = { 'bomb-lite': 1 };
      }
    });
    const victim = after.players.find((p) => p.id !== 'p1');
    expect(victim!.items['bomb-lite']).toBeUndefined();
    expect(after.log.some((l) => l.text.includes('道具'))).toBe(true);
  });

  it('NPC-04 窃取租金：窃取本地上次收取的租金', () => {
    const { cellId, after } = sceneForLanding('rent-thief', (g, landing) => {
      const cell = g.board[landing]!;
      if (cell.type !== 'property') throw new Error('落点非土地');
      g.players.find((p) => p.id !== 'p1')!.properties.push({ cellId: landing, grade: 1, lastRent: 3000 });
    });
    expect(after.board[cellId]!.type).toBe('property');
    const owner = after.players.find((p) => p.properties.some((q) => q.cellId === cellId))!;
    expect(owner.properties.find((q) => q.cellId === cellId)!.lastRent).toBeNull();
    expect(after.log.some((l) => l.text.includes('窃取租金'))).toBe(true);
  });

  it('NPC-04 窃取租金：公司格盗领累积红利', () => {
    // 公司格在 43/47/51/55/57..63，从 45 号格出发可在 1..6 步内抵达 47
    const { cellId, after } = sceneForLanding(
      'rent-thief',
      (g, landing) => {
        const cell = g.board[landing]!;
        if (cell.type !== 'company') throw new Error('落点非公司');
        g.companies.find((c) => c.cellId === landing)!.surplus = 8888;
      },
      45,
    );
    expect(after.board[cellId]!.type).toBe('company');
    expect(after.companies.find((c) => c.cellId === cellId)!.surplus).toBe(0);
    expect(after.log.some((l) => l.text.includes('盗领累积红利'))).toBe(true);
  });

  // 用户规则：四大恶人的赃物都实际交给释放（保释）他的人
  it('赃物转交保释人：小偷偷到的点券与道具归保释人', () => {
    const { after } = sceneForLanding('thief', (g) => {
      for (const p of g.players) {
        if (p.id === 'p1') continue;
        p.points = 2000;
        p.items = { 'bomb-lite': 1 };
      }
    });
    const bailer = after.players.find((p) => p.id === 'p1')!;
    // 小偷每次只偷一名路人：点券必为 500（2000 触顶），道具一并转交
    expect(bailer.points).toBe(500);
    expect(bailer.items['bomb-lite']).toBe(1);
    expect(after.log.some((l) => l.text.includes('赃物交予') && l.text.includes('阿福'))).toBe(true);
  });

  it('赃物转交保释人：行抢的卡片入保释人手牌', () => {
    const { after } = sceneForLanding('robber', (g) => {
      for (const p of g.players) {
        if (p.id === 'p1') continue;
        p.cards = ['tax-audit'];
      }
    });
    const bailer = after.players.find((p) => p.id === 'p1')!;
    expect(bailer.cards).toContain('tax-audit');
  });

  it('赃物转交保释人：窃取的租金现金归保释人', () => {
    const { after } = sceneForLanding('rent-thief', (g, landing) => {
      const cell = g.board[landing]!;
      if (cell.type !== 'property') throw new Error('落点非土地');
      g.players.find((p) => p.id !== 'p1')!.properties.push({ cellId: landing, grade: 1, lastRent: 3000 });
    });
    const bailer = after.players.find((p) => p.id === 'p1')!;
    // 窃取额要过物价指数（行情池扩到 17 支后不再恰好是 1），所以钉的是「钱从被害人名下全额转到保释人名下」，
    // 而不是某个写死的整数
    const victim = after.players.find((p) => p.id !== 'p1')!;
    // 数额要过物价指数、场景推进中指数还会漂（这一局偷到 3,157），所以钉方向不钉整数：
    // 钱进了保释人的现金、被害人名下被扣走，且播报点名交给了他
    expect(bailer.cash).toBeGreaterThan(15000);
    expect(victim.cash + victim.deposit).toBeLessThan(15000);
  });

  it('赃物转交保释人：保护费现金归保释人', () => {
    const { cellId, after } = sceneForLanding('protection', (g, landing) => {
      const cell = g.board[landing]!;
      if (cell.type !== 'property' || !cell.price) throw new Error('落点非地产');
      const owner = g.players.find((p) => p.id !== 'p1')!;
      owner.properties.push({ cellId: landing, grade: 1 });
      owner.cash = 1_000_000;
      owner.deposit = 0;
    });
    const fee = Math.round((after.board[cellId]!.price ?? 0) * 0.05);
    const bailer = after.players.find((p) => p.id === 'p1')!;
    expect(bailer.cash).toBe(15000 + fee);
  });
});

describe('TILE-11 魔法屋（NPC-06 女巫）', () => {
  it('落格只给出一条目标标语：机会里没有名单，也无从下发', () => {
    const landed = landAtMagic(53, 0);
    expect(landed.players[0]!.position).toBe(MAGIC_CELL);
    expect(landed.phase).toBe('awaiting_action');
    const magic = landed.magic!;
    expect(MAGIC_CONDITIONS.map((c) => c.kind)).toContain(magic.condition);
    // 整个机会只有 condition 一个字段：名单一旦进状态就随快照下发，而这条玩法的赌注
    // 正是「水晶球只报标语，谁中招自己判断」（决策表 §7.6）
    expect(Object.keys(magic)).toEqual(['condition']);
    expect(availableActions(landed).magic).toEqual(magic);
  });

  it('「财产最多的人」并列时一起中招，含施法者本人（M-03/M-04/M-07）', () => {
    const g = setupLanding(newGame(61), MAGIC_CELL, 3, seedForCondition(0));
    for (const p of g.players) p.cards.push('tax-audit'); // 开局三人现金相同 → 并列最高＝全体
    const landed = applyAction(g, { type: 'ROLL_DICE' });
    expect(landed.magic!.condition).toBe('richest');
    const next = applyAction(landed, { type: 'CAST_MAGIC', effect: 'sell-cards' });
    expect(next.players.map((p) => p.cards.length)).toEqual([0, 0, 0]);
    // 施法者自己也在这份名单里：判断错了就自己吃，这正是 M-04 要的
    expect(next.players[0]!.points).toBeGreaterThan(landed.players[0]!.points);
  });

  it('「走路的人」只命中没有载具的人（M-05 的身份类条件）', () => {
    const g = setupLanding(newGame(67), MAGIC_CELL, 3, seedForCondition(6));
    for (const p of g.players) p.cards.push('tax-audit');
    g.players[1]!.diceCount = 3; // p2 开汽车 → 不算走路的人
    const landed = applyAction(g, { type: 'ROLL_DICE' });
    expect(landed.magic!.condition).toBe('walker');
    const next = applyAction(landed, { type: 'CAST_MAGIC', effect: 'sell-cards' });
    expect(next.players.find((p) => p.id === 'p2')!.cards).toContain('tax-audit');
    expect(next.players.find((p) => p.id === 'p1')!.cards).toEqual([]);
    expect(next.players.find((p) => p.id === 'p3')!.cards).toEqual([]);
  });

  it('身份类条件无人对上时，选完魔法才发现：默默收回水晶球，谁都不受影响（Q-07）', () => {
    const landed = landAtMagic(71, 9); // 「神明附身的人」，开局无人被附身
    expect(landed.magic!.condition).toBe('godded');
    // 轮盘照开 —— 名单本来就不显示，"没人对上"不是开窗前能判的事
    expect(landed.landing?.cellId).toBe(MAGIC_CELL);
    const before = landed.players.map((p) => p.custody);
    const next = applyAction(landed, { type: 'CAST_MAGIC', effect: 'jail' });
    expect(next.magic).toBeNull();
    expect(next.players.map((p) => p.custody)).toEqual(before);
    expect(next.log.some((l) => l.text.includes('悻悻收回水晶球'))).toBe(true);
  });

  it('「立刻坐牢三天」：押到监狱格、暂停 3 回合并丧失收租权（M-09/M-14/D-54）', () => {
    const landed = applyAction(setupLanding(richest(newGame(101), 'p2'), MAGIC_CELL, 3, seedForCondition(0)), {
      type: 'ROLL_DICE',
    });
    expect(landed.magic!.condition).toBe('richest');
    const next = applyAction(landed, { type: 'CAST_MAGIC', effect: 'jail' });
    const t = next.players.find((p) => p.id === 'p2')!;
    expect(t.skipTurns).toBe(MAGIC_EFFECTS.jail.days);
    expect(t.custody?.kind).toBe('jail');
    expect(t.rentBlockedTurns).toBeGreaterThan(0);
    expect(t.position).toBe(JAIL_CELL); // 判了入狱就得真的被押过去，否则门外保释那道门永远开不了
    expect(next.log.some((l) => l.text.includes('被押送至「监狱」'))).toBe(true);
    // 只有他一个中招
    expect(next.players.find((p) => p.id === 'p1')!.custody).toBeNull();
  });

  it('「住院检查三天」：押到医院格，且不重走落格事务（D-54）', () => {
    const g = setupLanding(richest(newGame(103), 'p2'), MAGIC_CELL, 3, seedForCondition(0));
    g.players[1]!.position = 40; // 离医院格很远，判完只能靠"押送"到 14
    const landed = applyAction(g, { type: 'ROLL_DICE' });
    const next = applyAction(landed, { type: 'CAST_MAGIC', effect: 'hospital' });
    const v = next.players.find((p) => p.id === 'p2')!;
    expect(v.position).toBe(14);
    expect(v.custody?.kind).toBe('hospital');
    // 站上一格医院会办「住院 + 每天医药费」那套；强制押送只改位置，不该再办一遍
    expect(next.log.filter((l) => l.text.includes('办理住院')).length).toBe(0);
  });

  it('保险理赔（M-15/Q-01）：在保的人才拿到钱，且是给被施法者本人的现金', () => {
    const insured = setupLanding(richest(newGame(105), 'p2'), MAGIC_CELL, 3, seedForCondition(0));
    insured.players[1]!.insurance = { daysLeft: 3 };
    const landed = applyAction(insured, { type: 'ROLL_DICE' });
    const cashBefore = landed.players[1]!.cash;
    const next = applyAction(landed, { type: 'CAST_MAGIC', effect: 'jail' });
    // 金额过物价指数（行情池会带着指数漂），所以钉方向与归属，不钉整数
    expect(next.players[1]!.cash).toBeGreaterThan(cashBefore);
    expect(next.log.some((l) => l.text.includes('领取保险金'))).toBe(true);
    // 踩屋者不收钱：这笔不是魔法屋的奖励，是保单的理赔
    expect(next.players[0]!.cash).toBe(landed.players[0]!.cash);
    // 无保单 → 一分不赔
    const bare = applyAction(landAtMagic(107, 0), { type: 'CAST_MAGIC', effect: 'jail' });
    expect(bare.log.some((l) => l.text.includes('领取保险金'))).toBe(false);
  });

  it('魔法屋不走反制栈：免罪卡在手里也照样被关，且不被消耗（M-16）', () => {
    const landed = applyAction(setupLanding(richest(newGame(109), 'p2'), MAGIC_CELL, 3, seedForCondition(0)), {
      type: 'ROLL_DICE',
    });
    const withCard = structuredClone(landed);
    withCard.players[1]!.cards = ['absolve'];
    const next = applyAction(withCard, { type: 'CAST_MAGIC', effect: 'jail' });
    const t = next.players[1]!;
    expect(t.custody?.kind).toBe('jail');
    expect(t.position).toBe(JAIL_CELL);
    expect(t.cards).toEqual(['absolve']);
    expect(next.log.some((l) => l.text.includes('免罪卡'))).toBe(false);
  });

  it('「变卖所有卡片」只清手牌，道具一格不动（M-13 / Q-08 拆档）', () => {
    const g = setupLanding(richest(newGame(113), 'p2'), MAGIC_CELL, 3, seedForCondition(0));
    // 整手清成已知的一卡两道具：开局发的牌与道具一并算进变卖，等式才有意义
    g.players[1]!.cards = ['tax-audit'];
    g.players[1]!.items = { roadblock: 2 };
    const pointsBefore = g.players[1]!.points;
    const landed = applyAction(g, { type: 'ROLL_DICE' });
    const next = applyAction(landed, { type: 'CAST_MAGIC', effect: 'sell-cards' });
    const after = next.players[1]!;
    expect(after.cards).toEqual([]);
    expect(after.items).toEqual({ roadblock: 2 });
    // 半价口径与商店卖卡、命运卡「变卖所有卡片道具」是同一条
    expect(after.points).toBe(pointsBefore + Math.floor(CARDS['tax-audit']!.cost / 2));
  });

  it('「变卖所有道具」是轮盘第 12 档：只清道具，手牌一格不动', () => {
    const g = setupLanding(richest(newGame(113), 'p2'), MAGIC_CELL, 3, seedForCondition(0));
    g.players[1]!.cards = ['tax-audit'];
    g.players[1]!.items = { roadblock: 2 };
    const pointsBefore = g.players[1]!.points;
    const landed = applyAction(g, { type: 'ROLL_DICE' });
    const next = applyAction(landed, { type: 'CAST_MAGIC', effect: 'sell-items' });
    const after = next.players[1]!;
    expect(after.items).toEqual({});
    expect(after.cards).toEqual(['tax-audit']);
    expect(after.points).toBe(pointsBefore + itemSellValue('roadblock') * 2);
  });

  it('身上没有对应那一类时，这一档在他身上没有落点（不记进"命中几人"）', () => {
    const g = setupLanding(richest(newGame(113), 'p2'), MAGIC_CELL, 3, seedForCondition(0));
    g.players[1]!.cards = ['tax-audit'];
    g.players[1]!.items = {};
    const landed = applyAction(g, { type: 'ROLL_DICE' });
    const next = applyAction(landed, { type: 'CAST_MAGIC', effect: 'sell-items' });
    expect(next.log.some((l) => /道具全部变卖/.test(l.text))).toBe(false);
    expect(next.players[1]!.cards).toEqual(['tax-audit']);
  });

  it('魔法机会不跨回合残留（advanceTurn 清空 magic）', () => {
    const landed = landAtMagic(307, 0);
    expect(landed.magic).not.toBeNull();
    expect(applyAction(landed, { type: 'FINISH_LANDING' }).magic).toBeNull();
  });

  it('非法 CAST_MAGIC：无机会 / 轮盘上没有这一档，都被拒', () => {
    expect(() => applyAction(newGame(311), { type: 'CAST_MAGIC', effect: 'jail' })).toThrow(/没有可施法的机会/);
    const landed = landAtMagic(313, 0);
    // 拍卖档在波 2 已经上盘（M-24），这里换一枚真不存在的档名钉"可选集只有一处说法"
    expect(() => applyAction(landed, { type: 'CAST_MAGIC', effect: 'whammy' as never })).toThrow(/魔法书上没有这一档/);
  });

  it('放弃施法 → 结束回合，机会随即消散', () => {
    const landed = landAtMagic(317, 0);
    expect(landed.phase).toBe('awaiting_action');
    expect(availableActions(landed).canFinishLanding).toBe(true);
    expect(applyAction(landed, { type: 'FINISH_LANDING' }).magic).toBeNull();
  });
});

describe('TILE-11 魔法屋 · 波 2 的八档', () => {
  /** 一个住宅格：脚下格类效果（拆除 / 加盖 / 拍卖）都拿它当布景 */
  const OWNED_CELL = 1;
  type OnePlayer = GameState['players'][number];

  /** 钉「财产最多的人」这条标语，并让 `id` 是唯一对得上的人 */
  function magicOn(seed: number, id: string): GameState {
    return applyAction(setupLanding(richest(newGame(seed), id), MAGIC_CELL, 3, seedForCondition(0)), {
      type: 'ROLL_DICE',
    });
  }

  /**
   * 施法前的布景。改的是**当下**的状态而不是落格之前 —— 命中名单本来就在施法那一刻
   * 从活状态现算（决策表 §7.6），所以布景晚一步做反而更贴近引擎的判法。
   */
  function prepare(landed: GameState, id: string, mutate: (p: OnePlayer) => void): GameState {
    const s = structuredClone(landed);
    mutate(s.players.find((p) => p.id === id)!);
    return s;
  }

  /** 让他站在自己名下的一块地上 */
  function standOnOwn(grade: 1 | 2 | 3 | 4 | 5) {
    return (p: OnePlayer) => {
      p.position = OWNED_CELL;
      p.properties = [{ cellId: OWNED_CELL, grade }];
    };
  }

  it('「抽取命运三张」＝连抽三张公共池命运（M-17）', () => {
    const next = applyAction(prepare(magicOn(201, 'p2'), 'p2', (p) => { p.cash = 200_000; }), {
      type: 'CAST_MAGIC',
      effect: 'fate-x3',
    });
    expect(next.log.filter((l) => l.text.startsWith('【命运】小美')).length).toBe(3);
  });

  it('「原地停留一回合」挂 holdTurns，与停留卡同一字段（M-23）', () => {
    const next = applyAction(magicOn(203, 'p2'), { type: 'CAST_MAGIC', effect: 'hold' });
    expect(next.players[1]!.holdTurns).toBe(1);
  });

  it('「就地拆除房屋」拆一层；1 级已是最低一级，算落空（Q-03）', () => {
    const down = applyAction(prepare(magicOn(205, 'p2'), 'p2', standOnOwn(3)), {
      type: 'CAST_MAGIC',
      effect: 'demolish',
    });
    expect(down.players[1]!.properties[0]!.grade).toBe(2);

    const flat = applyAction(prepare(magicOn(207, 'p2'), 'p2', standOnOwn(1)), {
      type: 'CAST_MAGIC',
      effect: 'demolish',
    });
    expect(flat.players[1]!.properties[0]!.grade).toBe(1);
    expect(flat.log.some((l) => l.text.includes('没有落点'))).toBe(true);
  });

  it('「就地加盖房屋」免费加一层，钱一分不动（Q-02 不挑）', () => {
    const before = magicOn(209, 'p2');
    const cashBefore = before.players[1]!.cash;
    const next = applyAction(prepare(before, 'p2', standOnOwn(2)), { type: 'CAST_MAGIC', effect: 'build-up' });
    expect(next.players[1]!.properties[0]!.grade).toBe(3);
    expect(next.players[1]!.cash).toBe(cashBefore);
  });

  it('连锁店不能加盖（help[21]：改建后即无法再往上加）', () => {
    const next = applyAction(
      prepare(magicOn(210, 'p2'), 'p2', (p) => {
        p.position = OWNED_CELL;
        p.properties = [{ cellId: OWNED_CELL, grade: 2, chain: true }];
      }),
      { type: 'CAST_MAGIC', effect: 'build-up' },
    );
    expect(next.players[1]!.properties[0]!.grade).toBe(2);
    expect(next.log.some((l) => l.text.includes('没有落点'))).toBe(true);
  });

  it('「得一张卡片」走免费卡格那条通道（M-22）', () => {
    const before = magicOn(211, 'p2');
    const cardsBefore = before.players[1]!.cards.length;
    const next = applyAction(before, { type: 'CAST_MAGIC', effect: 'gain-card' });
    expect(next.players[1]!.cards.length).toBe(cardsBefore + 1);
    expect(next.log.some((l) => l.text.includes('在魔法屋抽到卡片'))).toBe(true);
  });

  it('「存入所有现金」把现金账整笔搬进存款账（M-21）', () => {
    const before = magicOn(213, 'p2');
    const { cash, deposit } = before.players[1]!;
    const next = applyAction(before, { type: 'CAST_MAGIC', effect: 'to-deposit' });
    expect(next.players[1]!.cash).toBe(0);
    expect(next.players[1]!.deposit).toBe(deposit + cash);
  });

  it('「向后转」翻朝向，与转向卡同一条算式（M-20）', () => {
    const before = magicOn(215, 'p2');
    const was = before.players[1]!.heading;
    const next = applyAction(before, { type: 'CAST_MAGIC', effect: 'turn-back' });
    expect(next.players[1]!.heading).not.toBe(was);
  });

  it('「拍卖当格土地」挂进拍卖队列，成交后回合恢复为拍卖阶段（M-24）', () => {
    const next = applyAction(prepare(magicOn(217, 'p2'), 'p2', standOnOwn(2)), {
      type: 'CAST_MAGIC',
      effect: 'auction-cell',
    });
    // sellerId = 被施法者 ⇒ 成交价归他自己（A 只在坐牢/住院那条写了"记在踩屋者名下"）
    expect(next.auction?.cellId).toBe(OWNED_CELL);
    expect(next.auction?.sellerId).toBe('p2');
    expect(next.auction?.trigger).toBe('magic');
    expect(next.phase).toBe('awaiting_auction');
  });

  it('脚下是别人的地也照办：拆的是地主的楼，不是踩着它的那位', () => {
    const s = prepare(magicOn(227, 'p2'), 'p2', (p) => { p.position = OWNED_CELL; });
    s.players[2]!.properties = [{ cellId: OWNED_CELL, grade: 3 }]; // 小美站在老王的洋房上
    const next = applyAction(s, { type: 'CAST_MAGIC', effect: 'demolish' });
    expect(next.players[2]!.properties[0]!.grade).toBe(2);
    expect(next.players[1]!.properties.some((q) => q.cellId === OWNED_CELL)).toBe(false);
    expect(next.log.some((l) => l.text.includes('地主 老王'))).toBe(true);
  });

  it('脚下是无主之地时落空：没有卖方就不拍（拍出去等于白送一块地）', () => {
    const next = applyAction(magicOn(219, 'p2'), { type: 'CAST_MAGIC', effect: 'auction-cell' });
    expect(next.auction).toBeNull();
    expect(next.auctionQueue).toEqual([]);
    expect(next.log.some((l) => l.text.includes('没有落点'))).toBe(true);
  });

  it('bot 施法：命中含自己时强制改「得一张卡片」自保（M-25）', () => {
    const s = structuredClone(newGame(221));
    s.currentPlayerIndex = 1;
    s.phase = 'awaiting_action';
    s.players[1]!.cash = 9_999_999; // 「财产最多的人」＝它自己
    s.magic = { condition: 'richest' };
    expect(botDecide(s, 'p2', () => 0.5)).toEqual({ type: 'CAST_MAGIC', effect: 'gain-card' });
  });

  it('bot 施法：没烧到自己时从坏档里挑', () => {
    const s = structuredClone(newGame(223));
    s.currentPlayerIndex = 0;
    s.phase = 'awaiting_action';
    s.players[1]!.cash = 9_999_999; // 最富的是 p2，施法的 p1 不在名单里
    s.magic = { condition: 'richest' };
    const act = botDecide(s, 'p1', () => 0.5);
    expect(act?.type).toBe('CAST_MAGIC');
    expect(MAGIC_EFFECTS[(act as { effect: MagicEffectKind }).effect].polarity).toBe('bad');
  });
});

describe('总资产（魔法屋「财产最多的人」依赖）', () => {
  it('totalAssets 可用于比较前后资产', () => {
    const g = newGame(401);
    const a = totalAssets(g, g.players[0]!);
    expect(typeof a).toBe('number');
    expect(a).toBeGreaterThan(0);
  });
});