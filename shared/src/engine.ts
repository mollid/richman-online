import {
  BOARD_SIZE,
  DEFAULT_BOARD,
  DEPOSIT_MONTHLY_INTEREST,
  LOAN_TERM_MONTHS,
  MAX_HAND_CARDS,
  MAX_ITEM_COUNT,
  MAX_LOAN,
  MINIGAME_POINTS_PER_HIT,
  PASS_START_SALARY,
  POINTS_START,
  STARTING_CASH,
  STOCK_DEFS,
  TREASURE_POINTS,
} from './board.js';
import { GODS, godDef, type GodDef } from './gods.js';
import { addMonths, DEFAULT_START_DATE, gameDate, toSerial } from './calendar.js';
import { landPrice, landRent, landUpgradeCost, scaled, upgradeCost } from './economy.js';
import { CARDS, CHANCE_CARD_POOL, SHOP_CARD_IDS } from './cards.js';
import { ITEMS, SHOP_ITEM_IDS } from './items.js';
import { nextRandom, rollDie } from './rng.js';
import {
  FACILITIES,
  FACILITY_ORDER,
  HOTEL_MAX_DAYS,
  MAX_GRADE,
  RESEARCH_ORDER,
  chainRent,
  facilityBuildCost,
  facilitySpendBase,
  facilityUpgradeable,
  gasFee,
  gradeName,
  holdsWholeStreet,
  researchDef,
  streetCells,
  vehicleLabel,
  vehicleLevel,
} from './tiles.js';
import {
  COMPANIES,
  COMPANY_LIST,
  ESTATE_BUILD_RATIO,
  MAX_SHARES_PER_BUY,
  WHEEL_KINDS,
  companyAtCell,
  companyFee,
  majorityHolderId,
} from './companies.js';
import type {
  AvailableActions,
  BankAccess,
  BoardCell,
  CompanyKind,
  CompanyState,
  DateSerial,
  FacilityType,
  GameState,
  Player,
  PlayerAction,
  PlayerDef,
  PlayerProperty,
  RoundSnapshot,
} from './types.js';

export interface CreateGameOptions {
  /** 起始日期；缺省用固定常量，保证 shared 不读系统时钟 */
  startDate?: DateSerial;
}

/** 新玩家的初始字段（createGame 与 addPlayer 共用） */
function basePlayer(def: PlayerDef): Player {
  return {
    ...def,
    cash: STARTING_CASH,
    deposit: 0,
    points: POINTS_START,
    loan: null,
    position: 0,
    properties: [],
    cards: [],
    items: {},
    stocks: {},
    god: null,
    skipTurns: 0,
    direction: 1 as 1 | -1,
    holdTurns: 0,
    rentBlockedTurns: 0,
    sleepwalkTurns: 0,
    turtleTurns: 0,
    bulldozerTurns: 0,
    research: null,
    diceCount: 1,
    alliance: null,
    abroadTurns: 0,
    insurance: null,
    financing: 0,
    bankrupt: false,
    online: true,
  };
}

export function createGame(players: PlayerDef[], seed = Date.now() % 2147483647, options: CreateGameOptions = {}): GameState {
  if (players.length > 4) {
    throw new Error('游戏最多 4 名玩家');
  }
  return {
    players: players.map((p) => basePlayer(p)),
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
    roadblocks: [],
    mines: [],
    bombs: [],
    stockHalts: [],
    rentEffects: [],
    lastRoundSnapshot: null,
    minigame: null,
    calendar: { start: options.startDate ?? DEFAULT_START_DATE, elapsedDays: 0 },
    initialCashPerPlayer: STARTING_CASH,
    initialPlayerCount: players.length,
    bankAccess: null,
    lotteryPool: 0,
    companies: COMPANY_LIST.map((def) => ({
      kind: def.kind,
      cellId: def.cellId,
      sharePrice: def.sharePrice,
      surplus: 0,
      shares: {},
      chairmanId: null,
      firstHeldDayIndex: {},
    })),
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
  next.players.push(basePlayer(def));
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
  p.deposit = 0;
  p.points = 0;
  p.loan = null;
  p.skipTurns = 0;
  p.direction = 1;
  p.holdTurns = 0;
  p.rentBlockedTurns = 0;
  p.sleepwalkTurns = 0;
  p.turtleTurns = 0;
  p.bulldozerTurns = 0;
  p.research = null;
  p.diceCount = 1;
  p.alliance = null;
  p.abroadTurns = 0;
  p.insurance = null;
  p.financing = 0;
  p.properties = [];
  p.cards = [];
  p.items = {};
  p.stocks = {};
  p.stockCost = {};
  p.god = null;
  // 释放所持公司股份，并在必要时重新判定经营权（破产者已不参与持股计算）
  for (const company of state.companies) {
    if (company.shares[p.id] === undefined) continue;
    delete company.shares[p.id];
    delete company.firstHeldDayIndex[p.id];
    if (company.chairmanId === p.id) company.chairmanId = majorityHolderId(company, state.players);
  }
  // 定时炸弹失去载体
  state.bombs = state.bombs.filter((b) => b.playerId !== p.id);
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
      if (p.stockCost) delete p.stockCost[stockId];
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
    target.grade = (target.grade - 1) as 1 | 2 | 3 | 4 | 5;
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

/** 支付用途（波 6 罚金汇总用；波 1 仅作日志语义） */
export type PayReason = 'rent' | 'tax' | 'god' | 'news' | 'minigame' | 'loan' | 'card' | 'company' | 'financing' | 'other';

/**
 * 三货币支付管道：现金 → 存款 → 变卖（股票→降级→售地）→ 破产。
 * 收款方按「实付 paid」入账，不凭空造钱；`toDeposit` 为真时租金等入收款方存款（ECON-02）。
 */
function pay(
  state: GameState,
  from: Player,
  amount: number,
  to: Player | null,
  opts: { toDeposit?: boolean; reason?: PayReason } = {},
): number {
  if (amount <= 0) return 0;

  let remaining = amount;

  // 1. 现金
  const fromCash = Math.min(from.cash, remaining);
  from.cash -= fromCash;
  remaining -= fromCash;

  // 2. 存款
  if (remaining > 0) {
    const fromDeposit = Math.min(from.deposit, remaining);
    from.deposit -= fromDeposit;
    remaining -= fromDeposit;
  }

  // 3. 变卖资产
  if (remaining > 0) {
    liquidateFor(state, from, remaining);
    const afterLiquidate = Math.min(from.cash, remaining);
    from.cash -= afterLiquidate;
    remaining -= afterLiquidate;
  }

  const paid = amount - remaining;
  creditPayee(to, paid, opts.toDeposit === true);

  if (remaining > 0) {
    log(state, `${from.name} 变卖全部资产后仍不足，只能支付 ¥${paid}`);
    bankruptPlayer(state, from);
    checkWinner(state);
  }

  return paid;
}

function creditPayee(to: Player | null, paid: number, toDeposit: boolean): void {
  if (!to || paid <= 0) return;
  if (toDeposit) to.deposit += paid;
  else to.cash += paid;
}

/** `pay` 的薄包装：现金/存款/变卖，收款方入现金 */
function payCash(state: GameState, from: Player, amount: number, to: Player | null): void {
  pay(state, from, amount, to, { toDeposit: false });
}

/** 股票市场回合波动 + 随机新闻；例假日休市（ECON-09）；红卡/黑卡期间涨跌停（CARD-24/25） */
function tickStockMarket(state: GameState): void {
  if (gameDate(state).isHoliday) return;
  for (const stock of state.stockMarket.stocks) {
    const draw = nextRandom(state.rngState);
    state.rngState = draw.nextState;
    let pct = Math.round(draw.value * 20 - 10); // -10% ~ +10%
    const halt = state.stockHalts.find((h) => h.stockId === stock.id);
    if (halt?.kind === 'up') pct = Math.max(pct, 0); // 涨停板：不允许下跌
    if (halt?.kind === 'down') pct = Math.min(pct, 0); // 跌停板：不允许上涨
    const next = Math.max(5, Math.round(stock.price * (1 + pct / 100)));
    stock.lastChangePct = pct + Math.round(((next - stock.price) / Math.max(stock.price, 1)) * 100) - pct;
    stock.price = next;
  }
  applyRandomNews(state);
}

/**
 * 新闻事件（波 7 将扩充为 36 条事件池；TILE-18 新闻格与日切共用）：
 * 随机一支股票额外 ±15%，另有 25% 概率触发玩家事件（影响全体或随机一名玩家）。
 * 抽数顺序固定为「新闻选股 → 涨跌方向 → 事件门槛 → …」，保证确定性回放。
 */
function applyRandomNews(state: GameState): void {
  const newsDraw = nextRandom(state.rngState);
  state.rngState = newsDraw.nextState;
  const stock = state.stockMarket.stocks[Math.floor(newsDraw.value * state.stockMarket.stocks.length)]!;
  const signDraw = nextRandom(state.rngState);
  state.rngState = signDraw.nextState;
  const up = signDraw.value < 0.5;
  let pct = up ? 15 : -15;
  const halt = state.stockHalts.find((h) => h.stockId === stock.id);
  if (halt?.kind === 'up') pct = Math.max(pct, 0);
  if (halt?.kind === 'down') pct = Math.min(pct, 0);
  stock.price = Math.max(5, Math.round(stock.price * (1 + pct / 100)));
  stock.lastChangePct = pct;
  const newsText = pct > 0
    ? `【新闻】${stock.name} 业绩超预期，大涨 ${pct}%！`
    : pct < 0
      ? `【新闻】${stock.name} 被曝财务问题，暴跌 ${-pct}%！`
      : `【新闻】${stock.name} 受涨跌停板限制，价格纹丝不动`;
  log(state, newsText);

  // 玩家事件（25% 概率）：影响全体或随机一名玩家
  const eventRoll = nextRandom(state.rngState);
  state.rngState = eventRoll.nextState;
  if (eventRoll.value < 0.25) {
    const active = state.players.filter((q) => !q.bankrupt);
    if (active.length > 0) {
      const pickDraw = nextRandom(state.rngState);
      state.rngState = pickDraw.nextState;
      const target = active[Math.floor(pickDraw.value * active.length)]!;
      const kindDraw = nextRandom(state.rngState);
      state.rngState = kindDraw.nextState;
      switch (Math.floor(kindDraw.value * 4)) {
        case 0: {
          const fine = scaled(state, 200);
          log(state, `【新闻】税务局年终稽查：全体玩家缴纳所得税 ¥${fine}`);
          for (const q of active) {
            payCash(state, q, fine, null);
            if (isGameOver(state)) return;
          }
          break;
        }
        case 1: {
          const prize = scaled(state, 800);
          target.cash += prize;
          log(state, `【新闻】${target.name} 中了电台有奖竞猜，喜提 ¥${prize}`);
          break;
        }
        case 2: {
          const repair = scaled(state, 500);
          log(state, `【新闻】${target.name} 的电脑突然蓝屏，维修花了 ¥${repair}`);
          payCash(state, target, repair, null);
          break;
        }
        default: {
          const interest = scaled(state, 150);
          for (const q of active) q.cash += interest;
          log(state, `【新闻】央行宣布加息：全体玩家获得存款利息 ¥${interest}`);
          break;
        }
      }
    }
  }
}

/** 日切钩子（波 4/5/7 将在此挂载神明现身/股东分红/新闻等） */
type DayHook = (state: GameState) => void;

/** TIME-02：例假日提示 + 休市（休市本身是派生值，这里只做提示） */
function noticeHolidayHook(state: GameState): void {
  const d = gameDate(state);
  if (d.isHoliday) {
    log(state, `【休市】今天是 ${d.iso} ${d.weekdayLabel}，例假日股市与银行停业`);
  }
}

/**
 * TIME-03：每月 15 号股东分红 + 乐透开奖（乐透归波 6）。
 * 各公司按持股比例分配**累积盈余**；盈余为负（负债）时由股东按持股比例共同承担。
 * 不抽 RNG，保持确定性回放。
 */
function dividendAndLotteryHook(state: GameState): void {
  const d = gameDate(state);
  if (!d.isDividendDay) return;
  log(state, `【分红日】${d.iso} 是 15 号，股东分红结算`);
  for (const company of state.companies) {
    const total = Object.values(company.shares).reduce((a, b) => a + b, 0);
    if (total <= 0 || company.surplus === 0) continue;
    const name = COMPANIES[company.kind].name;
    const surplus = company.surplus;
    let distributed = 0;
    for (const [id, shares] of Object.entries(company.shares)) {
      if (shares <= 0) continue;
      const owner = state.players.find((p) => p.id === id);
      if (!owner || owner.bankrupt) continue;
      const part = Math.floor((surplus * shares) / total);
      if (part === 0) continue;
      distributed += part;
      if (part > 0) {
        owner.cash += part;
        log(state, `【${name}】${owner.name} 按 ${shares}/${total} 股获分红 ¥${part}`);
      } else {
        log(state, `【${name}】${owner.name} 按 ${shares}/${total} 股承担亏损 ¥${-part}`);
        pay(state, owner, -part, null, { reason: 'company' });
        if (isGameOver(state)) return;
      }
    }
    company.surplus -= distributed;
  }
}

/**
 * CORP-09：企业银行董事长特别融资——若周转额超过「其他玩家存款总额」，
 * 视为损害客户权益，须立即全额还清。不抽 RNG，保持确定性回放。
 */
function financingCheckHook(state: GameState): void {
  for (const p of state.players) {
    if (p.bankrupt || p.financing <= 0) continue;
    const cap = financingCap(state, p);
    if (p.financing <= cap) continue;
    const amount = p.financing;
    p.financing = 0;
    log(state, `【特别融资】${p.name} 的周转额 ¥${amount} 超出客户存款总额 ¥${cap}，须立即还清`);
    pay(state, p, amount, null, { reason: 'financing' });
    if (isGameOver(state)) return;
  }
}

/** TIME-04：月末存款计息（有贷款者当月不计息） */
function monthEndInterestHook(state: GameState): void {
  const d = gameDate(state);
  if (!d.isMonthEnd) return;
  for (const p of state.players) {
    if (p.bankrupt || p.deposit <= 0) continue;
    if (p.loan || p.financing > 0) {
      log(state, `【利息】${p.name} 因${p.loan ? '贷款' : '特别融资周转'}在身，本月存款不计息`);
      continue;
    }
    const interest = Math.round(p.deposit * DEPOSIT_MONTHLY_INTEREST);
    if (interest <= 0) continue;
    p.deposit += interest;
    log(state, `【利息】月末结算，${p.name} 存款获得利息 ¥${interest}`);
  }
}

/** ECON-05：贷款到期强制全额归还（先清 loan 再 pay，避免递归） */
function loanDueHook(state: GameState): void {
  for (const p of state.players) {
    if (p.bankrupt || !p.loan) continue;
    if (state.calendar.elapsedDays < p.loan.dueDayIndex) continue;
    const principal = p.loan.principal;
    p.loan = null;
    log(state, `【贷款到期】${p.name} 的贷款 ¥${principal} 到期，强制归还`);
    pay(state, p, principal, null, { reason: 'loan' });
    if (isGameOver(state)) return;
  }
}

/** 波 2 时效性效果按天递减：涨跌停 / 涨价查封 / 同盟 / 乌龟 / 梦游 / 丧失收租 */
function expireTimedEffectsHook(state: GameState): void {
  state.stockHalts = state.stockHalts
    .map((h) => ({ ...h, daysLeft: h.daysLeft - 1 }))
    .filter((h) => h.daysLeft > 0);
  state.rentEffects = state.rentEffects
    .map((e) => ({ ...e, daysLeft: e.daysLeft - 1 }))
    .filter((e) => e.daysLeft > 0);
  for (const p of state.players) {
    if (p.bankrupt) continue;
    if (p.rentBlockedTurns > 0) p.rentBlockedTurns -= 1;
    if (p.sleepwalkTurns > 0) p.sleepwalkTurns -= 1;
    if (p.turtleTurns > 0) p.turtleTurns -= 1;
    if (p.abroadTurns > 0) p.abroadTurns -= 1;
    if (p.insurance) {
      p.insurance.daysLeft -= 1;
      if (p.insurance.daysLeft <= 0) {
        log(state, `${p.name} 的保险合同到期`);
        p.insurance = null;
      }
    }
    if (p.alliance) {
      p.alliance.daysLeft -= 1;
      if (p.alliance.daysLeft <= 0) {
        log(state, `${p.name} 的同盟到期解除`);
        p.alliance = null;
      }
    }
  }
}

/** EST-09：研究所研发按天推进，到期后道具入栏（每种上限 9）。不抽 RNG，保持回放确定性。 */
function researchTickHook(state: GameState): void {
  for (const p of state.players) {
    if (p.bankrupt || !p.research) continue;
    p.research.remainDays -= 1;
    const name = ITEMS[p.research.itemId]?.name ?? p.research.itemId;
    if (p.research.remainDays > 0) {
      log(state, `【研发】${p.name} 的「${name}」还需 ${p.research.remainDays} 天`);
      continue;
    }
    const itemId = p.research.itemId;
    p.research = null;
    if ((p.items[itemId] ?? 0) >= MAX_ITEM_COUNT) {
      log(state, `【研发】${p.name} 完成「${name}」，但道具已满（上限 ${MAX_ITEM_COUNT}），成果暂时搁置`);
    } else {
      p.items[itemId] = (p.items[itemId] ?? 0) + 1;
      log(state, `【研发】${p.name} 完成研发，「${name}」已入栏`);
    }
  }
}

const DAY_HOOKS: DayHook[] = [
  noticeHolidayHook,
  dividendAndLotteryHook,
  monthEndInterestHook,
  loanDueHook,
  financingCheckHook,
  expireTimedEffectsHook,
  researchTickHook,
  godTickHook,
];

/** 日切唯一收口点：逐钩子执行，game_over 时提前返回 */
function onDayChange(state: GameState): void {
  for (const hook of DAY_HOOKS) {
    if (isGameOver(state)) return;
    hook(state);
  }
}

/** 时光机（ITEM-10）用：把「本回合开始」的轻量状态记入 GameState */
function captureRoundSnapshot(state: GameState): void {
  const snapshot: RoundSnapshot = {
    players: state.players.map((p) => ({
      id: p.id,
      position: p.position,
      cash: p.cash,
      deposit: p.deposit,
      properties: structuredClone(p.properties),
      stocks: { ...p.stocks },
    })),
  };
  state.lastRoundSnapshot = snapshot;
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
  state.bankAccess = null;
  if (state.currentPlayerIndex < before) {
    state.round += 1;
    captureRoundSnapshot(state);
    state.calendar.elapsedDays += 1;
    onDayChange(state);
    if (isGameOver(state)) {
      state.dice = null;
      return;
    }
    tickStockMarket(state);
  }
  state.dice = null;
  state.phase = 'awaiting_roll';
}

function cellAt(state: GameState, position: number): BoardCell {
  const c = state.board[position]!;
  return c;
}

/** 确定性取 [min, max] 闭区间整数（附身效果数值用） */
function godRoll(state: GameState, min: number, max: number): number {
  const draw = nextRandom(state.rngState);
  state.rngState = draw.nextState;
  return min + Math.floor(draw.value * (max - min + 1));
}

/** 随机遗失 n 张手牌（GOD-08/09），返回遗失的卡片 id */
function loseRandomCards(state: GameState, p: Player, n: number): string[] {
  const lost: string[] = [];
  for (let i = 0; i < n && p.cards.length > 0; i++) {
    lost.push(p.cards.splice(godRoll(state, 0, p.cards.length - 1), 1)[0]!);
  }
  return lost;
}

/** 神庙随机召唤：从 12 尊中确定性地抽一位附身 */
function summonGod(state: GameState, p: Player): void {
  const draw = nextRandom(state.rngState);
  state.rngState = draw.nextState;
  attachGod(state, p, GODS[Math.floor(draw.value * GODS.length)]!);
}

/** 神明附身（含期满对偶转化）：设置计时并一次性结算附身效果（GOD §8.1） */
function attachGod(state: GameState, p: Player, def: GodDef): void {
  p.god = { godId: def.id, remainingDays: def.durationDays };
  log(state, `${def.name} 附身 ${p.name}！${def.possession}（持续 ${def.durationDays} 天）`);
  applyGodPossession(state, p, def);
}

/** 附身效果（一次性结算） */
function applyGodPossession(state: GameState, p: Player, def: GodDef): void {
  switch (def.id) {
    case 'big-wealth': {
      const gain = scaled(state, godRoll(state, 1000, 3999));
      p.cash += gain;
      log(state, `大财神显灵，${p.name} 意外获得 ¥${gain}`);
      break;
    }
    case 'small-wealth': {
      const each = scaled(state, godRoll(state, 100, 999));
      log(state, `小财神显灵，${p.name} 向每位对手收取 ¥${each}`);
      for (const other of state.players) {
        if (other.id === p.id || other.bankrupt) continue;
        pay(state, other, each, p, { reason: 'god' });
      }
      break;
    }
    case 'big-fortune': {
      drawChanceCard(state, p, '大福神');
      drawChanceCard(state, p, '大福神');
      break;
    }
    case 'small-fortune': {
      drawChanceCard(state, p, '小福神');
      break;
    }
    case 'big-poverty': {
      const loss = scaled(state, godRoll(state, 1000, 3999));
      log(state, `大穷神作祟，${p.name} 损失 ¥${loss}`);
      payCash(state, p, loss, null);
      break;
    }
    case 'small-poverty': {
      const each = scaled(state, godRoll(state, 100, 999));
      log(state, `小穷神作祟，${p.name} 送给每位对手 ¥${each}`);
      for (const other of state.players) {
        if (other.id === p.id || other.bankrupt) continue;
        pay(state, p, each, other, { reason: 'god' });
        if (p.bankrupt) break;
      }
      break;
    }
    case 'big-misfortune': {
      const lost = loseRandomCards(state, p, Math.floor(p.cards.length / 2));
      log(state, `大衰神作祟，${p.name} 遗失 ${lost.length} 张卡片（剩余 ${p.cards.length} 张）`);
      break;
    }
    case 'small-misfortune': {
      const lost = loseRandomCards(state, p, 1);
      log(state, `小衰神作祟，${p.name}${lost.length > 0 ? '遗失一张卡片' : '手牌已空，无卡可失'}`);
      break;
    }
    case 'death': {
      const cardCount = p.cards.length;
      const itemCount = Object.values(p.items).reduce((a, b) => a + b, 0);
      p.cards = [];
      p.items = {};
      const loss = scaled(state, 2000);
      log(state, `死神降临！${p.name} 遗失全部 ${cardCount} 张卡片与 ${itemCount} 件道具，并遭逢一连串倒霉事损失 ¥${loss}`);
      payCash(state, p, loss, null);
      break;
    }
    default:
      // 土地公 / 天使 / 恶魔：效果在移动路径上被动生效（applyGodTravel）
      break;
  }
}

/**
 * 行进显灵·租金类（GOD-02/03/06/07）：返回调整后的应付过路费；返回 0 表示完全抵赖。
 */
function applyGodRentModifier(state: GameState, p: Player, rent: number, cellName: string): number {
  const id = p.god?.godId;
  if (!id || rent <= 0) return rent;
  const name = godDef(id)?.name ?? '神明';
  if (id === 'land-god' || id === 'big-wealth') {
    log(state, `${name}显灵，${p.name} 抵赖了「${cellName}」的全部租金`);
    return 0;
  }
  if (id === 'small-wealth') {
    const half = Math.floor(rent / 2);
    log(state, `${name}显灵，「${cellName}」租金减半至 ¥${half}`);
    return half;
  }
  if (id === 'big-poverty' || id === 'small-poverty') {
    log(state, `${name}显灵，「${cellName}」租金加倍至 ¥${rent * 2}`);
    return rent * 2;
  }
  return rent;
}

/**
 * 行进显灵·落格类（GOD-01 土地公侵占 / GOD-10 天使加盖 / GOD-11 恶魔拆屋）：
 * 在落格结算前对当格生效。
 */
function applyGodTravel(state: GameState, p: Player, c: BoardCell): void {
  const id = p.god?.godId;
  if (!id) return;
  if (id === 'land-god') {
    if ((c.type === 'property' || c.type === 'commercial') && c.price !== undefined && !cellOwner(state, c.id)) {
      p.properties.push({ cellId: c.id, grade: 1 });
      log(state, `土地公显灵，${p.name} 将无主之地「${c.name}」占为己有`);
    }
    return;
  }
  if (id !== 'angel' && id !== 'devil') return;
  const owned = cellOwner(state, c.id);
  if (!owned) return;
  const prop = owned.property;
  if (c.type === 'commercial' && !prop.facility) return;
  if (id === 'angel') {
    if (prop.grade >= MAX_GRADE) return;
    prop.grade = (prop.grade + 1) as 1 | 2 | 3 | 4 | 5;
    log(state, `天使显灵，「${c.name}」加盖一层至 ${prop.grade} 级`);
  } else {
    if (prop.grade <= 1) return;
    prop.grade = (prop.grade - 1) as 1 | 2 | 3 | 4 | 5;
    log(state, `恶魔显灵，「${c.name}」被拆掉一层至 ${prop.grade} 级`);
  }
}

/** 行进显灵辅助：买地完全免费（GOD-04 大福神） */
function godFreeLandPurchase(p: Player): boolean {
  return p.god?.godId === 'big-fortune';
}

/** 行进显灵辅助：买地流标、投资失败（GOD-08/09 衰神） */
function godBlocksInvestment(p: Player): boolean {
  return p.god?.godId === 'big-misfortune' || p.god?.godId === 'small-misfortune';
}

/** 行进显灵辅助：盖房投资加倍（GOD-04/05 大/小福神） */
function godDoublesBuild(p: Player): boolean {
  return p.god?.godId === 'big-fortune' || p.god?.godId === 'small-fortune';
}

/** GOD-01..12：神明按天计时，期满对偶转化或离开（死神 13 天到期自动消失） */
function godTickHook(state: GameState): void {
  for (const p of state.players) {
    if (isGameOver(state)) return;
    if (p.bankrupt || !p.god) continue;
    const current = godDef(p.god.godId);
    if (!current) {
      p.god = null;
      continue;
    }
    p.god.remainingDays -= 1;
    if (p.god.remainingDays > 0) continue;
    const next = current.transformsTo ? godDef(current.transformsTo) : undefined;
    p.god = null;
    if (next) {
      log(state, `${current.name} 期满，对偶转化为 ${next.name}`);
      attachGod(state, p, next);
    } else {
      log(state, `${current.name} 离开了 ${p.name}`);
    }
  }
}

/** 抽卡（机会格 / 卡片屋；额满时自动舍弃最旧一张，V0 简化：原版为玩家自选） */
function drawChanceCard(state: GameState, p: Player, source = '机会'): void {
  const draw = nextRandom(state.rngState);
  state.rngState = draw.nextState;
  const cardId = CHANCE_CARD_POOL[Math.floor(draw.value * CHANCE_CARD_POOL.length)]!;
  if (p.cards.length >= MAX_HAND_CARDS) {
    const dropped = p.cards.shift()!;
    log(state, `${p.name} 手牌已满，舍弃「${CARDS[dropped]?.name ?? dropped}」以容纳新卡`);
  }
  p.cards.push(cardId);
  log(state, `${p.name} 在${source}抽到卡片「${CARDS[cardId]!.name}」`);
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

// ---------------------------------------------------------------------------
// 波 2：卡片 / 道具通用工具
// ---------------------------------------------------------------------------

/** 消耗一张手牌；持有则返回 true */
function consumeCard(p: Player, cardId: string): boolean {
  const idx = p.cards.indexOf(cardId);
  if (idx < 0) return false;
  p.cards.splice(idx, 1);
  return true;
}

/** 消耗一个道具；持有则返回 true */
function consumeItem(p: Player, itemId: string): boolean {
  const count = p.items[itemId] ?? 0;
  if (count <= 0) return false;
  if (count === 1) delete p.items[itemId];
  else p.items[itemId] = count - 1;
  return true;
}

/** 确定性随机下标（走 state.rngState，保证可回放） */
function randomIndex(state: GameState, n: number): number {
  const draw = nextRandom(state.rngState);
  state.rngState = draw.nextState;
  return Math.min(n - 1, Math.floor(draw.value * n));
}

/** 取玩家在指定格的地产 */
function propOf(p: Player, cellId: number): PlayerProperty | undefined {
  return p.properties.find((q) => q.cellId === cellId);
}

/**
 * 路段（EST-03）：波 3 起改由棋盘数据 `BoardCell.street` 显式定义，
 * 用于天使卡 / 恶魔卡 / 涨价卡 / 查封卡与「整路段联合租金」判定。
 */
function routeSegment(state: GameState, cellId: number): number[] {
  return streetCells(state, cellId);
}

/**
 * 住宅租金（EST-03/04/05）：
 * - 连锁店（EST-04/05）：以店面总数计价，不与同路段联合计算；
 * - 其余：同路段、同业主的产业租金「联合计算」（EST-03）；买下整路段再享黄金路线加成。
 */
function propertyRent(state: GameState, cell: BoardCell, owned: { player: Player; property: PlayerProperty }): number {
  if (owned.property.chain) return chainRent(state, owned.player.id);
  const base = landRent(state, cell, owned.property.grade);
  const cells = streetCells(state, cell.id);
  if (cells.length < 2) return base;
  let total = 0;
  for (const id of cells) {
    const o = cellOwner(state, id);
    if (o && o.player.id === owned.player.id) total += landRent(state, state.board[id]!, o.property.grade);
  }
  if (total <= base) return base;
  return holdsWholeStreet(state, owned.player.id, cell.id) ? Math.round(total * 1.5) : total;
}

/** 环上以 center 为中心、半径 radius 的格集合（模拟 3×3 / 5×5 爆炸范围） */
function blastArea(center: number, radius: number): number[] {
  const cells: number[] = [];
  for (let d = -radius; d <= radius; d++) cells.push((center + d + BOARD_SIZE) % BOARD_SIZE);
  return cells;
}

/**
 * 免费卡（CARD-20）：租金/罚金/税金超过 2000 × 物价指数（或超过剩余资金）时自动抵用一次。
 * 返回 true 表示本次费用已被免除。
 */
function tryFreePass(state: GameState, p: Player, amount: number): boolean {
  if (amount <= 0) return false;
  if (!p.cards.includes('free-pass')) return false;
  const threshold = scaled(state, 2000);
  if (amount <= threshold && amount <= p.cash + p.deposit) return false;
  consumeCard(p, 'free-pass');
  log(state, `${p.name} 使用「免费卡」，本次 ¥${amount} 费用予以免除`);
  return true;
}

/** 丧失收租权（坐牢 / 冬眠 / 梦游） */
function blockRent(p: Player, days: number): void {
  p.rentBlockedTurns = Math.max(p.rentBlockedTurns, days);
}

type DisasterKind = 'jail' | 'frame' | 'sleepwalk' | 'turtle';

/**
 * 反制栈（§6.1）：施加负面效果时按 免罪 → 嫁祸 → 复仇 的优先级查询受击方持有的反制卡。
 * - 免罪卡：抵消牢狱/陷害/梦游/乌龟；
 * - 嫁祸卡：把灾难转嫁给他人；
 * - 复仇卡：拖害你的人一起下水（受击方仍然中招）。
 */
function applyDisaster(
  state: GameState,
  target: Player,
  kind: DisasterKind,
  source: Player | null,
  apply: (victim: Player) => void,
): void {
  if (target.bankrupt) return;
  const label = kind === 'frame' ? '陷害' : kind === 'sleepwalk' ? '梦游' : kind === 'turtle' ? '乌龟' : '牢狱';

  // 1. 免罪卡
  if (consumeCard(target, 'absolve')) {
    log(state, `${target.name} 使用「免罪卡」，抵消了${label}之灾`);
    return;
  }
  // 2. 嫁祸卡（需要有加害者才有转嫁意义）
  if (source && consumeCard(target, 'shift-blame')) {
    const others = state.players.filter((q) => !q.bankrupt && q.id !== target.id && q.id !== source.id);
    const victim = others.length > 0 ? others[randomIndex(state, others.length)]! : source;
    log(state, `${target.name} 使用「嫁祸卡」，把${label}之灾转嫁给 ${victim.name}`);
    if (!victim.bankrupt) apply(victim);
    return;
  }
  // 3. 复仇卡
  if (source && consumeCard(target, 'revenge')) {
    log(state, `${target.name} 使用「复仇卡」，拖 ${source.name} 一起下水`);
    if (!source.bankrupt) apply(source);
  }
  apply(target);
}

/** 结算一次爆炸（飞弹 / 核子飞弹 / 定时炸弹）：范围内玩家住院 + 房屋倒塌 + 车辆损毁 */
function detonate(state: GameState, center: number, radius: number, hospitalDays: number, label: string): number {
  const cells = blastArea(center, radius);
  const cellNames = cells.map((id) => state.board[id]?.name ?? `${id}`).join('、');
  log(state, `【${label}】${cellNames} 遭受轰炸！`);
  let destroyed = 0;

  for (const cellId of cells) {
    const owned = cellOwner(state, cellId);
    if (!owned) continue;
    if (owned.property.grade > 1) {
      owned.property.grade = 1;
      destroyed += 1;
      log(state, `「${state.board[cellId]!.name}」的房屋被摧毁，还原为平地`);
    }
  }

  for (const q of state.players) {
    if (q.bankrupt) continue;
    if (!cells.includes(q.position)) continue;
    q.skipTurns = Math.max(q.skipTurns, hospitalDays);
    q.bulldozerTurns = 0;
    q.diceCount = 1; // 车辆损毁
    blockRent(q, hospitalDays);
    log(state, `${q.name} 被炸伤，住院 ${hospitalDays} 天`);
  }
  return destroyed;
}

export function availableActions(state: GameState): AvailableActions {
  if (
    state.phase === 'awaiting_roll' ||
    state.phase === 'awaiting_action' ||
    state.phase === 'awaiting_pick'
  ) {
    const p = currentPlayer(state);
    const c = cellAt(state, p.position);
    const owned = cellOwner(state, c.id);
    const holiday = gameDate(state).isHoliday;
    const bank = state.bankAccess;
    const atBank = state.phase === 'awaiting_action' && !!bank;
    // CORP-01/09/13：公司格上的经营操作
    const company = state.phase === 'awaiting_action' && c.type === 'company' ? companyAtCell(state, c.id) : undefined;
    const sharePrice = company?.sharePrice ?? 0;
    const shareQuantityLimit =
      company && sharePrice > 0 ? Math.min(MAX_SHARES_PER_BUY, Math.floor(p.cash / sharePrice)) : 0;
    const canBuyShares = !!company && shareQuantityLimit > 0;
    const estateBuildCells: number[] = [];
    if (company && c.companyKind === 'estate') {
      for (const prop of p.properties) {
        if (prop.grade >= MAX_GRADE) continue;
        const target = state.board[prop.cellId];
        if (!target || (target.type !== 'property' && target.type !== 'commercial')) continue;
        if (target.type === 'commercial' && !prop.facility) continue;
        estateBuildCells.push(prop.cellId);
      }
    }
    const canBuildEstate = estateBuildCells.length > 0;
    const financingRemaining =
      company && c.companyKind === 'bank' && company.chairmanId === p.id
        ? Math.max(0, financingCap(state, p) - p.financing)
        : 0;
    const canFinancing = financingRemaining > 0;
    let canBuy = false;
    let canUpgrade = false;
    const buildableFacilities: FacilityType[] = [];
    const researchableItems: string[] = [];
    if (state.phase === 'awaiting_action' && (c.type === 'property' || c.type === 'commercial') && c.price !== undefined) {
      const price = landPrice(state, c);
      if (!owned && p.cash >= price) canBuy = true;
      if (owned?.player.id === p.id) {
        const prop = owned.property;
        if (c.type === 'commercial') {
          // EST-06/07：空地可选建设施；已建且可升级的设施可继续升级
          if (!prop.facility) {
            for (const f of FACILITY_ORDER) {
              if (p.cash >= facilityBuildCost(state, c, f)) buildableFacilities.push(f);
            }
          } else if (facilityUpgradeable(prop) && prop.grade < MAX_GRADE && p.cash >= landUpgradeCost(state, c, prop.grade)) {
            canUpgrade = true;
          }
          // EST-09/10：研究所按等级解锁研发项目（同时只能进行一项）
          if (prop.facility === 'lab' && !p.research) {
            for (const r of RESEARCH_ORDER) {
              if (r.level <= prop.grade) researchableItems.push(r.itemId);
            }
          }
        } else if (!prop.chain && prop.grade < MAX_GRADE && p.cash >= landUpgradeCost(state, c, prop.grade)) {
          // EST-02：住宅可加盖至 5 级；EST-04：连锁店不能再加盖
          canUpgrade = true;
        }
      }
    }
    // 梦游卡（CARD-16）：丧失买地权利
    if (p.sleepwalkTurns > 0) canBuy = false;
    const usableCards = p.cards.filter((cardId) => {
      const card = CARDS[cardId];
      if (!card) return false;
      if (card.auto) return false; // 自动触发类不可主动使用
      if (card.phase === 'any') return true;
      if (card.phase === 'pre_roll') return state.phase === 'awaiting_roll';
      return state.phase === 'awaiting_action';
    });
    const usableItems = Object.keys(p.items).filter((itemId) => {
      const item = ITEMS[itemId];
      if (!item || (p.items[itemId] ?? 0) <= 0) return false;
      if (item.phase === 'any') return true;
      if (item.phase === 'pre_roll') return state.phase === 'awaiting_roll';
      return state.phase === 'awaiting_action';
    });
    return {
      canRoll: state.phase === 'awaiting_roll',
      canBuy,
      canUpgrade,
      canEnd: state.phase === 'awaiting_action',
      canShop: state.phase === 'awaiting_action' && isShopCell(c),
      canTradeStock: state.phase === 'awaiting_action' && isBankCell(c) && !holiday,
      canPick: state.phase === 'awaiting_pick',
      canDeposit: atBank && bank!.canDeposit && !holiday && p.cash > 0,
      canWithdraw: atBank && bank!.canDeposit && !holiday && p.deposit > 0,
      canLoan: atBank && bank!.canLoan && !holiday && p.loan === null,
      canRepayLoan: atBank && bank!.canLoan && p.loan !== null && p.cash > 0,
      isHoliday: holiday,
      canBuyShares,
      sharePrice,
      shareQuantityLimit,
      canBuildEstate,
      estateBuildCells,
      canFinancing,
      financingRemaining,
      buildableFacilities,
      researchableItems,
      usableCards,
      usableItems,
    };
  }
  return {
    canRoll: false,
    canBuy: false,
    canUpgrade: false,
    canEnd: false,
    canShop: false,
    canTradeStock: false,
    canPick: false,
    canDeposit: false,
    canWithdraw: false,
    canLoan: false,
    canRepayLoan: false,
    isHoliday: gameDate(state).isHoliday,
    canBuyShares: false,
    sharePrice: 0,
    shareQuantityLimit: 0,
    canBuildEstate: false,
    estateBuildCells: [],
    canFinancing: false,
    financingRemaining: 0,
    buildableFacilities: [],
    researchableItems: [],
    usableCards: [],
    usableItems: [],
  };
}

function startGame(state: GameState): void {
  if (state.phase !== 'lobby') throw new Error('游戏已经开始');
  if (state.players.length < 2) throw new Error('至少需要 2 名玩家才能开始');
  state.phase = 'awaiting_roll';
  state.turn = 1;
  // 冻结物价指数分母（此后不再随加入/破产变化）
  state.initialCashPerPlayer = STARTING_CASH;
  state.initialPlayerCount = state.players.length;
  log(state, '游戏开始！');
}

function rollDice(state: GameState, action: Extract<PlayerAction, { type: 'ROLL_DICE' }>): void {
  if (state.phase !== 'awaiting_roll') throw new Error('当前不能掷骰');
  const p = currentPlayer(state);

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

  // 工程车（ITEM-12）：开动 7 回合，逐回合递减
  if (p.bulldozerTurns > 0) {
    p.bulldozerTurns -= 1;
    if (p.bulldozerTurns === 0) log(state, `${p.name} 的工程车报废了`);
  }

  // 骰子个数（CORE-03）：步行 1 颗、机车 2 颗、汽车 3 颗；玩家可自选本次使用几颗（默认用满）
  const maxDice = Math.max(1, Math.min(3, p.diceCount));
  const requested = action.diceCount ?? maxDice;
  if (!Number.isInteger(requested) || requested < 1 || requested > maxDice) {
    throw new Error(`骰子数必须是 1-${maxDice} 的整数`);
  }
  const diceCount = requested;
  const rolls: number[] = [];
  for (let i = 0; i < diceCount; i++) {
    if (i === 0 && state.pendingFixedDice !== null) {
      rolls.push(state.pendingFixedDice);
      log(state, `遥控骰子生效：第一颗骰子固定为 ${state.pendingFixedDice} 点`);
      state.pendingFixedDice = null;
    } else {
      const r = rollDie(state.rngState);
      state.rngState = r.nextState;
      rolls.push(r.value);
    }
  }
  state.dice = rolls;
  const rawSteps = rolls.reduce((a, b) => a + b, 0);
  let steps = rawSteps;

  // 停留卡（CARD-14）：下一次前进时停留在原地
  if (p.holdTurns > 0) {
    p.holdTurns -= 1;
    steps = 0;
    log(state, `${p.name} 受停留卡影响，本次原地不动（剩余 ${p.holdTurns} 次）`);
  } else if (p.turtleTurns > 0) {
    steps = Math.min(steps, 1);
    log(state, `${p.name} 受乌龟卡影响，本次只能走 1 步（剩余 ${p.turtleTurns} 天）`);
  }
  log(state, `${p.name} 掷出 ${rolls.join(' + ')} = ${rawSteps} 点${diceCount > 1 ? `（${diceCount} 颗骰子）` : ''}`);

  // 逐格移动：支持方向反转、路障截停与地雷
  const oldPos = p.position;
  let pos = oldPos;
  let crossedStart = false;
  let moved = 0;
  let steppedOnMine = false;
  // TILE-08 公立银行：路过开放存取款（停留当格的完整权限由落格分派给出）
  const publicBankId = state.board.find((bc) => bc.bankKind === 'public')?.id;
  let passedPublicBank = false;
  for (let i = 0; i < steps; i++) {
    pos = (pos + p.direction + BOARD_SIZE) % BOARD_SIZE;
    moved += 1;
    if (pos === 0) crossedStart = true;
    if (publicBankId !== undefined && pos === publicBankId) passedPublicBank = true;
    if (state.roadblocks.includes(pos)) {
      state.roadblocks = state.roadblocks.filter((id) => id !== pos);
      const coneCell = state.board[pos]!;
      log(state, `${p.name} 撞上路障，被迫停在「${coneCell.name}」`);
      break;
    }
    if (state.mines.includes(pos)) {
      state.mines = state.mines.filter((id) => id !== pos);
      steppedOnMine = true;
      log(state, `${p.name} 踩中地雷，被炸伤`);
      break;
    }
  }
  if (crossedStart) {
    p.cash += PASS_START_SALARY;
    log(state, `${p.name} 经过起点，领取薪水 ¥${PASS_START_SALARY}`);
  }
  p.position = pos;
  // 停在公立银行当格时，由落格分派给出完整权限，不再算「路过」
  if (publicBankId !== undefined && pos === publicBankId) passedPublicBank = false;

  // 定时炸弹（ITEM-04）：走满 38 步自动爆炸
  const bomb = state.bombs.find((b) => b.playerId === p.id);
  if (bomb) {
    bomb.stepsLeft -= moved;
    if (bomb.stepsLeft <= 0) {
      state.bombs = state.bombs.filter((b) => b !== bomb);
      detonate(state, pos, 1, 5, '定时炸弹爆炸');
      advanceTurn(state);
      return;
    }
    log(state, `${p.name} 身上的定时炸弹还剩 ${Math.max(0, bomb.stepsLeft)} 步`);
  }

  if (steppedOnMine) {
    p.skipTurns = Math.max(p.skipTurns, 3);
    blockRent(p, 3);
    log(state, `${p.name} 住院 3 天，且暂时无法收租`);
    advanceTurn(state);
    return;
  }

  // TILE-08 路过公立银行：开放存取款（停留当格的完整权限在下方 bank 分支覆盖）
  if (passedPublicBank) {
    state.bankAccess = { canDeposit: true, canLoan: false, cellId: publicBankId! };
    log(state, `${p.name} 路过公立银行，可办理存取款`);
  }

  const c = cellAt(state, pos);

  // 行进显灵·落格类（GOD-01 土地公侵占 / GOD-10 天使加盖 / GOD-11 恶魔拆屋）
  applyGodTravel(state, p, c);

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
    const tax = scaled(state, Math.floor(p.cash * 0.1));
    if (tryFreePass(state, p, tax)) {
      advanceTurn(state);
      return;
    }
    log(state, `${p.name} 需缴税 ¥${tax}`);
    payCash(state, p, tax, null);
    if (isGameOver(state)) return;
    advanceTurn(state);
    return;
  }

  if (c.type === 'hospital') {
    // TILE-09：住院不能出门且丧失收租权利，每天 1000 医药费
    p.skipTurns = Math.max(p.skipTurns, 1);
    blockRent(p, 1);
    const medical = scaled(state, 1000);
    log(state, `${p.name} 住院休养 1 天（期间丧失收租权），支付医药费 ¥${medical}`);
    payCash(state, p, medical, null);
    if (isGameOver(state)) return;
    advanceTurn(state);
    return;
  }

  if (c.type === 'jail') {
    applyDisaster(state, p, 'jail', null, (v) => {
      v.skipTurns = Math.max(v.skipTurns, 2);
      blockRent(v, 2);
      log(state, `${v.name} 被关进监狱，暂停 2 回合并丧失收租权`);
    });
    advanceTurn(state);
    return;
  }

  if (c.type === 'shop') {
    state.phase = 'awaiting_action';
    log(state, `${p.name} 来到${c.name}，可以购买卡片道具`);
    return;
  }

  if (c.type === 'bank') {
    // TILE-08 银行（公立）/ TILE-26 银行（公司）：停留当格开放存取款、贷款与股票交易
    state.bankAccess = { canDeposit: true, canLoan: true, cellId: c.id };
    state.phase = 'awaiting_action';
    log(state, `${p.name} 来到${c.name}，可以存取款、贷款与买卖股票`);
    return;
  }

  if (c.type === 'god') {
    log(state, `${p.name} 进入神庙祈福`);
    summonGod(state, p);
    advanceTurn(state);
    return;
  }

  if (c.type === 'game') {
    const kindRoll = nextRandom(state.rngState);
    state.rngState = kindRoll.nextState;
    if (kindRoll.value < 0.5) {
      state.minigame = {
        kind: 'shells',
        round: 0,
        hits: [],
        symbols: [],
        revealed: [],
        matched: [],
        flips: 0,
      };
      state.phase = 'awaiting_pick';
      log(state, `${p.name} 进入游戏厅玩「三仙归洞」：共 3 轮，猜中越多奖励越高！`);
    } else {
      // 记忆翻牌：4 对图案洗牌
      const symbols: number[] = [];
      for (let i = 0; i < 4; i++) symbols.push(i, i);
      for (let i = symbols.length - 1; i > 0; i--) {
        const draw = nextRandom(state.rngState);
        state.rngState = draw.nextState;
        const j = Math.floor(draw.value * (i + 1));
        const tmp = symbols[i]!;
        symbols[i] = symbols[j]!;
        symbols[j] = tmp;
      }
      state.minigame = {
        kind: 'memory',
        round: 0,
        hits: [],
        symbols,
        revealed: [],
        matched: Array(8).fill(false),
        flips: 0,
      };
      state.phase = 'awaiting_pick';
      log(state, `${p.name} 进入游戏厅玩「记忆翻牌」：8 张牌 4 对图案，翻完全部配对奖励翻倍！`);
    }
    return;
  }

  // 住宅用地（TILE-01 / EST-01..05）
  if (c.type === 'property' && c.price !== undefined && c.baseRent !== undefined) {
    const owned = cellOwner(state, c.id);

    // 工程车（ITEM-12）：走到哪拆到哪
    if (p.bulldozerTurns > 0 && owned && owned.player.id !== p.id && owned.property.grade > 1) {
      owned.property.grade = (owned.property.grade - 1) as 1 | 2 | 3 | 4 | 5;
      log(state, `工程车轰鸣，${owned.player.name} 的「${c.name}」被拆至 ${owned.property.grade} 级`);
    }

    if (!owned) {
      state.phase = 'awaiting_action';
      log(state, `${p.name} 来到无主地产「${c.name}」（售价 ¥${landPrice(state, c)}）`);
      return;
    }
    if (owned.player.id === p.id) {
      // EST-02 住宅可加盖至 5 级；EST-04 连锁店不能再加盖
      if (!owned.property.chain && owned.property.grade < MAX_GRADE) {
        state.phase = 'awaiting_action';
        log(state, `${p.name} 回到自家「${c.name}」（${gradeName(owned.property.grade)}）`);
      } else {
        log(state, `${p.name} 回到${owned.property.chain ? '连锁店' : '满级地产'}「${c.name}」`);
        advanceTurn(state);
      }
      return;
    }

    // 丧失收租权（坐牢/冬眠/梦游）；出国旅游期间同样不能收租（CORP-03）
    if (owned.player.rentBlockedTurns > 0 || owned.player.abroadTurns > 0) {
      const blocked =
        owned.player.rentBlockedTurns > 0
          ? `正在停留中（剩余 ${owned.player.rentBlockedTurns} 天）`
          : `正在国外旅游（剩余 ${owned.player.abroadTurns} 天）`;
      log(state, `${owned.player.name} ${blocked}，无权收租`);
      advanceTurn(state);
      return;
    }

    // 同盟卡（CARD-29）：互不收过路费
    if (p.alliance && p.alliance.with === owned.player.id) {
      log(state, `${p.name} 与 ${owned.player.name} 处于同盟，互免过路费`);
      advanceTurn(state);
      return;
    }

    const effect = state.rentEffects.find((e) => e.cells.includes(c.id));
    if (effect?.kind === 'seal') {
      log(state, `「${c.name}」所在的街道被查封，本次免收过路费`);
      advanceTurn(state);
      return;
    }
    let rent = propertyRent(state, c, owned);
    if (effect?.kind === 'raise') {
      rent *= 2;
      log(state, `「${c.name}」所在的街道正在涨价，过路费加倍`);
    }
    // 行进显灵·租金类（抵赖 / 减半 / 加倍）
    rent = applyGodRentModifier(state, p, rent, c.name);
    if (rent <= 0) {
      advanceTurn(state);
      return;
    }

    if (tryFreePass(state, p, rent)) {
      advanceTurn(state);
      return;
    }
    log(state, `${p.name} 进入 ${owned.player.name} 的「${c.name}」，需付租金 ¥${rent}`);
    pay(state, p, rent, owned.player, { toDeposit: true, reason: 'rent' });
    if (isGameOver(state)) return;
    advanceTurn(state);
    return;
  }

  // 商业用地与设施（TILE-02..07 / EST-06..12）
  if (c.type === 'commercial' && c.price !== undefined) {
    const owned = cellOwner(state, c.id);
    if (!owned) {
      state.phase = 'awaiting_action';
      log(state, `${p.name} 来到无主商业用地「${c.name}」（售价 ¥${landPrice(state, c)}；首次只能购地，再次抵达才可建设）`);
      return;
    }
    if (owned.player.id === p.id) {
      if (!owned.property.facility) {
        state.phase = 'awaiting_action';
        log(state, `${p.name} 回到自有商业用地「${c.name}」，可以开工建设`);
      } else if (facilityUpgradeable(owned.property) && owned.property.grade < MAX_GRADE) {
        state.phase = 'awaiting_action';
        log(state, `${p.name} 回到自己的${FACILITIES[owned.property.facility].name}「${c.name}」（${gradeName(owned.property.grade)}）`);
      } else if (owned.property.facility === 'lab') {
        state.phase = 'awaiting_action';
        log(state, `${p.name} 回到自己的研究所「${c.name}」，可以立项研发`);
      } else {
        log(state, `${p.name} 在自己的「${c.name}」稍作停留`);
        advanceTurn(state);
      }
      return;
    }

    const prop = owned.property;
    if (!prop.facility) {
      log(state, `${owned.player.name} 的「${c.name}」尚未建设，${p.name} 无需付费`);
      advanceTurn(state);
      return;
    }
    const def = FACILITIES[prop.facility];
    if (!def.charges) {
      // EST-08 公园 / EST-09 研究所：不向使用者收费
      log(state, `「${c.name}」的${def.name}免费开放，${p.name} 安全落脚`);
      advanceTurn(state);
      return;
    }
    if (prop.facility === 'gas') {
      // EST-11 / TILE-05：按行走步数 × 交通工具等级收费
      const level = vehicleLevel(p);
      const fee = applyGodRentModifier(state, p, gasFee(state, moved, level), c.name);
      if (fee <= 0) {
        advanceTurn(state);
        return;
      }
      log(state, `${p.name} 在「${c.name}」加油（${moved} 步 × ${vehicleLabel(level)}），需付 ¥${fee}`);
      if (tryFreePass(state, p, fee)) {
        advanceTurn(state);
        return;
      }
      pay(state, p, fee, owned.player, { toDeposit: true, reason: 'rent' });
      if (isGameOver(state)) return;
      advanceTurn(state);
      return;
    }
    // EST-12 / TILE-06/07：购物中心 / 旅馆转轮盘决定消费金额（旅馆另加强制休息天数）
    const spin = nextRandom(state.rngState);
    state.rngState = spin.nextState;
    const multiplier = 1 + Math.floor(spin.value * 3); // 1..3 档
    const amount = applyGodRentModifier(state, p, scaled(state, facilitySpendBase(c, prop.grade) * multiplier), c.name);
    let days = 0;
    if (prop.facility === 'hotel') {
      const rest = nextRandom(state.rngState);
      state.rngState = rest.nextState;
      days = 1 + Math.floor(rest.value * HOTEL_MAX_DAYS); // 1..3 天
    }
    if (amount > 0) {
      log(state, `${p.name} 在「${c.name}」的${def.name}消费，轮盘判定需付 ¥${amount}${days > 0 ? `，并强制休息 ${days} 天` : ''}`);
      if (tryFreePass(state, p, amount)) {
        advanceTurn(state);
        return;
      }
      pay(state, p, amount, owned.player, { toDeposit: true, reason: 'rent' });
      if (isGameOver(state)) return;
    } else {
      log(state, `${p.name} 在「${c.name}」的${def.name}落脚${days > 0 ? `，并强制休息 ${days} 天` : ''}`);
    }
    if (days > 0) {
      p.skipTurns = Math.max(p.skipTurns, days);
      blockRent(p, days);
      log(state, `${p.name} 在旅馆休息 ${days} 天，期间丧失收租权`);
    }
    advanceTurn(state);
    return;
  }

  // TILE-13 免费卡片格
  if (c.type === 'free-card') {
    drawChanceCard(state, p, '卡片屋');
    advanceTurn(state);
    return;
  }

  // TILE-14/15/16 点券格
  if (c.type === 'points') {
    const gain = c.pointsGain ?? 10;
    p.points += gain;
    log(state, `${p.name} 在「${c.name}」获得 ${gain} 点券`);
    advanceTurn(state);
    return;
  }

  // TILE-31 宝箱（点数来源，待验证）
  if (c.type === 'treasure') {
    p.points += TREASURE_POINTS;
    log(state, `${p.name} 打开「${c.name}」，获得 ${TREASURE_POINTS} 点券！`);
    advanceTurn(state);
    return;
  }

  // TILE-18 新闻格：触发随机新闻事件
  if (c.type === 'news') {
    log(state, `${p.name} 在「${c.name}」触发新闻事件`);
    applyRandomNews(state);
    if (isGameOver(state)) return;
    advanceTurn(state);
    return;
  }

  // TILE-19 乐透行：现金投注，奖池累积（开奖归波 6）
  if (c.type === 'lottery') {
    const ticket = scaled(state, 1000);
    if (p.cash >= ticket) {
      p.cash -= ticket;
      state.lotteryPool += ticket;
      log(state, `${p.name} 在「${c.name}」投注 ¥${ticket}，奖池累计 ¥${state.lotteryPool}（每月 15 号开奖）`);
    } else {
      log(state, `${p.name} 现金不足 ¥${ticket}，无法在「${c.name}」投注`);
    }
    advanceTurn(state);
    return;
  }

  // TILE-11 魔法屋（女巫水晶球与指定受罚者归波 8）
  if (c.type === 'magic') {
    log(state, `${p.name} 走进「${c.name}」，女巫的水晶球尚未苏醒（波 8 开放）`);
    advanceTurn(state);
    return;
  }

  // TILE-20..30 公司企业（CORP-01..13）
  if (c.type === 'company') {
    landOnCompany(state, p, c);
    return;
  }

  throw new Error(`未知格类型: ${c.type}`);
}

/**
 * 公司企业落格结算（CORP-01..13）。
 * - 经营权属他人 → 按消费方式缴费（费用充作累积盈余）+ 强制服务（出国/休息/投保）；
 * - 董事长本人 → 免付费，并享受专属福利（百货赠礼）；
 * - 银行/百货无论持股均提供公共服务；
 * - 结算后进入 `awaiting_action`：可认购股份（CORP-01）、房地产公司可加盖（CORP-13）、
 *   企业银行董事长可特别融资（CORP-09）。
 */
function landOnCompany(state: GameState, p: Player, c: BoardCell): void {
  const company = c.companyKind ? companyAtCell(state, c.id) : undefined;
  const def = company ? COMPANIES[company.kind] : undefined;
  if (!company || !def) {
    log(state, `${p.name} 来到「${c.name}」`);
    advanceTurn(state);
    return;
  }

  const chairmanId = company.chairmanId;
  const isChairman = chairmanId === p.id;
  const chairmanName = chairmanId ? state.players.find((q) => q.id === chairmanId)?.name ?? chairmanId : null;
  log(
    state,
    `${p.name} 来到「${def.name}」${isChairman ? '（董事长）' : chairmanName ? `（董事长：${chairmanName}）` : '（经营权空缺）'}`,
  );

  // CORP-09 / CORP-12：银行与百货无论经营权归属，任何人都可使用公共服务
  if (company.kind === 'bank') {
    state.bankAccess = { canDeposit: true, canLoan: true, cellId: c.id };
  }
  if (isChairman && company.kind === 'department') {
    grantDepartmentGift(state, p, def.name);
  }

  // CORP-01：经营权属他人时按消费方式缴费，费用计入累积盈余
  if (chairmanId !== null && !isChairman) {
    let roll = 0;
    if (WHEEL_KINDS.has(company.kind)) {
      const draw = nextRandom(state.rngState);
      state.rngState = draw.nextState;
      roll = 1 + Math.floor(draw.value * 3); // 转轮盘 1..3 天
    }
    const fee = companyFee(state, company.kind, p, roll);
    if (fee > 0) {
      const paid = pay(state, p, fee, null, { reason: 'company' });
      company.surplus += paid;
      log(state, `${p.name} 在「${def.name}」缴费 ¥${paid}（计入累积盈余 ¥${company.surplus}）`);
      if (p.bankrupt || isGameOver(state)) return;
      applyCompanyService(state, p, company.kind, roll);
    } else {
      log(state, `${p.name} 在「${def.name}」无需缴费`);
    }
  }

  state.phase = 'awaiting_action';
}

/** 公司强制服务（CORP-03/04/06）：出国旅游 / 饭店休息 / 强制投保 */
function applyCompanyService(state: GameState, p: Player, kind: CompanyKind, roll: number): void {
  const days = Math.max(1, Math.min(3, roll));
  switch (kind) {
    case 'airline':
      p.abroadTurns = Math.max(p.abroadTurns, days);
      p.skipTurns = Math.max(p.skipTurns, days);
      blockRent(p, days);
      log(state, `【航空公司】${p.name} 乘机出国旅游 ${days} 天（期间不能收租）`);
      break;
    case 'restaurant':
      p.skipTurns = Math.max(p.skipTurns, days);
      blockRent(p, days);
      log(state, `【大饭店】${p.name} 在饭店休息 ${days} 天（期间丧失收租权）`);
      break;
    case 'insurance':
      p.insurance = { daysLeft: days };
      log(state, `【保险公司】${p.name} 强制签约，投保期 ${days} 天`);
      break;
    default:
      break;
  }
}

/** CORP-12：百货公司董事长进入时获赠一张卡片或一项道具 */
function grantDepartmentGift(state: GameState, p: Player, companyName: string): void {
  const kindDraw = nextRandom(state.rngState);
  state.rngState = kindDraw.nextState;
  const pickDraw = nextRandom(state.rngState);
  state.rngState = pickDraw.nextState;
  if (kindDraw.value < 0.5 && p.cards.length < MAX_HAND_CARDS) {
    const cardId = SHOP_CARD_IDS[Math.floor(pickDraw.value * SHOP_CARD_IDS.length)]!;
    p.cards.push(cardId);
    log(state, `【${companyName}】董事长专享：${p.name} 获赠卡片「${CARDS[cardId]?.name ?? cardId}」`);
    return;
  }
  const itemId = SHOP_ITEM_IDS[Math.floor(pickDraw.value * SHOP_ITEM_IDS.length)]!;
  if ((p.items[itemId] ?? 0) >= MAX_ITEM_COUNT) {
    log(state, `【${companyName}】董事长专享：道具已满（上限 ${MAX_ITEM_COUNT}），赠礼作废`);
    return;
  }
  p.items[itemId] = (p.items[itemId] ?? 0) + 1;
  log(state, `【${companyName}】董事长专享：${p.name} 获赠道具「${ITEMS[itemId]?.name ?? itemId}」`);
}

function buyLand(state: GameState): void {
  if (state.phase !== 'awaiting_action') throw new Error('当前不能购买地产');
  const p = currentPlayer(state);
  if (p.sleepwalkTurns > 0) throw new Error('梦游中无法买地');
  const c = cellAt(state, p.position);
  if ((c.type !== 'property' && c.type !== 'commercial') || c.price === undefined) throw new Error('此格不可购买');
  if (cellOwner(state, c.id)) throw new Error('该地产已有主人');
  if (godBlocksInvestment(p)) throw new Error('衰神附身，买地流拍');
  const freeBuy = godFreeLandPurchase(p);
  const price = freeBuy ? 0 : landPrice(state, c);
  if (p.cash < price) throw new Error('现金不足');
  p.cash -= price;
  p.properties.push({ cellId: c.id, grade: 1 });
  if (freeBuy) {
    log(state, `大福神显灵，${p.name} 免费获得「${c.name}」`);
  } else if (c.type === 'commercial') {
    // EST-06：商业用地首次只能购地，须再次抵达才能选择建设项目
    log(state, `${p.name} 以 ¥${price} 购入商业用地「${c.name}」（下次抵达可选择建设项目）`);
  } else {
    log(state, `${p.name} 以 ¥${price} 购入「${c.name}」`);
  }
  advanceTurn(state);
}

function upgradeLand(state: GameState): void {
  if (state.phase !== 'awaiting_action') throw new Error('当前不能升级地产');
  const p = currentPlayer(state);
  const c = cellAt(state, p.position);
  if ((c.type !== 'property' && c.type !== 'commercial') || c.price === undefined) throw new Error('此格不可升级');
  const owned = cellOwner(state, c.id);
  if (!owned || owned.player.id !== p.id) throw new Error('只能升级自己的地产');
  const prop = owned.property;
  if (c.type === 'commercial') {
    if (!prop.facility) throw new Error('请先建设施，再行升级');
    if (!facilityUpgradeable(prop)) throw new Error('该设施无法升级（EST-08/EST-11）');
  } else if (prop.chain) {
    throw new Error('连锁店不能再加盖（EST-04）');
  }
  if (prop.grade >= MAX_GRADE) throw new Error('地产已满级');
  if (godBlocksInvestment(p)) throw new Error('衰神附身，投资失败');
  // 行进显灵·投资加倍（GOD-04/05 大/小福神）：一次加盖两层，费用按实际层数计
  const target = Math.min(MAX_GRADE, prop.grade + (godDoublesBuild(p) ? 2 : 1));
  let cost = 0;
  for (let g = prop.grade; g < target; g++) cost += landUpgradeCost(state, c, g);
  if (p.cash < cost) throw new Error('现金不足');
  p.cash -= cost;
  const levels = target - prop.grade;
  prop.grade = target as 1 | 2 | 3 | 4 | 5;
  if (levels > 1) log(state, `福神显灵，投资加倍，一次加盖 ${levels} 层`);
  if (c.type === 'commercial') {
    log(state, `${p.name} 花费 ¥${cost} 将「${c.name}」的${FACILITIES[prop.facility!].name}升级为${gradeName(prop.grade)}（${prop.grade} 级）`);
  } else {
    log(state, `${p.name} 花费 ¥${cost} 将「${c.name}」升级为${gradeName(prop.grade)}（${prop.grade} 级）`);
  }
  advanceTurn(state);
}

/** EST-07 建设：在自有商业用地上选择并建成一种设施（同一次停留可继续升级） */
function buildFacility(state: GameState, action: Extract<PlayerAction, { type: 'BUILD_FACILITY' }>): void {
  if (state.phase !== 'awaiting_action') throw new Error('当前不能建设');
  const p = currentPlayer(state);
  const c = cellAt(state, p.position);
  if (c.type !== 'commercial' || c.price === undefined) throw new Error('此格不是商业用地');
  const owned = cellOwner(state, c.id);
  if (!owned || owned.player.id !== p.id) throw new Error('只能在自己的商业用地上建设');
  if (owned.property.facility) throw new Error('该用地已建有设施，可用改建卡变更项目');
  const def = FACILITIES[action.facility];
  if (!def) throw new Error('未知设施项目');
  if (godBlocksInvestment(p)) throw new Error('衰神附身，投资失败');
  const cost = facilityBuildCost(state, c, action.facility);
  if (p.cash < cost) throw new Error('现金不足');
  p.cash -= cost;
  owned.property.facility = action.facility;
  if (godDoublesBuild(p) && def.upgradeable) {
    // 行进显灵·投资加倍（GOD-04/05）：可升级设施直接建成 2 级
    owned.property.grade = 2;
    log(state, `${p.name} 花费 ¥${cost} 在「${c.name}」建成${def.name}，福神显灵投资加倍直抵 ${gradeName(2)}`);
    return;
  }
  log(state, `${p.name} 花费 ¥${cost} 在「${c.name}」建成${def.name}`);
}

/** EST-09/10 研究所立项：按所等级解锁项目，到期后由 researchTickHook 交付道具 */
function startResearch(state: GameState, action: Extract<PlayerAction, { type: 'START_RESEARCH' }>): void {
  if (state.phase !== 'awaiting_action') throw new Error('当前不能立项研发');
  const p = currentPlayer(state);
  if (p.research) throw new Error('已有研发项目在进行中');
  const c = cellAt(state, p.position);
  if (c.type !== 'commercial') throw new Error('此格不是商业用地');
  const owned = cellOwner(state, c.id);
  if (!owned || owned.player.id !== p.id) throw new Error('只能在自己的研究所立项');
  if (owned.property.facility !== 'lab') throw new Error('此处不是研究所');
  const def = researchDef(action.itemId);
  if (!def) throw new Error('未知研发项目');
  if (def.level > owned.property.grade) throw new Error(`研究所等级不足（需 Lv${def.level}）`);
  p.research = { itemId: def.itemId, remainDays: def.days };
  log(state, `${p.name} 在「${c.name}」立项研发「${ITEMS[def.itemId]?.name ?? def.itemId}」，预计 ${def.days} 天完成`);
}

/** 三仙归洞：猜杯（球的位置由引擎确定性 RNG 决定，可回放） */
function minigamePick(state: GameState, action: Extract<PlayerAction, { type: 'MINIGAME_PICK' }>): void {
  if (state.phase !== 'awaiting_pick' || !state.minigame) throw new Error('当前没有进行中的小游戏');
  if (state.minigame.kind === 'memory') {
    memoryFlip(state, action.hole);
    return;
  }
  const p = currentPlayer(state);
  const hole = action.hole;
  if (hole !== 0 && hole !== 1 && hole !== 2) throw new Error('杯号必须是 0-2');
  const draw = nextRandom(state.rngState);
  state.rngState = draw.nextState;
  const ball = Math.floor(draw.value * 3);
  const hit = hole === ball;
  state.minigame.hits.push(hit);
  const roundNo = state.minigame.round + 1;
  if (hit) {
    log(state, `${p.name} 第 ${roundNo} 轮猜中了！`);
  } else {
    log(state, `${p.name} 第 ${roundNo} 轮猜错，球在 ${ball + 1} 号杯`);
  }

  if (state.minigame.round < 2) {
    state.minigame.round = (state.minigame.round + 1) as 0 | 1 | 2;
    return;
  }

  // 3 轮结束，结算奖励
  const hits = state.minigame.hits.filter(Boolean).length;
  const payoutTable = [-200, 100, 500, 1200];
  const payout = scaled(state, payoutTable[hits]!);
  if (payout >= 0) {
    p.cash += payout;
    log(state, `小游戏结束：命中 ${hits}/3，${p.name} 获得 ¥${payout}`);
  } else {
    log(state, `小游戏结束：全军覆没，${p.name} 支付门票 ¥${-payout}`);
    payCash(state, p, -payout, null);
  }
  awardMinigamePoints(state, p, hits);
  state.minigame = null;
  if (isGameOver(state)) return;
  advanceTurn(state);
}

/** 游戏厅小游戏发放点券（波 2 前的点券来源） */
function awardMinigamePoints(state: GameState, p: Player, hits: number): void {
  if (hits <= 0) return;
  const pts = hits * MINIGAME_POINTS_PER_HIT;
  p.points += pts;
  log(state, `${p.name} 额外获得 ${pts} 点券`);
}

/** 记忆翻牌：hole 为 0-7 的牌下标 */
function memoryFlip(state: GameState, index: number): void {
  const mg = state.minigame!;
  if (!Number.isInteger(index) || index < 0 || index > 7) throw new Error('牌下标必须是 0-7');
  if (mg.matched[index]) throw new Error('这张牌已配对消除');
  if (mg.revealed.includes(index)) throw new Error('这张牌已经翻开');
  if (mg.flips >= 8) throw new Error('翻牌次数已用完');
  const p = currentPlayer(state);

  mg.revealed.push(index);
  mg.flips += 1;
  if (mg.revealed.length < 2) {
    log(state, `${p.name} 翻开第 ${index + 1} 张牌`);
    return;
  }

  // 第二张：判定配对
  const [a, b] = mg.revealed;
  if (mg.symbols[a!] === mg.symbols[b!]) {
    mg.matched[a!] = true;
    mg.matched[b!] = true;
    mg.revealed = [];
    log(state, `${p.name} 翻牌配对成功！（${mg.matched.filter(Boolean).length / 2}/4 对）`);
  } else {
    mg.revealed = [];
    log(state, `${p.name} 翻牌未配对，牌面重新盖回`);
  }

  // 终局判定：全部配对 或 翻牌次数用尽
  const pairs = mg.matched.filter(Boolean).length / 2;
  if (pairs === 4 || mg.flips >= 8) {
    const payout = scaled(state, pairs * 500 - mg.flips * 100);
    if (payout >= 0) {
      p.cash += payout;
      log(state, `记忆翻牌结束：配对 ${pairs}/4（翻牌 ${mg.flips} 次），${p.name} 获得 ¥${payout}`);
    } else {
      log(state, `记忆翻牌结束：配对 ${pairs}/4（翻牌 ${mg.flips} 次），${p.name} 支付 ¥${-payout}`);
      payCash(state, p, -payout, null);
    }
    awardMinigamePoints(state, p, pairs);
    state.minigame = null;
    if (isGameOver(state)) return;
    advanceTurn(state);
  }
}

function endTurn(state: GameState): void {
  if (state.phase !== 'awaiting_action') throw new Error('当前不能结束回合');
  const p = currentPlayer(state);
  log(state, `${p.name} 选择不操作，结束回合`);
  advanceTurn(state);
}

/** 校验并返回本回合银行访问上下文 */
function requireBank(state: GameState): { p: Player; bank: BankAccess } {
  if (state.phase !== 'awaiting_action') throw new Error('当前不能进行银行操作');
  const bank = state.bankAccess;
  if (!bank) throw new Error('不在银行，不能进行银行操作');
  if (gameDate(state).isHoliday) throw new Error('例假日银行休市');
  return { p: currentPlayer(state), bank };
}

function assertAmount(amount: number): void {
  if (!Number.isInteger(amount) || amount <= 0) throw new Error('金额必须为正整数');
}

/** 存款：现金 → 存款 */
function depositMoney(state: GameState, amount: number): void {
  const { p, bank } = requireBank(state);
  if (!bank.canDeposit) throw new Error('此处不能存款');
  assertAmount(amount);
  if (p.cash < amount) throw new Error('现金不足');
  p.cash -= amount;
  p.deposit += amount;
  log(state, `${p.name} 存入 ¥${amount}（存款余额 ¥${p.deposit}）`);
}

/** 取款：存款 → 现金 */
function withdrawMoney(state: GameState, amount: number): void {
  const { p, bank } = requireBank(state);
  if (!bank.canDeposit) throw new Error('此处不能取款');
  assertAmount(amount);
  if (p.deposit < amount) throw new Error('存款不足');
  p.deposit -= amount;
  p.cash += amount;
  log(state, `${p.name} 取出 ¥${amount}（存款余额 ¥${p.deposit}）`);
}

/** 贷款：无利息，3 个月后到期强制全额归还 */
function takeLoan(state: GameState, amount: number): void {
  const { p, bank } = requireBank(state);
  if (!bank.canLoan) throw new Error('此处不能贷款');
  if (p.loan) throw new Error('已有未还清的贷款');
  assertAmount(amount);
  if (amount > MAX_LOAN) throw new Error(`单笔贷款上限 ¥${MAX_LOAN}`);
  const today = gameDate(state);
  const dueSerial = toSerial(addMonths({ year: today.year, month: today.month, day: today.day }, LOAN_TERM_MONTHS));
  const dueDayIndex = dueSerial - toSerial(state.calendar.start);
  p.loan = { principal: amount, takenAtDayIndex: state.calendar.elapsedDays, dueDayIndex };
  p.cash += amount;
  log(state, `${p.name} 向银行借款 ¥${amount}，${LOAN_TERM_MONTHS} 个月后到期（第 ${dueDayIndex} 天）`);
}

/** 还贷：可部分或全额提前归还（现金支付） */
function repayLoan(state: GameState, amount: number): void {
  const { p, bank } = requireBank(state);
  if (!bank.canLoan) throw new Error('此处不能还贷');
  if (!p.loan) throw new Error('当前没有贷款');
  assertAmount(amount);
  const principal = p.loan.principal;
  const paid = Math.min(amount, principal);
  if (p.cash < paid) throw new Error('现金不足');
  p.cash -= paid;
  const remaining = principal - paid;
  if (remaining <= 0) {
    p.loan = null;
    log(state, `${p.name} 提前还清贷款 ¥${principal}`);
  } else {
    p.loan.principal = remaining;
    log(state, `${p.name} 归还贷款 ¥${paid}（剩余 ¥${remaining}）`);
  }
}

/**
 * 卡片统一入口（CARD-01..30）。
 * 阶段校验 → 目标解析 → 效果结算 → 消耗一张手牌。
 */
function useCard(state: GameState, action: Extract<PlayerAction, { type: 'USE_CARD' }>): void {
  const p = currentPlayer(state);
  const card = CARDS[action.cardId];
  if (!card) throw new Error('未知卡片');
  if (!p.cards.includes(card.id)) throw new Error('没有这张卡片');
  if (card.auto) throw new Error('该卡片为自动触发，不能主动使用');
  if (!card.available) throw new Error('该卡片尚未开放');
  if (state.phase !== 'awaiting_roll' && state.phase !== 'awaiting_action') throw new Error('当前不能使用卡片');
  if (card.phase === 'pre_roll' && state.phase !== 'awaiting_roll') throw new Error('该卡片只能在掷骰前使用');
  if (card.phase === 'post_roll' && state.phase !== 'awaiting_action') throw new Error('该卡片只能在掷骰后使用');

  /** 需要显式传入的目标格（换地/换屋） */
  const requireCellId = (): number => {
    const id = action.cellId;
    if (id === undefined || !state.board[id]) throw new Error('请选择有效的目标格');
    return id;
  };
  /** 任意土地/建筑目标，缺省取脚下 */
  const anyCellId = (): number => {
    const id = action.cellId ?? p.position;
    if (!state.board[id]) throw new Error('请选择有效的目标格');
    return id;
  };
  const targetPlayer = (): Player => {
    const t = state.players.find((q) => q.id === action.targetPlayerId);
    if (!t || t.id === p.id || t.bankrupt) throw new Error('请选择有效的目标玩家');
    return t;
  };

  switch (card.id) {
    case 'even-all': {
      const active = state.players.filter((q) => !q.bankrupt);
      const pool = active.reduce((sum, q) => sum + q.cash, 0);
      const avg = Math.floor(pool / active.length);
      for (const q of active) q.cash = avg;
      p.cash += pool - avg * active.length; // 余数归使用者（V0 简化）
      log(state, `${p.name} 使用「均富卡」，所有玩家现金变为 ¥${avg}`);
      break;
    }
    case 'even-target': {
      const t = targetPlayer();
      const pool = p.cash + t.cash;
      const avg = Math.floor(pool / 2);
      p.cash = avg + (pool - avg * 2);
      t.cash = avg;
      log(state, `${p.name} 对 ${t.name} 使用「均贫卡」，双方现金变为 ¥${avg}`);
      break;
    }
    case 'buy-land': {
      const id = anyCellId();
      const c = state.board[id]!;
      if (c.type !== 'property' && c.type !== 'commercial') throw new Error('目标不是土地');
      if (c.price === undefined) throw new Error('目标不是土地');
      const owned = cellOwner(state, id);
      if (!owned) throw new Error('该土地无主，无需收购');
      if (owned.player.id === p.id) throw new Error('这里已经是你的土地');
      let base = c.price;
      for (let g = 1; g < owned.property.grade; g++) base += upgradeCost(c.price, g);
      const value = scaled(state, base);
      if (p.cash < value) throw new Error(`现金不足（需 ¥${value}），购地失败`);
      p.cash -= value;
      owned.player.properties = owned.player.properties.filter((q) => q.cellId !== id);
      // 连房屋（等级/设施/连锁店状态）一并取得
      p.properties.push({ ...owned.property });
      log(state, `${p.name} 使用「购地卡」，以 ¥${value} 强制收购 ${owned.player.name} 的「${c.name}」（含 ${gradeName(owned.property.grade)}）`);
      break;
    }
    case 'swap-land': {
      const toId = requireCellId();
      if (toId === p.position) throw new Error('请选择与脚下不同的土地');
      const fromCell = state.board[p.position]!;
      const toCell = state.board[toId]!;
      if (fromCell.type !== toCell.type) throw new Error('只能同类互换（住宅换住宅 / 商业换商业）');
      if (fromCell.type !== 'property' && fromCell.type !== 'commercial') throw new Error('换地双方都必须是土地');
      const mine = propOf(p, p.position);
      if (!mine) throw new Error('脚下的土地不属于你');
      const owned = cellOwner(state, toId);
      if (!owned) throw new Error('目标土地无主');
      if (owned.player.id === p.id) throw new Error('目标土地已属于你');
      owned.player.properties = owned.player.properties.filter((q) => q.cellId !== toId);
      p.properties = p.properties.filter((q) => q.cellId !== p.position);
      p.properties.push(owned.property);
      owned.player.properties.push(mine);
      log(state, `${p.name} 使用「换地卡」，以「${fromCell.name}」换取 ${owned.player.name} 的「${toCell.name}」`);
      break;
    }
    case 'swap-house': {
      const toId = requireCellId();
      if (toId === p.position) throw new Error('请选择与脚下不同的土地');
      const fromCell = state.board[p.position]!;
      const toCell = state.board[toId]!;
      if (fromCell.type !== toCell.type) throw new Error('只能同类互换（住宅换住宅 / 商业换商业）');
      if (fromCell.type !== 'property' && fromCell.type !== 'commercial') throw new Error('换屋双方都必须是土地');
      const mine = propOf(p, p.position);
      if (!mine) throw new Error('脚下的土地不属于你');
      const owned = cellOwner(state, toId);
      if (!owned) throw new Error('目标土地无主');
      if (owned.player.id === p.id) throw new Error('目标土地已属于你');
      const grade = mine.grade;
      mine.grade = owned.property.grade;
      owned.property.grade = grade;
      log(state, `${p.name} 使用「换屋卡」，以「${fromCell.name}」的房屋换取 ${owned.player.name}「${toCell.name}」的房屋`);
      break;
    }
    case 'turnaround': {
      for (const q of state.players) {
        if (!q.bankrupt) q.direction = q.direction === 1 ? -1 : 1;
      }
      log(state, `${p.name} 使用「转向卡」，所有玩家行进方向 180° 反转`);
      break;
    }
    case 'rebuild': {
      const id = anyCellId();
      const c = state.board[id]!;
      const owned = cellOwner(state, id);
      if (!owned) throw new Error('目标土地上没有建筑');
      if (c.type === 'property') {
        // CARD-07：住宅建筑 ⇄ 连锁商店互转（EST-04；改建后不能再加盖）
        owned.property.chain = !owned.property.chain;
        log(state, `${p.name} 使用「改建卡」，将 ${owned.player.name} 的「${c.name}」${owned.property.chain ? '改建为连锁店（不能再加盖）' : '改回一般建筑'}`);
      } else if (c.type === 'commercial') {
        // CARD-07：变更商业用地设施项目（EST-07）
        const current = owned.property.facility;
        if (!current) throw new Error('该商业用地尚未建设，无法变更设施项目');
        const next = action.facility;
        if (!next || !FACILITIES[next]) throw new Error('请选择新的设施项目');
        if (next === current) throw new Error('设施项目没有变化');
        owned.property.facility = next;
        log(state, `${p.name} 使用「改建卡」，将「${c.name}」的${FACILITIES[current].name}变更为${FACILITIES[next].name}`);
      } else {
        throw new Error('改建卡只能用于住宅建筑或商业用地设施');
      }
      break;
    }
    case 'angel-road': {
      const id = anyCellId();
      const c = state.board[id]!;
      if (c.type !== 'property' && c.type !== 'commercial') throw new Error('目标必须是土地');
      const cells = routeSegment(state, id);
      let count = 0;
      for (const cellId of cells) {
        const owned = cellOwner(state, cellId);
        if (!owned) continue;
        const cc = state.board[cellId]!;
        if (cc.type === 'commercial') {
          // 商业用地：只有可升级的已建设施能加盖（EST-07/08/11）
          if (!facilityUpgradeable(owned.property) || owned.property.grade >= MAX_GRADE) continue;
        } else if (owned.property.chain || owned.property.grade >= MAX_GRADE) {
          continue; // 连锁店不能再加盖（EST-04）
        }
        owned.property.grade = (owned.property.grade + 1) as 1 | 2 | 3 | 4 | 5;
        count += 1;
      }
      if (count === 0) throw new Error('该路段没有可加盖的房屋');
      log(state, `${p.name} 使用「天使卡」，路段「${c.name}」共 ${count} 处房屋加盖一层`);
      break;
    }
    case 'devil-road': {
      const id = anyCellId();
      const c = state.board[id]!;
      if (c.type !== 'property' && c.type !== 'commercial') throw new Error('目标必须是土地');
      const cells = routeSegment(state, id);
      let count = 0;
      for (const q of state.players) {
        const before = q.properties.length;
        q.properties = q.properties.filter((prop) => !cells.includes(prop.cellId));
        count += before - q.properties.length;
      }
      if (count === 0) throw new Error('该路段没有可拆除的建筑');
      log(state, `${p.name} 使用「恶魔卡」，路段「${c.name}」共 ${count} 处地产被夷为平地`);
      break;
    }
    case 'monster': {
      const id = anyCellId();
      const owned = cellOwner(state, id);
      if (!owned || owned.property.grade < 2) throw new Error('目标没有可摧毁的建筑');
      owned.property.grade = 1;
      log(state, `${p.name} 使用「怪兽卡」，${owned.player.name} 的「${state.board[id]!.name}」建筑被彻底摧毁`);
      break;
    }
    case 'demolish': {
      const id = anyCellId();
      const owned = cellOwner(state, id);
      if (owned && owned.property.grade > 1) {
        owned.property.grade = (owned.property.grade - 1) as 1 | 2 | 3 | 4 | 5;
        log(state, `${p.name} 使用「拆除卡」，${owned.player.name} 的「${state.board[id]!.name}」被拆至 ${owned.property.grade} 级`);
      } else if (state.mines.includes(id)) {
        state.mines = state.mines.filter((m) => m !== id);
        log(state, `${p.name} 使用「拆除卡」，清除了「${state.board[id]!.name}」的地雷`);
      } else if (state.roadblocks.includes(id)) {
        state.roadblocks = state.roadblocks.filter((m) => m !== id);
        log(state, `${p.name} 使用「拆除卡」，清除了「${state.board[id]!.name}」的路障`);
      } else {
        throw new Error('目标没有可拆除的建筑或道具');
      }
      break;
    }
    case 'snatch': {
      const t = targetPlayer();
      const pool: string[] = [];
      for (const cid of t.cards) pool.push(`card:${cid}`);
      for (const [iid, n] of Object.entries(t.items)) for (let k = 0; k < n; k++) pool.push(`item:${iid}`);
      if (pool.length === 0) throw new Error('对方没有可抢夺的卡片或道具');
      const [kind, id] = pool[randomIndex(state, pool.length)]!.split(':') as ['card' | 'item', string];
      if (kind === 'card') {
        if (p.cards.length >= MAX_HAND_CARDS) throw new Error('你的手牌已满，无法接收抢夺物');
        consumeCard(t, id);
        p.cards.push(id);
        log(state, `${p.name} 使用「抢夺卡」，抢走 ${t.name} 的卡片「${CARDS[id]?.name ?? id}」`);
      } else {
        if ((p.items[id] ?? 0) >= MAX_ITEM_COUNT) throw new Error('你的道具已满，无法接收抢夺物');
        consumeItem(t, id);
        p.items[id] = (p.items[id] ?? 0) + 1;
        log(state, `${p.name} 使用「抢夺卡」，抢走 ${t.name} 的「${ITEMS[id]?.name ?? id}」`);
      }
      break;
    }
    case 'hold': {
      const t = targetPlayer();
      t.holdTurns += 1;
      log(state, `${p.name} 对 ${t.name} 使用「停留卡」，其下一次前进将原地不动`);
      break;
    }
    case 'hibernate': {
      const others = state.players.filter((q) => !q.bankrupt && q.id !== p.id);
      if (!others.length) throw new Error('没有其他对手');
      for (const q of others) {
        q.skipTurns = Math.max(q.skipTurns, 5);
        blockRent(q, 5);
      }
      log(state, `${p.name} 使用「冬眠卡」，所有对手睡眠 5 天并丧失收租权利`);
      break;
    }
    case 'sleepwalk': {
      const t = targetPlayer();
      applyDisaster(state, t, 'sleepwalk', p, (v) => {
        v.sleepwalkTurns = Math.max(v.sleepwalkTurns, 5);
        blockRent(v, 5);
        log(state, `${v.name} 陷入梦游 5 天，丧失收租与买地权利`);
      });
      break;
    }
    case 'frame': {
      const t = targetPlayer();
      applyDisaster(state, t, 'frame', p, (v) => {
        v.skipTurns = Math.max(v.skipTurns, 5);
        blockRent(v, 5);
        log(state, `${v.name} 被陷害入狱 5 天，丧失收租权利`);
      });
      break;
    }
    case 'send-god': {
      let done = false;
      const bomb = state.bombs.find((b) => b.playerId === p.id);
      if (bomb) {
        state.bombs = state.bombs.filter((b) => b !== bomb);
        log(state, `${p.name} 使用「送神卡」，拆走了身上的定时炸弹`);
        done = true;
      }
      if (p.god) {
        const godName = godDef(p.god.godId)?.name ?? '神明';
        p.god = null;
        log(state, `${p.name} 使用「送神卡」，送走了 ${godName}`);
        done = true;
      }
      if (!done) throw new Error('身上没有神明或定时炸弹');
      break;
    }
    case 'invite-god': {
      summonGod(state, p);
      break;
    }
    case 'red-card':
    case 'black-card': {
      const stock = action.stockId ? stockById(state, action.stockId) : undefined;
      if (!stock) throw new Error('请选择有效的股票');
      const kind = card.id === 'red-card' ? 'up' : 'down';
      const opposite = state.stockHalts.find((h) => h.stockId === stock.id && h.kind !== kind);
      if (opposite) {
        state.stockHalts = state.stockHalts.filter((h) => h !== opposite);
        log(state, `${p.name} 使用「${card.name}」，与反向操作互相抵消，${stock.name} 恢复自由涨跌`);
      } else {
        state.stockHalts = state.stockHalts.filter((h) => h.stockId !== stock.id);
        state.stockHalts.push({ stockId: stock.id, kind, daysLeft: 3 });
        const pct = kind === 'up' ? 15 : -15;
        stock.price = Math.max(5, Math.round(stock.price * (1 + pct / 100)));
        log(state, `${p.name} 使用「${card.name}」，${stock.name} ${kind === 'up' ? '涨停' : '跌停'}板 3 天（现价 ¥${stock.price}）`);
      }
      break;
    }
    case 'tax-audit': {
      const t = targetPlayer();
      if (consumeCard(t, 'free-pass')) {
        log(state, `${t.name} 使用「免费卡」，抵免了查税`);
        break;
      }
      if (t.cards.includes('shift-blame')) {
        const others = state.players.filter((q) => !q.bankrupt && q.id !== t.id && q.id !== p.id);
        const victim = others.length > 0 ? others[randomIndex(state, others.length)]! : p;
        consumeCard(t, 'shift-blame');
        log(state, `${t.name} 使用「嫁祸卡」，把查税转嫁给 ${victim.name}`);
        pay(state, victim, Math.floor(victim.cash * 0.2), p, { reason: 'card' });
        break;
      }
      const tax = Math.floor(t.cash * 0.2);
      log(state, `${p.name} 使用「查税卡」，强制收取 ${t.name} 20% 现金税 ¥${tax}`);
      pay(state, t, tax, p, { reason: 'card' });
      break;
    }
    case 'raise-rent':
    case 'seal-rent': {
      const id = anyCellId();
      const c = state.board[id]!;
      if (c.type !== 'property') throw new Error('目标必须是土地');
      const cells = routeSegment(state, id);
      const kind = card.id === 'raise-rent' ? 'raise' : 'seal';
      // 查封 ⇄ 涨价 互反：同路段的旧效果被覆盖
      state.rentEffects = state.rentEffects.filter((e) => !e.cells.some((x) => cells.includes(x)));
      state.rentEffects.push({ kind, daysLeft: 5, cells, ownerId: p.id });
      log(state, `${p.name} 使用「${card.name}」，路段「${c.name}」${kind === 'raise' ? '加倍收取过路费' : '免收过路费'} 5 天`);
      break;
    }
    case 'alliance': {
      const t = targetPlayer();
      p.alliance = { with: t.id, daysLeft: 7 };
      t.alliance = { with: p.id, daysLeft: 7 };
      log(state, `${p.name} 与 ${t.name} 结盟 7 天，互不收过路费`);
      break;
    }
    case 'turtle': {
      for (const q of state.players) {
        if (q.bankrupt) continue;
        if (q.id === p.id) {
          q.turtleTurns = Math.max(q.turtleTurns, 3);
          log(state, `${q.name} 受乌龟卡影响，3 天内一次只走一步`);
          continue;
        }
        applyDisaster(state, q, 'turtle', p, (v) => {
          v.turtleTurns = Math.max(v.turtleTurns, 3);
          log(state, `${v.name} 受乌龟卡影响，3 天内一次只走一步`);
        });
      }
      break;
    }
    default:
      throw new Error('未知卡片效果');
  }
  consumeCard(p, card.id);
}

/** 购买卡片（CARD-*）：点券结算，手牌上限 15（波 2：货币由现金改为点券） */
function buyCard(state: GameState, action: Extract<PlayerAction, { type: 'BUY_CARD' }>): void {
  if (state.phase !== 'awaiting_action') throw new Error('当前不能购买卡片');
  const p = currentPlayer(state);
  if (!isShopCell(cellAt(state, p.position))) throw new Error('不在商店，不能购买卡片');
  const card = CARDS[action.cardId];
  if (!card || !SHOP_CARD_IDS.includes(card.id)) throw new Error('商店不出售这张卡片');
  if (p.cards.length >= MAX_HAND_CARDS) throw new Error(`手牌已满（上限 ${MAX_HAND_CARDS}），请先舍弃卡片`);
  if (p.points < card.cost) throw new Error('点券不足');
  p.points -= card.cost;
  p.cards.push(card.id);
  log(state, `${p.name} 以 ${card.cost} 点券购入「${card.name}」`);
}

/** 舍弃手牌（满手时的腾位手段；仅在自己回合内可用） */
function discardCard(state: GameState, action: Extract<PlayerAction, { type: 'DISCARD_CARD' }>): void {
  if (state.phase !== 'awaiting_roll' && state.phase !== 'awaiting_action') throw new Error('当前不能舍弃卡片');
  const p = currentPlayer(state);
  if (!consumeCard(p, action.cardId)) throw new Error('没有这张卡片');
  log(state, `${p.name} 舍弃了卡片「${CARDS[action.cardId]?.name ?? action.cardId}」`);
}

/** 购买道具（ITEM-01..08）：点券结算，每种道具上限 9（MAX_ITEM_COUNT） */
function buyItem(state: GameState, action: Extract<PlayerAction, { type: 'BUY_ITEM' }>): void {
  if (state.phase !== 'awaiting_action') throw new Error('当前不能购买道具');
  const p = currentPlayer(state);
  if (!isShopCell(cellAt(state, p.position))) throw new Error('不在商店，不能购买道具');
  const item = ITEMS[action.itemId];
  if (!item || !SHOP_ITEM_IDS.includes(item.id)) throw new Error('商店不出售这种道具');
  if ((p.items[item.id] ?? 0) >= MAX_ITEM_COUNT) throw new Error(`该道具已达上限（${MAX_ITEM_COUNT} 个）`);
  const cost = item.cost ?? 0;
  if (p.points < cost) throw new Error('点券不足');
  p.points -= cost;
  p.items[item.id] = (p.items[item.id] ?? 0) + 1;
  log(state, `${p.name} 以 ${cost} 点券购入「${item.name}」`);
}

/** 使用道具（ITEM-01..13） */
function useItem(state: GameState, action: Extract<PlayerAction, { type: 'USE_ITEM' }>): void {
  const p = currentPlayer(state);
  const item = ITEMS[action.itemId];
  if (!item) throw new Error('未知道具');
  if ((p.items[item.id] ?? 0) <= 0) throw new Error('没有这个道具');
  if (state.phase !== 'awaiting_roll' && state.phase !== 'awaiting_action') throw new Error('当前不能使用道具');
  if (item.phase === 'pre_roll' && state.phase !== 'awaiting_roll') throw new Error('该道具只能在掷骰前使用');
  if (item.phase === 'post_roll' && state.phase !== 'awaiting_action') throw new Error('该道具只能在掷骰后使用');

  /** 目标格，缺省取脚下 */
  const anyCellId = (): number => {
    const id = action.cellId ?? p.position;
    if (!state.board[id]) throw new Error('请选择有效的目标格');
    return id;
  };

  switch (item.id) {
    case 'robot-doll': {
      // ITEM-01：踢除前方 9 步内的路障 / 地雷 / 定时炸弹
      const ahead: number[] = [];
      for (let i = 1; i <= 9; i++) ahead.push((p.position + p.direction * i + BOARD_SIZE) % BOARD_SIZE);
      const beforeRoad = state.roadblocks.length;
      const beforeMine = state.mines.length;
      state.roadblocks = state.roadblocks.filter((id) => !ahead.includes(id));
      state.mines = state.mines.filter((id) => !ahead.includes(id));
      let defused = 0;
      for (const q of state.players) {
        if (q.bankrupt || !ahead.includes(q.position)) continue;
        const bomb = state.bombs.find((b) => b.playerId === q.id);
        if (bomb) {
          state.bombs = state.bombs.filter((b) => b !== bomb);
          defused += 1;
        }
      }
      const cleared = beforeRoad - state.roadblocks.length + (beforeMine - state.mines.length) + defused;
      if (cleared === 0) throw new Error('前方 9 步内没有障碍物');
      log(state, `${p.name} 使用「机器娃娃」，清除前方 9 步内 ${cleared} 处障碍`);
      break;
    }
    case 'roadblock': {
      // ITEM-02：在没有他人停留的道路上设置路障（可挡自己也可害别人）
      const id = anyCellId();
      if (state.roadblocks.includes(id)) throw new Error('此处已有路障');
      if (state.players.some((q) => !q.bankrupt && q.id !== p.id && q.position === id)) {
        throw new Error('此处有玩家停留，不能放置路障');
      }
      state.roadblocks = [...state.roadblocks, id];
      log(state, `${p.name} 在「${state.board[id]!.name}」设置路障`);
      break;
    }
    case 'mine': {
      // ITEM-03：埋设地雷，踩中者住院 3 天（也可能害到自己）
      const id = anyCellId();
      if (state.mines.includes(id)) throw new Error('此处已有地雷');
      if (state.players.some((q) => !q.bankrupt && q.id !== p.id && q.position === id)) {
        throw new Error('此处有玩家停留，不能埋设地雷');
      }
      state.mines = [...state.mines, id];
      log(state, `${p.name} 在「${state.board[id]!.name}」埋设地雷`);
      break;
    }
    case 'time-bomb': {
      // ITEM-04：附身走满 38 步爆炸（可蹭到他人时转手）
      if (state.bombs.some((b) => b.playerId === p.id)) throw new Error('身上已有定时炸弹');
      state.bombs = [...state.bombs, { playerId: p.id, stepsLeft: 38 }];
      log(state, `${p.name} 装上定时炸弹（38 步后爆炸），快蹭给别人！`);
      break;
    }
    case 'motorbike':
      // ITEM-05：骰子数增至 2 个
      p.diceCount = Math.max(p.diceCount, 2);
      log(state, `${p.name} 骑上机车，骰子数增至 2 个`);
      break;
    case 'car':
      // ITEM-06：骰子数增至 3 个
      p.diceCount = Math.max(p.diceCount, 3);
      log(state, `${p.name} 开上汽车，骰子数增至 3 个`);
      break;
    case 'missile': {
      // ITEM-07：3×3 范围轰炸，人屋俱毁，被炸者住院 3 天
      const id = anyCellId();
      detonate(state, id, 1, 3, `飞弹轰炸「${state.board[id]!.name}」`);
      break;
    }
    case 'remote-dice-item': {
      // ITEM-08：控制下一次掷骰点数
      const v = action.diceValue;
      if (v === undefined || !Number.isInteger(v) || v < 1 || v > 6) throw new Error('请指定 1-6 的点数');
      state.pendingFixedDice = v;
      log(state, `${p.name} 使用遥控骰子，下一次掷骰固定为 ${v} 点`);
      break;
    }
    case 'robot-worker': {
      // ITEM-09（研究所 Lv1）：在自家土地免费加盖一级
      const id = anyCellId();
      const owned = cellOwner(state, id);
      if (!owned || owned.player.id !== p.id) throw new Error('只能加盖自己的土地');
      if (owned.property.chain) throw new Error('连锁店不能再加盖（EST-04）');
      if (owned.property.grade >= MAX_GRADE) throw new Error('该土地已是最高等级');
      owned.property.grade = (owned.property.grade + 1) as 1 | 2 | 3 | 4 | 5;
      log(state, `${p.name} 使用机器工人，「${state.board[id]!.name}」免费加盖至 ${owned.property.grade} 级`);
      break;
    }
    case 'time-machine': {
      // ITEM-10（研究所 Lv2）：所有人回复上一回合状态（位置/现金/存款/地产/持股）
      const snap = state.lastRoundSnapshot;
      if (!snap) throw new Error('暂无上一回合记录，无法回到过去');
      for (const q of state.players) {
        const s = snap.players.find((r) => r.id === q.id);
        if (!s) continue;
        q.position = s.position;
        q.cash = s.cash;
        q.deposit = s.deposit;
        q.properties = s.properties.map((prop) => ({ ...prop }));
        q.stocks = { ...s.stocks };
      }
      log(state, `${p.name} 使用时光机，所有人回复到上一回合的状态`);
      break;
    }
    case 'teleporter': {
      // ITEM-11（研究所 Lv3）：瞬间移动到指定空道路，本回合不再前进
      const id = anyCellId();
      if (id === p.position) throw new Error('请选择与脚下不同的地点');
      if (state.players.some((q) => !q.bankrupt && q.id !== p.id && q.position === id)) {
        throw new Error('目标道路已有玩家停留');
      }
      p.position = id;
      // V0 简化：传送不结算落点事件（波 3 精修）
      log(state, `${p.name} 使用传送机，瞬间移动到「${state.board[id]!.name}」`);
      break;
    }
    case 'bulldozer':
      // ITEM-12（研究所 Lv4）：7 回合内走到哪拆到哪
      p.bulldozerTurns = 7;
      log(state, `${p.name} 启动工程车，7 回合内走到哪拆到哪`);
      break;
    case 'nuke': {
      // ITEM-13（研究所 Lv5）：大范围轰炸（7 格），被炸者住院 3 天
      const id = anyCellId();
      detonate(state, id, 3, 3, `核子飞弹轰炸「${state.board[id]!.name}」`);
      break;
    }
    default:
      throw new Error('未知道具效果');
  }
  consumeItem(p, item.id);
}

/** 银行/证交所格（含 TILE-26 企业银行，CORP-09「功能与公立银行相同」） */
function isBankCell(c: BoardCell): boolean {
  return c.type === 'bank' || (c.type === 'company' && c.companyKind === 'bank');
}

/** 商店格（含 TILE-29 百货公司，CORP-12「同公立百货」） */
function isShopCell(c: BoardCell): boolean {
  return c.type === 'shop' || (c.type === 'company' && c.companyKind === 'department');
}

function buyStock(state: GameState, action: Extract<PlayerAction, { type: 'BUY_STOCK' }>): void {
  if (state.phase !== 'awaiting_action') throw new Error('当前不能交易股票');
  const p = currentPlayer(state);
  if (!isBankCell(cellAt(state, p.position))) throw new Error('不在银行/证交所，不能买入股票');
  const stock = stockById(state, action.stockId);
  if (!stock) throw new Error('未知股票');
  if (!Number.isInteger(action.quantity) || action.quantity <= 0) throw new Error('数量必须为正整数');
  const total = stock.price * action.quantity;
  if (p.cash < total) throw new Error('现金不足');
  p.cash -= total;
  p.stocks[stock.id] = (p.stocks[stock.id] ?? 0) + action.quantity;
  // ECON-10：记录建仓成本（累计投入），UI 用于展示浮动盈亏
  p.stockCost = p.stockCost ?? {};
  p.stockCost[stock.id] = (p.stockCost[stock.id] ?? 0) + total;
  log(state, `${p.name} 以 ¥${total} 买入 ${stock.name} ×${action.quantity}（单价 ¥${stock.price}）`);
}

function sellStock(state: GameState, action: Extract<PlayerAction, { type: 'SELL_STOCK' }>): void {
  if (state.phase !== 'awaiting_action') throw new Error('当前不能交易股票');
  const p = currentPlayer(state);
  if (!isBankCell(cellAt(state, p.position))) throw new Error('不在银行/证交所，不能卖出股票');
  const stock = stockById(state, action.stockId);
  if (!stock) throw new Error('未知股票');
  if (!Number.isInteger(action.quantity) || action.quantity <= 0) throw new Error('数量必须为正整数');
  const holding = p.stocks[stock.id] ?? 0;
  if (action.quantity > holding) throw new Error('持股不足');
  const total = stock.price * action.quantity;
  // ECON-10：按持股比例结转建仓成本
  const costBefore = p.stockCost?.[stock.id] ?? 0;
  const costOut = holding > 0 ? Math.round((costBefore * action.quantity) / holding) : 0;
  p.stocks[stock.id] = holding - action.quantity;
  if (p.stocks[stock.id] === 0) {
    delete p.stocks[stock.id];
    if (p.stockCost) delete p.stockCost[stock.id];
  } else if (p.stockCost) {
    p.stockCost[stock.id] = costBefore - costOut;
  }
  p.cash += total;
  log(state, `${p.name} 以 ¥${total} 卖出 ${stock.name} ×${action.quantity}（单价 ¥${stock.price}）`);
}

/**
 * CORP-01：认购公司股份。单次 ≤1000 张，按股面值现金结算。
 * 认购后重新判定经营权（CORP-02：最大持股 + 同票先到先得），董事长换人时触发融资清算。
 */
function buyShares(state: GameState, action: Extract<PlayerAction, { type: 'BUY_SHARES' }>): void {
  if (state.phase !== 'awaiting_action') throw new Error('当前不能认购股份');
  const p = currentPlayer(state);
  const c = cellAt(state, p.position);
  if (c.type !== 'company' || c.id !== action.cellId) throw new Error('不在该公司格，不能认购股份');
  const company = companyAtCell(state, c.id);
  if (!company) throw new Error('该公司不存在');
  if (!Number.isInteger(action.quantity) || action.quantity <= 0) throw new Error('股数必须为正整数');
  if (action.quantity > MAX_SHARES_PER_BUY) throw new Error(`单次认购上限 ${MAX_SHARES_PER_BUY} 张`);
  const cost = company.sharePrice * action.quantity;
  if (p.cash < cost) throw new Error('现金不足');
  p.cash -= cost;
  company.shares[p.id] = (company.shares[p.id] ?? 0) + action.quantity;
  if (company.firstHeldDayIndex[p.id] === undefined) company.firstHeldDayIndex[p.id] = state.calendar.elapsedDays;
  log(state, `${p.name} 以 ¥${cost} 认购${COMPANIES[company.kind].name} ${action.quantity} 张（持股 ${company.shares[p.id]}）`);
  recomputeCompanyChairman(state, company);
}

/**
 * CORP-02：重新判定经营权。他人持股反超即自动移交；
 * CORP-09：董事长换人时，上任董事长的特别融资须立即还清。
 */
function recomputeCompanyChairman(state: GameState, company: CompanyState): void {
  const nextId = majorityHolderId(company, state.players);
  const prevId = company.chairmanId;
  if (nextId === prevId) return;
  company.chairmanId = nextId;
  if (prevId) {
    const prev = state.players.find((q) => q.id === prevId);
    if (prev && prev.financing > 0) {
      const amount = prev.financing;
      prev.financing = 0;
      log(state, `【特别融资】${COMPANIES[company.kind].name} 董事长换人，${prev.name} 的周转融资 ¥${amount} 须立即还清`);
      pay(state, prev, amount, null, { reason: 'financing' });
    }
  }
  if (nextId) {
    const next = state.players.find((q) => q.id === nextId);
    log(state, `${next?.name ?? nextId} 取得${COMPANIES[company.kind].name}经营权，成为董事长`);
  } else {
    log(state, `${COMPANIES[company.kind].name}经营权空缺`);
  }
}

/** CORP-09：特别融资可周转额 = 其他存活玩家存款总额 */
function financingCap(state: GameState, self: Player): number {
  return state.players.reduce((sum, q) => (q.id !== self.id && !q.bankrupt ? sum + q.deposit : sum), 0);
}

/** CORP-09：企业银行董事长特别融资（周转期间存款不计息） */
function specialFinancing(state: GameState, action: Extract<PlayerAction, { type: 'SPECIAL_FINANCING' }>): void {
  if (state.phase !== 'awaiting_action') throw new Error('当前不能特别融资');
  const p = currentPlayer(state);
  const c = cellAt(state, p.position);
  if (c.type !== 'company' || c.companyKind !== 'bank') throw new Error('不在企业银行，不能特别融资');
  const company = companyAtCell(state, c.id);
  if (!company || company.chairmanId !== p.id) throw new Error('只有董事长可以特别融资');
  if (!Number.isInteger(action.amount) || action.amount <= 0) throw new Error('金额必须为正整数');
  const cap = financingCap(state, p);
  if (p.financing + action.amount > cap) throw new Error(`特别融资上限 ¥${cap}`);
  p.financing += action.amount;
  p.cash += action.amount;
  log(state, `${p.name} 以${COMPANIES.bank.name}董事长身份特别融资 ¥${action.amount}（累计 ¥${p.financing}；周转期间存款不计息）`);
}

/** CORP-13：房地产公司任选一处自有地产加盖一层，按该地地价收取施工费 */
function buildEstate(state: GameState, action: Extract<PlayerAction, { type: 'BUILD_ESTATE' }>): void {
  if (state.phase !== 'awaiting_action') throw new Error('当前不能加盖');
  const p = currentPlayer(state);
  const c = cellAt(state, p.position);
  if (c.type !== 'company' || c.companyKind !== 'estate') throw new Error('不在房地产公司，不能加盖');
  const prop = p.properties.find((q) => q.cellId === action.cellId);
  if (!prop) throw new Error('只能加盖自己的地产');
  if (prop.grade >= MAX_GRADE) throw new Error('该地产已满级');
  const target = state.board[action.cellId];
  if (!target || (target.type !== 'property' && target.type !== 'commercial') || target.price === undefined) {
    throw new Error('该格不可加盖');
  }
  if (target.type === 'commercial' && !prop.facility) throw new Error('商业用地需先建设施');
  const cost = scaled(state, Math.round(target.price * ESTATE_BUILD_RATIO));
  if (p.cash < cost) throw new Error('现金不足');
  p.cash -= cost;
  prop.grade = (prop.grade + 1) as PlayerProperty['grade'];
  const company = companyAtCell(state, c.id);
  if (company) company.surplus += cost;
  log(state, `${p.name} 通过${COMPANIES.estate.name}在「${target.name}」加盖一层（${gradeName(prop.grade)}），支付施工费 ¥${cost}`);
}

/** 测试专用：强制结束对局（其余玩家全部破产），走真实破产/胜利/战绩流程 */
export function forceGameOver(state: GameState, winnerId: string): GameState {
  const next = structuredClone(state);
  if (next.phase === 'game_over') return next;
  for (const p of next.players) {
    if (p.id === winnerId || p.bankrupt) continue;
    bankruptPlayer(next, p);
  }
  checkWinner(next);
  return next;
}

/** 唯一入口：应用玩家动作并返回新状态（纯函数，不修改传入状态） */
export function applyAction(state: GameState, action: PlayerAction): GameState {
  const next = clone(state);
  switch (action.type) {
    case 'START_GAME':
      startGame(next);
      break;
    case 'ROLL_DICE':
      rollDice(next, action);
      break;
    case 'BUY_LAND':
      buyLand(next);
      break;
    case 'UPGRADE_LAND':
      upgradeLand(next);
      break;
    case 'BUILD_FACILITY':
      buildFacility(next, action);
      break;
    case 'START_RESEARCH':
      startResearch(next, action);
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
    case 'DISCARD_CARD':
      discardCard(next, action);
      break;
    case 'USE_ITEM':
      useItem(next, action);
      break;
    case 'BUY_ITEM':
      buyItem(next, action);
      break;
    case 'BUY_STOCK':
      buyStock(next, action);
      break;
    case 'SELL_STOCK':
      sellStock(next, action);
      break;
    case 'MINIGAME_PICK':
      minigamePick(next, action);
      break;
    case 'DEPOSIT':
      depositMoney(next, action.amount);
      break;
    case 'WITHDRAW':
      withdrawMoney(next, action.amount);
      break;
    case 'TAKE_LOAN':
      takeLoan(next, action.amount);
      break;
    case 'REPAY_LOAN':
      repayLoan(next, action.amount);
      break;
    case 'BUY_SHARES':
      buyShares(next, action);
      break;
    case 'BUILD_ESTATE':
      buildEstate(next, action);
      break;
    case 'SPECIAL_FINANCING':
      specialFinancing(next, action);
      break;
    default: {
      const exhaustive: never = action;
      throw new Error(`未知动作: ${JSON.stringify(exhaustive)}`);
    }
  }
  return next;
}







