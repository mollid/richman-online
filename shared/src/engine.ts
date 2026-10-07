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
import { landPrice, landRent, landUpgradeCost, propertyValue, scaled, totalAssets, upgradeCost } from './economy.js';
import { CARDS, CHANCE_CARD_POOL, SHOP_CARD_IDS } from './cards.js';
import { ITEMS, SHOP_ITEM_IDS } from './items.js';
import { nextRandom, rollDie } from './rng.js';
import { drawWinningNumber, isValidLotteryNumber, LOTTERY_TICKET_COST } from './lottery.js';
import {
  NEWS_CATEGORY_LABEL,
  NEWS_EVENT_COUNT,
  renderNewsText,
  supportedNewsEvents,
  type NewsEventDef,
} from './news.js';
import {
  FATE_MAP_IDS,
  FATE_PUBLIC_IDS,
  fateCardById,
  renderFateText,
  type FateCardDef,
} from './fate.js';
import {
  BAIL_FEE,
  CURSE_ORDER,
  CURSES,
  MAGIC_CONDITION_LABEL,
  MAGIC_CONDITIONS,
  PROTECTION_FEE_RATE,
  THIEF_POINTS_TAKE,
  VILLAIN_DAYS,
  VILLAIN_KINDS,
  VILLAINS,
  type VillainDef,
} from './npc.js';
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
  AuctionState,
  AuctionTrigger,
  AvailableActions,
  BankAccess,
  BoardCell,
  CompanyKind,
  CompanyState,
  DateSerial,
  FacilityType,
  GameState,
  MagicOffer,
  NpcUnit,
  PendingAuction,
  Player,
  PlayerAction,
  PlayerDef,
  PlayerProperty,
  RoundSnapshot,
  VillainKind,
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
    custody: null,
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
    lotteryTickets: [],
    auction: null,
    auctionQueue: [],
    companies: COMPANY_LIST.map((def) => ({
      kind: def.kind,
      cellId: def.cellId,
      sharePrice: def.sharePrice,
      surplus: 0,
      shares: {},
      chairmanId: null,
      firstHeldDayIndex: {},
    })),
    // EVT-01：游标初值由种子派生（原版「游标从当前值起轮询」，不消耗 RNG 抽数）
    newsCursor: (seed >>> 0) % NEWS_EVENT_COUNT,
    streetPriceFactors: {},
    stockHaltAllDays: 0,
    loanBanDays: 0,
    // NPC-01..04 四大恶人初始在押于监狱；被玩家保释后上路为保释人效力
    npcs: VILLAIN_KINDS.map((kind) => ({
      kind,
      position: DEFAULT_BOARD.find((c) => c.type === 'jail')!.id,
      ownerId: null,
      daysLeft: 0,
      jailed: true,
    })),
    magic: null,
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
    // 对局结束后不再开拍，清空拍卖状态与待拍队列
    state.auction = null;
    state.auctionQueue = [];
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
  p.custody = null;
  // ECON-13：名下土地进入拍卖队列（破产清算），由拍卖器逐件开拍
  if (state.phase !== 'game_over') {
    for (const prop of p.properties) {
      const cell = state.board[prop.cellId];
      if (!cell || (cell.type !== 'property' && cell.type !== 'commercial')) continue;
      state.auctionQueue.push({ cellId: prop.cellId, sellerId: null, trigger: 'bankrupt' });
    }
  }
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
 * ECON-08：属于「运气/事件等意外损失」的支付用途——无收款方时款项汇总进乐透奖池。
 * 租金（给玩家）、贷款/特别融资（还给银行本金）、公司亏损均不计入。
 */
const LOTTERY_PENALTY_REASONS: ReadonlySet<PayReason> = new Set<PayReason>([
  'tax',
  'god',
  'news',
  'minigame',
  'card',
  'other',
]);

/**
 * EVT-02：机会/危险格的违法事件风险。
 * 判定用**只读派生随机**（`nextRandom(rngState).value` 读而不写回），
 * 因此不改变 RNG 抽数序列，对既有确定性回放零影响。
 */
const CRIME_CHANCE = 0.35;
/** EVT-02：违法事件判处拘役天数 */
const CRIME_JAIL_DAYS = 2;
/** EVT-01 事件 16/17：豪雨/交通阻塞强制停留天数 */
const TRAFFIC_HALT_DAYS = 1;
/** EVT-01 事件 24/25：股市全面崩盘/上涨的幅度（%） */
const STOCK_NEWS_PCT = 10;
/** EVT-05 七彩气球：安全通过 0/1/2/3 轮的金币奖励 */
const BALLOON_PAYOUT = [0, 200, 700, 1500];
/** EVT-05 七彩气球：踩到炸弹的门票罚金 */
const BALLOON_BOMB_FEE = 300;
/** EVT-06 企鹅挖宝：命中 0/1/2/3 次的金币奖励（负值 = 门票） */
const PENGUIN_PAYOUT = [-200, 200, 800, 2000];

/**
 * NPC-05 恶犬：日切时以**只读派生随机**决定是否出没（读而不写回 `rngState`），
 * 因此不改变 RNG 抽数序列，确定性回放不受影响。
 */
const DOG_SPAWN_CHANCE = 0.12;
/** NPC-05 恶犬：步行者被咬伤的住院天数 */
const DOG_HOSPITAL_DAYS = 3;
/** EVT-04 倒闭乞讨：路人施舍金额（固定金额，随物价指数缩放） */
const BEGGAR_ALMS = 1000;

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

  // ECON-08：运气/事件等意外损失（无收款方）的钱汇总进乐透奖池
  if (to === null && paid > 0 && opts.reason && LOTTERY_PENALTY_REASONS.has(opts.reason)) {
    state.lotteryPool += paid;
  }

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

/** `pay` 的薄包装：现金/存款/变卖，收款方入现金；`reason` 用于乐透奖池罚金汇总 */
function payCash(state: GameState, from: Player, amount: number, to: Player | null, reason?: PayReason): void {
  pay(state, from, amount, to, { toDeposit: false, reason });
}

/** EVT-01 事件 26/27：全体或单支股票是否处于停牌期（停牌期间价格冻结、不可买卖） */
function isStockSuspended(state: GameState, stockId: string): boolean {
  return state.stockHalts.some((h) => h.stockId === stockId && h.kind === 'suspend');
}

/** 股票市场回合波动 + 随机新闻；例假日休市（ECON-09）；红卡/黑卡期间涨跌停（CARD-24/25） */
function tickStockMarket(state: GameState): void {
  if (gameDate(state).isHoliday) return;
  for (const stock of state.stockMarket.stocks) {
    const draw = nextRandom(state.rngState);
    state.rngState = draw.nextState;
    // EVT-01 事件 26/27：停牌期间价格冻结（仍消耗抽数，保持回放确定性）
    if (state.stockHaltAllDays > 0 || isStockSuspended(state, stock.id)) {
      stock.lastChangePct = 0;
      continue;
    }
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
  if (state.stockHaltAllDays > 0 || halt?.kind === 'suspend') pct = 0; // EVT-01 事件 26/27：停牌
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
            payCash(state, q, fine, null, 'news');
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
          payCash(state, target, repair, null, 'news');
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

// ---------------------------------------------------------------------------
// EVT-01 新闻事件池（TILE-18 新闻格）：36 条 · 游标轮询 + 前提过滤 + 30 种效果
// 与原版一致：抽签不消耗随机抽数（游标顺序轮询 + check_news 前提），
// 因此不会影响既有的确定性回放序列。
// ---------------------------------------------------------------------------

/** 存活玩家 */
function activePlayers(state: GameState): Player[] {
  return state.players.filter((q) => !q.bankrupt);
}

/** 拥有不动产的玩家 */
function playersWithLand(state: GameState): Player[] {
  return activePlayers(state).filter((q) => q.properties.length > 0);
}

/** 持有股份的玩家（股票市场 + 公司持股合计） */
function playersWithShares(state: GameState): Player[] {
  return activePlayers(state).filter((q) => totalSharesOf(state, q) > 0);
}

/** 单名玩家的持股总数（股票市场 + 公司股份） */
function totalSharesOf(state: GameState, p: Player): number {
  let n = 0;
  for (const qty of Object.values(p.stocks)) n += qty;
  for (const c of state.companies) n += c.shares[p.id] ?? 0;
  return n;
}

/** 已开工的建筑（等级 > 1 或已建设施）：摧毁类事件的目标池 */
interface BuildingRef {
  player: Player;
  prop: PlayerProperty;
  cell: BoardCell;
}

function builtProperties(state: GameState): BuildingRef[] {
  const out: BuildingRef[] = [];
  for (const p of activePlayers(state)) {
    for (const prop of p.properties) {
      if (prop.grade <= 1 && !prop.facility) continue;
      const cell = state.board[prop.cellId];
      if (cell) out.push({ player: p, prop, cell });
    }
  }
  return out;
}

/** 已售出的街道（有主地产所在路段）：地价涨跌事件的候选池 */
function ownedStreets(state: GameState): string[] {
  const set = new Set<string>();
  for (const p of activePlayers(state)) {
    for (const prop of p.properties) {
      const street = state.board[prop.cellId]?.street;
      if (street) set.add(street);
    }
  }
  return [...set];
}

/** 无主可拍卖的土地（TILE-01/02 且尚未售出） */
function unownedLandCells(state: GameState): BoardCell[] {
  return state.board.filter(
    (c) =>
      (c.type === 'property' || c.type === 'commercial') &&
      c.price !== undefined &&
      !state.players.some((q) => q.properties.some((prop) => prop.cellId === c.id)),
  );
}

/** 路段显示名（单格路段用格名，多格路段用「首格—末格」） */
function streetLabel(state: GameState, street: string): string {
  const cells = state.board.filter((c) => c.street === street);
  if (!cells.length) return street;
  const first = cells[0]!.name;
  const last = cells[cells.length - 1]!.name;
  return cells.length > 1 ? `${first}—${last}` : first;
}

/** 确定性随机取一项（走 state.rngState） */
function randomPick<T>(state: GameState, items: T[]): T | undefined {
  if (!items.length) return undefined;
  return items[randomIndex(state, items.length)];
}

/** 摧毁一处建筑：等级还原为 1，设施清除 */
function destroyBuilding(ref: BuildingRef): void {
  ref.prop.grade = 1;
  ref.prop.facility = undefined;
}

/** check_news：各事件的前提（照抄报告「抽签前提清单」） */
function newsPrecondition(state: GameState, def: NewsEventDef): boolean {
  const active = activePlayers(state);
  switch (def.effect) {
    case 'clear-jail':
    case 'extend-jail':
      return active.some((q) => q.custody?.kind === 'jail');
    case 'clear-hospital':
    case 'extend-hospital':
      return active.some((q) => q.custody?.kind === 'hospital');
    case 'destroy-one':
    case 'destroy-many':
    case 'burn-house':
      return builtProperties(state).length > 0;
    case 'street-up':
    case 'street-down':
      return ownedStreets(state).length > 0;
    case 'auction-land':
      return unownedLandCells(state).length > 0;
    case 'reward-most-land':
    case 'subsidize-least-land':
    case 'land-tax':
      return playersWithLand(state).length > 0;
    case 'reward-top-shareholder':
    case 'securities-tax':
      return playersWithShares(state).length > 0;
    case 'halt-walkers':
      return active.some((q) => q.diceCount <= 1);
    case 'halt-riders':
      return active.some((q) => q.diceCount > 1);
    case 'stock-halt-all':
      return state.stockHaltAllDays === 0;
    case 'stock-halt-one':
      return state.stockMarket.stocks.some((s) => !isStockSuspended(state, s.id));
    case 'stock-resume-one':
      return state.stockMarket.stocks.some((s) => isStockSuspended(state, s.id));
    case 'loan-ban':
      return state.loanBanDays === 0;
    case 'company-jail':
    case 'company-fine':
    case 'company-gain':
    case 'company-loss':
    case 'company-profit-double':
      return state.companies.some((c) => c.chairmanId !== null);
    default:
      return true;
  }
}

/** 游标轮询选取事件；一圈皆不满足前提则返回 null（本期无事） */
function selectNewsEvent(state: GameState): NewsEventDef | null {
  const pool = supportedNewsEvents();
  const n = pool.length;
  for (let i = 0; i < n; i++) {
    const def = pool[(state.newsCursor + i) % n]!;
    if (newsPrecondition(state, def)) {
      state.newsCursor = (def.id + 1) % n;
      return def;
    }
  }
  return null;
}

/** 结算一条新闻事件（30 种效果；需要随机的部分统一走 state.rngState 派生） */
function applyNewsEvent(state: GameState, def: NewsEventDef): void {
  const params: Partial<Record<'street' | 'player' | 'company' | 'stock' | 'amount', string>> = {};
  let extra = '';

  switch (def.effect) {
    // ---- 事件 0–3：囚犯 / 病患的开释与延期 ----
    case 'clear-jail':
    case 'extend-jail':
    case 'clear-hospital':
    case 'extend-hospital': {
      const kind: 'jail' | 'hospital' = def.effect.endsWith('jail') ? 'jail' : 'hospital';
      const clearing = def.effect.startsWith('clear');
      const days = def.days ?? 0;
      const targets = activePlayers(state).filter((q) => q.custody?.kind === kind);
      for (const v of targets) {
        if (clearing) {
          v.skipTurns = 0;
          v.custody = null;
          v.rentBlockedTurns = 0;
        } else {
          v.skipTurns += days;
          v.custody!.daysLeft += days;
          blockRent(v, days);
        }
      }
      extra = targets.length ? targets.map((v) => v.name).join('、') : '无人在押';
      break;
    }

    // ---- 事件 4/5/21/15：摧毁建筑 ----
    case 'destroy-one': {
      const ref = randomPick(state, builtProperties(state));
      if (ref) {
        params.street = ref.cell.street ? streetLabel(state, ref.cell.street) : ref.cell.name;
        extra = `「${ref.cell.name}」建筑被摧毁`;
        destroyBuilding(ref);
      }
      break;
    }
    case 'burn-house': {
      const ref = randomPick(state, builtProperties(state));
      if (ref) {
        params.street = ref.cell.street ? streetLabel(state, ref.cell.street) : ref.cell.name;
        extra = `「${ref.cell.name}」付之一炬，建筑归零`;
        destroyBuilding(ref);
      }
      break;
    }
    case 'destroy-many': {
      const names: string[] = [];
      let street = '';
      for (let i = 0; i < 2; i++) {
        const ref = randomPick(state, builtProperties(state));
        if (!ref) break;
        if (!street && ref.cell.street) street = streetLabel(state, ref.cell.street);
        names.push(ref.cell.name);
        destroyBuilding(ref);
      }
      params.street = street;
      extra = names.length ? `${names.join('、')} 建筑受损` : '';
      break;
    }

    // ---- 事件 6/14：地价涨跌（永久生效于买地价与租金） ----
    case 'street-up':
    case 'street-down': {
      const street = randomPick(state, ownedStreets(state));
      if (street) {
        const factor = def.factor ?? 1;
        state.streetPriceFactors[street] = (state.streetPriceFactors[street] ?? 1) * factor;
        params.street = streetLabel(state, street);
        extra = `该路段地价 ×${factor}`;
      }
      break;
    }

    // ---- 事件 7：公开拍卖公有土地 ----
    case 'auction-land': {
      const cell = randomPick(state, unownedLandCells(state));
      if (cell) {
        state.auctionQueue.push({ cellId: cell.id, sellerId: null, trigger: 'event' });
        params.street = cell.street ? streetLabel(state, cell.street) : cell.name;
        extra = `「${cell.name}」交付拍卖`;
      }
      break;
    }

    // ---- 事件 8/9/10：政府奖励与补助 ----
    case 'reward-most-land': {
      const cands = playersWithLand(state);
      const best = cands.reduce((a, b) => (b.properties.length > a.properties.length ? b : a));
      const gain = scaled(state, def.amount ?? 0);
      best.deposit += gain; // 报告：奖金入存款
      params.player = best.name;
      params.amount = String(gain);
      break;
    }
    case 'subsidize-least-land': {
      const cands = playersWithLand(state);
      const least = cands.reduce((a, b) => (b.properties.length < a.properties.length ? b : a));
      const gain = scaled(state, def.amount ?? 0);
      least.cash += gain;
      params.player = least.name;
      params.amount = String(gain);
      break;
    }
    case 'reward-top-shareholder': {
      const cands = playersWithShares(state);
      const best = cands.reduce((a, b) => (totalSharesOf(state, b) > totalSharesOf(state, a) ? b : a));
      const gain = scaled(state, def.amount ?? 0);
      best.cash += gain;
      params.player = best.name;
      params.amount = String(gain);
      break;
    }

    // ---- 事件 11/12/13：三项税收 ----
    // 报告：税率 0.05 直接作用于名义值（现金 / 地价+造价 / 股票市值），不乘物价指数；
    // 物价指数只用于固定金额（奖励、罚款、门票等）。
    case 'income-tax': {
      const rate = def.rate ?? 0;
      let sum = 0;
      for (const q of activePlayers(state)) {
        const tax = Math.floor(q.cash * rate);
        if (tax <= 0) continue;
        sum += tax;
        payCash(state, q, tax, null, 'news');
        if (isGameOver(state)) return;
      }
      extra = `合计征收 ¥${sum}`;
      break;
    }
    case 'land-tax': {
      const rate = def.rate ?? 0;
      let sum = 0;
      for (const q of activePlayers(state)) {
        let base = 0;
        for (const prop of q.properties) base += propertyValue(state, prop);
        const tax = Math.floor(base * rate);
        if (tax <= 0) continue;
        sum += tax;
        payCash(state, q, tax, null, 'news');
        if (isGameOver(state)) return;
      }
      extra = `合计征收 ¥${sum}`;
      break;
    }
    case 'securities-tax': {
      const rate = def.rate ?? 0;
      let sum = 0;
      for (const q of activePlayers(state)) {
        let base = 0;
        for (const [stockId, qty] of Object.entries(q.stocks)) {
          const stock = stockById(state, stockId);
          if (stock) base += stock.price * qty;
        }
        const tax = Math.floor(base * rate);
        if (tax <= 0) continue;
        sum += tax;
        payCash(state, q, tax, null, 'news');
        if (isGameOver(state)) return;
      }
      extra = `合计征收 ¥${sum}`;
      break;
    }

    // ---- 事件 16/17：路况报道 ----
    case 'halt-walkers':
    case 'halt-riders': {
      const days = def.days ?? TRAFFIC_HALT_DAYS;
      const walking = def.effect === 'halt-walkers';
      const targets = activePlayers(state).filter((q) => (walking ? q.diceCount <= 1 : q.diceCount > 1));
      for (const v of targets) {
        v.skipTurns = Math.max(v.skipTurns, days);
        blockRent(v, days);
      }
      extra = targets.length ? `${targets.map((v) => v.name).join('、')} 停留 ${days} 天` : '无人受影响';
      break;
    }

    // ---- 事件 22/23：银行业务 ----
    case 'loan-ban': {
      const days = def.days ?? 15;
      state.loanBanDays = days;
      extra = `${days} 天内停止放款`;
      break;
    }
    case 'deposit-dividend': {
      const rate = def.rate ?? 0;
      let sum = 0;
      for (const q of activePlayers(state)) {
        const bonus = Math.round(q.deposit * rate);
        if (bonus <= 0) continue;
        q.deposit += bonus;
        sum += bonus;
      }
      extra = `合计派发 ¥${sum}`;
      break;
    }

    // ---- 事件 24–28：股市行情 ----
    case 'stock-crash':
    case 'stock-rally': {
      const sign = def.effect === 'stock-rally' ? 1 : -1;
      for (const s of state.stockMarket.stocks) {
        if (state.stockHaltAllDays > 0 || isStockSuspended(state, s.id)) continue;
        const pct = sign * STOCK_NEWS_PCT;
        s.price = Math.max(5, Math.round(s.price * (1 + pct / 100)));
        s.lastChangePct = pct;
      }
      extra = `全市场${sign > 0 ? '上涨' : '下跌'} ${STOCK_NEWS_PCT}%`;
      break;
    }
    case 'stock-halt-all': {
      const days = def.days ?? 10;
      state.stockHaltAllDays = days;
      extra = `全市场停牌 ${days} 天`;
      break;
    }
    case 'stock-halt-one': {
      const days = def.days ?? 10;
      const stock = randomPick(state, state.stockMarket.stocks.filter((s) => !isStockSuspended(state, s.id)));
      if (stock) {
        state.stockHalts.push({ stockId: stock.id, kind: 'suspend', daysLeft: days });
        params.stock = stock.name;
        extra = `停牌 ${days} 天`;
      }
      break;
    }
    case 'stock-resume-one': {
      const stock = randomPick(state, state.stockMarket.stocks.filter((s) => isStockSuspended(state, s.id)));
      if (stock) {
        state.stockHalts = state.stockHalts.filter((h) => !(h.stockId === stock.id && h.kind === 'suspend'));
        params.stock = stock.name;
        extra = '恢复上市交易';
      }
      break;
    }

    // ---- 事件 29–35：公司企业 ----
    case 'company-jail': {
      const company = randomPick(state, state.companies.filter((c) => c.chairmanId !== null));
      const victim = company ? state.players.find((q) => q.id === company.chairmanId) : undefined;
      if (company && victim && !victim.bankrupt) {
        const days = def.days ?? 5;
        applyDisaster(state, victim, 'jail', null, (v) => {
          v.skipTurns = Math.max(v.skipTurns, days);
          v.custody = { kind: 'jail', daysLeft: Math.max(v.skipTurns, days) };
          blockRent(v, days);
        });
        params.company = state.board[company.cellId]?.name ?? '';
        params.player = victim.name;
        extra = `${victim.name} 坐牢 ${days} 天`;
        if (isGameOver(state)) return;
      }
      break;
    }
    case 'company-fine': {
      const company = randomPick(state, state.companies);
      if (company) {
        const fine = scaled(state, def.amount ?? 0);
        company.surplus -= fine;
        params.company = state.board[company.cellId]?.name ?? '';
        params.amount = String(fine);
        extra = `累积盈余 -¥${fine}`;
      }
      break;
    }
    case 'company-gain': {
      const company = randomPick(state, state.companies);
      if (company) {
        const gain = scaled(state, def.amount ?? 0);
        company.surplus += gain;
        params.company = state.board[company.cellId]?.name ?? '';
        params.amount = String(gain);
        extra = `累积盈余 +¥${gain}`;
      }
      break;
    }
    case 'company-loss': {
      const company = randomPick(state, state.companies);
      if (company) {
        const loss = scaled(state, def.amount ?? 0);
        company.surplus -= loss;
        params.company = state.board[company.cellId]?.name ?? '';
        params.amount = String(loss);
        extra = `累积盈余 -¥${loss}`;
      }
      break;
    }
    case 'company-profit-double': {
      const company = randomPick(state, state.companies);
      if (company) {
        company.surplus *= 2;
        params.company = state.board[company.cellId]?.name ?? '';
        extra = `累积盈余翻倍至 ¥${company.surplus}`;
      }
      break;
    }

    default:
      break;
  }

  const body = renderNewsText(def, params);
  log(state, `【新闻】${NEWS_CATEGORY_LABEL[def.category]}｜${body}${extra ? `（${extra}）` : ''}`);
}

/** TILE-18 新闻格：游标轮询选一条满足前提的事件并结算；一圈全不满足则本期无事 */
function resolveNewsEvent(state: GameState): void {
  log(state, '驻足新闻格，收听今日头条');
  const def = selectNewsEvent(state);
  if (!def) {
    log(state, '【新闻】本期新闻无事发生');
    return;
  }
  applyNewsEvent(state, def);
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
  drawLottery(state);
}

/**
 * ECON-08：每月 15 号乐透开奖。中奖者按人数均分奖池，无人中奖则奖金累积到下一期。
 * 开奖号码由 `rngState` **只读派生**（不推进随机数），避免扰动股市波动/新闻的抽数序列。
 */
function drawLottery(state: GameState): void {
  if (state.lotteryTickets.length === 0) return;
  const winning = drawWinningNumber(state.rngState);
  const winners = state.lotteryTickets.filter((t) => t.number === winning);
  log(state, `【乐透开奖】本期开奖号码 ${winning}，有效注数 ${state.lotteryTickets.length}，奖池 ¥${state.lotteryPool}`);
  if (winners.length === 0) {
    log(state, `【乐透开奖】本期无人中奖，奖金 ¥${state.lotteryPool} 累积至下期`);
  } else {
    const share = Math.floor(state.lotteryPool / winners.length);
    for (const ticket of winners) {
      const owner = state.players.find((q) => q.id === ticket.playerId);
      if (!owner || owner.bankrupt) continue;
      owner.cash += share;
      log(state, `【乐透开奖】${owner.name} 中奖！获得 ¥${share}`);
    }
    state.lotteryPool -= share * winners.length;
    if (state.lotteryPool > 0) log(state, `【乐透开奖】奖池零头 ¥${state.lotteryPool} 滚动至下期`);
  }
  state.lotteryTickets = [];
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
  if (state.stockHaltAllDays > 0) {
    state.stockHaltAllDays -= 1;
    if (state.stockHaltAllDays === 0) log(state, '【股市】全市场恢复交易');
  }
  if (state.loanBanDays > 0) {
    state.loanBanDays -= 1;
    if (state.loanBanDays === 0) log(state, '【银行】挤兑平息，恢复放款');
  }
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
    // EVT-01 事件 0–3：在押/住院天数与 skipTurns 同处递减（skipTurns 是真正的停留门槛）
    if (p.custody) {
      p.custody.daysLeft -= 1;
      if (p.custody.daysLeft <= 0) p.custody = null;
    }
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

/**
 * NPC-05 恶犬：每天日切时先让昨日的恶犬离场，再以只读派生随机决定今日是否出没。
 * 全程读而不写回 `rngState`（零抽数），不扰动确定性回放。
 */
function dogActivityHook(state: GameState): void {
  state.npcs = state.npcs.filter((n) => n.kind !== 'dog');
  const roll = nextRandom(state.rngState);
  if (roll.value >= DOG_SPAWN_CHANCE) return;
  const position = Math.min(BOARD_SIZE - 1, Math.floor((roll.value / DOG_SPAWN_CHANCE) * BOARD_SIZE));
  state.npcs.push({ kind: 'dog', position, ownerId: null, daysLeft: 1, jailed: false });
  log(state, `【恶犬】一只恶犬在「${state.board[position]!.name}」附近徘徊`);
}

/**
 * 只读派生随机：读 `nextRandom` 但**不写回** `state.rngState`。
 * `salt` 为派生层数（同一 salt 恒得同值），全程零抽数 → 不扰动确定性回放。
 */
function derivedValue(state: GameState, salt: number): number {
  let st = state.rngState;
  for (let i = 0; i <= salt; i += 1) st = nextRandom(st).nextState;
  return nextRandom(st).value;
}

/** 只读派生的 [0, n) 整数索引 */
function derivedIndex(state: GameState, salt: number, n: number): number {
  return Math.floor(derivedValue(state, salt) * n);
}

/** 恶人行动收益结算：收益归保释人；保释人倒闭则恶人押回监狱 */
function giveVillainLoot(state: GameState, npc: NpcUnit, text: string): void {
  const def = villainDefOf(npc);
  const owner = npc.ownerId ? state.players.find((p) => p.id === npc.ownerId) : undefined;
  if (!owner || owner.bankrupt) {
    log(state, `${def.name} ${text}，但保释人已倒闭，赃物充公`);
    npc.ownerId = null;
    npc.jailed = true;
    npc.daysLeft = 0;
    npc.position = JAIL_CELL_ID(state);
    return;
  }
  log(state, `${def.name} ${text}，收益归 ${owner.name}`);
}

/** NpcUnit.kind 收窄为四大恶人（排除恶犬），供 VILLAINS 索引 */
function villainDefOf(npc: NpcUnit): VillainDef {
  if (npc.kind === 'dog') throw new Error('恶犬不是四大恶人之一');
  return VILLAINS[npc.kind];
}

/**
 * NPC-01..04 四大恶人的每日行动（每日移动 1..6 步并就地作案）。
 * 移动步数与作案目标均由 `derivedValue` 派生（零抽数），保证确定性回放。
 */
function villainAct(state: GameState, npc: NpcUnit, salt: number): void {
  const steps = 1 + derivedIndex(state, salt, 6);
  npc.position = (npc.position + steps) % BOARD_SIZE;
  const cell = state.board[npc.position]!;
  const victimPool = activePlayers(state).filter((p) => p.id !== npc.ownerId && !p.bankrupt);
  if (victimPool.length === 0) return;

  switch (npc.kind) {
    case 'thief': {
      // 偷取一名路人的点券（上限 500）并取走一件道具
      const victim = victimPool[derivedIndex(state, salt + 1, victimPool.length)]!;
      const take = Math.min(victim.points, THIEF_POINTS_TAKE);
      victim.points -= take;
      const itemIds = Object.keys(victim.items).filter((id) => (victim.items[id] ?? 0) > 0);
      let itemText = '';
      if (itemIds.length > 0) {
        const itemId = itemIds[derivedIndex(state, salt + 2, itemIds.length)]!;
        victim.items[itemId] = (victim.items[itemId] ?? 1) - 1;
        if ((victim.items[itemId] ?? 0) <= 0) delete victim.items[itemId];
        itemText = `、道具「${ITEMS[itemId]?.name ?? itemId}」`;
      }
      giveVillainLoot(state, npc, `在「${cell.name}」偷走 ${victim.name} 的 ${take} 点券${itemText}`);
      break;
    }
    case 'protection': {
      // 站在土地格时向该地产主收取 5% 地价的保护费（现金不足则折算点券）
      const owner = cellOwner(state, cell.id);
      if (!owner || cell.price === undefined) return;
      const fee = Math.round(cell.price * PROTECTION_FEE_RATE);
      if (fee <= 0) return;
      if (owner.player.cash + owner.player.deposit >= fee) {
        pay(state, owner.player, fee, null);
      } else {
        const byPoints = Math.min(owner.player.points, Math.max(1, Math.floor(fee / 10)));
        owner.player.points -= byPoints;
      }
      giveVillainLoot(state, npc, `在「${cell.name}」向 ${owner.player.name} 收取保护费 ¥${fee}`);
      break;
    }
    case 'robber': {
      // 抢夺一名路人的一张卡片，没有卡片则抢一件道具
      const victim = victimPool[derivedIndex(state, salt + 1, victimPool.length)]!;
      let lootText = '';
      if (victim.cards.length > 0) {
        const idx = derivedIndex(state, salt + 2, victim.cards.length);
        const cardId = victim.cards[idx]!;
        victim.cards.splice(idx, 1);
        lootText = `卡片「${CARDS[cardId]?.name ?? cardId}」`;
      } else {
        const itemIds = Object.keys(victim.items).filter((id) => (victim.items[id] ?? 0) > 0);
        if (itemIds.length === 0) return;
        const itemId = itemIds[derivedIndex(state, salt + 2, itemIds.length)]!;
        victim.items[itemId] = (victim.items[itemId] ?? 1) - 1;
        if ((victim.items[itemId] ?? 0) <= 0) delete victim.items[itemId];
        lootText = `道具「${ITEMS[itemId]?.name ?? itemId}」`;
      }
      giveVillainLoot(state, npc, `在「${cell.name}」抢走 ${victim.name} 的 ${lootText}`);
      break;
    }
    case 'rent-thief': {
      // 公司格：盗领全部累积红利；土地格：窃取上次收取的租金
      const company = companyAtCell(state, cell.id);
      if (company) {
        if (company.surplus <= 0) return;
        const stolen = company.surplus;
        company.surplus = 0;
        giveVillainLoot(state, npc, `潜入「${cell.name}」盗领累积红利 ¥${stolen}`);
        return;
      }
      const owner = cellOwner(state, cell.id);
      if (!owner || !owner.property.lastRent) return;
      const stolen = owner.property.lastRent;
      owner.property.lastRent = null;
      giveVillainLoot(state, npc, `在「${cell.name}」窃取租金 ¥${stolen}`);
      break;
    }
  }
}

/** 监狱格 id（四大恶人初始在押处） */
function JAIL_CELL_ID(state: GameState): number {
  const jail = state.board.find((c) => c.type === 'jail');
  if (!jail) throw new Error('棋盘缺少监狱格');
  return jail.id;
}

/**
 * NPC-01..04 四大恶人日切：
 * 1) 未保释者留在监狱；2) 已保释者刑期 -1 天，归零或保释人倒闭则押回监狱；
 * 3) 在外者当日移动并作案（只读派生随机，零抽数）。
 */
function villainActivityHook(state: GameState): void {
  const jailId = JAIL_CELL_ID(state);
  for (let i = 0; i < state.npcs.length; i += 1) {
    const npc = state.npcs[i]!;
    if (npc.kind === 'dog') continue;
    if (npc.jailed) {
      npc.position = jailId;
      continue;
    }
    const owner = npc.ownerId ? state.players.find((p) => p.id === npc.ownerId) : undefined;
    if (!owner || owner.bankrupt) {
      npc.ownerId = null;
      npc.jailed = true;
      npc.daysLeft = 0;
      npc.position = jailId;
      log(state, `【恶人】${villainDefOf(npc).name} 的保释人倒闭，被押回监狱`);
      continue;
    }
    npc.daysLeft -= 1;
    if (npc.daysLeft <= 0) {
      npc.ownerId = null;
      npc.jailed = true;
      npc.daysLeft = 0;
      npc.position = jailId;
      log(state, `【恶人】${villainDefOf(npc).name} 刑满释放，被押回监狱`);
      continue;
    }
    // salt 按日推进（elapsedDays）与恶人序号错开，确保不同恶人不同步、跨日不同值
    villainAct(state, npc, state.calendar.elapsedDays * 8 + i * 2);
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
  dogActivityHook,
  villainActivityHook,
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
  // ECON-13：倒闭清算等产生待拍卖标的时，先开拍（拍卖结束后再继续推进回合）
  if (startQueuedAuction(state)) return;
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
  state.magic = null;
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
      payCash(state, p, loss, null, 'god');
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
      payCash(state, p, loss, null, 'god');
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

// ---------------------------------------------------------------------------
// 波 8：命运卡池（TILE-17 机会/危险格的原版实现）
// 数据源 `docs/extraction/fate_pool_数据表_2026-09-27.txt`（49 张：公共池 33 + 地图专属 16）。
// ---------------------------------------------------------------------------

/**
 * 抽一张命运卡并结算（机会/危险格）。
 * 抽签只消耗 **1 抽**（与原先的抽卡一致），个别效果（拆除/征收）另需 1 抽选目标。
 */
function resolveFateCard(state: GameState, p: Player): void {
  const id = FATE_PUBLIC_IDS[randomIndex(state, FATE_PUBLIC_IDS.length)]!;
  const def = fateCardById(id);
  if (!def) return;
  applyFateEffect(state, p, def);
}

/** 结算单张命运卡效果；金额类过 `scaled()`（固定金额），百分比类直接作用于名义值 */
function applyFateEffect(state: GameState, p: Player, def: FateCardDef): void {
  // 日志占位符参数（金额默认按物价指数缩放，百分比类在分支内改回原值）
  const renderParams: Record<string, string | number> = {
    amount: scaled(state, def.amount ?? 0),
    days: def.days ?? 0,
    player: p.name,
  };
  const money = scaled(state, def.amount ?? 0);
  let extra = '';

  switch (def.effect) {
    case 'demolish-house': {
      const ref = randomPick(state, builtProperties(state));
      if (ref) {
        destroyBuilding(ref);
        extra = `「${ref.cell.name}」建筑被强制拆除`;
      } else {
        extra = '（无人拥有可拆的建筑，无事发生）';
      }
      break;
    }
    case 'requisition-land': {
      const pool: BuildingRef[] = [];
      for (const q of activePlayers(state)) {
        for (const prop of q.properties) pool.push({ player: q, prop, cell: state.board[prop.cellId]! });
      }
      const ref = randomPick(state, pool);
      if (ref) {
        ref.player.properties = ref.player.properties.filter((q) => q !== ref.prop);
        extra = `${ref.player.name} 的「${ref.cell.name}」被强制征收`;
      } else {
        extra = '（无人拥有土地，无事发生）';
      }
      break;
    }
    case 'fake-loan': {
      renderParams.amount = money;
      payCash(state, p, money, null, 'other');
      extra = `被冒名贷款，损失 ¥${money}`;
      break;
    }
    case 'check-bounce': {
      state.loanBanDays = 30;
      extra = '银行拒绝往来 30 天（停止放款）';
      break;
    }
    case 'bank-hack': {
      const pct = def.amount ?? 10;
      renderParams.amount = pct;
      let stolen = 0;
      for (const q of activePlayers(state)) {
        if (q.id === p.id) continue;
        const take = Math.floor((q.deposit * pct) / 100);
        if (take <= 0) continue;
        q.deposit -= take;
        stolen += take;
      }
      p.deposit += stolen;
      extra = `挪用他人存款共 ¥${stolen}`;
      break;
    }
    case 'birthday-cards': {
      let got = 0;
      for (const q of activePlayers(state)) {
        if (q.id === p.id || q.cards.length === 0) continue;
        if (p.cards.length >= MAX_HAND_CARDS) break;
        p.cards.push(q.cards.shift()!);
        got += 1;
      }
      extra = `向每人收取一张卡片，共得 ${got} 张`;
      break;
    }
    case 'forced-abroad': {
      const days = def.days ?? 5;
      renderParams.days = days;
      p.abroadTurns = Math.max(p.abroadTurns, days);
      extra = `被迫出国观光 ${days} 天（期间不能收租）`;
      break;
    }
    case 'abduct': {
      const days = def.days ?? 5;
      renderParams.days = days;
      p.skipTurns = Math.max(p.skipTurns, days);
      blockRent(p, days);
      extra = `被外星人绑架 ${days} 天（暂停行动并丧失收租权）`;
      break;
    }
    case 'stock-default': {
      const pct = def.amount ?? 20;
      renderParams.amount = pct;
      for (const [stockId, qty] of Object.entries(p.stocks)) {
        const lost = Math.floor((qty * pct) / 100);
        if (lost <= 0) continue;
        const left = qty - lost;
        if (left > 0) p.stocks[stockId] = left;
        else delete p.stocks[stockId];
      }
      extra = `违约交割损失 ${pct}% 持股`;
      break;
    }
    case 'sell-all-stocks': {
      let total = 0;
      for (const [stockId, qty] of Object.entries(p.stocks)) {
        const stock = stockById(state, stockId);
        if (!stock || qty <= 0) continue;
        total += stock.price * qty;
        delete p.stocks[stockId];
        if (p.stockCost) delete p.stockCost[stockId];
      }
      p.cash += total;
      extra = `变卖所有股票求现 ¥${total}`;
      break;
    }
    case 'lose-bike':
    case 'crash-car': {
      p.diceCount = 1;
      extra = '交通工具损毁，恢复步行（1 颗骰子）';
      break;
    }
    case 'ditch-hospital':
    case 'bike-hospital': {
      const days = def.days ?? 2;
      renderParams.days = days;
      p.skipTurns = Math.max(p.skipTurns, days);
      p.custody = { kind: 'hospital', daysLeft: Math.max(p.skipTurns, days) };
      blockRent(p, days);
      extra = `就医住院 ${days} 天（暂停行动并丧失收租权）`;
      break;
    }
    case 'jaywalk-fine':
    case 'helmet-fine':
    case 'speeding-fine':
    case 'litter-fine':
    case 'dog-fine': {
      renderParams.amount = money;
      payCash(state, p, money, null, 'other');
      extra = `罚款 ¥${money}`;
      break;
    }
    case 'treat-all': {
      renderParams.amount = money;
      const others = activePlayers(state).filter((q) => q.id !== p.id);
      const share = others.length > 0 ? Math.floor(money / others.length) : 0;
      for (const q of others) {
        if (share > 0) pay(state, p, share, q, { toDeposit: true, reason: 'other' });
      }
      extra = `请所有人吃大餐，共花 ¥${share * others.length}`;
      break;
    }
    case 'found-money':
    case 'inherit':
    case 'invoice-win': {
      renderParams.amount = money;
      p.cash += money;
      extra = `获得 ¥${money}`;
      break;
    }
    case 'lose-wallet':
    case 'bad-loan': {
      renderParams.amount = money;
      payCash(state, p, money, null, 'other');
      extra = `损失 ¥${money}`;
      break;
    }
    case 'pay-insurance': {
      renderParams.amount = money;
      payCash(state, p, money, null, 'other');
      extra = `支付保险金 ¥${money}`;
      break;
    }
    case 'claim-insurance': {
      renderParams.amount = money;
      if (p.insurance) {
        p.cash += money;
        extra = `领取保险金 ¥${money}`;
      } else {
        extra = '（无有效保单，未获理赔）';
      }
      break;
    }
    case 'sell-all-cards': {
      let gained = 0;
      for (const cardId of p.cards) gained += Math.floor((CARDS[cardId]?.cost ?? 0) / 2);
      for (const [itemId, count] of Object.entries(p.items)) {
        gained += Math.floor((ITEMS[itemId]?.cost ?? 0) / 2) * count;
      }
      p.cards = [];
      p.items = {};
      p.points += gained;
      extra = `变卖所有卡片道具，回收 ${gained} 点券`;
      break;
    }
    case 'jail': {
      const days = def.days ?? CRIME_JAIL_DAYS;
      renderParams.days = days;
      applyDisaster(state, p, 'jail', null, (v) => {
        v.skipTurns = Math.max(v.skipTurns, days);
        v.custody = { kind: 'jail', daysLeft: Math.max(v.skipTurns, days) };
        blockRent(v, days);
      });
      extra = `坐牢 ${days} 天（丧失收租权）`;
      break;
    }
  }

  log(state, `【命运】${p.name} 抽到「${renderFateText(def, renderParams)}」 —— ${extra}`);
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
    q.custody = { kind: 'hospital', daysLeft: Math.max(q.skipTurns, hospitalDays) };
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
    // ECON-08：站立于乐透行且现金足够时可自选号码投注
    const canBuyLottery = state.phase === 'awaiting_action' && c.type === 'lottery' && p.cash >= LOTTERY_TICKET_COST;
    return {
      canRoll: state.phase === 'awaiting_roll',
      canBuy,
      canUpgrade,
      canEnd: state.phase === 'awaiting_action',
      canShop: state.phase === 'awaiting_action' && isShopCell(c),
      canTradeStock: state.phase === 'awaiting_action' && isBankCell(c) && !holiday && state.stockHaltAllDays === 0,
      canPick: state.phase === 'awaiting_pick',
      canDeposit: atBank && bank!.canDeposit && !holiday && p.cash > 0,
      canWithdraw: atBank && bank!.canDeposit && !holiday && p.deposit > 0,
      canLoan: atBank && bank!.canLoan && !holiday && p.loan === null && state.loanBanDays === 0,
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
      canBuyLottery,
      lotteryTicketCost: LOTTERY_TICKET_COST,
      auction: null,
      bailableVillains: bailableVillains(state),
      bailFee: bailFee(state),
      magic: state.magic,
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
    canBuyLottery: false,
    lotteryTicketCost: LOTTERY_TICKET_COST,
    auction: state.phase === 'awaiting_auction' ? state.auction : null,
    bailableVillains: bailableVillains(state),
    bailFee: bailFee(state),
    magic: state.magic,
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
    if (p.custody) {
      p.custody.daysLeft = Math.min(p.custody.daysLeft, p.skipTurns);
      if (p.skipTurns === 0) {
        log(state, `${p.name} ${p.custody.kind === 'jail' ? '刑满释放，重获自由' : '康复出院'}`);
        p.custody = null;
      }
    }
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
  let bittenByDog = false;
  /** EVT-04：途中遇到的原地乞讨者 */
  let beggar: Player | null = null;
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
    // EVT-04 倒闭与乞讨：倒闭者在原地乞讨，路过遇上一律施舍 1000 元
    if (!beggar) {
      const b = state.players.find((q) => q.bankrupt && q.position === pos);
      if (b) beggar = b;
    }
    // NPC-05 恶犬：步行者被咬伤（住院 3 天）；以车辆行进者可将其撞跑
    const dogIdx = state.npcs.findIndex((n) => n.kind === 'dog' && n.position === pos);
    if (dogIdx >= 0) {
      const dogCell = state.board[pos]!;
      state.npcs.splice(dogIdx, 1);
      if (p.diceCount <= 1) {
        log(state, `${p.name} 在「${dogCell.name}」步行途中碰上恶犬，被咬伤`);
        bittenByDog = true;
        break;
      }
      log(state, `${p.name} 驾车在「${dogCell.name}」撞跑了恶犬`);
    }
  }
  if (crossedStart) {
    p.cash += PASS_START_SALARY;
    log(state, `${p.name} 经过起点，领取薪水 ¥${PASS_START_SALARY}`);
  }
  p.position = pos;
  // 停在公立银行当格时，由落格分派给出完整权限，不再算「路过」
  if (publicBankId !== undefined && pos === publicBankId) passedPublicBank = false;

  // EVT-04 倒闭与乞讨：路遇原地乞讨的倒闭者，施舍 1000 元（固定金额，随物价指数缩放）
  if (beggar) {
    const alms = scaled(state, BEGGAR_ALMS);
    log(state, `${p.name} 路遇在原处乞讨的 ${beggar.name}，施舍 ¥${alms}`);
    pay(state, p, alms, beggar, { reason: 'other' });
    if (isGameOver(state)) return;
  }

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

  // NPC-05 恶犬咬伤（步行者）：住院 3 天并丧失收租权
  if (bittenByDog) {
    p.skipTurns = Math.max(p.skipTurns, DOG_HOSPITAL_DAYS);
    p.custody = { kind: 'hospital', daysLeft: Math.max(p.skipTurns, DOG_HOSPITAL_DAYS) };
    blockRent(p, DOG_HOSPITAL_DAYS);
    log(state, `${p.name} 被恶犬咬伤，住院 ${DOG_HOSPITAL_DAYS} 天并丧失收租权`);
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
    // TILE-17 机会/危险格：原版为命运卡池抽签（help[28]），此处抽公共池 33 张中的一张
    resolveFateCard(state, p);
    if (isGameOver(state)) return;
    // EVT-02：机会/危险格附带违法事件风险（只读派生随机，不消耗 RNG 抽数）
    const crimeRoll = nextRandom(state.rngState);
    if (crimeRoll.value < CRIME_CHANCE) {
      // 案由取自命运卡「地图专属池」（id 33–48 全是违法坐牢事件）：用同一读数值派生，零抽数
      const causeId =
        FATE_MAP_IDS[
          Math.min(FATE_MAP_IDS.length - 1, Math.floor((crimeRoll.value / CRIME_CHANCE) * FATE_MAP_IDS.length))
        ]!;
      const cause = fateCardById(causeId);
      const days = cause?.days ?? CRIME_JAIL_DAYS;
      applyDisaster(state, p, 'jail', null, (v) => {
        v.skipTurns = Math.max(v.skipTurns, days);
        v.custody = { kind: 'jail', daysLeft: Math.max(v.skipTurns, days) };
        blockRent(v, days);
      });
      log(state, `【违法事件】${renderFateText(cause ?? { id: causeId, text: '卷入违法案件', effect: 'jail' }, { days })}`);
      if (isGameOver(state)) return;
    }
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
    payCash(state, p, tax, null, 'tax');
    if (isGameOver(state)) return;
    advanceTurn(state);
    return;
  }

  if (c.type === 'hospital') {
    // TILE-09：住院不能出门且丧失收租权利，每天 1000 医药费
    p.skipTurns = Math.max(p.skipTurns, 1);
    p.custody = { kind: 'hospital', daysLeft: Math.max(p.skipTurns, 1) };
    blockRent(p, 1);
    const medical = scaled(state, 1000);
    log(state, `${p.name} 住院休养 1 天（期间丧失收租权），支付医药费 ¥${medical}`);
    payCash(state, p, medical, null, 'other');
    if (isGameOver(state)) return;
    advanceTurn(state);
    return;
  }

  // TILE-10 监狱：落地不停留在牢内（安全），可在监狱门外保释在押恶人（help [34]）
  if (c.type === 'jail') {
    state.phase = 'awaiting_action';
    const jailed = state.npcs.filter((n) => n.jailed && n.kind !== 'dog');
    log(
      state,
      jailed.length > 0
        ? `${p.name} 来到「${c.name}」门外（安全无恙），可花 ¥${bailFee(state)} 保释在押恶人`
        : `${p.name} 来到「${c.name}」门外（安全无恙），当前没有在押恶人`,
    );
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
    // EVT-05/06：游戏厅四选一（三仙归洞 / 记忆翻牌 / 七彩气球 / 企鹅挖宝）
    const pick = Math.floor(kindRoll.value * 4);
    if (pick === 1) {
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
    } else if (pick === 2) {
      // EVT-05 七彩气球：3 轮，踩中气球得奖、踩到炸弹提前结束
      state.minigame = {
        kind: 'balloon',
        round: 0,
        hits: [],
        symbols: [],
        revealed: [],
        matched: [],
        flips: 0,
        exploded: false,
      };
      state.phase = 'awaiting_pick';
      log(state, `${p.name} 进入游戏厅玩「七彩气球」：共 3 轮，小心别踩到炸弹！`);
    } else if (pick === 3) {
      // EVT-06 企鹅挖宝：3 轮，帮企鹅挖出冰下的宝物
      state.minigame = {
        kind: 'penguin',
        round: 0,
        hits: [],
        symbols: [],
        revealed: [],
        matched: [],
        flips: 0,
      };
      state.phase = 'awaiting_pick';
      log(state, `${p.name} 进入游戏厅玩「企鹅挖宝」：共 3 轮，挖中宝物越多奖励越高！`);
    } else {
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
    // NPC-04 窃取租金：记录本地上次收取的租金，供窃取租金型恶人作案
    owned.property.lastRent = rent;
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

  // TILE-18 新闻格：游标轮询触发 36 条新闻事件池中的一条（EVT-01）
  if (c.type === 'news') {
    resolveNewsEvent(state);
    if (isGameOver(state)) return;
    advanceTurn(state);
    return;
  }

  // TILE-19 乐透行：自选号码投注（ECON-08），每月 15 号开奖
  if (c.type === 'lottery') {
    state.phase = 'awaiting_action';
    log(state, `${p.name} 来到「${c.name}」：可自选号码投注 ¥${LOTTERY_TICKET_COST}（每月 15 号开奖）`);
    return;
  }

  // TILE-11 魔法屋（NPC-06 女巫）：水晶球给出施法条件 + 诅咒，由玩家指定受罚者
  if (c.type === 'magic') {
    const conditionRoll = nextRandom(state.rngState);
    state.rngState = conditionRoll.nextState;
    const condition = MAGIC_CONDITIONS[Math.floor(conditionRoll.value * MAGIC_CONDITIONS.length)]!.kind;
    const curseRoll = nextRandom(state.rngState);
    state.rngState = curseRoll.nextState;
    const curse = CURSE_ORDER[Math.floor(curseRoll.value * CURSE_ORDER.length)]!;
    const curseDef = CURSES[curse];
    const candidateIds = magicCandidates(state, p, condition);
    const offer: MagicOffer = {
      condition,
      curse,
      candidateIds,
      amount: curse === 'fine' ? scaled(state, curseDef.amount ?? 0) : 0,
      days: curseDef.days ?? 0,
    };
    state.magic = offer;
    state.phase = 'awaiting_action';
    log(
      state,
      `${p.name} 进入「${c.name}」，女巫的水晶球亮起：${MAGIC_CONDITION_LABEL[condition]}；若施法，将降下「${curseDef.name}」`,
    );
    if (candidateIds.length === 0) {
      log(state, '当前没有符合条件的受罚对象，女巫悻悻收回水晶球');
    }
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

/** 小游戏猜位置统一入口（三仙归洞 / 七彩气球 / 企鹅挖宝：猜 0-2；记忆翻牌：牌下标） */
function minigamePick(state: GameState, action: Extract<PlayerAction, { type: 'MINIGAME_PICK' }>): void {
  if (state.phase !== 'awaiting_pick' || !state.minigame) throw new Error('当前没有进行中的小游戏');
  if (state.minigame.kind === 'memory') {
    memoryFlip(state, action.hole);
    return;
  }
  const p = currentPlayer(state);
  const hole = action.hole;
  if (hole !== 0 && hole !== 1 && hole !== 2) throw new Error('杯号必须是 0-2');
  if (state.minigame.kind === 'balloon') {
    balloonPick(state, p, hole);
    return;
  }
  if (state.minigame.kind === 'penguin') {
    penguinPick(state, p, hole);
    return;
  }
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
    payCash(state, p, -payout, null, 'minigame');
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

/**
 * EVT-05 七彩气球：3 个气球中 1 个是炸弹。
 * 踩中炸弹立即结束游戏并支付门票；连续 3 轮安全通过则按通过轮数发放奖励。
 */
function balloonPick(state: GameState, p: Player, hole: number): void {
  const mg = state.minigame!;
  const draw = nextRandom(state.rngState);
  state.rngState = draw.nextState;
  const bomb = Math.floor(draw.value * 3);
  const roundNo = mg.round + 1;
  if (hole === bomb) {
    const fee = scaled(state, BALLOON_BOMB_FEE);
    mg.exploded = true;
    log(state, `${p.name} 第 ${roundNo} 轮踩到炸弹，气球炸开，游戏提前结束（门票 ¥${fee}）`);
    state.minigame = null;
    payCash(state, p, fee, null, 'minigame');
    if (isGameOver(state)) return;
    advanceTurn(state);
    return;
  }
  mg.hits.push(true);
  log(state, `${p.name} 第 ${roundNo} 轮踩中七彩气球，安全通过`);
  if (mg.round < 2) {
    mg.round = (mg.round + 1) as 0 | 1 | 2;
    return;
  }
  const hits = mg.hits.filter(Boolean).length;
  const payout = scaled(state, BALLOON_PAYOUT[hits]!);
  p.cash += payout;
  log(state, `七彩气球结束：安全通过 ${hits}/3，${p.name} 获得 ¥${payout}`);
  awardMinigamePoints(state, p, hits);
  state.minigame = null;
  if (isGameOver(state)) return;
  advanceTurn(state);
}

/** EVT-06 企鹅挖宝：3 轮三选一，挖中冰下宝物；挖空则支付门票 */
function penguinPick(state: GameState, p: Player, hole: number): void {
  const mg = state.minigame!;
  const draw = nextRandom(state.rngState);
  state.rngState = draw.nextState;
  const treasure = Math.floor(draw.value * 3);
  const hit = hole === treasure;
  mg.hits.push(hit);
  const roundNo = mg.round + 1;
  if (hit) {
    log(state, `${p.name} 第 ${roundNo} 轮挖到宝物！`);
  } else {
    log(state, `${p.name} 第 ${roundNo} 轮挖空了，宝物在 ${treasure + 1} 号冰窟`);
  }
  if (mg.round < 2) {
    mg.round = (mg.round + 1) as 0 | 1 | 2;
    return;
  }
  const hits = mg.hits.filter(Boolean).length;
  const payout = scaled(state, PENGUIN_PAYOUT[hits]!);
  if (payout >= 0) {
    p.cash += payout;
    log(state, `企鹅挖宝结束：挖到 ${hits}/3 件宝物，${p.name} 获得 ¥${payout}`);
  } else {
    log(state, `企鹅挖宝结束：一无所获，${p.name} 支付门票 ¥${-payout}`);
    payCash(state, p, -payout, null, 'minigame');
  }
  awardMinigamePoints(state, p, hits);
  state.minigame = null;
  if (isGameOver(state)) return;
  advanceTurn(state);
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
      payCash(state, p, -payout, null, 'minigame');
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

/** ECON-08：乐透行自选号码投注（现金 1000，不随物价指数缩放） */
function buyLotteryTicket(state: GameState, action: Extract<PlayerAction, { type: 'BUY_LOTTERY_TICKET' }>): void {
  if (state.phase !== 'awaiting_action') throw new Error('当前不能投注乐透');
  const p = currentPlayer(state);
  const c = cellAt(state, p.position);
  if (c.type !== 'lottery') throw new Error('不在乐透行，不能投注');
  if (!isValidLotteryNumber(action.number)) throw new Error('号码必须是 0-99 的整数');
  if (p.cash < LOTTERY_TICKET_COST) throw new Error('现金不足');
  p.cash -= LOTTERY_TICKET_COST;
  state.lotteryPool += LOTTERY_TICKET_COST;
  state.lotteryTickets.push({ playerId: p.id, number: action.number });
  log(state, `${p.name} 在「${c.name}」以 ¥${LOTTERY_TICKET_COST} 投注号码 ${action.number}，奖池累计 ¥${state.lotteryPool}`);
}

// ---------------------------------------------------------------------------
// NPC-01..06 特殊单位动作：保释四大恶人 + 魔法屋施法
// ---------------------------------------------------------------------------

/** 保释金（固定 5000，随物价指数缩放） */
function bailFee(state: GameState): number {
  return scaled(state, BAIL_FEE);
}

/** 魔法屋施法条件对应的候选受罚者（排除施法者本人与已倒闭玩家） */
function magicCandidates(state: GameState, caster: Player, condition: MagicOffer['condition']): string[] {
  const others = activePlayers(state).filter((p) => p.id !== caster.id);
  switch (condition) {
    case 'all':
      return others.map((p) => p.id);
    case 'ahead':
      return others.filter((p) => totalAssets(state, p) > totalAssets(state, caster)).map((p) => p.id);
    case 'behind':
      return others.filter((p) => totalAssets(state, p) < totalAssets(state, caster)).map((p) => p.id);
    case 'vehicle':
      // 拥有交通工具（机车 diceCount=2 / 汽车 diceCount=3）
      return others.filter((p) => p.diceCount > 1).map((p) => p.id);
    case 'landowner':
      return others.filter((p) => p.properties.some((q) => {
        const cell = state.board[q.cellId];
        return cell ? (cell.type === 'property' || cell.type === 'commercial') : false;
      })).map((p) => p.id);
    default: {
      const exhaustive: never = condition;
      throw new Error(`未知施法条件: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** 当前站立于监狱门外时可保释的在押恶人 */
function bailableVillains(state: GameState): VillainKind[] {
  const p = currentPlayer(state);
  if (state.phase !== 'awaiting_action' || p.bankrupt) return [];
  if (cellAt(state, p.position).type !== 'jail') return [];
  return state.npcs
    .filter((n) => n.kind !== 'dog' && n.jailed)
    .map((n) => n.kind as VillainKind);
}

/** NPC-01..04：在监狱门外保释一名在押恶人（收益归保释人） */
function bailPrisoner(state: GameState, action: Extract<PlayerAction, { type: 'BAIL_PRISONER' }>): void {
  if (state.phase !== 'awaiting_action') throw new Error('当前不能保释');
  const p = currentPlayer(state);
  if (cellAt(state, p.position).type !== 'jail') throw new Error('不在监狱门外，不能保释');
  const npc = state.npcs.find((n) => n.kind === action.npcKind);
  if (!npc) throw new Error('没有这名恶人');
  if (!npc.jailed) throw new Error('这名恶人不在押');
  const fee = bailFee(state);
  if (p.cash < fee) throw new Error('现金不足以支付保释金');
  p.cash -= fee;
  npc.jailed = false;
  npc.ownerId = p.id;
  npc.daysLeft = VILLAIN_DAYS;
  npc.position = cellAt(state, p.position).id;
  log(
    state,
    `${p.name} 花费 ¥${fee} 保释了${villainDefOf(npc).name}，${VILLAIN_DAYS} 天内所获收益归 ${p.name}`,
  );
}

/** TILE-11：女巫施法，对指定候选降下诅咒 */
function castMagic(state: GameState, action: Extract<PlayerAction, { type: 'CAST_MAGIC' }>): void {
  const offer = state.magic;
  if (!offer) throw new Error('当前没有可施法的机会');
  if (state.phase !== 'awaiting_action') throw new Error('当前不能施法');
  const p = currentPlayer(state);
  const target = state.players.find((q) => q.id === action.targetPlayerId);
  if (!target) throw new Error('受罚对象不存在');
  if (target.id === p.id) throw new Error('不能诅咒自己');
  if (!offer.candidateIds.includes(target.id)) throw new Error('该对象不满足施法条件');
  const curseDef = CURSES[offer.curse];
  state.magic = null;
  log(state, `${p.name} 对 ${target.name} 施法，诅咒「${curseDef.name}」降临`);
  switch (offer.curse) {
    case 'fine':
      payCash(state, target, offer.amount, null, 'god');
      break;
    case 'jail':
      applyDisaster(state, target, 'jail', p, (v) => {
        v.skipTurns = Math.max(v.skipTurns, offer.days);
        v.custody = { kind: 'jail', daysLeft: Math.max(v.skipTurns, offer.days) };
        blockRent(v, offer.days);
        log(state, `${v.name} 被关进监狱，暂停 ${offer.days} 回合并丧失收租权`);
      });
      break;
    case 'hospital':
      applyDisaster(state, target, 'jail', p, (v) => {
        v.skipTurns = Math.max(v.skipTurns, offer.days);
        v.custody = { kind: 'hospital', daysLeft: Math.max(v.skipTurns, offer.days) };
        blockRent(v, offer.days);
        log(state, `${v.name} 怪病缠身，住院 ${offer.days} 天并丧失收租权`);
      });
      break;
    case 'abroad':
      applyDisaster(state, target, 'jail', p, (v) => {
        v.abroadTurns = Math.max(v.abroadTurns, offer.days);
        v.skipTurns = Math.max(v.skipTurns, offer.days);
        log(state, `${v.name} 被放逐异界 ${offer.days} 回合`);
      });
      break;
    case 'lose-card':
      applyDisaster(state, target, 'jail', p, (v) => {
        if (v.cards.length === 0) {
          log(state, `${v.name} 身上没有卡片，诅咒无处降落`);
          return;
        }
        const idx = randomIndex(state, v.cards.length);
        const cardId = v.cards[idx]!;
        v.cards.splice(idx, 1);
        log(state, `${v.name} 的卡片「${CARDS[cardId]?.name ?? cardId}」凭空消失`);
      });
      break;
    default: {
      const exhaustive: never = offer.curse;
      throw new Error(`未知诅咒: ${JSON.stringify(exhaustive)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// ECON-13 拍卖器：触发源（倒闭/拍卖卡/事件/银行）+ 出价轮询 + 价高者得
// ---------------------------------------------------------------------------

/** 起拍价：有地价者取其半价（含物价指数），否则 100 */
function auctionMinBid(state: GameState, cell: BoardCell): number {
  if (cell.price === undefined) return 100;
  return Math.max(1, Math.floor(scaled(state, cell.price) / 2));
}

/** 竞买人：非破产且有现金者（ECON-13「无现金不得参与」）；卖家本人不参与 */
function auctionBidders(state: GameState, excludeId: string | null): string[] {
  return state.players
    .filter((q) => !q.bankrupt && q.cash > 0 && q.id !== excludeId)
    .map((q) => q.id);
}

/** 开一场拍卖会；无人具备竞买资格时返回 false（不进入拍卖阶段） */
function beginAuction(
  state: GameState,
  opts: { cellId: number; sellerId: string | null; trigger: AuctionTrigger; afterComplete: 'resume' | 'advance' },
): boolean {
  const cell = state.board[opts.cellId];
  if (!cell || (cell.type !== 'property' && cell.type !== 'commercial')) return false;
  const bidders = auctionBidders(state, opts.sellerId);
  if (bidders.length === 0) {
    log(state, `【拍卖】「${cell.name}」无人具备竞买资格（须持有现金），流拍`);
    return false;
  }
  state.auction = {
    cellId: opts.cellId,
    sellerId: opts.sellerId,
    trigger: opts.trigger,
    bidders,
    turnIndex: 0,
    minBid: auctionMinBid(state, cell),
    highestBid: 0,
    highestBidderId: null,
    passes: 0,
    afterComplete: opts.afterComplete,
  };
  state.phase = 'awaiting_auction';
  log(state, `【拍卖】「${cell.name}」开拍，起拍价 ¥${state.auction.minBid}，竞买人 ${bidders.length} 位`);
  return true;
}

/** 倒闭清算等产生的待拍卖标的：开拍并暂停回合推进；无标的时返回 false */
function startQueuedAuction(state: GameState): boolean {
  while (state.auctionQueue.length > 0) {
    const next = state.auctionQueue.shift()!;
    if (beginAuction(state, { ...next, afterComplete: 'advance' })) return true;
  }
  return false;
}

function currentBidder(state: GameState): Player {
  const a = state.auction;
  if (!a) throw new Error('当前没有进行中的拍卖');
  const id = a.bidders[a.turnIndex];
  const p = state.players.find((q) => q.id === id);
  if (!p) throw new Error('竞买人不存在');
  return p;
}

/** 下一次允许的最低出价 */
function nextBidAmount(a: AuctionState): number {
  return a.highestBidderId ? a.highestBid + 1 : a.minBid;
}

function auctionBid(state: GameState, action: Extract<PlayerAction, { type: 'AUCTION_BID' }>): void {
  if (state.phase !== 'awaiting_auction' || !state.auction) throw new Error('当前没有进行中的拍卖');
  const a = state.auction;
  const bidder = currentBidder(state);
  const min = nextBidAmount(a);
  if (!Number.isInteger(action.amount) || action.amount < min) throw new Error(`出价不得低于 ¥${min}`);
  if (action.amount > bidder.cash) throw new Error('出价不能超过自己的现金');
  a.highestBid = action.amount;
  a.highestBidderId = bidder.id;
  a.passes = 0;
  log(state, `【拍卖】${bidder.name} 出价 ¥${action.amount}`);
  a.turnIndex = (a.turnIndex + 1) % a.bidders.length;
  if (a.passes >= a.bidders.length) settleAuction(state);
}

function auctionPass(state: GameState): void {
  if (state.phase !== 'awaiting_auction' || !state.auction) throw new Error('当前没有进行中的拍卖');
  const a = state.auction;
  const bidder = currentBidder(state);
  a.passes += 1;
  log(state, `【拍卖】${bidder.name} 放弃出价`);
  a.turnIndex = (a.turnIndex + 1) % a.bidders.length;
  if (a.passes >= a.bidders.length) settleAuction(state);
}

/** 收锤：价高者得；地权与款项一并交割，随后继续下一件标的或恢复流程 */
function settleAuction(state: GameState): void {
  const a = state.auction!;
  const cell = state.board[a.cellId]!;
  state.auction = null;
  const winner = a.highestBidderId ? state.players.find((q) => q.id === a.highestBidderId) : undefined;
  if (winner) {
    const price = Math.min(a.highestBid, winner.cash);
    winner.cash -= price;
    const seller = a.sellerId ? state.players.find((q) => q.id === a.sellerId) : undefined;
    if (seller && !seller.bankrupt) seller.cash += price;
    // 地权转移（延续等级/设施/连锁状态，避免凭空重置）
    const prev = cellOwner(state, a.cellId);
    if (prev && prev.player.id !== winner.id) {
      prev.player.properties = prev.player.properties.filter((q) => q.cellId !== a.cellId);
      winner.properties.push({ ...prev.property });
    } else if (!prev) {
      winner.properties.push({ cellId: a.cellId, grade: 1 });
    }
    log(state, `【拍卖】成交！${winner.name} 以 ¥${price} 拍得「${cell.name}」`);
  } else {
    log(state, `【拍卖】「${cell.name}」流拍，无人出价`);
  }

  while (state.auctionQueue.length > 0) {
    const next = state.auctionQueue.shift()!;
    if (beginAuction(state, { ...next, afterComplete: 'advance' })) return;
  }
  if (a.afterComplete === 'advance') advanceTurn(state);
  else state.phase = 'awaiting_action';
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
  if (state.loanBanDays > 0) throw new Error(`银行挤兑中，${state.loanBanDays} 天内停止放款（EVT-01 事件 22）`);
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
    case 'auction': {
      // CARD-08：拍卖脚下土地，所得归使用者，且使用者本人不参与该拍卖会
      const id = anyCellId();
      const c = state.board[id]!;
      if (c.type !== 'property' && c.type !== 'commercial') throw new Error('目标必须是土地');
      const owned = cellOwner(state, id);
      if (!owned) throw new Error('该土地无主，无法拍卖');
      log(state, `${p.name} 使用「拍卖卡」，将 ${owned.player.name} 的「${c.name}」送上拍卖台（所得归 ${p.name}）`);
      beginAuction(state, { cellId: id, sellerId: p.id, trigger: 'card', afterComplete: 'resume' });
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
  if (state.stockHaltAllDays > 0) throw new Error(`全市场停牌中（剩余 ${state.stockHaltAllDays} 天）`);
  if (isStockSuspended(state, stock.id)) throw new Error(`${stock.name} 暂停交易中`);
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
  if (state.stockHaltAllDays > 0) throw new Error(`全市场停牌中（剩余 ${state.stockHaltAllDays} 天）`);
  if (isStockSuspended(state, stock.id)) throw new Error(`${stock.name} 暂停交易中`);
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
  next.auction = null;
  next.auctionQueue = [];
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
    case 'BUY_LOTTERY_TICKET':
      buyLotteryTicket(next, action);
      break;
    case 'AUCTION_BID':
      auctionBid(next, action);
      break;
    case 'AUCTION_PASS':
      auctionPass(next);
      break;
    case 'BAIL_PRISONER':
      bailPrisoner(next, action);
      break;
    case 'CAST_MAGIC':
      castMagic(next, action);
      break;
    default: {
      const exhaustive: never = action;
      throw new Error(`未知动作: ${JSON.stringify(exhaustive)}`);
    }
  }
  return next;
}







