import { describe, expect, it } from 'vitest';
import {
  BAIL_FEE,
  CARDS,
  ITEMS,
  actionRefusal,
  actionTargets,
  applyAction,
  autoSkipAction,
  availableActions,
  createGame,
  landPrice,
  landUpgradeCost,
  type TargetSpec,
} from '../src/index.js';
import { FACILITIES } from '../src/tiles.js';
import { GOLDEN_PLAYERS, MONDAY, runGoldenMatch } from './helpers/golden_run.js';
import { pinIndexOne } from './helpers/state.js';
import type { AvailableActions, BoardCell, GameState, Player, PlayerAction } from '../src/index.js';

/**
 * 门控与引擎同源的不变式测试（重构波 R3 的机器化验收）。
 *
 * 要根治的 bug 类：`availableActions` 自己写一套「能不能」的判断，动作函数另写一套
 * 「能不能」的 `if … throw`。两套一漂移，就是「按钮能点、点下去报错」。
 * R3-b/R3-c 把规则收进注册表的 `check` 之后，本测试把不变式钉死：
 *
 *   门控说可以 ⇒ `actionRefusal` 必须放行 ⇒（不需要现场收集目标的动作）`applyAction` 真的不抛错
 *
 * 遍历两类局面：① bot 对跑采到的中局状态（覆盖面广、含人工想不到的组合）；
 * ② 手工构造的边界局面（衰神买地 / 福神加倍投资 / 商业地实付价 / 梦游 / 例假日 / 未开放卡）。
 */

/**
 * 用同源候选把一个「不带目标」的动作补成真的能派单的那一套。
 *
 * `executable=false` 只出现在一种情况：这个动作确实需要某个维度、而该维度此刻没有候选
 * —— 此时门控本来就不该把它列进可用手牌，交给上层那句「门控列为可用却拒绝」去抓。
 */
function withCandidateTargets(
  base: PlayerAction,
  state: GameState,
  me: Player,
  spec: TargetSpec,
): { action: PlayerAction; executable: boolean } {
  const t = actionTargets(state, me, spec);
  const action = { ...base } as Record<string, unknown>;
  let executable = true;
  if (spec.cells) {
    if (t.cells.length === 0) executable = false;
    else action.cellId = t.cells[0];
  }
  if (spec.players && t.players.length > 0) action.targetPlayerId = t.players[0];
  if (spec.stocks) {
    if (t.stocks.length === 0) executable = false;
    else action.stockId = t.stocks[0];
  }
  if (spec.facilities && t.facilities.length > 0) action.facility = t.facilities[0];
  if (spec.dice && t.diceValues.length > 0) action.diceValue = t.diceValues[0];
  return { action: action as PlayerAction, executable };
}

/** 由门控推导出的「应当可执行」动作；`executable=false` = 还需 UI 现场补目标参数 */
function obligations(
  state: GameState,
  acts: AvailableActions,
  me: Player,
): Array<{ action: PlayerAction; executable: boolean }> {
  const cell = state.board[me.position]!;
  const out: Array<{ action: PlayerAction; executable: boolean }> = [];
  const push = (action: PlayerAction, executable = true) => out.push({ action, executable });

  if (acts.canRoll) push({ type: 'ROLL_DICE' });
  if (acts.canBuy) push({ type: 'BUY_LAND' });
  if (acts.canUpgrade) push({ type: 'UPGRADE_LAND' });
  if (acts.canFinishLanding) push({ type: 'FINISH_LANDING' });
  if (acts.canDeposit) push({ type: 'DEPOSIT', amount: me.cash });
  if (acts.canWithdraw) push({ type: 'WITHDRAW', amount: me.deposit });
  if (acts.canLoan) push({ type: 'TAKE_LOAN', amount: 1 });
  if (acts.canRepayLoan && me.loan) push({ type: 'REPAY_LOAN', amount: Math.min(me.cash, me.loan.principal) });
  if (acts.canBuyLottery) push({ type: 'BUY_LOTTERY_TICKET', number: 0 });
  if (acts.canBuyShares && acts.shareQuantityLimit > 0) push({ type: 'BUY_SHARES', cellId: cell.id, quantity: acts.shareQuantityLimit });
  if (acts.canFinancing && acts.financingRemaining > 0) push({ type: 'SPECIAL_FINANCING', amount: acts.financingRemaining });
  for (const facility of acts.buildableFacilities) push({ type: 'BUILD_FACILITY', facility });
  for (const itemId of acts.researchableItems) push({ type: 'START_RESEARCH', itemId });
  for (const cellId of acts.estateBuildCells) push({ type: 'BUILD_ESTATE', cellId });
  for (const npcKind of acts.bailableVillains) push({ type: 'BAIL_PRISONER', npcKind });
  for (const playerId of acts.dischargeablePatients) push({ type: 'DISCHARGE_PATIENT', targetPlayerId: playerId });
  if (acts.canSurrender && acts.revengeCandidates.length > 0) {
    push({ type: 'SURRENDER', revengeTargetId: acts.revengeCandidates[0]!.id });
  }
  // W1：卡片 / 道具的目标参数不再是「由 UI 现场收集、这里只能验个空壳」——
  // 合法性与候选同出一个谓词，所以能凑出一套**真的能派单**的动作，`executable` 第一次是真的。
  // 某一维度确实没有候选时（例如拆除卡此刻既无建筑也无道具）保留 false：那种卡本来就不该被列进可用。
  for (const cardId of acts.usableCards) {
    const filled = withCandidateTargets({ type: 'USE_CARD', cardId }, state, me, CARDS[cardId]!.targetSpec);
    push(filled.action, filled.executable);
  }
  for (const itemId of acts.usableItems) {
    const filled = withCandidateTargets({ type: 'USE_ITEM', itemId }, state, me, ITEMS[itemId]!.targetSpec);
    push(filled.action, filled.executable);
  }
  // ECON-13：拍卖的三个动作 —— 竞买人不是 currentPlayer，actor 由注册表自己取（W3 新增 GIVE UP）
  if (acts.auction) {
    const bid: PlayerAction = { type: 'AUCTION_BID', amount: acts.auctionMinBid };
    if (actionRefusal(state, bid) === null) push(bid);
    if (acts.canAuctionPass) push({ type: 'AUCTION_PASS' });
    if (acts.canAuctionGiveUp) push({ type: 'AUCTION_GIVE_UP' });
  }
  return out;
}

function assertGatesHonest(state: GameState, label: string): void {
  const me = state.players[state.currentPlayerIndex];
  if (!me) return;
  const acts = availableActions(state);
  for (const { action, executable } of obligations(state, acts, me)) {
    const refusal = actionRefusal(state, action);
    expect(refusal, `${label}：门控把 ${action.type} 列为可用，引擎却拒绝（${refusal}）`).toBeNull();
    if (!executable) continue;
    expect(() => applyAction(state, action), `${label}：门控放行 ${action.type}，执行却抛错`).not.toThrow();
  }
}

/** 反方向也要成立：门控说不行，引擎必须真的不行（否则 UI 少给了玩家一个合法选择） */
function assertNoHiddenCapability(state: GameState, label: string): void {
  const me = state.players[state.currentPlayerIndex];
  if (!me) return;
  const acts = availableActions(state);
  const cell = state.board[me.position]!;
  const pairs: Array<[boolean, PlayerAction]> = [
    [acts.canRoll, { type: 'ROLL_DICE' }],
    [acts.canBuy, { type: 'BUY_LAND' }],
    [acts.canUpgrade, { type: 'UPGRADE_LAND' }],
    [acts.canFinishLanding, { type: 'FINISH_LANDING' }],
    [acts.canBuyLottery, { type: 'BUY_LOTTERY_TICKET', number: 0 }],
    [acts.canLoan, { type: 'TAKE_LOAN', amount: 1 }],
    [acts.canDeposit, { type: 'DEPOSIT', amount: 1 }],
    [acts.canWithdraw, { type: 'WITHDRAW', amount: 1 }],
    [acts.canBuyShares, { type: 'BUY_SHARES', cellId: cell.id, quantity: 1 }],
    [acts.canFinancing, { type: 'SPECIAL_FINANCING', amount: 1 }],
  ];
  if (acts.auction) {
    pairs.push(
      [acts.canAuctionPass, { type: 'AUCTION_PASS' }],
      [acts.canAuctionGiveUp, { type: 'AUCTION_GIVE_UP' }],
    );
  }
  for (const [flag, action] of pairs) {
    expect(flag, `${label}：${action.type} 的门控与引擎判断不一致`).toBe(actionRefusal(state, action) === null);
  }
}

function newGame(playerCount = 2): GameState {
  const game = createGame(GOLDEN_PLAYERS.slice(0, playerCount), 20260105, { startDate: { ...MONDAY } });
  return applyAction(game, { type: 'START_GAME' });
}

/** 取一块指定格型的格子；`landOnly` 用于可买卖的格（住宅 / 商业），要求有标价 */
function cellOf(state: GameState, type: BoardCell['type'], wantOwned: boolean, landOnly = false): BoardCell {
  const me = state.players[state.currentPlayerIndex]!;
  const ownedIds = new Set(me.properties.map((p) => p.cellId));
  const candidates = state.board.filter((c) => c.type === type && (!landOnly || c.price !== undefined));
  expect(candidates.length, `棋盘上应有${type}格`).toBeGreaterThan(0);
  if (wantOwned) return candidates.find((c) => ownedIds.has(c.id)) ?? candidates[0]!;
  return (
    candidates.find((c) => !ownedIds.has(c.id) && !state.players.some((q) => q.properties.some((p) => p.cellId === c.id))) ??
    candidates[0]!
  );
}

/**
 * 搭一个「当前玩家站在指定格上、处于决策相位」的局面。
 * `own: true` 表示该格必须归当前玩家（缺地时直接挂一块，测试只关心门控判断）。
 */
/**
 * 设定当前玩家现金后**重新冻结物价指数**。
 * 物价指数的分子含现金本身，直接改现金会让指数漂移，边界断言（差 1 元）因此失准。
 */
function withCash(state: GameState, cash: number): GameState {
  const next = structuredClone(state);
  next.players[next.currentPlayerIndex]!.cash = cash;
  return pinIndexOne(next);
}

function standOn(state: GameState, type: BoardCell['type'], opts: { own?: boolean; cash?: number; landOnly?: boolean } = {}): GameState {
  const next = structuredClone(state);
  next.phase = 'awaiting_action';
  const me = next.players[next.currentPlayerIndex]!;
  const cell = cellOf(next, type, opts.own === true, opts.landOnly !== false);
  if (opts.own && !me.properties.some((p) => p.cellId === cell.id)) {
    me.properties.push({ cellId: cell.id, grade: 1 });
  }
  me.position = cell.id;
  if (opts.cash !== undefined) me.cash = opts.cash;
  return pinIndexOne(next);
}

function attachGod(state: GameState, godId: string): GameState {
  const next = structuredClone(state);
  next.players[next.currentPlayerIndex]!.god = { godId, remainingDays: 3 };
  return next;
}

describe('门控与引擎同源（遍历 bot 对跑的中局状态）', () => {
  for (const seed of [20260105, 31337]) {
    it(`seed=${seed}：不出现「门控可点、引擎报错」，也不出现「门控锁死、引擎其实允许」`, () => {
      const run = runGoldenMatch({ seed, maxTurns: 45, sampleEvery: 50, collectStates: true });
      expect(run.states.length).toBeGreaterThan(20);
      for (const [i, state] of run.states.entries()) {
        if (i % 2) continue; // 相邻状态高度相似，隔步取样即可
        assertGatesHonest(state, `seed=${seed} 第 ${i} 步`);
        assertNoHiddenCapability(state, `seed=${seed} 第 ${i} 步`);
      }
    });
  }
});

describe('门控与引擎同源（边界局面逐条钉死）', () => {
  it('衰神附身 ⇒ 买地按钮消失（旧实现：canBuy 仍为真，点下去报「买地流拍」）', () => {
    const rich = standOn(newGame(), 'property', { cash: 50000 });
    expect(availableActions(rich).canBuy).toBe(true);
    const cursed = attachGod(rich, 'big-misfortune');
    expect(availableActions(cursed).canBuy).toBe(false);
    expect(actionRefusal(cursed, { type: 'BUY_LAND' })).toBe('衰神附身，买地流拍');
  });

  it('衰神附身 ⇒ 升级按钮消失（旧实现：canUpgrade 仍为真，点下去报「投资失败」）', () => {
    const rich = standOn(newGame(), 'property', { own: true, cash: 50000 });
    expect(availableActions(rich).canUpgrade).toBe(true);
    const cursed = attachGod(rich, 'small-misfortune');
    expect(availableActions(cursed).canUpgrade).toBe(false);
  });

  it('买价跟随公定地价（含路段调价因子），门控不会按裸标价放行', () => {
    // 历史 bug：门控按 landPrice 判断而引擎按另一个价（商业地 ×1.5）收钱。
    // W1 取消溢价后两者同源，这里改用「公告地价调涨」来钉住同源性：
    // 成交价一旦随路段因子上涨，门控必须跟着变严，不能还按旧标价放行。
    const g = standOn(newGame(), 'property');
    const cell = g.board[g.players[g.currentPlayerIndex]!.position]!;
    expect(cell.street, '前提：住宅格属于某个路段').toBeTruthy();
    const base = landPrice(g, cell);
    const bumped = structuredClone(g);
    bumped.streetPriceFactors[cell.street!] = (bumped.streetPriceFactors[cell.street!] ?? 1) * 1.5;
    const price = landPrice(bumped, cell);
    expect(price).toBeGreaterThan(base);
    expect(availableActions(withCash(bumped, price - 1)).canBuy).toBe(false);
    const exact = withCash(bumped, price);
    expect(availableActions(exact).canBuy).toBe(true);
    expect(() => applyAction(exact, { type: 'BUY_LAND' })).not.toThrow();
  });

  it('大福神一次加盖两层 ⇒ 按两层成本判定（旧实现只按一层成本判定，点下去现金不足）', () => {
    const base = standOn(newGame(), 'property', { own: true });
    const cell = base.board[base.players[base.currentPlayerIndex]!.position]!;
    const oneLevel = landUpgradeCost(base, cell, 1);
    const twoLevels = oneLevel + landUpgradeCost(base, cell, 2);
    const blessed = attachGod(base, 'big-fortune');
    expect(twoLevels).toBeGreaterThan(oneLevel); // 前提：加倍投资确实更贵
    expect(availableActions(withCash(blessed, oneLevel + 1)).canUpgrade).toBe(false);
    const enough = withCash(blessed, twoLevels);
    expect(availableActions(enough).canUpgrade).toBe(true);
    expect(() => applyAction(enough, { type: 'UPGRADE_LAND' })).not.toThrow();
  });

  it('梦游中丧失买地权利', () => {
    const g = standOn(newGame(), 'property', { cash: 50000 });
    g.players[g.currentPlayerIndex]!.sleepwalkTurns = 3;
    expect(availableActions(g).canBuy).toBe(false);
  });

  it('例假日银行休市 ⇒ 存取款与贷款全部消失', () => {
    const g = standOn(newGame(), 'bank', { cash: 50000, landOnly: false });
    const me = g.players[g.currentPlayerIndex]!;
    me.deposit = 50000;
    g.bankAccess = { canDeposit: true, canLoan: true, cellId: me.position };
    expect(availableActions(g).canDeposit).toBe(true);
    const sunday = structuredClone(g);
    sunday.calendar.elapsedDays = 6; // 起始 2026-01-05 是周一，+6 → 周日
    const acts = availableActions(sunday);
    expect(acts.isHoliday).toBe(true);
    expect(acts.canDeposit).toBe(false);
    expect(acts.canWithdraw).toBe(false);
    expect(acts.canLoan).toBe(false);
  });

  it('自动触发卡与未知卡 id 都不进入可用手牌（旧实现只看时机）', () => {
    const autoCard = Object.entries(CARDS).find(([, def]) => def.auto);
    expect(autoCard, '前提：存在自动触发卡片').toBeTruthy();
    const state = structuredClone(newGame());
    state.phase = 'awaiting_action';
    const me = state.players[state.currentPlayerIndex]!;
    me.cards.push(autoCard![0]);
    const acts = availableActions(state);
    expect(acts.usableCards).not.toContain(autoCard![0]);
    expect(actionRefusal(state, { type: 'USE_CARD', cardId: 'no-such-card' })).toBe('未知卡片');
    expect(actionRefusal(state, { type: 'USE_CARD', cardId: autoCard![0] })).toBe('该卡片为自动触发，不能主动使用');
  });

  it('保释名单按**点券**过滤（D-50：旧实现按现金，改成点券后这条同源性质必须跟着换钱包）', () => {
    const broke = standOn(newGame(), 'jail', { cash: 0, landOnly: false });
    broke.players[broke.currentPlayerIndex]!.points = 0;
    expect(broke.npcs.some((n) => n.jailed)).toBe(true);
    expect(availableActions(broke).bailableVillains).toEqual([]);
    const rich = structuredClone(broke);
    // 现金再多也不顶用：两套账不许互相支付
    rich.players[rich.currentPlayerIndex]!.cash = 200000;
    expect(availableActions(rich).bailableVillains).toEqual([]);
    rich.players[rich.currentPlayerIndex]!.points = BAIL_FEE;
    expect(availableActions(rich).bailableVillains.length).toBeGreaterThan(0);
  });

  it('canShop 只表示「站在商店」；能否真买由各自动作自己判定', () => {
    const g = standOn(newGame(), 'shop', { cash: 50000, landOnly: false });
    const me = g.players[g.currentPlayerIndex]!;
    me.points = 0;
    expect(availableActions(g).canShop).toBe(true);
    expect(actionRefusal(g, { type: 'BUY_CARD', cardId: 'even-all' })).toBe('点券不足');
    me.points = 9999;
    expect(actionRefusal(g, { type: 'BUY_CARD', cardId: 'even-all' })).toBeNull();
    expect(actionRefusal(g, { type: 'SELL_CARD', cardId: 'hold' })).toBe('没有这张卡片');
  });

  it('可用道具清单里的每一件都有效果体且真能用', () => {
    const state = structuredClone(newGame());
    state.phase = 'awaiting_roll'; // R4：道具清单只在掷骰前那一段有意义
    const me = state.players[state.currentPlayerIndex]!;
    me.items = Object.fromEntries(Object.keys(ITEMS).map((id) => [id, 1]));
    const acts = availableActions(state);
    expect(acts.usableItems.length).toBeGreaterThan(0);
    for (const itemId of acts.usableItems) {
      expect(ITEMS[itemId]!.apply, `${itemId} 列在可用道具里却没有效果体`).toBeTruthy();
      expect(actionRefusal(state, { type: 'USE_ITEM', itemId })).toBeNull();
    }
  });

  it('可建设施清单受现金与衰神双重约束', () => {
    const g = standOn(newGame(), 'commercial', { own: true, cash: 500000 });
    const acts = availableActions(g);
    expect(acts.buildableFacilities.length).toBeGreaterThan(0);
    for (const facility of acts.buildableFacilities) {
      expect(FACILITIES[facility]).toBeTruthy();
      expect(actionRefusal(g, { type: 'BUILD_FACILITY', facility })).toBeNull();
    }
    expect(availableActions(attachGod(g, 'big-misfortune')).buildableFacilities).toEqual([]);
  });
});

describe('停留锁：在押 / 住院期间一律无法操作，回合自动跳过', () => {
  /** 把当前玩家判进牢里并押到监狱格（字段口径与 `imposeCustody` 一致） */
  function jailed(state: GameState): GameState {
    const next = structuredClone(state);
    const p = next.players[next.currentPlayerIndex]!;
    p.skipTurns = 3;
    p.custody = { kind: 'jail', daysLeft: 3 };
    p.cards = ['tax-audit'];
    p.items = { teleporter: 1 };
    p.position = next.board.find((c) => c.type === 'jail')!.id;
    return next;
  }

  it('买地 / 用卡 / 用道具 / 存取款全被拒，掷骰与离窗仍然放行', () => {
    const s = jailed(withCash(newGame(), 200_000));
    expect(actionRefusal(s, { type: 'BUY_LAND' })).toContain('在押中无法操作');
    expect(actionRefusal(s, { type: 'USE_CARD', cardId: 'tax-audit' })).toContain('在押中无法操作');
    expect(actionRefusal(s, { type: 'USE_ITEM', itemId: 'teleporter' })).toContain('在押中无法操作');
    expect(actionRefusal(s, { type: 'DEPOSIT', amount: 100 })).toContain('在押中无法操作');
    expect(actionRefusal(s, { type: 'BUY_STOCK', stockId: 'media', quantity: 1 })).toContain('在押中无法操作');
    // 放行清单：自动跳过要发的那一颗 + 落格窗的逃生门（这句拒绝来自相位，不来自停留锁）
    expect(actionRefusal(s, { type: 'ROLL_DICE' })).toBeNull();
    expect(actionRefusal(s, { type: 'FINISH_LANDING' })).toBe('当前不在落格决策中');
  });

  it('门控与锁同源：可用位一律落下来，不出现「面板说能买、引擎说不让买」', () => {
    const acts = availableActions(jailed(withCash(newGame(), 200_000)));
    expect(acts.canRoll).toBe(true);
    expect(acts.canBuy).toBe(false);
    expect(acts.canShop).toBe(false);
    expect(acts.canTradeStock).toBe(false);
    expect(acts.canDeposit).toBe(false);
    expect(acts.canWithdraw).toBe(false);
    expect(acts.canLoan).toBe(false);
    expect(acts.usableCards).toEqual([]);
    expect(acts.usableItems).toEqual([]);
    expect(acts.researchableItems).toEqual([]);
  });

  it('门外代办不被锁：踩医院格的人也还能替别人办出院', () => {
    const s = jailed(newGame());
    const me = s.players[s.currentPlayerIndex]!;
    const other = s.players.find((p) => p.id !== me.id)!;
    other.custody = { kind: 'hospital', daysLeft: 3 };
    other.skipTurns = 3;
    other.position = s.board.find((c) => c.type === 'hospital')!.id;
    // 自己也住院：站在医院格门外，窗里唯一能做的事就是替别人办出院
    me.custody = { kind: 'hospital', daysLeft: 1 };
    me.skipTurns = 1;
    me.position = other.position;
    me.cash = 200_000;
    s.phase = 'awaiting_action';
    s.landing = { cellId: me.position, venue: null, turn: s.turn };
    expect(actionRefusal(s, { type: 'DISCHARGE_PATIENT', targetPlayerId: other.id })).toBeNull();
    // 这一扇窗还有事可做，所以自动跳过不该把它替他关掉
    expect(autoSkipAction(s)).toBeNull();
  });

  it('自动跳过给出的那一步：掷骰阶段发骰子、空窗就关上，正常人回合不插手', () => {
    expect(autoSkipAction(jailed(newGame()))).toEqual({ type: 'ROLL_DICE' });
    const window = structuredClone(jailed(newGame()));
    window.phase = 'awaiting_action';
    window.landing = null;
    expect(autoSkipAction(window)).toEqual({ type: 'FINISH_LANDING' });
    expect(autoSkipAction(newGame())).toBeNull();
  });

  it('跳过的一手不掷骰、不进落格，只留一条播报', () => {
    const s = jailed(newGame());
    const before = s.players[s.currentPlayerIndex]!;
    const next = applyAction(s, autoSkipAction(s)!);
    const after = next.players.find((p) => p.id === before.id)!;
    expect(after.skipTurns).toBe(2);
    expect(after.position).toBe(before.position);
    expect(next.dice).toBeNull();
    expect(next.turn).toBe(s.turn + 1);
    expect(next.log.some((l) => l.text.includes('在押中，无法操作，本回合自动跳过（剩余 2 回合）'))).toBe(true);
  });

  it('牢底那一手不再自称「无法操作」：只报刑满释放', () => {
    const s = jailed(newGame());
    const me = s.players[s.currentPlayerIndex]!;
    me.skipTurns = 1;
    me.custody = { kind: 'jail', daysLeft: 1 };
    const next = applyAction(s, { type: 'ROLL_DICE' });
    const after = next.players.find((p) => p.id === me.id)!;
    expect(after.custody).toBeNull();
    expect(next.log.some((l) => l.text.includes('刑满释放'))).toBe(true);
    // 人已经自由了，再跟一句「在押中，无法操作」就是自相矛盾
    expect(next.log.some((l) => l.text.includes('无法操作'))).toBe(false);
  });
});
