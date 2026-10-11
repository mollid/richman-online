import { describe, expect, it } from 'vitest';
import {
  BOARD_SIZE,
  GODS,
  GOD_MAX_ON_BOARD,
  GOD_MIN_GAP_CELLS,
  GOD_PAIR_REST_DAYS,
  GOD_SPAWN_ELIGIBLE_TYPES,
  GOD_TTL_DAYS,
  applyAction,
  availableActions,
  boardGodAt,
  createGame,
  godDef,
  godPairKey,
  ringDistance,
  spawnCellCandidates,
  spawnableGodDefs,
  summonableGodDefs,
  type GameState,
  type PlayerDef,
} from '../src/index.js';
import { atLegacyStart, pinIndexOne, putGodOnBoard } from './helpers/state.js';
import { MONDAY, runGoldenMatch } from './helpers/golden_run.js';

/**
 * 神明现身驻留棋盘（GOD 现身机制，W2）。
 *
 * 原版（`docs/gameplay/GAP调研记录_2026-09-24.md` §3）：日切随机现身、驻留固定格、
 * 经过即附身、对偶不共现、同屏最多 3-4 尊。这些用例逐条钉住，外加抽数纪律那条
 * 「`spawnGods` 关闭时零抽数」。全部经由 `applyAction` 驱动，不直接调内部钩子。
 */

const PLAYERS: PlayerDef[] = [
  { id: 'p1', name: '阿福', color: 0xef5350 },
  { id: 'p2', name: '小美', color: 0x42a5f5 },
  { id: 'p3', name: '老王', color: 0x66bb6a },
];

function game(seed: number, spawnGods: boolean): GameState {
  const g = applyAction(createGame(PLAYERS, seed, { startDate: { ...MONDAY }, spawnGods }), { type: 'START_GAME' });
  atLegacyStart(g); // SP-01 出生点随机会改写落格轨迹；本文件钉的是神明现身，出生点钉回旧默认
  for (const p of g.players) p.diceCount = 2;
  return pinIndexOne(g);
}

/**
 * 推进到下一次日切（全员各行动一次）。
 *
 * 连跑很多天时会被 bot 不管的相位绊住（小游戏 / 手牌额满 / 拍卖），所以这里一并喂掉：
 * 拍卖一律让过（除最高价者外全体让过就收锤），小游戏只翻第一张可翻的牌。
 */
function toNextDay(state: GameState): GameState {
  let s = state;
  const day = s.calendar.elapsedDays;
  for (let i = 0; i < 80 && s.calendar.elapsedDays === day && s.phase !== 'game_over'; i++) {
    if (s.phase === 'awaiting_auction') {
      s = applyAction(s, { type: 'AUCTION_PASS' });
    } else if (s.phase === 'awaiting_discard') {
      const cardId = s.players[s.currentPlayerIndex]!.cards[0];
      if (!cardId) break;
      s = applyAction(s, { type: 'DISCARD_CARD', cardId });
    } else if (s.phase === 'awaiting_pick') {
      const mg = s.minigame;
      const open =
        mg?.kind === 'memory'
          ? mg.matched.map((matched, idx) => (matched || mg.revealed.includes(idx) ? -1 : idx)).filter((idx) => idx >= 0)
          : [0];
      s = applyAction(s, { type: 'MINIGAME_PICK', hole: open[0] ?? 0 });
    } else if (s.phase === 'awaiting_roll') {
      s = applyAction(s, { type: 'ROLL_DICE' });
    } else {
      s = applyAction(s, { type: 'FINISH_LANDING' });
    }
  }
  expect(s.calendar.elapsedDays).toBeGreaterThan(day); // 别把「没推进」当成通过
  return s;
}

describe('抽数纪律：spawnGods 开关', () => {
  it('关掉开关 ⇒ 这条随机源整个不参与：推进十二个日切场上也不会有神', () => {
    // 两个版本都要跑到各自收束或满 12 天：中途 game_over 时不能再硬推（会撞上「当前不能掷骰」）
    const runDays = (state: GameState, days: number) => {
      let s = state;
      const everSeen: string[] = [];
      for (let i = 0; i < days && s.phase !== 'game_over'; i++) {
        s = toNextDay(s);
        for (const god of s.boardGods) everSeen.push(god.godId);
      }
      return { state: s, everSeen };
    };
    const off = runDays(game(20260105, false), 12);
    expect(off.everSeen).toEqual([]); // 关掉 ⇒ 一个都没出现过
    const on = runDays(game(20260105, true), 12);
    expect(on.everSeen.length).toBeGreaterThan(0); // 开着 ⇒ 出现过（可能被附身走，所以数的是「出现过」）
    // 同一 seed 下两者的 rngState 必然分叉 ⇒ 这条机制确实在吃抽数，测试隔离它是有必要的
    expect(off.state.rngState).not.toBe(on.state.rngState);
  });

  it('开启时，日切才会把神明放上棋盘（同一 seed 下可复现）', () => {
    const seen = new Set<string>();
    for (const seed of [11, 23, 47, 61, 88, 101]) {
      const a = toNextDay(game(seed, true));
      const b = toNextDay(game(seed, true));
      expect(JSON.stringify(a.boardGods)).toBe(JSON.stringify(b.boardGods)); // 确定性
      for (const g of a.boardGods) seen.add(g.godId);
    }
    expect(seen.size).toBeGreaterThan(0);
  });

  it('缺字段的旧存档经 normalizeGameState 补齐为当前规则的默认值（开启但场上没有神明）', async () => {
    const { normalizeGameState } = await import('../src/index.js');
    const legacy = structuredClone(game(11, true)) as unknown as Record<string, unknown>;
    delete legacy.boardGods;
    delete legacy.spawnGods;
    delete legacy.godPairBanUntil;
    const restored = normalizeGameState(legacy as unknown as GameState);
    expect(restored.boardGods).toEqual([]);
    expect(restored.spawnGods).toBe(true);
    expect(restored.godPairBanUntil).toEqual({});
  });
});

describe('现身规则（概率 / 上限 / 对偶 / 格位）', () => {
  it('驻留格只允许落在非必触发格上', () => {
    const g = game(7, true);
    const candidates = spawnCellCandidates(g);
    expect(candidates.length).toBeGreaterThan(0);
    for (const cell of candidates) {
      expect(GOD_SPAWN_ELIGIBLE_TYPES).toContain(cell.type);
    }
  });

  it('候选格与玩家、与在场神明都至少隔 GOD_MIN_GAP_CELLS 格', () => {
    const g = game(7, true);
    const occupied = g.players.map((p) => p.position);
    putGodOnBoard(g, 'big-wealth', 30);
    for (const cell of spawnCellCandidates(g)) {
      for (const at of [...occupied, 30]) expect(ringDistance(cell.id, at)).toBeGreaterThanOrEqual(GOD_MIN_GAP_CELLS);
    }
  });

  it('同对不共现：大财神在场时这对财神整对都不进候选', () => {
    const g = game(7, true);
    putGodOnBoard(g, 'big-wealth', 10);
    const ids = spawnableGodDefs(g).map((d) => d.id);
    expect(ids).not.toContain('small-wealth'); // 对偶不得共现
    expect(ids).not.toContain('big-wealth'); // 已在场的那尊也不会被再选一遍（键相同）
    expect(ids).toContain('big-poverty'); // 其它对不受影响
  });

  it('清退后对偶进入冷却，期满才对偶可现身；无对偶者不受影响', () => {
    const g = game(7, true);
    putGodOnBoard(g, 'big-wealth', 10);
    g.calendar.elapsedDays = 5;
    // 手工清退（等价于机器娃娃扫走 / 期满离开）：走引擎路径难以定点，故直接调 hook 前的等价效果
    g.boardGods = [];
    g.godPairBanUntil[godPairKey('big-wealth')] = 5 + GOD_PAIR_REST_DAYS;
    expect(spawnableGodDefs(g).map((d) => d.id)).not.toContain('small-wealth');
    g.calendar.elapsedDays = 5 + GOD_PAIR_REST_DAYS;
    expect(spawnableGodDefs(g).map((d) => d.id)).toContain('small-wealth');
    // 土地公 / 死神没有对偶，冷却键不影响它们
    expect(godPairKey('land-god')).toBe('land-god');
  });

  it('在场满 4 尊时不再现身（且任何情况下都不许超上限）', () => {
    const g = game(7, true);
    // 把玩家集中到棋盘一侧、神明摆在另一侧：这样日切时既没人撞上神明（会腾出空位），
    // 也就不会因为「清退一尊、再现一尊」而看不出上限规则。
    g.players.forEach((p, i) => {
      p.position = i;
      p.diceCount = 1;
    });
    const far = spawnCellCandidates(g).filter((c) => c.id >= 20 && c.id <= 44).slice(0, GOD_MAX_ON_BOARD);
    expect(far).toHaveLength(GOD_MAX_ON_BOARD);
    // 4 尊互不为对偶，占满同屏上限
    ;['big-wealth', 'big-fortune', 'big-poverty', 'big-misfortune'].forEach((godId, i) => putGodOnBoard(g, godId, far[i]!.id, 9));
    const next = toNextDay(g);
    expect(next.boardGods.length).toBeLessThanOrEqual(GOD_MAX_ON_BOARD);
    expect(next.boardGods.some((god) => god.bornDay === next.calendar.elapsedDays)).toBe(false);
  });

  it('死神不参与随机现身（把其余神明逐个排除后仍轮不到它）', () => {
    const g = game(7, true);
    for (const def of GODS) {
      if (def.id === 'death') continue;
      g.godPairBanUntil[godPairKey(def.id)] = g.calendar.elapsedDays + 99;
    }
    expect(spawnableGodDefs(g)).toEqual([]);
    const land = GODS.filter((d) => d.id === 'land-god')[0]!;
    g.godPairBanUntil = {};
    g.landGodCooldownMonth = 0;
    const ids = spawnableGodDefs(g).map((d) => d.id);
    expect(ids).toContain(land.id);
    expect(ids).not.toContain('death');
  });
});

describe('经过即附身', () => {
  /** 造一个「正前方第 n 格站着一尊神」的局面 */
  function godAhead(seed: number, godId: string, offset: number) {
    const g = game(seed, true);
    const me = g.players[g.currentPlayerIndex]!;
    const cellId = (me.position + 1 + offset) % BOARD_SIZE;
    me.diceCount = 1; // 步行：一颗骰子，落点可预测
    g.phase = 'awaiting_roll';
    putGodOnBoard(g, godId, cellId);
    return { state: g, cellId };
  }

  it('踩到驻留神明立刻附身，并退出在场列表', () => {
    const { state, cellId } = godAhead(3, 'big-wealth', 0);
    const rolled = applyAction(state, { type: 'ROLL_DICE', diceCount: 1 });
    expect(rolled.players[0]!.god?.godId).toBe('big-wealth');
    expect(rolled.players[0]!.position).toBe(cellId);
    expect(boardGodAt(rolled, cellId)).toBeUndefined();
  });

  /** 造一个「神明驻在指定格、我正站在它前一格、一颗骰子刚好踩上去」的局面 */
  function godOn(godId: string, pick: (c: { type: string }) => boolean) {
    const g = game(3, true);
    const me = g.players[g.currentPlayerIndex]!;
    const cellId = g.board.findIndex(pick);
    me.position = (cellId - 1 + BOARD_SIZE) % BOARD_SIZE;
    me.diceCount = 1;
    g.phase = 'awaiting_roll';
    putGodOnBoard(g, godId, cellId);
    return { g, cellId };
  }

  it('附身之后照常结算脚下那一格（R4 定死的次序：先附身、再落格）', () => {
    // 旧规是「附身即结束回合、跳过这一格」，所以神明只能驻在不会强制结算的格子上。
    // R4 把次序反过来之后，两件事都发生：先大财神显灵拿钱，再被税务格抽 10% 现金。
    const { g, cellId } = godOn('big-wealth', (c) => c.type === 'tax');
    const rolled = applyAction(g, { type: 'ROLL_DICE', diceCount: 1 });
    expect(rolled.players[0]!.position).toBe(cellId);
    expect(rolled.players[0]!.god?.godId).toBe('big-wealth');
    const taxIdx = rolled.log.findIndex((l) => l.text.includes('需缴税'));
    const attachIdx = rolled.log.findIndex((l) => l.text.includes('附身'));
    expect(taxIdx).toBeGreaterThanOrEqual(0); // 落格没被跳过
    expect(attachIdx).toBeLessThan(taxIdx); // 而附身排在前面
  });

  it('神明停在商店格：先附身，再进店，买完「离开商店」才结束回合', () => {
    const { g, cellId } = godOn('big-wealth', (c) => c.type === 'shop');
    const rolled = applyAction(g, { type: 'ROLL_DICE', diceCount: 1 });
    expect(rolled.players[0]!.god?.godId).toBe('big-wealth');
    // 这一格从此可以是商店 —— 驻留格型开放（R4）之后，次序有答案就不必从源头排除
    expect(rolled.landing).toEqual({ cellId, venue: 'shop', turn: rolled.turn });
    expect(rolled.phase).toBe('awaiting_action'); // 会话窗：回合还没交出去
    const left = applyAction(rolled, { type: 'FINISH_LANDING' });
    expect(left.landing).toBeNull();
    expect(left.phase).toBe('awaiting_roll');
  });

  it('神明停在无主地产：土地公当场侵占脚下这一格，落格给的是加盖而不是买地', () => {
    // 附身先发生 ⇒ applyGodTravel 看到的是「刚请到的土地公」⇒ 脚下这格已被占为己有
    // ⇒ 落格分派走到「自有可加盖」那条分支。这是**规则**，不是 bug（用户口径：先附身再结算）。
    const { g, cellId } = godOn('land-god', (c) => c.type === 'property');
    const rolled = applyAction(g, { type: 'ROLL_DICE', diceCount: 1 });
    expect(rolled.players[0]!.god?.godId).toBe('land-god');
    expect(rolled.players[0]!.properties.some((q) => q.cellId === cellId)).toBe(true);
    expect(rolled.log.some((l) => l.text.includes('占为己有'))).toBe(true);
    expect(rolled.landing).toEqual({ cellId, venue: null, turn: rolled.turn });
    const acts = availableActions(rolled);
    expect(acts.canBuy).toBe(false); // 已经是自己的地，没有「买」这一手
    expect(acts.canUpgrade).toBe(true); // 加盖照旧是终结动作
    const up = applyAction(rolled, { type: 'UPGRADE_LAND' });
    expect(up.phase).toBe('awaiting_roll');
  });

  it('神明与路障同格时以路障优先（截停型效果先结算，不双触发）', () => {
    const { state, cellId } = godAhead(3, 'big-wealth', 0);
    state.roadblocks = [...state.roadblocks, cellId];
    const rolled = applyAction(state, { type: 'ROLL_DICE', diceCount: 1 });
    expect(rolled.players[0]!.god).toBeNull(); // 只撞路障，没附身
    expect(boardGodAt(rolled, cellId)).toBeDefined(); // 神明仍在场上
  });

  it('土地公现身也遵守同一套规则；附身后按 help[40] 记本月冷却', () => {
    const { state, cellId } = godAhead(3, 'land-god', 0);
    const rolled = applyAction(state, { type: 'ROLL_DICE', diceCount: 1 });
    expect(rolled.players[0]!.god?.godId).toBe('land-god');
    expect(rolled.landGodCooldownMonth).toBeGreaterThan(0);
    // 同月内不再进候选
    expect(spawnableGodDefs(rolled).map((d) => d.id)).not.toContain('land-god');
    void cellId;
  });
});

describe('驻留神明的清退联动', () => {
  it('机器娃娃扫掉前方 9 步内的驻留神明，并写下对偶冷却', () => {
    const g = game(3, true);
    const me = g.players[g.currentPlayerIndex]!;
    const cellId = (me.position + 5) % BOARD_SIZE;
    putGodOnBoard(g, 'big-poverty', cellId);
    g.phase = 'awaiting_action';
    me.items = { 'robot-doll': 1 };
    const used = applyAction(g, { type: 'USE_ITEM', itemId: 'robot-doll' });
    expect(boardGodAt(used, cellId)).toBeUndefined();
    expect(used.godPairBanUntil[godPairKey('big-poverty')]).toBeGreaterThan(used.calendar.elapsedDays - 1);
    expect(used.log.some((l) => l.text.includes('驻留神明'))).toBe(true);
  });

  it('没被附身时，送神卡可以请走前方 9 步内的驻留神明', () => {
    const g = game(3, true);
    const me = g.players[g.currentPlayerIndex]!;
    const cellId = (me.position + 4) % BOARD_SIZE;
    putGodOnBoard(g, 'devil', cellId);
    g.phase = 'awaiting_action';
    me.cards = ['send-god'];
    const used = applyAction(g, { type: 'USE_CARD', cardId: 'send-god' });
    expect(boardGodAt(used, cellId)).toBeUndefined();
    expect(used.players[0]!.cards).not.toContain('send-god');
  });

  it('前方什么都没有时，送神卡与机器娃娃都拒绝使用（不是空转一次）', () => {
    const g = game(3, true);
    const me = g.players[g.currentPlayerIndex]!;
    g.phase = 'awaiting_action';
    me.cards = ['send-god'];
    me.items = { 'robot-doll': 1 };
    expect(() => applyAction(g, { type: 'USE_CARD', cardId: 'send-god' })).toThrow('身上没有神明或定时炸弹，前方也没有驻留的神明');
    expect(() => applyAction(g, { type: 'USE_ITEM', itemId: 'robot-doll' })).toThrow('前方 9 步内没有障碍物或特殊单位');
  });

  it('请神卡只能请到在场的神明，无神可请时门控与引擎同口径拒绝', () => {
    const g = game(3, true);
    const me = g.players[g.currentPlayerIndex]!;
    g.phase = 'awaiting_action';
    me.cards = ['invite-god'];
    expect(availableActions(g).usableCards).not.toContain('invite-god');
    expect(() => applyAction(g, { type: 'USE_CARD', cardId: 'invite-god' })).toThrow('棋盘上此刻没有可请的神明');

    const far = (me.position + 20) % BOARD_SIZE;
    const near = (me.position + 2) % BOARD_SIZE;
    putGodOnBoard(g, 'angel', far);
    putGodOnBoard(g, 'big-fortune', near);
    expect(availableActions(g).usableCards).toContain('invite-god');
    const invited = applyAction(g, { type: 'USE_CARD', cardId: 'invite-god' });
    expect(invited.players[0]!.god?.godId).toBe('big-fortune'); // 取最近的那尊
    expect(boardGodAt(invited, near)).toBeUndefined();
  });

  it('驻留天数为 0 的神明在下一次日切离场', () => {
    const g = game(3, true);
    putGodOnBoard(g, 'big-misfortune', spawnCellCandidates(g)[0]!.id, 1);
    const next = toNextDay(g);
    expect(next.boardGods).not.toContainEqual(expect.objectContaining({ godId: 'big-misfortune' }));
    // 期间它可能被别的玩家撞上附身 —— 那种离场不写对偶冷却，所以只在「确实清退」时断言
    const attached = next.players.some((p) => p.god?.godId === 'big-misfortune');
    if (!attached) {
      expect(next.godPairBanUntil[godPairKey('big-misfortune')]).toBeGreaterThanOrEqual(next.calendar.elapsedDays);
    }
  });
});

describe('同对不共现是一条全局不变式（不止管现身）', () => {
  /** 附身的入口有四个：日切现身、经过附身、神庙摇籤、请神卡，外加期满对偶转化。
   *  W2 只在「现身」那一个入口上筛了同对，其余入口照样能把第二尊同对神塞进场上
   *  —— 实测两名玩家同时挂着「小福神·7天」。 */
  const pairKeysOnField = (s: GameState): string[] => [
    ...(s.boardGods ?? []).map((g) => godPairKey(g.godId)),
    ...s.players.filter((p) => p.god?.godId).map((p) => godPairKey(p.god!.godId)),
  ];

  it('神庙摇籤不会摇到已在场的那一尊，也不会摇到它的对偶', () => {
    const g = game(5, true);
    const me = g.players[g.currentPlayerIndex]!;
    // 小福神已经附在别人身上 ⇒ 大/小福神这一对整对不可再摇到
    g.players[1]!.god = { godId: 'small-fortune', remainingDays: 7 };
    const ids = summonableGodDefs(g).map((d) => d.id);
    expect(ids).not.toContain('small-fortune');
    expect(ids).not.toContain('big-fortune');
    expect(ids).toContain('big-poverty'); // 其它对不受牵连
    void me;
  });

  it('棋盘上驻留着大福神时，神庙摇不到小福神（同对不得一在棋盘一在人身上）', () => {
    const g = game(5, true);
    putGodOnBoard(g, 'big-fortune', 20);
    expect(summonableGodDefs(g).map((d) => d.id)).not.toContain('small-fortune');
  });

  it('诸神全在场时神庙不附身，只播报「无应验」，而不是硬塞一尊', () => {
    const g = game(5, true);
    // 12 尊全摆满：两位玩家身上各一尊，其余全压在棋盘上（夹具不受同屏上限约束）
    g.players[1]!.god = { godId: 'death', remainingDays: 13 };
    g.players[2]!.god = { godId: 'land-god', remainingDays: 7 };
    for (const def of GODS) {
      if (def.id === 'death' || def.id === 'land-god') continue;
      putGodOnBoard(g, def.id, 20 + def.cellId!);
    }
    const temple = g.board.find((c) => c.type === 'god')!;
    g.players[0]!.position = (temple.id - 1 + BOARD_SIZE) % BOARD_SIZE;
    g.players[0]!.diceCount = 1;
    g.pendingFixedDice = 1; // 钉死这一手正好落在神庙格上，别被随机点数带偏
    g.phase = 'awaiting_roll';
    const rolled = applyAction(g, { type: 'ROLL_DICE', diceCount: 1 });
    expect(rolled.players[0]!.position).toBe(temple.id);
    expect(rolled.players[0]!.god).toBeNull(); // 一个都没附上
    expect(rolled.log.some((e) => e.text.includes('无应验'))).toBe(true);
  });

  it('bot 对跑的整局轨迹里，任何一帧都不同对共现（属性测试）', () => {
    for (const seed of [20260105, 77, 1007]) {
      const run = runGoldenMatch({ maxTurns: 120, sampleEvery: 5, seed, collectStates: true });
      for (const s of run.states) {
        const keys = pairKeysOnField(s);
        expect(
          new Set(keys).size,
          `seed=${seed} turn=${s.turn} 出现同对共现：${keys.join(',')}`,
        ).toBe(keys.length);
      }
    }
  });
});

describe('数据口径', () => {
  it('GOD_TTL_DAYS 与对偶冷却都是正数，且上限不低于 1', () => {
    expect(GOD_TTL_DAYS).toBeGreaterThan(0);
    expect(GOD_PAIR_REST_DAYS).toBeGreaterThanOrEqual(0);
    expect(GOD_MAX_ON_BOARD).toBeGreaterThanOrEqual(1);
    expect(GOD_MIN_GAP_CELLS).toBeGreaterThan(1);
  });

  it('每尊神明的对偶键都自洽：有 transformsTo 的两尊共用一个键', () => {
    for (const def of GODS) {
      const key = godPairKey(def.id);
      if (!def.transformsTo) {
        expect(key).toBe(def.id);
        continue;
      }
      expect(key).toBe(godPairKey(def.transformsTo));
      expect(godDef(def.transformsTo)).toBeTruthy();
    }
  });
});
