import { BOARD_SIZE, DEFAULT_BOARD, GODS, MAX_HAND_CARDS, PASS_START_SALARY, STARTING_CASH, STOCK_DEFS } from './board.js';
import { CARDS, CHANCE_CARD_POOL, SHOP_CARD_IDS } from './cards.js';
import { nextRandom, rollDie } from './rng.js';
import type { AvailableActions, BoardCell, GameState, Player, PlayerAction, PlayerDef, PlayerProperty } from './types.js';

export function createGame(players: PlayerDef[], seed = Date.now() % 2147483647): GameState {
  if (players.length > 4) {
    throw new Error('游戏最多 4 名玩家');
  }
  return {
    players: players.map((p) => ({
      ...p,
      cash: STARTING_CASH,
      position: 0,
      properties: [],
      cards: [],
      stocks: {},
      god: null,
      skipTurns: 0,
      bankrupt: false,
      online: true,
    })),
    board: structuredClone(DEFAULT_BOARD),
    currentPlayerIndex: 0,
    phase: 'lobby',
    dice: null,
    turn: 0,
    round: 1,
    rngState: seed >>> 0,
    log: [{ turn: 0, text: '游戏房间已创建' }],
    winnerId: null,
    stockMarket: {
      stocks: STOCK_DEFS.map((s) => ({ id: s.id, name: s.name, price: s.initialPrice, lastChangePct: 0 })),
    },
    pendingFixedDice: null,
  };
}

function clone(state: GameState): GameState {
  return structuredClone(state);
}

/** 房间阶段加入玩家（纯函数） */
export function addPlayer(state: GameState, def: PlayerDef): GameState {
  if (state.phase !== 'lobby') throw new Error('游戏已开始，无法加入');
  if (state.players.length >= 4) throw new Error('房间已满');
  if (state.players.some((p) => p.id === def.id)) throw new Error('玩家已存在');
  const next = clone(state);
  next.players.push({
    ...def,
    cash: STARTING_CASH,
    position: 0,
    properties: [],
    cards: [],
    stocks: {},
    god: null,
    skipTurns: 0,
    bankrupt: false,
    online: true,
  });
  log(next, `${def.name} 加入了房间`);
  return next;
}

/** 房间阶段移除玩家（纯函数） */
export function removePlayer(state: GameState, id: string): GameState {
  if (state.phase !== 'lobby') throw new Error('游戏已开始，无法移除');
  const next = clone(state);
  const idx = next.players.findIndex((p) => p.id === id);
  if (idx < 0) return next;
  const name = next.players[idx]!.name;
  next.players.splice(idx, 1);
  log(next, `${name} 离开了房间`);
  return next;
}

function log(state: GameState, text: string): void {
  state.log.push({ turn: state.turn, text });
  if (state.log.length > 200) state.log.splice(0, state.log.length - 200);
}

function isGameOver(s: GameState): boolean {
  return s.phase === 'game_over';
}

function currentPlayer(state: GameState): Player {
  const p = state.players[state.currentPlayerIndex];
  if (!p) throw new Error('当前玩家不存在');
  return p;
}

function cellOwner(state: GameState, cellId: number): { player: Player; property: PlayerProperty } | undefined {
  for (const player of state.players) {
    const prop = player.properties.find((q) => q.cellId === cellId);
    if (prop) return { player, property: prop };
  }
  return undefined;
}

function stockById(state: GameState, stockId: string) {
  return state.stockMarket.stocks.find((s) => s.id === stockId);
}

export function rentOf(baseRent: number, grade: number): number {
  return baseRent * grade;
}

export function upgradeCost(price: number, grade: number): number {
  return grade === 1 ? Math.round(price * 0.6) : Math.round(price * 0.8);
}

function checkWinner(state: GameState): void {
  const active = state.players.filter((p) => !p.bankrupt);
  if (active.length === 1) {
    state.winnerId = active[0]!.id;
    state.phase = 'game_over';
    log(state, `${active[0]!.name} 获得最终胜利！`);
  }
}

function bankruptPlayer(state: GameState, p: Player): void {
  p.bankrupt = true;
  p.cash = 0;
  p.skipTurns = 0;
  p.properties = [];
  p.cards = [];
  p.stocks = {};
  p.god = null;
  log(state, `${p.name} 破产出局，名下资产被银行没收`);
}

/** 资产变卖：优先卖股票，再降级地产，最后出售地产，直到凑够金额 */
function liquidateFor(state: GameState, p: Player, needed: number): void {
  // 1. 变卖全部股票
  for (const [stockId, qty] of Object.entries(p.stocks)) {
    if (qty > 0 && p.cash < needed) {
      const stock = stockById(state, stockId);
      if (!stock) continue;
      p.cash += stock.price * qty;
      delete p.stocks[stockId];
      log(state, `${p.name} 变卖 ${stock.name} ×${qty}，回收 ¥${stock.price * qty}`);
    }
  }

  // 2. 降级最高等级地产（回收对应升级成本的一半）
  while (p.cash < needed) {
    const candidates = p.properties.filter((q) => q.grade > 1);
    if (!candidates.length) break;
    const target = candidates.reduce((best, q) => {
      const cellB = state.board[q.cellId]!;
      const cellBest = state.board[best.cellId]!;
      const valueB = q.grade * 1000 + (cellB.price ?? 0);
      const valueBest = best.grade * 1000 + (cellBest.price ?? 0);
      return valueB > valueBest ? q : best;
    });
    const cell = state.board[target.cellId]!;
    const recovery = Math.round(upgradeCost(cell.price ?? 0, target.grade - 1) / 2);
    target.grade = (target.grade - 1) as 1 | 2 | 3;
    p.cash += recovery;
    log(state, `${p.name} 将「${cell.name}」降级为 ${target.grade} 级，回收 ¥${recovery}`);
  }

  // 3. 出售最便宜地产（回收买价一半）
  while (p.cash < needed) {
    if (!p.properties.length) break;
    const target = p.properties.reduce((cheapest, q) => {
      const cellQ = state.board[q.cellId]!;
      const cellC = state.board[cheapest.cellId]!;
      return (cellQ.price ?? 0) < (cellC.price ?? 0) ? q : cheapest;
    });
    const cell = state.board[target.cellId]!;
    const recovery = Math.round((cell.price ?? 0) / 2);
    p.properties = p.properties.filter((q) => q !== target);
    p.cash += recovery;
    log(state, `${p.name} 以 ¥${recovery} 出售「${cell.name}」`);
  }
}

function payCash(state: GameState, from: Player, amount: number, to: Player | null): void {
  if (amount <= 0) return;
  if (from.cash < amount) {
    liquidateFor(state, from, amount);
  }
  if (from.cash >= amount) {
    from.cash -= amount;
    if (to) to.cash += amount;
  } else {
    const paid = from.cash;
    if (to) to.cash += paid;
    log(state, `${from.name} 变卖全部资产后仍不足，只能支付 ¥${paid}`);
    bankruptPlayer(state, from);
    checkWinner(state);
  }
}

/** 股票市场回合波动 + 随机新闻 */
function tickStockMarket(state: GameState): void {
  for (const stock of state.stockMarket.stocks) {
    const draw = nextRandom(state.rngState);
    state.rngState = draw.nextState;
    const pct = Math.round(draw.value * 20 - 10); // -10% ~ +10%
    const next = Math.max(5, Math.round(stock.price * (1 + pct / 100)));
    stock.lastChangePct = pct + Math.round(((next - stock.price) / Math.max(stock.price, 1)) * 100) - pct;
    stock.price = next;
  }
  // 新闻事件：随机一支股票额外 ±15%
  const newsDraw = nextRandom(state.rngState);
  state.rngState = newsDraw.nextState;
  const stock = state.stockMarket.stocks[Math.floor(newsDraw.value * state.stockMarket.stocks.length)]!;
  const signDraw = nextRandom(state.rngState);
  state.rngState = signDraw.nextState;
  const up = signDraw.value < 0.5;
  const pct = up ? 15 : -15;
  stock.price = Math.max(5, Math.round(stock.price * (1 + pct / 100)));
  stock.lastChangePct = pct;
  const newsText = up
    ? `【新闻】${stock.name} 业绩超预期，大涨 15%！`
    : `【新闻】${stock.name} 被曝财务问题，暴跌 15%！`;
  log(state, newsText);
}

function advanceTurn(state: GameState): void {
  if (isGameOver(state)) return;
  const before = state.currentPlayerIndex;
  const n = state.players.length;
  for (let step = 1; step <= n; step++) {
    const idx = (state.currentPlayerIndex + step) % n;
    const p = state.players[idx]!;
    if (!p.bankrupt) {
      state.currentPlayerIndex = idx;
      break;
    }
  }
  state.turn += 1;
  if (state.currentPlayerIndex < before) {
    state.round += 1;
    tickStockMarket(state);
  }
  state.dice = null;
  state.phase = 'awaiting_roll';
}

function cellAt(state: GameState, position: number): BoardCell {
  const c = state.board[position]!;
  return c;
}

/** 随机召唤神仙附身 */
function summonGod(state: GameState, p: Player): void {
  const draw = nextRandom(state.rngState);
  state.rngState = draw.nextState;
  const god = GODS[Math.floor(draw.value * GODS.length)]!;
  p.god = { godId: god.id, remainingTurns: god.durationTurns };
  log(state, `${god.name} 附身 ${p.name}！${god.description}（持续 ${god.durationTurns} 回合）`);
}

/** 回合开始时结算神仙效果 */
function applyGodEffect(state: GameState, p: Player): void {
  const god = p.god;
  if (!god) return;
  const def = GODS.find((g) => g.id === god.godId);
  if (def?.id === 'wealth') {
    p.cash += 800;
    log(state, `财神保佑，${p.name} 获得 ¥800`);
  } else if (def?.id === 'poverty') {
    log(state, `穷神作祟，${p.name} 损失 ¥400`);
    payCash(state, p, 400, null);
  } else if (def?.id === 'land') {
    const upgradable = p.properties.filter((q) => q.grade < 3);
    if (upgradable.length > 0) {
      const draw = nextRandom(state.rngState);
      state.rngState = draw.nextState;
      const prop = upgradable[Math.floor(draw.value * upgradable.length)]!;
      prop.grade = (prop.grade + 1) as 1 | 2 | 3;
      const cell = state.board[prop.cellId]!;
      log(state, `土地公显灵，「${cell.name}」免费升级为 ${prop.grade} 级`);
    }
  }
  god.remainingTurns -= 1;
  if (god.remainingTurns <= 0) {
    p.god = null;
    log(state, `${def?.name ?? '神仙'} 离开了 ${p.name}`);
  }
}

/** 机会格抽卡 */
function drawChanceCard(state: GameState, p: Player): void {
  if (p.cards.length >= MAX_HAND_CARDS) {
    p.cash += 300;
    log(state, `${p.name} 手牌已满，获得现金补偿 ¥300`);
    return;
  }
  const draw = nextRandom(state.rngState);
  state.rngState = draw.nextState;
  const cardId = CHANCE_CARD_POOL[Math.floor(draw.value * CHANCE_CARD_POOL.length)]!;
  p.cards.push(cardId);
  log(state, `${p.name} 抽到卡片「${CARDS[cardId]!.name}」`);
}

/** 玩家最值钱的地产 */
function mostValuableProperty(state: GameState, p: Player): PlayerProperty | undefined {
  if (!p.properties.length) return undefined;
  return p.properties.reduce((best, q) => {
    const cellQ = state.board[q.cellId]!;
    const cellBest = state.board[best.cellId]!;
    const valueQ = q.grade * 1000 + (cellQ.price ?? 0);
    const valueBest = best.grade * 1000 + (cellBest.price ?? 0);
    return valueQ > valueBest ? q : best;
  });
}

export function availableActions(state: GameState): AvailableActions {
  if (state.phase === 'awaiting_roll' || state.phase === 'awaiting_action') {
    const p = currentPlayer(state);
    const c = cellAt(state, p.position);
    const owned = cellOwner(state, c.id);
    let canBuy = false;
    let canUpgrade = false;
    if (state.phase === 'awaiting_action' && c.type === 'property' && c.price !== undefined) {
      if (!owned && p.cash >= c.price) canBuy = true;
      if (owned?.player.id === p.id && owned.property.grade < 3 && p.cash >= upgradeCost(c.price, owned.property.grade)) {
        canUpgrade = true;
      }
    }
    const usableCards = p.cards.filter((cardId) => {
      const card = CARDS[cardId];
      if (!card) return false;
      if (card.phase === 'any') return true;
      if (card.phase === 'pre_roll') return state.phase === 'awaiting_roll';
      return state.phase === 'awaiting_action';
    });
    return {
      canRoll: state.phase === 'awaiting_roll',
      canBuy,
      canUpgrade,
      canEnd: state.phase === 'awaiting_action',
      canShop: state.phase === 'awaiting_action' && c.type === 'shop',
      canTradeStock: state.phase === 'awaiting_action' && c.type === 'bank',
      usableCards,
    };
  }
  return { canRoll: false, canBuy: false, canUpgrade: false, canEnd: false, canShop: false, canTradeStock: false, usableCards: [] };
}

function startGame(state: GameState): void {
  if (state.phase !== 'lobby') throw new Error('游戏已经开始');
  if (state.players.length < 2) throw new Error('至少需要 2 名玩家才能开始');
  state.phase = 'awaiting_roll';
  state.turn = 1;
  log(state, '游戏开始！');
}

function rollDice(state: GameState): void {
  if (state.phase !== 'awaiting_roll') throw new Error('当前不能掷骰');
  const p = currentPlayer(state);

  // 回合开始：神仙效果
  applyGodEffect(state, p);
  if (p.bankrupt) {
    if (!isGameOver(state)) advanceTurn(state);
    return;
  }

  if (p.skipTurns > 0) {
    p.skipTurns -= 1;
    log(state, `${p.name} 停留中，剩余 ${p.skipTurns} 回合`);
    advanceTurn(state);
    return;
  }

  let d1: number;
  if (state.pendingFixedDice !== null) {
    d1 = state.pendingFixedDice;
    log(state, `遥控骰子生效：第一颗骰子固定为 ${d1} 点`);
    state.pendingFixedDice = null;
  } else {
    const r1 = rollDie(state.rngState);
    state.rngState = r1.nextState;
    d1 = r1.value;
  }
  const r2 = rollDie(state.rngState);
  state.rngState = r2.nextState;
  state.dice = [d1 as 1 | 2 | 3 | 4 | 5 | 6, r2.value];
  const steps = d1 + r2.value;
  log(state, `${p.name} 掷出 ${d1} + ${r2.value} = ${steps} 点`);

  const oldPos = p.position;
  const newPos = (oldPos + steps) % BOARD_SIZE;
  if (oldPos + steps >= BOARD_SIZE) {
    p.cash += PASS_START_SALARY;
    log(state, `${p.name} 经过起点，领取薪水 ¥${PASS_START_SALARY}`);
  }
  p.position = newPos;

  const c = cellAt(state, newPos);

  if (c.type === 'start') {
    log(state, `${p.name} 正好停在起点`);
    advanceTurn(state);
    return;
  }

  if (c.type === 'neutral') {
    log(state, `${p.name} 在${c.name}休息了一会`);
    advanceTurn(state);
    return;
  }

  if (c.type === 'chance') {
    drawChanceCard(state, p);
    advanceTurn(state);
    return;
  }

  if (c.type === 'tax') {
    const tax = Math.floor(p.cash * 0.1);
    log(state, `${p.name} 需缴税 ¥${tax}`);
    payCash(state, p, tax, null);
    if (isGameOver(state)) return;
    advanceTurn(state);
    return;
  }

  if (c.type === 'hospital') {
    p.skipTurns = 1;
    log(state, `${p.name} 住院休养，下回合暂停`);
    advanceTurn(state);
    return;
  }

  if (c.type === 'jail') {
    p.skipTurns = 2;
    log(state, `${p.name} 被关进监狱，暂停 2 回合`);
    advanceTurn(state);
    return;
  }

  if (c.type === 'shop') {
    state.phase = 'awaiting_action';
    log(state, `${p.name} 来到${c.name}，可以购买卡片道具`);
    return;
  }

  if (c.type === 'bank') {
    state.phase = 'awaiting_action';
    log(state, `${p.name} 来到${c.name}，可以买卖股票`);
    return;
  }

  if (c.type === 'god') {
    log(state, `${p.name} 进入神庙祈福`);
    summonGod(state, p);
    advanceTurn(state);
    return;
  }

  // property
  if (c.type === 'property' && c.price !== undefined && c.baseRent !== undefined) {
    const owned = cellOwner(state, c.id);
    if (!owned) {
      state.phase = 'awaiting_action';
      log(state, `${p.name} 来到无主地产「${c.name}」（售价 ¥${c.price}）`);
      return;
    }
    if (owned.player.id === p.id) {
      if (owned.property.grade < 3) {
        state.phase = 'awaiting_action';
        log(state, `${p.name} 回到自家「${c.name}」（${owned.property.grade} 级）`);
      } else {
        log(state, `${p.name} 回到满级地产「${c.name}」`);
        advanceTurn(state);
      }
      return;
    }
    const rent = rentOf(c.baseRent, owned.property.grade);
    log(state, `${p.name} 进入 ${owned.player.name} 的「${c.name}」，需付租金 ¥${rent}`);
    payCash(state, p, rent, owned.player);
    if (isGameOver(state)) return;
    advanceTurn(state);
    return;
  }

  throw new Error(`未知格类型: ${c.type}`);
}

function buyLand(state: GameState): void {
  if (state.phase !== 'awaiting_action') throw new Error('当前不能购买地产');
  const p = currentPlayer(state);
  const c = cellAt(state, p.position);
  if (c.type !== 'property' || c.price === undefined) throw new Error('此格不可购买');
  if (cellOwner(state, c.id)) throw new Error('该地产已有主人');
  if (p.cash < c.price) throw new Error('现金不足');
  p.cash -= c.price;
  p.properties.push({ cellId: c.id, grade: 1 });
  log(state, `${p.name} 以 ¥${c.price} 购入「${c.name}」`);
  advanceTurn(state);
}

function upgradeLand(state: GameState): void {
  if (state.phase !== 'awaiting_action') throw new Error('当前不能升级地产');
  const p = currentPlayer(state);
  const c = cellAt(state, p.position);
  if (c.type !== 'property' || c.price === undefined) throw new Error('此格不可升级');
  const owned = cellOwner(state, c.id);
  if (!owned || owned.player.id !== p.id) throw new Error('只能升级自己的地产');
  if (owned.property.grade >= 3) throw new Error('地产已满级');
  const cost = upgradeCost(c.price, owned.property.grade);
  if (p.cash < cost) throw new Error('现金不足');
  p.cash -= cost;
  owned.property.grade = (owned.property.grade + 1) as 1 | 2 | 3;
  const levelName = owned.property.grade === 2 ? '小屋' : '大厦';
  log(state, `${p.name} 花费 ¥${cost} 将「${c.name}」升级为${levelName}（${owned.property.grade} 级）`);
  advanceTurn(state);
}

function endTurn(state: GameState): void {
  if (state.phase !== 'awaiting_action') throw new Error('当前不能结束回合');
  const p = currentPlayer(state);
  log(state, `${p.name} 选择不操作，结束回合`);
  advanceTurn(state);
}

function useCard(state: GameState, action: Extract<PlayerAction, { type: 'USE_CARD' }>): void {
  const p = currentPlayer(state);
  const card = CARDS[action.cardId];
  if (!card) throw new Error('未知卡片');
  if (!p.cards.includes(card.id)) throw new Error('没有这张卡片');
  if (state.phase !== 'awaiting_roll' && state.phase !== 'awaiting_action') throw new Error('当前不能使用卡片');
  if (card.phase === 'pre_roll' && state.phase !== 'awaiting_roll') throw new Error('该卡片只能在掷骰前使用');
  if (card.phase === 'post_roll' && state.phase !== 'awaiting_action') throw new Error('该卡片只能在掷骰后使用');

  const consume = () => {
    p.cards = p.cards.filter((id) => id !== card.id);
  };

  switch (card.id) {
    case 'equalize': {
      const active = state.players.filter((q) => !q.bankrupt);
      const avg = Math.floor(active.reduce((sum, q) => sum + q.cash, 0) / active.length);
      for (const q of active) q.cash = avg;
      log(state, `${p.name} 使用「均富卡」，所有玩家现金变为 ¥${avg}`);
      break;
    }
    case 'swap': {
      const target = state.players.find((q) => q.id === action.targetPlayerId);
      if (!target || target.id === p.id || target.bankrupt) throw new Error('请选择有效的目标玩家');
      const mine = mostValuableProperty(state, p);
      const theirs = mostValuableProperty(state, target);
      if (!mine || !theirs) throw new Error('双方都需要至少一处地产');
      p.properties = p.properties.filter((q) => q !== mine).concat(theirs);
      target.properties = target.properties.filter((q) => q !== theirs).concat(mine);
      log(state, `${p.name} 使用「换屋卡」，与 ${target.name} 交换了最值钱的地产`);
      break;
    }
    case 'demolish': {
      const target = state.players.find((q) => q.id === action.targetPlayerId);
      if (!target || target.id === p.id || target.bankrupt) throw new Error('请选择有效的目标玩家');
      const candidates = target.properties.filter((q) => q.grade > 0);
      if (!candidates.length) throw new Error('目标没有地产');
      const target2 = candidates.reduce((best, q) => {
        const cellQ = state.board[q.cellId]!;
        const cellBest = state.board[best.cellId]!;
        const valueQ = q.grade * 1000 + (cellQ.price ?? 0);
        const valueBest = best.grade * 1000 + (cellBest.price ?? 0);
        return valueQ > valueBest ? q : best;
      });
      const cell = state.board[target2.cellId]!;
      if (target2.grade > 1) {
        target2.grade = (target2.grade - 1) as 1 | 2 | 3;
        log(state, `${p.name} 使用「拆屋卡」，${target.name} 的「${cell.name}」被降为 ${target2.grade} 级`);
      } else {
        target.properties = target.properties.filter((q) => q !== target2);
        log(state, `${p.name} 使用「拆屋卡」，${target.name} 的「${cell.name}」被夷为平地`);
      }
      break;
    }
    case 'remote-dice': {
      const v = action.diceValue;
      if (!v || v < 1 || v > 6) throw new Error('请指定 1-6 的骰子点数');
      state.pendingFixedDice = v;
      log(state, `${p.name} 使用「遥控骰子」，下一次第一颗骰子将掷出 ${v} 点`);
      break;
    }
    case 'seize': {
      const c = cellAt(state, p.position);
      if (c.type !== 'property') throw new Error('当前位置不是地产');
      const owned = cellOwner(state, c.id);
      if (owned?.player.id === p.id) throw new Error('这里已经是你的地产');
      if (owned) {
        owned.player.properties = owned.player.properties.filter((q) => q.cellId !== c.id);
        p.properties.push({ cellId: c.id, grade: owned.property.grade });
        log(state, `${p.name} 使用「强占卡」，夺取了 ${owned.player.name} 的「${c.name}」`);
      } else {
        p.properties.push({ cellId: c.id, grade: 1 });
        log(state, `${p.name} 使用「强占卡」，免费获得无主地产「${c.name}」`);
      }
      break;
    }
    case 'red-card':
    case 'black-card': {
      const stock = action.stockId ? stockById(state, action.stockId) : undefined;
      if (!stock) throw new Error('请选择有效的股票');
      const pct = card.id === 'red-card' ? 25 : -25;
      stock.price = Math.max(5, Math.round(stock.price * (1 + pct / 100)));
      stock.lastChangePct = pct;
      log(state, `${p.name} 使用「${card.name}」，${stock.name} 价格变为 ¥${stock.price}`);
      break;
    }
    case 'god-summon': {
      summonGod(state, p);
      break;
    }
    default:
      throw new Error('未知卡片效果');
  }
  consume();
}

function buyCard(state: GameState, action: Extract<PlayerAction, { type: 'BUY_CARD' }>): void {
  if (state.phase !== 'awaiting_action') throw new Error('当前不能购买卡片');
  const p = currentPlayer(state);
  if (cellAt(state, p.position).type !== 'shop') throw new Error('不在商店，不能购买卡片');
  const card = CARDS[action.cardId];
  if (!card || !SHOP_CARD_IDS.includes(card.id)) throw new Error('商店不出售这张卡片');
  if (p.cards.length >= MAX_HAND_CARDS) throw new Error('手牌已满');
  if (p.cash < card.cost) throw new Error('现金不足');
  p.cash -= card.cost;
  p.cards.push(card.id);
  log(state, `${p.name} 以 ¥${card.cost} 购入「${card.name}」`);
}

function buyStock(state: GameState, action: Extract<PlayerAction, { type: 'BUY_STOCK' }>): void {
  if (state.phase !== 'awaiting_action') throw new Error('当前不能交易股票');
  const p = currentPlayer(state);
  if (cellAt(state, p.position).type !== 'bank') throw new Error('不在银行/证交所，不能买入股票');
  const stock = stockById(state, action.stockId);
  if (!stock) throw new Error('未知股票');
  if (!Number.isInteger(action.quantity) || action.quantity <= 0) throw new Error('数量必须为正整数');
  const total = stock.price * action.quantity;
  if (p.cash < total) throw new Error('现金不足');
  p.cash -= total;
  p.stocks[stock.id] = (p.stocks[stock.id] ?? 0) + action.quantity;
  log(state, `${p.name} 以 ¥${total} 买入 ${stock.name} ×${action.quantity}（单价 ¥${stock.price}）`);
}

function sellStock(state: GameState, action: Extract<PlayerAction, { type: 'SELL_STOCK' }>): void {
  if (state.phase !== 'awaiting_action') throw new Error('当前不能交易股票');
  const p = currentPlayer(state);
  if (cellAt(state, p.position).type !== 'bank') throw new Error('不在银行/证交所，不能卖出股票');
  const stock = stockById(state, action.stockId);
  if (!stock) throw new Error('未知股票');
  if (!Number.isInteger(action.quantity) || action.quantity <= 0) throw new Error('数量必须为正整数');
  const holding = p.stocks[stock.id] ?? 0;
  if (action.quantity > holding) throw new Error('持股不足');
  const total = stock.price * action.quantity;
  p.stocks[stock.id] = holding - action.quantity;
  if (p.stocks[stock.id] === 0) delete p.stocks[stock.id];
  p.cash += total;
  log(state, `${p.name} 以 ¥${total} 卖出 ${stock.name} ×${action.quantity}（单价 ¥${stock.price}）`);
}

/** 唯一入口：应用玩家动作并返回新状态（纯函数，不修改传入状态） */
export function applyAction(state: GameState, action: PlayerAction): GameState {
  const next = clone(state);
  switch (action.type) {
    case 'START_GAME':
      startGame(next);
      break;
    case 'ROLL_DICE':
      rollDice(next);
      break;
    case 'BUY_LAND':
      buyLand(next);
      break;
    case 'UPGRADE_LAND':
      upgradeLand(next);
      break;
    case 'END_TURN':
      endTurn(next);
      break;
    case 'USE_CARD':
      useCard(next, action);
      break;
    case 'BUY_CARD':
      buyCard(next, action);
      break;
    case 'BUY_STOCK':
      buyStock(next, action);
      break;
    case 'SELL_STOCK':
      sellStock(next, action);
      break;
    default: {
      const exhaustive: never = action;
      throw new Error(`未知动作: ${JSON.stringify(exhaustive)}`);
    }
  }
  return next;
}


