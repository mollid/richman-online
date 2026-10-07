import { BOARD_SIZE, CHANCE_EVENTS, DEFAULT_BOARD, PASS_START_SALARY, STARTING_CASH } from './board.js';
import { rollDie } from './rng.js';
import type { BoardCell, GameState, Player, PlayerAction, PlayerProperty } from './types.js';

export interface PlayerDef {
  id: string;
  name: string;
  color: number;
}

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
      skipTurns: 0,
      bankrupt: false,
      online: true,
    })),
    board: structuredClone(DEFAULT_BOARD),
    currentPlayerIndex: 0,
    phase: 'lobby',
    dice: null,
    turn: 0,
    rngState: seed >>> 0,
    log: [{ turn: 0, text: '游戏房间已创建' }],
    winnerId: null,
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
  log(state, `${p.name} 破产出局，名下地产被银行没收`);
}

function payCash(state: GameState, from: Player, amount: number, to: Player | null): void {
  if (amount <= 0) return;
  if (from.cash >= amount) {
    from.cash -= amount;
    if (to) to.cash += amount;
  } else {
    const paid = from.cash;
    if (to) to.cash += paid;
    log(state, `${from.name} 现金不足，只能支付 ¥${paid}`);
    bankruptPlayer(state, from);
    checkWinner(state);
  }
}

function advanceTurn(state: GameState): void {
  if (isGameOver(state)) return;
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
  state.dice = null;
  state.phase = 'awaiting_roll';
}

function cellAt(state: GameState, position: number): BoardCell {
  const c = state.board[position]!;
  return c;
}

export function availableActions(state: GameState): {
  canRoll: boolean;
  canBuy: boolean;
  canUpgrade: boolean;
  canEnd: boolean;
} {
  if (state.phase === 'awaiting_roll') return { canRoll: true, canBuy: false, canUpgrade: false, canEnd: false };
  if (state.phase !== 'awaiting_action') return { canRoll: false, canBuy: false, canUpgrade: false, canEnd: false };
  const p = currentPlayer(state);
  const c = cellAt(state, p.position);
  const owned = cellOwner(state, c.id);
  let canBuy = false;
  let canUpgrade = false;
  if (c.type === 'property' && c.price !== undefined) {
    if (!owned && p.cash >= c.price) canBuy = true;
    if (owned?.player.id === p.id && owned.property.grade < 3 && p.cash >= upgradeCost(c.price, owned.property.grade)) {
      canUpgrade = true;
    }
  }
  return { canRoll: false, canBuy, canUpgrade, canEnd: true };
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

  if (p.skipTurns > 0) {
    p.skipTurns -= 1;
    log(state, `${p.name} 停留中，剩余 ${p.skipTurns} 回合`);
    advanceTurn(state);
    return;
  }

  const r1 = rollDie(state.rngState);
  const r2 = rollDie(r1.nextState);
  state.rngState = r2.nextState;
  state.dice = [r1.value, r2.value];
  const steps = r1.value + r2.value;
  log(state, `${p.name} 掷出 ${r1.value} + ${r2.value} = ${steps} 点`);

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
    const draw = CHANCE_EVENTS[Math.floor((r2.value / 6) * CHANCE_EVENTS.length) % CHANCE_EVENTS.length]!;
    if (draw.amount >= 0) {
      p.cash += draw.amount;
    } else {
      payCash(state, p, -draw.amount, null);
    }
    log(state, `${p.name} 触发机会：${draw.text}`);
    if (isGameOver(state)) return;
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
    default: {
      const exhaustive: never = action;
      throw new Error(`未知动作: ${JSON.stringify(exhaustive)}`);
    }
  }
  return next;
}


