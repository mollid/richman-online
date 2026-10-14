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
  boardNeighbors,
  pathAhead,
  stepAlong,
  POINTS_START,
  STARTING_CASH,
  STOCK_DEFS,
  walkWindow,
} from './board.js';
import { boardFromMap, companiesFromMap, mapStockPool } from './maps/index.js';
import {
  applyGodRentModifier,
  applyGodTravel,
  attachGod,
  currentMonthIndex,
  godBlocksInvestment,
  godDef,
  godDoublesBuild,
  godFreeLandPurchase,
  godTickHook,
  nearestGodFor,
  summonDeathOnAvenger,
  summonGod,
} from './gods.js';
import { addMonths, DEFAULT_START_DATE, gameDate, toSerial } from './calendar.js';
import { landPrice, landRent, landPriceLevel, landUpgradeCost, mapLandPriceLevel, scaled, totalAssets } from './economy.js';
import { boardGodAt, clearBoardGodsOnCells, detachGodForPossession, godSpawnHook, godSummonRefusal } from './godspawn.js';
import {
  applyTradeImpact,
  clampStockPrice,
  MARKET_DRIFT_PCT,
  sealDailyCandle,
  STOCK_DAY_LIMIT_PCT,
  STOCK_MIN_PRICE,
  STOCK_NOISE_PCT,
  STOCK_REVERSION_HIGH,
  STOCK_REVERSION_LOW,
  stockAnchor,
  stockExecPrice,
  stockLimitState,
} from './stocks.js';
import { CARDS, CHANCE_CARD_POOL, SHOP_CARD_IDS } from './cards.js';
import { resolveLanding } from './cell_handlers.js';
import { BOMB_FUSE_STEPS, ITEMS, itemSellValue, SHOP_ITEM_IDS, STARTING_ITEMS } from './items.js';
import type { CellLandingCtx, EffectKit, GodEffectCtx } from './effect_ctx.js';
import { landingVenueOf } from './effect_ctx.js';
import { nextRandom, rollDie } from './rng.js';
import { drawWinningNumber, isValidLotteryNumber, LOTTERY_TICKET_COST } from './lottery.js';
import {
  NEWS_CATEGORY_LABEL,
  NEWS_EFFECTS,
  NEWS_EVENT_COUNT,
  renderNewsText,
  supportedNewsEvents,
  type NewsEventDef,
} from './news.js';
import {
  FATE_EFFECTS,
  FATE_PUBLIC_IDS,
  fateCardById,
  renderFateText,
  type FateCardDef,
} from './fate.js';
import { buyTrade, buyTradeRefusal, cancelTrade, cancelTradeRefusal, postTrade, postTradeRefusal, refreshTrades, tradableAssets } from './trade.js';
import {
  BAIL_FEE,
  MAGIC_CONDITION_LABEL,
  MAGIC_EFFECTS,
  MAGIC_EFFECT_ORDER,
  MAGIC_INSURANCE_CLAIM,
  PROTECTION_FEE_RATE,
  THIEF_POINTS_TAKE,
  TREASURE_POINTS,
  VILLAIN_DAYS,
  VILLAIN_KINDS,
  VILLAINS,
  type MagicEffectDef,
  type VillainDef,
} from './npc.js';
import {
  FACILITIES,
  FACILITY_ORDER,
  MAX_GRADE,
  RESEARCH_ORDER,
  chainRent,
  facilityBuildCost,
  facilityUpgradeable,
  gradeName,
  holdsWholeStreet,
  playersInViewport,
  researchDef,
  streetCells,
} from './tiles.js';
import { targetRefusal } from './targets.js';
import {
  COMPANIES,
  COMPANY_LIST,
  companyStockDefs,
  companyStockId,
  ESTATE_BUILD_RATIO,
  MAX_SHARES_PER_BUY,
  companyAtCell,
  lockedSharesOf,
  majorityHolderId,
  maxCashShares,
  sellableSharesOf,
} from './companies.js';
import type {
  ActionOf,
  ActionRefusal,
  ActionSpec,
  ActionSpecMap,
  AuctionState,
  AuctionTrigger,
  AvailableActions,
  BankAccess,
  BoardCell,
  CompanyKind,
  CompanyState,
  DateSerial,
  DisasterKind,
  FacilityType,
  GameState,
  MagicCondition,
  NpcUnit,
  PayReason,
  Player,
  PlayerAction,
  StockPoolDef,
  PlayerDef,
  PlayerProperty,
  RoundSnapshot,
  VillainKind,
} from './types.js';

/**
 * 联机房的默认天数上限（CORE-04 / 玩法文档 §14 第 2 项）。
 *
 * 60 天的来处：1 天 = 全员各行动一次，四人局约 240 回合，正好落在实测 bot 四人局自然
 * 分出胜负的 turn=259 附近 —— 长局卡住时能收口，正常对局又很少被提前截断。
 */
export const ONLINE_DEFAULT_MAX_DAYS = 60;
/** 开局可选的天数上限档位（`null` = 不限；热座默认这一档） */
export const MAX_DAY_CHOICES: ReadonlyArray<number | null> = [null, 40, ONLINE_DEFAULT_MAX_DAYS, 90];
/** 上限的合法区间：越界值由 `resolveMaxDays` 夹回来，不为建房参数报错 */
export const MAX_DAYS_LIMITS = { min: 10, max: 360 };

/**
 * 把客户端上报的天数上限夹到合法区间；`null` / 0 / 非法值 = 不限天数。
 * 「没传参数」不在这里判断 —— 房主显式选「不限」和客户端漏传字段是两回事，
 * 缺省值由调用方（GameRoom）决定。
 */
export function resolveMaxDays(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(MAX_DAYS_LIMITS.max, Math.max(MAX_DAYS_LIMITS.min, Math.floor(n)));
}

export interface CreateGameOptions {
  /** 起始日期；缺省用固定常量，保证 shared 不读系统时钟 */
  startDate?: DateSerial;
  /**
   * 地图：`null` / 不填 = 自建的 64 格环（默认，也是既有测试与录像的基线），
   * 数字取自 `shared/src/maps` 的原版图。棋盘、公司表、行情池都跟着这张图走。
   */
  mapId?: number | null;
  /**
   * 神明是否随机现身驻留棋盘（GOD 现身机制，W2）。默认开启。
   * 关掉 ⇒ 日切不为这条机制消耗 RNG 抽数，数值断言型测试用它隔离这条随机源
   * （同 `pinIndexOne` 隔离物价指数）。
   */
  spawnGods?: boolean;
  /**
   * 天数上限（CORE-04 / 玩法文档 §14 第 2 项）：打满 n 天后按总资产结算收场。
   * `null` 或不填 = 不限（只有「对手全破产」这一条结束路径）。
   * 联机房由 `GameRoom` 填 `ONLINE_DEFAULT_MAX_DAYS`，热座由开局面板选。
   */
  maxDays?: number | null;
}

/**
 * 出生格候选池（SP-01）：只取「站上去无事发生」的普通格 —— 可购地、商业地、机会、商店。
 * 起点（经过领薪水的特权格）、监狱、医院、银行、神庙、公司企业一律不作出生点。
 */
const SPAWNABLE_TYPES: BoardCell['type'][] = ['property', 'commercial', 'chance', 'shop'];
/** 两个出生点沿环的最小间隔（格数）：太近就失去「把人撒到全图」的意思；凑不满时退让成「只要不重叠」 */
const MIN_SPAWN_GAP = 4;

export function spawnCellPool(board: BoardCell[]): number[] {
  return board.filter((c) => SPAWNABLE_TYPES.includes(c.type)).map((c) => c.id);
}

/** 两格沿环形圈的最短距离 */
function ringGap(a: number, b: number, size: number): number {
  const d = Math.abs(a - b);
  return Math.min(d, size - d);
}

/**
 * 前 `count` 个座位的出生格（SP-01）。
 *
 * 口径同 `newsCursor`：**只从种子派生，不消耗 `rngState` 抽数**。联机房是「空房建局 + 逐个
 * `addPlayer`」，回放是「一次性 `createGame(全部座位)`」，两条路径必须算出同一批出生点；
 * 一旦走抽数，「谁几点进房」就会串改此后所有随机事件。座位 k 的结果与 `count` 无关，
 * 中途有人进房/退房也不会挪动别人已经拿到的出生点。
 */
export function spawnCells(seed: number, count: number, board: BoardCell[]): number[] {
  const pool = spawnCellPool(board);
  const size = board.length || BOARD_SIZE;
  const taken: number[] = [];
  for (let seat = 0; seat < count; seat++) {
    if (pool.length === 0) break;
    const start = Math.floor(nextRandom(((seed >>> 0) + (seat + 1) * 0x9e3779b1) >>> 0).value * pool.length) % pool.length;
    // 从派生出的那一格起沿池顺扫：先要「隔得开」，池子挤不满时退而求其次只要「不重叠」
    const order = pool.map((_, k) => pool[(start + k) % pool.length]!);
    const free = (cellId: number) => !taken.includes(cellId);
    const spaced = (cellId: number) => taken.every((t) => ringGap(t, cellId, size) >= MIN_SPAWN_GAP);
    const pick = order.find((c) => free(c) && spaced(c)) ?? order.find(free);
    if (pick == null) break;
    taken.push(pick);
  }
  return taken;
}

/** 新玩家的初始字段（createGame 与 addPlayer 共用） */
function basePlayer(def: PlayerDef, spawnAt: number): Player {
  return {
    ...def,
    cash: STARTING_CASH,
    deposit: 0,
    points: POINTS_START,
    loan: null,
    position: spawnAt,
    // SP-02：出生格先「押着」，踏出第一步之前这一格不算落到（见 standsOnOwnSpawn）
    spawnCell: spawnAt,
    heading: 1,
    properties: [],
    cards: [],
    items: {},
    stocks: {},
    god: null,
    skipTurns: 0,
    holdTurns: 0,
    rentBlockedTurns: 0,
    sleepwalkTurns: 0,
    turtleTurns: 0,
    bulldozerTurns: 0,
    bulldozerSteps: 0,
    bulldozerSavedDiceCount: 1,
    research: null,
    diceCount: 1,
    fixedDice: null,
    alliance: null,
    abroadTurns: 0,
    insurance: null,
    financing: 0,
    custody: null,
    unlucky: null,
    bankrupt: false,
    beggarGone: false,
    online: true,
  };
}

export function createGame(players: PlayerDef[], seed = Date.now() % 2147483647, options: CreateGameOptions = {}): GameState {
  if (players.length > 4) {
    throw new Error('游戏最多 4 名玩家');
  }
  const mapId = options.mapId ?? null;
  const board = mapId == null ? structuredClone(DEFAULT_BOARD) : boardFromMap(mapId);
  // 原版每张图的监狱格 id 都不同，恶人押在哪一格要跟着图走，不能写死默认图的那格
  const jailCell = board.find((c) => c.type === 'jail');
  if (!jailCell) throw new Error('棋盘缺少监狱格');
  // 公司表按图给：自建图是那 11 家，原版图用 mkf 自带的 1~4 家（一家占相邻两格、名字是原名）
  const companyDefs = mapId == null ? COMPANY_LIST : companiesFromMap(mapId);
  // 行情池按图给：自建图 = 6 支自造行业股 + 11 家公司股；原版图 = EXE 股票表 `0x47f072` 那 12 支。
  // 原版图上的公司**不另开行**（它的名字本来就在这 12 支里，id 仍是 `corp-<kind>`），
  // 而那 6 支行业股（科技/食品/地产…）是与地图无关的自造设计，挂在原版图上就是假数据。
  const stockDefs: StockPoolDef[] =
    mapId == null ? [...STOCK_DEFS, ...companyStockDefs(companyDefs)] : mapStockPool(mapId, companyDefs);
  const spawns = spawnCells(seed >>> 0, players.length, board);
  // 本地股的锚挂这张图的地价水平（原版 `股票表+0x04` 只有本地 / 非本地，没有城市号）。
  // 开局基准就在这一块算，日切那头走 `economy.mapLandPriceLevel` —— 同一段代码，两个入口。
  const landPriceBase = landPriceLevel(board);
  return {
    players: players.map((p, i) => basePlayer(p, spawns[i] ?? 0)),
    board,
    currentPlayerIndex: 0,
    phase: 'lobby',
    turnStage: 'start',
    dice: null,
    movePath: null,
    turn: 0,
    round: 1,
    // 建局参数原样存一份：出生点按 (seed, seat) 派生，`rngState` 会被后续抽数推着走、不能当种子用
    seed: seed >>> 0,
    mapId,
    rngState: seed >>> 0,
    log: [{ turn: 0, text: '游戏房间已创建' }],
    winnerId: null,
    endReason: null,
    maxDays: options.maxDays ?? null,
    stockMarket: {
      // 同一套行情机器：日切每支各抽一次数 ⇒ 抽数流按这张图的支数走
      stocks: stockDefs.map((s) => ({
          id: s.id,
          name: s.name,
          price: s.initialPrice,
          // 开盘 = 锚 = 建仓价：第一个交易日之前没有「昨收」，闸门因此判平盘；
          // 锚是均值回归的那根桩，本地股每天跟着这张图的地价走
          openPrice: s.initialPrice,
          anchorPrice: s.initialPrice,
          volatility: s.volatility ?? 1,
          lastChangePct: 0,
          floatShares: s.floatShares,
          remainingShares: s.floatShares,   // 还没被买走的量：买入扣、卖出回补，可以买光
          ...(s.followsLandPrice && landPriceBase > 0 ? { landPriceBase } : {}),
          candles: [],
        })),
    },
    roadblocks: [],
    mines: [],
    trapBombs: [],
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
    companies: companyDefs.map((def) => ({
      kind: def.kind,
      name: def.name,
      tile: def.tile,
      cellId: def.cellId,
      footprint: def.footprint ?? [def.cellId],
      sharePrice: def.sharePrice,
      surplus: 0,
      shares: {},
      chairmanId: null,
      firstHeldDayIndex: {},
      lockedShares: {},
    })),
    // EVT-01：游标初值由种子派生（原版「游标从当前值起轮询」，不消耗 RNG 抽数）
    newsCursor: (seed >>> 0) % NEWS_EVENT_COUNT,
    streetPriceFactors: {},
    stockHaltAllDays: 0,
    loanBanDays: 0,
    // NPC-01..04 四大恶人初始在押于监狱；被玩家保释后上路为保释人效力
    npcs: VILLAIN_KINDS.map((kind) => ({
      kind,
      position: jailCell.id,
      ownerId: null,
      daysLeft: 0,
      jailed: true,
    })),
    // 宝箱（TILE-31）：开局在 startGame 投第一只，此后换月由日切钩子重投
    treasureCellId: null,
    treasureMonth: 0,
    magic: null,
    // GOD-01 土地公隔月再现（help [40]）：初始未出现过，可随机到
    landGodCooldownMonth: 0,
    // 神明现身机制（W2）：新开的局默认开启
    boardGods: [],
    spawnGods: options.spawnGods !== false,
    godPairBanUntil: {},
    pendingCards: [],
    landing: null,
    // UI-06 公布栏：初始无挂牌、无成交记录
    trades: [],
    tradeHistory: [],
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
  const seat = next.players.length;
  const spawns = spawnCells(state.seed, seat + 1, state.board);
  next.players.push(basePlayer(def, spawns[seat] ?? 0));
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
  // 移除后修正 currentPlayerIndex，避免 players 变短导致越界（空房间时归零）
  if (next.players.length === 0) {
    next.currentPlayerIndex = 0;
  } else if (idx < next.currentPlayerIndex) {
    next.currentPlayerIndex -= 1;
  } else if (next.currentPlayerIndex >= next.players.length) {
    next.currentPlayerIndex = next.players.length - 1;
  }
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
  if (!p) throw new Error(NO_ACTOR_MESSAGE);
  return p;
}

/**
 * 安全的「当前玩家」查询：房间在 lobby 阶段可能一个玩家都没有
 * （所有人离开后 players 为空数组但 currentPlayerIndex 仍是 0）。
 * `availableActions` 会被`broadcastState` 在任何阶段调用，因此必须能安全降级，
 * 否则房间一空就会抛错、导致「联机失败」。
 */
function currentPlayerOrNull(state: GameState): Player | null {
  return state.players[state.currentPlayerIndex] ?? null;
}

function cellOwner(state: GameState, cellId: number): { player: Player; property: PlayerProperty } | undefined {
  for (const player of state.players) {
    const prop = player.properties.find((q) => q.cellId === cellId);
    if (prop) return { player, property: prop };
  }
  return undefined;
}

/**
 * 这只股票是不是地图上那 11 家公司挂进来的 `corp-<kind>`？是就返回它的经营状态。
 * CORP-14 改一本账之后，买卖它 = 买卖这家公司的持股（进股东名册、吃经营权与分红），
 * 两个渠道的差别只剩**价格与钱袋**：面板按市价走存款，踩格按面值走现金。
 */
function companyOfStock(state: GameState, stockId: string): CompanyState | undefined {
  if (!stockId.startsWith('corp-')) return undefined;
  const kind = stockId.slice('corp-'.length) as CompanyKind;
  return state.companies.find((c) => c.kind === kind);
}

function stockById(state: GameState, stockId: string) {
  return state.stockMarket.stocks.find((s) => s.id === stockId);
}

function checkWinner(state: GameState): void {
  // 收场只写一次：`checkWinner` 会在嵌套效果里和外面各被调一遍（认输 → 死神索命 → pay →
  // checkWinner，出来后 surrender 自己又调一遍），第二次进来局面早已判完，再走 `endGame`
  // 就是把同一条胜利播报写两遍。
  if (isGameOver(state)) return;
  const active = state.players.filter((p) => !p.bankrupt);
  if (active.length === 1) {
    endGame(state, active[0]!.id, 'bankrupt', `${active[0]!.name} 获得最终胜利！`);
  } else if (active.length === 0) {
    // 全员破产（单人房唯一的玩家倒下，或收场被覆盖后拖到同归于尽）：没有存活者就没有胜者，
    // 但**必须收场** —— 否则局面停在 awaiting_roll，谁也动不了，整局活锁。
    endGame(state, null, 'bankrupt', '场上已无存活者，本局无人获胜');
  }
}

/** 到期结算名次上的一行（只在本文件内用；结算面板的名次表由 `allAssetSummaries` 现算） */
interface RankedPlayer {
  p: Player;
  rank: number;
  assets: number;
}

/**
 * 到期结算的排名口径：总资产 → 现金 → 存款 → 座位序，倒闭者一律排在存活者之后。
 *
 * 现金做第一顺位决胜项：总资产里的地价部分在没卖出之前只是账面值，真金白银多的人该排前面。
 * 三项全等才算并列（同名次），不靠座位序硬分高下。
 */
function rankPlayers(state: GameState): RankedPlayer[] {
  const rows = state.players
    .map((p, seat) => ({ p, seat, assets: totalAssets(state, p) }))
    .sort((a, b) => {
      if (a.p.bankrupt !== b.p.bankrupt) return a.p.bankrupt ? 1 : -1;
      return b.assets - a.assets || b.p.cash - a.p.cash || b.p.deposit - a.p.deposit || a.seat - b.seat;
    });
  const out: RankedPlayer[] = [];
  rows.forEach((row, i) => {
    const prev = i > 0 ? rows[i - 1]! : null;
    const tied =
      !!prev &&
      !row.p.bankrupt &&
      prev.assets === row.assets &&
      prev.p.cash === row.p.cash &&
      prev.p.deposit === row.p.deposit;
    out.push({ p: row.p, assets: row.assets, rank: tied ? out[i - 1]!.rank : i + 1 });
  });
  return out;
}

/**
 * 收场：把 winner 与收场原因一次写定。两条结束路径（对手全破产 / 天数到点）共用这一个入口，
 * 免得「结束时要做什么」（停拍、清待拍队列、落日志）在两处各写一边。
 */
function endGame(state: GameState, winnerId: string | null, reason: 'bankrupt' | 'daylimit', line: string): void {
  state.phase = 'game_over';
  state.turnStage = 'end';
  state.winnerId = winnerId;
  state.endReason = reason;
  // 对局结束后不再开拍，清空拍卖状态与待拍队列
  state.auction = null;
  state.auctionQueue = [];
  log(state, line);
}

/**
 * 天数上限收场（CORE-04 的联机新增，玩法文档 §14 第 2 项）：打满 `maxDays` 天后按总资产结算。
 *
 * 排在 DAY_HOOKS 最前：到点这一天不该再发股东分红、计息或现神明 —— 否则「第 60 天」会多结
 * 一次利息与股利，而那笔钱正是名次要算的东西。
 */
function dayLimitHook(state: GameState): void {
  if (state.maxDays === null || state.calendar.elapsedDays < state.maxDays) return;
  const ranked = rankPlayers(state);
  const leaders = ranked.filter((r) => r.rank === 1 && !r.p.bankrupt);
  const winner = leaders.length === 1 ? leaders[0]! : null;
  const top3 = ranked.slice(0, 3).map((r) => `${r.p.name} ¥${r.assets}`).join('、');
  endGame(
    state,
    winner?.p.id ?? null,
    'daylimit',
    `第 ${state.calendar.elapsedDays} 天期满，按总资产结算：${
      winner ? `${winner.p.name} 以 ¥${winner.assets} 居首获胜（前三 ${top3}）` : `第一名并列（${top3}），本局平局`
    }`,
  );
}

function bankruptPlayer(state: GameState, p: Player): void {
  p.bankrupt = true;
  p.cash = 0;
  p.deposit = 0;
  p.points = 0;
  p.loan = null;
  p.skipTurns = 0;
  p.heading = 1;
  p.holdTurns = 0;
  p.rentBlockedTurns = 0;
  p.sleepwalkTurns = 0;
  p.turtleTurns = 0;
  p.bulldozerTurns = 0;
  p.bulldozerSteps = 0;
  p.bulldozerSavedDiceCount = 1;
  // D-46：破产即转做乞丐 —— 出局（`bankrupt` 已把它排除出在局集合），但留在棋盘上原地行乞
  p.beggarGone = false;
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
    delete company.lockedShares[p.id];
    if (company.chairmanId === p.id) company.chairmanId = majorityHolderId(company, state.players);
  }
  // 定时炸弹失去载体
  state.bombs = state.bombs.filter((b) => b.playerId !== p.id);
  log(state, `${p.name} 破产出局，名下资产被银行没收`);
}

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
/** EVT-04 倒闭乞讨：施舍金额区间（D-46，每次随机取一档再乘物价指数；旧口径为固定 1000） */
const BEGGAR_ALMS_MIN = 500;
const BEGGAR_ALMS_MAX = 3000;

/**
 * 乞丐收完施舍后的换岗（D-46）：挪去别处行乞，避免同一格被反复收钱。
 * 只挑「没人站着」的格子（在局玩家与其他乞丐都算占位）；挑不动就留在原地，
 * 宁可少挪一次，也不把两个单位叠在同一格上让落格结算互相咬。
 */
function relocateBeggar(state: GameState, beggar: Player): void {
  const occupied = new Set(state.players.filter((q) => !q.beggarGone && q.id !== beggar.id).map((q) => q.position));
  const free = state.board.map((cell) => cell.id).filter((id) => !occupied.has(id));
  if (free.length === 0) return;
  beggar.position = free[randomIndex(state, free.length)]!;
  log(state, `${beggar.name} 道过谢，挪到「${state.board[beggar.position]!.name}」继续行乞`);
}

/**
 * 工程车完工/报废（D-45）：18 步或 7 天任一先到，并把**暂停使用**的载具原样交还。
 */
function retireBulldozer(state: GameState, p: Player, reason: string): void {
  p.bulldozerTurns = 0;
  p.bulldozerSteps = 0;
  const saved = p.bulldozerSavedDiceCount || 1;
  p.bulldozerSavedDiceCount = 1;
  if (p.diceCount <= 1 && saved > 1) {
    p.diceCount = saved;
    log(state, `${p.name} 的工程车${reason}报废，原先的载具恢复使用`);
  } else {
    log(state, `${p.name} 的工程车${reason}报废`);
  }
}

/**
 * 三货币支付管道：**现金 → 存款 → 破产**。
 *
 * 关键规则：**负债时不自动变卖资产**（含股票、建筑）。玩家若因支付不起而破产，
 * 只能通过随机事件（如危险格「变卖所有股票求现」）主动兑现股票 —— 与原版一致。
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

  // 3. 现金与存款都用尽即告不足——**不自动变卖股票或建筑**（用户规则 + 原版口径）
  const paid = amount - remaining;

  // ECON-08：运气/事件等意外损失（无收款方）的钱汇总进乐透奖池
  if (to === null && paid > 0 && opts.reason && LOTTERY_PENALTY_REASONS.has(opts.reason)) {
    state.lotteryPool += paid;
  }

  creditPayee(to, paid, opts.toDeposit === true);

  if (remaining > 0) {
    log(state, `${from.name} 现金与存款均已用尽，无力支付 ¥${amount}（实付 ¥${paid}），宣告破产`);
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

/**
 * 无收款方的支出（罚款/损失/倒霉事）。
 *
 * GOD-12：霉运期间（`unlucky.multiplier > 1`）**倒霉事加倍**——
 * 罚金、事件损失、天灾等落在自己头上的钱按倍率上浮。
 */
function payCash(state: GameState, from: Player, amount: number, to: Player | null, reason?: PayReason): void {
  const bad = unluckyMultiplier(from);
  const finalAmount = to === null && bad > 1 ? amount * bad : amount;
  pay(state, from, finalAmount, to, { toDeposit: false, reason });
}

/** EVT-01 事件 26/27：全体或单支股票是否处于停牌期（停牌期间价格冻结、不可买卖） */
function isStockSuspended(state: GameState, stockId: string): boolean {
  return state.stockHalts.some((h) => h.stockId === stockId && h.kind === 'suspend');
}

/**
 * ECON-09 股市是否开放买卖。
 *
 * 原版 help[14]「股票是一項不錯的投資，**您可以隨時進行買賣**」——
 * 买卖**不绑定任何格型**，玩家在自己回合的任意决策点都能交易；
 * 唯一的全局开关是**星期例假日休市**（TIME-02）与新闻事件导致的**全市场停牌**。
 */
function isMarketOpen(state: GameState): boolean {
  if (state.stockHaltAllDays > 0) return false;
  if (gameDate(state).isHoliday) return false;
  return true;
}

/**
 * 交易股票所处阶段：自己回合的掷骰前或决策后都允许（不打断掷骰）。
 * `awaiting_roll` / `awaiting_action` 本身就意味着「轮到当前玩家」，故已天然满足回合归属。
 */
/*
 * R4：自由操作（炒股）收到**掷骰前**这一段。
 *
 * 落格决策窗（`awaiting_action`）从此只接受与脚下那一格有关的动作 —— 玩家踩到商店格时该看见
 * 的是「买什么」，不是顺手把整个股市打开。原版「随时可买卖」并没有被改掉：每一回合都有一段
 * `awaiting_roll`，那一整段都可以敞开交易，只是不再和「刚踩到某一格」挤在同一屏里。
 */
function canTradeStockNow(state: GameState): boolean {
  return state.phase === 'awaiting_roll';
}

/** 股票市场回合波动 + 随机新闻；例假日休市（ECON-09）；红卡/黑卡期间涨跌停（CARD-24/25） */
function tickStockMarket(state: GameState): void {
  if (gameDate(state).isHoliday) return; // 例假日休市：不生成当日 K 线，也不走随机
  const stocks = state.stockMarket.stocks;
  // 大盘漂移：当日全体共享一个（原版 `(rand()-0x4000)/4097` ∈ ±4%）。
  // 走**只读派生随机**而不是再抽一次：日钩子里多一条抽数会把此后所有骰子序列整体打散
  // （W2 的神明现身就是这种量级的代价），而漂移只是行情层的数，与恶犬/恶人/宝箱同一类，
  // 按日做 salt ⇒ 逐日不同、跨日不重演，且不扰动确定性回放。
  const drift = (derivedValue(state, state.calendar.elapsedDays * 8 + 7) * 2 - 1) * MARKET_DRIFT_PCT;
  // 本地股那根锚今天挂在什么地价上（一天一算：街道乘数当天不会自己变，抽数也不该被它扰动）
  const landToday = mapLandPriceLevel(state);
  // 每支当日已消耗的那个随机数，稍后借去决定上影长还是下影长（不再多抽一次）
  const bias = new Array<number>(stocks.length).fill(0.5);
  const traded = new Array<boolean>(stocks.length).fill(true);
  // 开盘价必须在游走之前取：上一根的收盘（首根则是建仓价），否则第一根线没有实体
  const openOf = stocks.map((s) => s.candles[s.candles.length - 1]?.close ?? s.price);
  stocks.forEach((stock, i) => {
    const draw = nextRandom(state.rngState);
    state.rngState = draw.nextState;
    bias[i] = draw.value;
    const open = openOf[i]!;
    stock.openPrice = open;   // 闸门与「今日涨跌」的基准都落在状态上，表现层不必自己猜
    // EVT-01 事件 26/27：停牌期间价格冻结（仍消耗抽数，保持回放确定性）
    if (state.stockHaltAllDays > 0 || isStockSuspended(state, stock.id)) {
      stock.lastChangePct = 0;
      traded[i] = false;
      return;
    }
    const halt = state.stockHalts.find((h) => h.stockId === stock.id);
    let pct: number;
    if (halt?.kind === 'up') {
      pct = STOCK_DAY_LIMIT_PCT;              // 被按在涨停板上：当日直接顶到 +10%
    } else if (halt?.kind === 'down') {
      pct = -STOCK_DAY_LIMIT_PCT;
    } else {
      // 原版的游走有三层：个股噪声（±14%）× 波动系数、**昨日涨跌**（趋势惯性）、大盘漂移。
      // 少掉中间那一项，价格就是一条无记忆随机游走 —— 走成一路单边，也就没有"追涨杀跌"这回事。
      const noise = (draw.value * 2 - 1) * STOCK_NOISE_PCT;
      pct = noise * stock.volatility + stock.lastChangePct + drift;
      // 均值回归：偏离锚越远越被往回拉（腰斩时涨得快、跌得慢；过热时对称反过来）
      const anchor = stockAnchor(stock, landToday);
      if (anchor > 0 && stock.price < anchor * STOCK_REVERSION_LOW) {
        pct = pct > 0 ? pct * 2 : pct * 0.5;
      } else if (anchor > 0 && stock.price > anchor * STOCK_REVERSION_HIGH) {
        pct = pct < 0 ? pct * 2 : pct * 0.5;
      }
      pct = Math.max(-STOCK_DAY_LIMIT_PCT, Math.min(STOCK_DAY_LIMIT_PCT, pct));
    }
    const next = clampStockPrice(open * (1 + pct / 100));
    stock.price = next;
    stock.lastChangePct = Math.round(((next - open) / Math.max(1, open)) * 100);
  });
  applyRandomNews(state);
  // 收 K 线放在新闻之后：这样当天那根线的收盘价就是「消息面落地后」的真实价
  stocks.forEach((stock, i) => sealDailyCandle(state, stock, openOf[i]!, bias[i]!, traded[i]!));
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
  const halt = state.stockHalts.find((h) => h.stockId === stock.id);
  const frozen = state.stockHaltAllDays > 0 || halt?.kind === 'suspend'; // EVT-01 事件 26/27：停牌
  // 消息面不再叠加在游走之上：原版一天的边界就是 ±10%（FUN_004291d6 末尾的 clamp），
  // 利好/利空的作用是「把这支当天钉在那块板上」，而不是把板击穿（原先的 ±15% 就是击穿）。
  const pct = frozen ? 0 : up ? STOCK_DAY_LIMIT_PCT : -STOCK_DAY_LIMIT_PCT;
  if (!frozen) {
    const open = stock.openPrice || stock.price;
    stock.price = Math.max(STOCK_MIN_PRICE, Math.round(open * (1 + pct / 100)));
    stock.lastChangePct = Math.round(((stock.price - open) / Math.max(1, open)) * 100);
  }
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

/** 结算一条新闻事件：效果行为表见 `news.ts` 的 `NEWS_EFFECTS`（返回 null = 对局已结束，不再播报） */
function applyNewsEvent(state: GameState, def: NewsEventDef): void {
  const params: Partial<Record<'street' | 'player' | 'company' | 'stock' | 'amount', string>> = {};
  const extra = NEWS_EFFECTS[def.effect]({ ...EFFECT_KIT, state, def, params });
  if (extra === null) return;
  log(state, `【新闻】${NEWS_CATEGORY_LABEL[def.category]}｜${renderNewsText(def, params)}${extra ? `（${extra}）` : ''}`);
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
  // 原版图一家公司都没有（`createGame` 按图给空表）⇒ 这句播报就成了假话，别播；
  // 乐透开奖照旧 —— 那与公司在不在无关。
  if (state.companies.length > 0) log(state, `【分红日】${d.iso} 是 15 号，股东分红结算`);
  for (const company of state.companies) {
    const total = Object.values(company.shares).reduce((a, b) => a + b, 0);
    if (total <= 0 || company.surplus === 0) continue;
    const name = company.name;
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
    const principal = p.loan!.principal;
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
      // TILE-09 住院每日医药费 1000（help [37]「入院時還要付每天一千元的醫藥費」）
      if (p.custody.kind === 'hospital' && p.custody.daysLeft > 0) {
        const medical = scaled(state, 1000);
        log(state, `${p.name} 住院医药费 ¥${medical}`);
        payCash(state, p, medical, null, 'other');
        if (p.bankrupt) continue;
      }
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
  const size = state.board.length;
  const position = Math.min(size - 1, Math.floor((roll.value / DOG_SPAWN_CHANCE) * size));
  state.npcs.push({ kind: 'dog', position, ownerId: null, daysLeft: 1, jailed: false });
  log(state, `【恶犬】一只恶犬在「${state.board[position]!.name}」附近徘徊`);
}

/**
 * TILE-31 宝箱：按月重投的驻留实体（用户规则：形态同恶犬，刷新周期换成一个月）。
 *
 * 换月即换地方；`treasureMonth` 记住「这个月已经投过」，所以本月被拿走之后不会当月又冒出来。
 * 零抽数：`derivedIndex` 读而不写回 `rngState`，salt 用 `elapsedDays * 8 + 5` 与恶人
 * （`elapsedDays * 8 + {0,2,4,6}`）错开 ⇒ 逐月不同位、又不扰动确定性回放。
 * 不投在有人站着的格上：宝箱一驻留就是一整个月，压在某人脚下等于本月谁都捡不到。
 */
function treasureRefreshHook(state: GameState): void {
  const month = currentMonthIndex(state);
  if (state.treasureMonth === month) return;
  const taken = new Set(state.players.map((p) => p.position));
  // 起点不摆：那是「经过即领薪水」的仪式格，压上一只宝箱等于把两条播报挤进同一帧 ——
  // 神明现身为同样的理由把它排除在外（见 godspawn.ts 里 GOD_SPAWN_ELIGIBLE_TYPES 的注释）。
  const candidates = state.board.filter((c) => c.type !== 'start' && !taken.has(c.id));
  if (candidates.length === 0) return;
  const cell = candidates[derivedIndex(state, state.calendar.elapsedDays * 8 + 5, candidates.length)]!;
  state.treasureMonth = month;
  state.treasureCellId = cell.id;
  log(state, `【宝箱】「${cell.name}」冒出一只宝箱，踩中就有 ${TREASURE_POINTS} 点券`);
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

/** 恶人作案收益（用户规则：四大恶人的赃物都交给释放/保释他的人） */
interface VillainLoot {
  cash?: number;
  points?: number;
  cardId?: string;
  itemId?: string;
}

/**
 * 恶人行动收益结算：赃物实际转交保释人；保释人倒闭则恶人押回监狱、赃物充公。
 * 卡片/道具转交时若保释人手牌已满或该道具已达上限，折半价点券入账（与商店变卖同口径）。
 */
function giveVillainLoot(state: GameState, npc: NpcUnit, text: string, loot: VillainLoot = {}): void {
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
  const parts: string[] = [];
  if (loot.cash && loot.cash > 0) {
    owner.cash += loot.cash;
    parts.push(`¥${loot.cash}`);
  }
  if (loot.points && loot.points > 0) {
    owner.points += loot.points;
    parts.push(`${loot.points} 点券`);
  }
  if (loot.cardId) {
    const card = CARDS[loot.cardId];
    if (owner.cards.length < MAX_HAND_CARDS) {
      owner.cards.push(loot.cardId);
      parts.push(`卡片「${card?.name ?? loot.cardId}」`);
    } else {
      const pts = Math.floor((card?.cost ?? 0) / 2);
      owner.points += pts;
      parts.push(`卡片「${card?.name ?? loot.cardId}」（手牌已满，折 ${pts} 点券）`);
    }
  }
  if (loot.itemId) {
    const item = ITEMS[loot.itemId];
    if ((owner.items[loot.itemId] ?? 0) < MAX_ITEM_COUNT) {
      owner.items[loot.itemId] = (owner.items[loot.itemId] ?? 0) + 1;
      parts.push(`道具「${item?.name ?? loot.itemId}」`);
    } else {
      const pts = itemSellValue(loot.itemId);
      owner.points += pts;
      parts.push(`道具「${item?.name ?? loot.itemId}」（已达上限，折 ${pts} 点券）`);
    }
  }
  log(state, `${def.name} ${text}，赃物交予 ${owner.name}${parts.length > 0 ? `（${parts.join('、')}）` : ''}`);
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
  // 恶人沿图前进（岔口取定序，不抽数 —— 这条机制的口径是「零抽数派生」）
  npc.position = pathAhead(state.board, npc.position, 1, steps).pop() ?? npc.position;
  const cell = state.board[npc.position]!;
  const victimPool = activePlayers(state).filter((p) => p.id !== npc.ownerId && !p.bankrupt);
  if (victimPool.length === 0) return;

  switch (npc.kind) {
    case 'thief': {
      // 偷取一名路人的点券（上限 500）并取走一件道具，一并交给保释人
      const victim = victimPool[derivedIndex(state, salt + 1, victimPool.length)]!;
      const take = Math.min(victim.points, THIEF_POINTS_TAKE);
      victim.points -= take;
      const itemIds = Object.keys(victim.items).filter((id) => (victim.items[id] ?? 0) > 0);
      let stolenItemId: string | undefined;
      if (itemIds.length > 0) {
        stolenItemId = itemIds[derivedIndex(state, salt + 2, itemIds.length)]!;
        victim.items[stolenItemId] = (victim.items[stolenItemId] ?? 1) - 1;
        if ((victim.items[stolenItemId] ?? 0) <= 0) delete victim.items[stolenItemId];
      }
      const itemText = stolenItemId ? `、道具「${ITEMS[stolenItemId]?.name ?? stolenItemId}」` : '';
      giveVillainLoot(state, npc, `在「${cell.name}」偷走 ${victim.name} 的 ${take} 点券${itemText}`, {
        points: take,
        itemId: stolenItemId,
      });
      break;
    }
    case 'protection': {
      // 站在土地格时向该地产主收取 5% 地价的保护费，交给保释人（现金不足则折算点券）
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
      giveVillainLoot(state, npc, `在「${cell.name}」向 ${owner.player.name} 收取保护费 ¥${fee}`, { cash: fee });
      break;
    }
    case 'robber': {
      // 抢夺一名路人的一张卡片（无卡片则抢一件道具），交给保释人
      const victim = victimPool[derivedIndex(state, salt + 1, victimPool.length)]!;
      if (victim.cards.length > 0) {
        const idx = derivedIndex(state, salt + 2, victim.cards.length);
        const cardId = victim.cards[idx]!;
        victim.cards.splice(idx, 1);
        giveVillainLoot(state, npc, `在「${cell.name}」抢走 ${victim.name} 的卡片「${CARDS[cardId]?.name ?? cardId}」`, { cardId });
      } else {
        const itemIds = Object.keys(victim.items).filter((id) => (victim.items[id] ?? 0) > 0);
        if (itemIds.length === 0) return;
        const itemId = itemIds[derivedIndex(state, salt + 2, itemIds.length)]!;
        victim.items[itemId] = (victim.items[itemId] ?? 1) - 1;
        if ((victim.items[itemId] ?? 0) <= 0) delete victim.items[itemId];
        giveVillainLoot(state, npc, `在「${cell.name}」抢走 ${victim.name} 的道具「${ITEMS[itemId]?.name ?? itemId}」`, { itemId });
      }
      break;
    }
    case 'rent-thief': {
      // 公司格：盗领全部累积红利；土地格：窃取上次收取的租金，均交给保释人
      const company = companyAtCell(state, cell.id);
      if (company) {
        if (company.surplus <= 0) return;
        const stolen = company.surplus;
        company.surplus = 0;
        giveVillainLoot(state, npc, `潜入「${cell.name}」盗领累积红利 ¥${stolen}`, { cash: stolen });
        return;
      }
      const owner = cellOwner(state, cell.id);
      if (!owner || !owner.property.lastRent) return;
      const stolen = owner.property.lastRent;
      owner.property.lastRent = null;
      giveVillainLoot(state, npc, `在「${cell.name}」窃取租金 ¥${stolen}`, { cash: stolen });
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
  // 天数上限收场排最前：到点那天不该再发股利、计息或现神明（详见 dayLimitHook）
  dayLimitHook,
  noticeHolidayHook,
  dividendAndLotteryHook,
  monthEndInterestHook,
  loanDueHook,
  financingCheckHook,
  expireTimedEffectsHook,
  researchTickHook,
  (state) => godTickHook(godCtx(state)),
  dogActivityHook,
  treasureRefreshHook,
  villainActivityHook,
  // 神明现身必须在 godTickHook 之后：先完成期满转化与清退，才知道还挤不挤得下第 4 尊
  (state) => godSpawnHook(godCtx(state)),
];

/** 日切唯一收口点：逐钩子执行，game_over 时提前返回 */
function onDayChange(state: GameState): void {
  // GOD-12 霉运倒数（与死神 13 天同步到期）
  for (const p of state.players) {
    if (!p.unlucky) continue;
    p.unlucky.daysLeft -= 1;
    if (p.unlucky.daysLeft <= 0) {
      p.unlucky = null;
      if (!p.bankrupt) log(state, `${p.name} 的霉运终于过去了`);
    }
  }
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
  // R4：还有卡要收（额满抽卡挂起）时**不推进** —— 与上面「先开拍」同一处理：
  // 流程里欠着一次必须玩家当场完成的收尾，把它压在这一帧之后就会被静默丢弃，
  // 玩家因此白丢一张卡。留在这里，等 `DISCARD_CARD` 把它收掉再轮转。
  if (state.pendingCards.length > 0) {
    state.phase = 'awaiting_discard';
    return;
  }
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
  // R4：回合推进 = 落格决策窗关闭。窗口里的动作是终结性的，推进与关窗必须是同一句话，
  // 否则「上一位的商店弹层还挂在下一位的回合上」这类残留就会渗进 UI。
  state.landing = null;
  // CORP-14：轮到谁，谁的原始股在此刻解锁（「本回合认购的，下次行动才转手得了」）。
  // 只清**新开这一回合的那位**：R4 之后认购自带回合推进，若还在这一句里整表清空，
  // 锁定期就会在同一次推进里被自己抹掉 —— 等于从来没锁过。
  const starting = state.players[state.currentPlayerIndex];
  if (starting) {
    for (const company of state.companies) delete company.lockedShares[starting.id];
  }
  // UI-06：回合推进时刷新公布栏（标的被消耗/转手的挂牌自动失效）
  refreshTrades(state);
  if (state.currentPlayerIndex < before) {
    state.round += 1;
    captureRoundSnapshot(state);
    state.calendar.elapsedDays += 1;
    onDayChange(state);
    if (isGameOver(state)) return;
    tickStockMarket(state);
  }
  // `dice` 不在这里清：它的定位是「最近一次掷骰结果」（见 types），客户端的骰子动画与
  // 走格子都取这一手。回合推进时掷骰与换人挤在同一个原子动作里，一清就没人知道骰了几点。
  //
  // 收场要在**这一句之前**再确认一次：本函数上面每一步都可能把某人逼到破产（`onDayChange` 的
  // 贷款到期、`tickStockMarket` 的每日随机新闻都是），而它们都在 `endGame` 之后继续往这里走。
  // 少了这一道闸门，刚写定的 `game_over` 会被覆盖成 `awaiting_roll` —— 局面带着胜者却仍在开局，
  // 于是可以继续打到所有人破产（`checkWinner` 的「只剩 1 人」永远等不到），整局收不了口。
  if (isGameOver(state)) return;
  state.phase = 'awaiting_roll';
  state.turnStage = 'start';
}

/**
 * R4：终结性动作的收尾 —— **单步窗**（`landing.venue === null`）里做成的那一手就结束本回合；
 * **会话窗**（商店 / 银行）里动作可以反复，只有玩家按「离开」（`FINISH_LANDING`）才推进。
 *
 * `landing` 为 null 也照样推进：那是「相位摆好了但没有凭据」的形态（局外摆场景的测试、
 * 重构前存下的热座档）。没有凭据就没有场所，按单步处理才不会退化成「动完还得手动结束回合」。
 */
function finishIfSingleStep(state: GameState): void {
  if (state.landing?.venue == null) advanceTurn(state);
}

function cellAt(state: GameState, position: number): BoardCell {
  const c = state.board[position]!;
  return c;
}

/**
 * 还站在自己的出生格上（SP-02）：开局是被「撒」到这格的，不是走到的，
 * 所以在 TA 第一次离开这格之前，这格不产生任何落格权益（买地、进商店）。
 */
function standsOnOwnSpawn(p: Player): boolean {
  return p.spawnCell !== null && p.spawnCell === p.position;
}

/** 人在商店里 —— 出生格正好撒到商店格也不算进店 */
function inShop(state: GameState, p: Player): boolean {
  return isShopCell(cellAt(state, p.position)) && !standsOnOwnSpawn(p);
}

/**
 * 神明行为（GOD-01..12 的附身结算 / 行进显灵 / 日切计时 / 死神降临）在 `gods.ts`，
 * 与它的数据定义同处一处；此处只负责把引擎能力集合注入进去。
 */
function godCtx(state: GameState): GodEffectCtx {
  return { ...EFFECT_KIT, state };
}


/**
 * 抽卡（机会格 / 卡片屋；ECON-12 卡片上限 15 张）。
 * 额满时**不自动舍弃**，而是挂起 `state.pendingCard` 并把阶段切到 `awaiting_discard`，
 * 由玩家发 `DISCARD_CARD` 选定舍弃哪一张后再把新卡入栏。
 */
function drawChanceCard(state: GameState, p: Player, source = '机会'): void {
  const draw = nextRandom(state.rngState);
  state.rngState = draw.nextState;
  const cardId = CHANCE_CARD_POOL[Math.floor(draw.value * CHANCE_CARD_POOL.length)]!;
  if (p.cards.length >= MAX_HAND_CARDS) {
    // R4：这里是**队列**而不是单槽。落格推进不再抹掉它（见 `advanceTurn` 的推迟闸门），
    // 但同一回合里连抽两张满手牌的情况仍然存在（神明先附身、随后落格又抽一张）——
    // 单槽会被后一张覆盖，前一张白丢。
    state.pendingCards.push({ cardId, ownerId: p.id });
    state.phase = 'awaiting_discard';
    log(state, `${p.name} 在${source}抽到卡片「${CARDS[cardId]!.name}」，但手牌已满（上限 ${MAX_HAND_CARDS} 张），请选择舍弃一张`);
    return;
  }
  p.cards.push(cardId);
  log(state, `${p.name} 在${source}抽到卡片「${CARDS[cardId]!.name}」`);
}

/** 此刻该由谁来舍弃：队列头部那张卡的主人（未必是当前回合玩家） */
function pendingOwner(state: GameState): Player | null {
  const head = state.pendingCards[0];
  return head ? (state.players.find((q) => q.id === head.ownerId) ?? null) : null;
}

/**
 * ECON-12：完成「选择舍弃」。队列里还有下一张就停在 `awaiting_discard` 继续问；
 * 收干净之后去哪一边，看**此刻还有没有落格决策窗**：
 * - 有窗（在商店 / 银行里抽到卡，或单步窗里的事还没做完）⇒ 交回 `awaiting_action`；
 * - 没窗 ⇒ 这一手的回合推进正被队列压在 `advanceTurn` 的推迟闸门里，在此补上那次推进。
 *   少了这一句，玩家舍弃完就顶着一个没有窗、也没有事可做的 `awaiting_action`。
 *
 * 新卡入的是**卡主**的手牌，不是「此刻轮到谁」—— 大福神显灵这类效果会在别人的回合里给第三
 * 个人发卡，按当前玩家入栏会把卡塞给错误的人，而原先的 `awaiting_discard` 正是这样卡死的。
 */
function resolvePendingCard(state: GameState): void {
  const entry = state.pendingCards.shift();
  if (entry) {
    const owner = state.players.find((q) => q.id === entry.ownerId);
    if (owner) {
      owner.cards.push(entry.cardId);
      log(state, `${owner.name} 舍弃一张手牌，收下新卡「${CARDS[entry.cardId]?.name ?? entry.cardId}」`);
    }
  }
  if (state.pendingCards.length > 0) {
    state.phase = 'awaiting_discard';
    return;
  }
  if (state.landing) {
    state.phase = 'awaiting_action';
    return;
  }
  advanceTurn(state);
}


/** UI-13：认输时可指定的复仇者候选（存活、非当前玩家）；不可认输时为空 */
function revengeCandidates(state: GameState): Player[] {
  if (!canSurrender(state)) return [];
  const p = state.players[state.currentPlayerIndex]!;
  return activePlayers(state).filter((q) => q.id !== p.id);
}

/** 霉运倍率（GOD-12）：1 = 无霉运，2 = 加倍 */
export function unluckyMultiplier(p: Player): number {
  if (!p.unlucky || p.unlucky.daysLeft <= 0) return 1;
  return Math.max(1, p.unlucky.multiplier);
}

/**
 * CORE-04 / UI-13：认输投降 —— 女巫召唤死神附身于认输者**指定**的「复仇者」
 * （help [13]「魔法屋的女巫會替您召喚死神，附身在您指定的人身上」），认输者本人干净退出。
 *
 * 死神对复仇者的结算（GOD-12，help [51]）：清空全部卡片与道具、13 天霉运加倍
 * （倒霉事按 2 倍放大）、当下一笔「索命」损失，死神本体附身 13 天（期满自动消失）。
 */
function surrender(state: GameState, revengeTargetId: string): void {
  assertLegal(state, { type: 'SURRENDER', revengeTargetId });
  const p = currentPlayer(state);
  const avenger = state.players.find((q) => q.id === revengeTargetId)!;
  log(state, `${p.name} 认输投降，把死神引向${avenger.name}`);

  // 认输者自身不走死神流程，干净退出（地产/股票随破产清算处理）
  p.cards = [];
  p.items = {};
  state.pendingCards = [];
  p.bankrupt = true;
  p.cash = 0;
  p.deposit = 0;
  p.points = 0;
  p.loan = null;
  p.properties = [];
  p.stocks = {};
  p.stockCost = {};
  p.god = null;
  p.skipTurns = 0;
  p.holdTurns = 0;
  p.rentBlockedTurns = 0;
  p.abroadTurns = 0;
  p.research = null;
  p.diceCount = 1;
  p.alliance = null;
  p.custody = null;
  p.unlucky = null;
  log(state, `${p.name} 已退出对局`);

  // 死神附身于复仇者：清空卡片道具 + 霉运加倍 13 天 + 索命损失
  summonDeathOnAvenger(godCtx(state), avenger, godDef('death'));
  // 收场判定排在「开新回合」之前，而且中间不能再有 phase 写入：索命那笔钱本身就能把复仇者
  // 打到破产 ⇒ 这一手可能已经分出结局（双人房甚至是同归于尽），先写 awaiting_roll 会把
  // 刚判定的 game_over 抹掉，胜者还在、局面却重新开局（同一条胜利播报因此会写第二遍）。
  checkWinner(state);
  if (!isGameOver(state)) {
    state.currentPlayerIndex = state.players.findIndex((q) => !q.bankrupt);
    if (state.currentPlayerIndex < 0) state.currentPlayerIndex = 0;
    state.phase = 'awaiting_roll';
  }
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

/**
 * 结算单张命运卡效果（导出供测试直接验证单个事件，如「变卖所有股票求现」）。
 * 生产路径请走 `resolveFateCard`（含抽签 + 落格），不要直接调用。
 *
 * 本函数只负责「算好缩放金额 → 委托 `FATE_EFFECTS[def.effect]` → 拼一条日志」；
 * 作用代码在 `fate.ts`，与牌面数据同处一处。金额类过 `scaled()`（固定金额），
 * 百分比类直接作用于名义值。
 */
export function applyFateEffect(state: GameState, p: Player, def: FateCardDef): void {
  // 日志占位符参数（金额默认按物价指数缩放，百分比类在效果体内改回原值）
  const renderParams: Record<string, string | number> = {
    amount: scaled(state, def.amount ?? 0),
    days: def.days ?? 0,
    player: p.name,
  };
  const extra = FATE_EFFECTS[def.effect]({
    ...EFFECT_KIT,
    state,
    self: p,
    def,
    renderParams,
    money: scaled(state, def.amount ?? 0),
  });

  log(state, `【命运】${p.name} 抽到「${renderFateText(def, renderParams)}」 —— ${extra}`);
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

/** 以 center 为中心、半径 radius 的连续格集合（模拟 3×3 / 5×5 爆炸范围；顺序被播报依赖） */
function blastArea(state: GameState, center: number, radius: number): number[] {
  return walkWindow(state.board, center, radius, radius);
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

/**
 * 判一处「入狱 / 住院」：停留天数 + 丧失收租权 + 把人**押到那一格**（D-54）。
 *
 * 移送是这条规则里原先缺的那一半：判罪的地方有八处（魔法屋两种诅咒、陷害、危险格违法事件、
 * 命运卡、新闻、飞弹 / 核弹 / 定时炸弹、恶犬咬伤），每处都只写 `custody` 与 `skipTurns`，
 * 于是「被关进监狱」的人还站在原地 —— 而保释与出院两道门控都要求**别人走到那一格**，
 * 结果这两条通道实际永远开不了窗。
 */
function imposeCustody(state: GameState, p: Player, kind: 'jail' | 'hospital', days: number): void {
  p.skipTurns = Math.max(p.skipTurns, days);
  p.custody = { kind, daysLeft: Math.max(p.skipTurns, days) };
  blockRent(p, days);
  transferToCustodyCell(state, p);
}

/**
 * 把在押 / 住院的人挪到对应格。不改走落格结算：强制押送不是掷骰前进，
 * 「走到监狱格」该触发的入狱事件与「踩中医院格」的办住院都不该再来一遍。
 * 图上没有那一格（有些地图没医院）就只判停留，不硬造落点。
 */
function transferToCustodyCell(state: GameState, p: Player): void {
  const kind = p.custody?.kind;
  if (!kind) return;
  const cell = state.board.find((c) => c.type === kind);
  if (!cell || p.position === cell.id) return;
  p.position = cell.id;
  // heading 是「新格邻接表里正要去那一格」的下标，换格后旧下标没有意义 —— 与出生时同口径
  p.heading = 1;
  log(state, `${p.name} 被押送至「${cell.name}」`);
}

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

  // CARD-29：陷害盟友则自动解除同盟（有陷害举动的双方同盟立即失效）
  if (kind === 'frame') {
    if (source && source.alliance?.with === target.id) {
      source.alliance = null;
      target.alliance = null;
      log(state, `${source.name} 陷害盟友 ${target.name}，同盟自动解除`);
    }
    if (target.alliance?.with === source?.id) {
      target.alliance = null;
      log(state, `${target.name} 遭盟友陷害，同盟自动解除`);
    }
  }

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

/**
 * 结算一次爆炸（飞弹 / 核子飞弹 / 定时炸弹）：范围内玩家住院 + 房屋受损 + 车辆损毁。
 * `levels` = 每处房屋被拆掉的等级数（默认 `Infinity` = 夷为平地还原空地）。
 */
function detonate(
  state: GameState,
  center: number,
  radius: number,
  hospitalDays: number,
  label: string,
  levels = Number.POSITIVE_INFINITY,
): number {
  const cells = blastArea(state, center, radius);
  const cellNames = cells.map((id) => state.board[id]?.name ?? `${id}`).join('、');
  log(state, `【${label}】${cellNames} 遭受轰炸！`);
  let destroyed = 0;

  for (const cellId of cells) {
    const owned = cellOwner(state, cellId);
    if (!owned || owned.property.grade <= 1) continue;
    const next = Math.max(1, owned.property.grade - levels);
    const dropped = owned.property.grade - next;
    owned.property.grade = next as 1 | 2 | 3 | 4 | 5;
    destroyed += 1;
    log(
      state,
      Number.isFinite(levels)
        ? `「${state.board[cellId]!.name}」的房屋被拆低 ${dropped} 级（现为${gradeName(next)}）`
        : `「${state.board[cellId]!.name}」的房屋被摧毁，还原为平地`,
    );
  }

  for (const q of state.players) {
    if (!cells.includes(q.position)) continue;
    if (q.bankrupt) {
      // D-46：乞丐不在「在局玩家」里，但打击照样落在他头上 —— 炸飞即退场，此后不再行乞
      if (!q.beggarGone) {
        q.beggarGone = true;
        log(state, `${q.name} 的乞讨摊被炸翻，从此退出乞讨`);
      }
      continue;
    }
    if (q.bulldozerTurns > 0) retireBulldozer(state, q, '被炸毁');
    q.bulldozerTurns = 0;
    q.diceCount = 1; // 车辆损毁
    imposeCustody(state, q, 'hospital', hospitalDays);
    log(state, `${q.name} 被炸伤，住院 ${hospitalDays} 天`);
  }
  return destroyed;
}

export function availableActions(state: GameState): AvailableActions {
  if (state.phase === 'awaiting_roll' || state.phase === 'awaiting_action' || state.phase === 'awaiting_pick') {
    // 空房间（lobby 且 players 为空）时安全降级到兜底分支
    const p = currentPlayerOrNull(state);
    if (!p) return idleActions(state);
    // 门控的唯一来源：向注册表问「这个动作此刻能不能执行」。
    // 于是「按钮可点」与「引擎不报错」在结构上是同一句话，不可能再分叉。
    const can = (action: PlayerAction): boolean => actionRefusal(state, action) === null;
    const c = cellAt(state, p.position);
    const holiday = gameDate(state).isHoliday;
    // CORP-01/09/13：公司格上的经营数据（额度与面值是给 UI 显示的数，不是门控）
    const company = state.phase === 'awaiting_action' && c.type === 'company' ? companyAtCell(state, c.id) : undefined;
    const sharePrice = company?.sharePrice ?? 0;
    const shareQuantityLimit = maxCashShares(sharePrice, p.cash);
    const financingRemaining =
      company && c.companyKind === 'bank' && company.chairmanId === p.id
        ? Math.max(0, financingCap(state, p) - p.financing)
        : 0;
    const estateBuildCells = p.properties
      .map((prop) => prop.cellId)
      .filter((cellId) => can({ type: 'BUILD_ESTATE', cellId }));
    const buildableFacilities = FACILITY_ORDER.filter((f) => can({ type: 'BUILD_FACILITY', facility: f }));
    const researchableItems = RESEARCH_ORDER.map((r) => r.itemId).filter((itemId) => can({ type: 'START_RESEARCH', itemId }));
    const usableCards = p.cards.filter((cardId) => can({ type: 'USE_CARD', cardId }));
    const usableItems = Object.keys(p.items).filter((itemId) => can({ type: 'USE_ITEM', itemId }));
    const bailable = bailableVillains(state).filter((npcKind) => can({ type: 'BAIL_PRISONER', npcKind }));
    const dischargeable = dischargeablePatients(state).filter((id) => can({ type: 'DISCHARGE_PATIENT', targetPlayerId: id }));
    const revenge = revengeCandidates(state);
    return {
      canRoll: can({ type: 'ROLL_DICE' }),
      canBuy: can({ type: 'BUY_LAND' }),
      canUpgrade: can({ type: 'UPGRADE_LAND' }),
      canFinishLanding: can({ type: 'FINISH_LANDING' }),
      landing: state.landing,
      // 商店没有「进入商店」这个动作：这一位只表示「脚下是商店格」，
      // 具体能不能买、能不能卖由 BUY_CARD / SELL_CARD 等动作各自的校验决定。
      canShop: state.phase === 'awaiting_action' && inShop(state, p),
      // 股市可交易性是整个市场的状态；能否买某一只、买几只由 BUY_STOCK 的校验决定（bot 与 UI 都问它）
      canTradeStock: canTradeStockNow(state) && !p.bankrupt && isMarketOpen(state),
      canPick: state.phase === 'awaiting_pick',
      canDeposit: can({ type: 'DEPOSIT', amount: 1 }),
      canWithdraw: can({ type: 'WITHDRAW', amount: 1 }),
      canLoan: can({ type: 'TAKE_LOAN', amount: 1 }),
      canRepayLoan: can({ type: 'REPAY_LOAN', amount: 1 }),
      isHoliday: holiday,
      canBuyShares: can({ type: 'BUY_SHARES', cellId: c.id, quantity: 1 }),
      sharePrice,
      shareQuantityLimit,
      canBuildEstate: estateBuildCells.length > 0,
      estateBuildCells,
      canFinancing: can({ type: 'SPECIAL_FINANCING', amount: 1 }),
      financingRemaining,
      buildableFacilities,
      researchableItems,
      usableCards,
      usableItems,
      canBuyLottery: can({ type: 'BUY_LOTTERY_TICKET', number: 0 }),
      lotteryTicketCost: LOTTERY_TICKET_COST,
      auction: null,
      auctionMinBid: 0,
      canAuctionPass: false,
      canAuctionGiveUp: false,
      bailableVillains: bailable,
      bailFee: bailFee(state),
      magic: state.magic,
      dischargeablePatients: dischargeable,
      dischargeFee: dischargeFee(state),
      // 认输必须指定复仇者，因此「能不能认输」等价于「存在一个认了之后真能执行的对象」
      canSurrender: revenge.length > 0 && can({ type: 'SURRENDER', revengeTargetId: revenge[0]!.id }),
      pendingCards: state.pendingCards,
      tradableAssets: tradableAssets(state, p),
      tradeCash: p.cash,
      revengeCandidates: revenge,
    };
  }
  return idleActions(state);
}

/**
 * 「不可操作」状态下的动作集（大厅 / 拍卖 / 小游戏 / 空房间）。
 * 抽成独立函数以便 `availableActions` 在遇到**空房间**时提前返回。
 */
function idleActions(state: GameState): AvailableActions {
  const p = currentPlayerOrNull(state);
  const auction = state.phase === 'awaiting_auction' ? state.auction : null;
  // 拍卖的三个动作同样只问注册表：面板上的「弃权」在最高价者面前就该是灰的
  const auctionRefusal = (action: PlayerAction): ActionRefusal =>
    auction ? actionRefusal(state, action) : '当前没有进行中的拍卖';
  return {
    canRoll: false,
    canBuy: false,
    canUpgrade: false,
    canFinishLanding: false,
    landing: state.landing,
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
    auction,
    auctionMinBid: auction ? nextBidAmount(auction) : 0,
    canAuctionPass: auctionRefusal({ type: 'AUCTION_PASS' }) === null,
    canAuctionGiveUp: auctionRefusal({ type: 'AUCTION_GIVE_UP' }) === null,
    bailableVillains: p ? bailableVillains(state) : [],
    bailFee: bailFee(state),
    magic: state.magic,
    dischargeablePatients: p ? dischargeablePatients(state) : [],
    dischargeFee: dischargeFee(state),
    canSurrender: canSurrender(state),
    pendingCards: state.pendingCards,
    // UI-06：非本人操作阶段（如拍卖/小游戏）或空房间时不给可挂标的
    tradableAssets: [],
    tradeCash: p?.cash ?? 0,
    revengeCandidates: revengeCandidates(state),
  };
}


function startGame(state: GameState): void {
  assertLegal(state, { type: 'START_GAME' });
  state.phase = 'awaiting_roll';
  state.turn = 1;
  // 冻结物价指数分母（此后不再随加入/破产变化）
  state.initialCashPerPlayer = STARTING_CASH;
  state.initialPlayerCount = state.players.length;
  // 开局赠送道具：机器娃娃/遥控骰子/路障/定时炸弹/地雷/机器工人 各 1（用户规则）
  for (const p of state.players) p.items = { ...STARTING_ITEMS };
  log(state, '游戏开始！每人获赠开局道具：机器娃娃、遥控骰子、路障、定时炸弹、地雷、机器工人 各 1');
  // SP-01 随机出生：出生点在 createGame/addPlayer 就已定下，开局只负责把它播报出来。
  // 顺带说明 SP-02（站着不算落到），否则玩家站在可地上却发现买不了，只会当成 bug。
  for (const p of state.players) {
    log(state, `${p.name} 随机出生落在「${state.board[p.position]?.name ?? `第 ${p.position} 格`}」—— 站着不算落到，走回来才能买`);
  }
  // 宝箱（TILE-31）第一只在开局投：出生点已经落定，此刻排除「有人站着」的格才有意义
  treasureRefreshHook(state);
}

/**
 * 回合起点闸门（自 `rollDice` 拆出，对应 CORE-02 的 `TURN_START` 相）：
 * 倒闭者与停留中的玩家直接消费掉本回合；工程车（ITEM-12）在此递减一回合。
 * 返回 true 表示 `rollDice` 应立即返回 —— 回合已由本函数推进或局面已定。
 */
function consumeTurnDelay(state: GameState, p: Player): boolean {
  if (p.bankrupt) {
    if (!isGameOver(state)) advanceTurn(state);
    return true;
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
    return true;
  }

  // 工程车（ITEM-12 / D-45）：7 天与 18 步双限、先到为准，完工后把暂停的载具交还
  if (p.bulldozerTurns > 0) {
    p.bulldozerTurns -= 1;
    if (p.bulldozerTurns === 0) retireBulldozer(state, p, '满 7 天');
  }
  return false;
}

/**
 * 逐颗掷骰（对应 CORE-02 的 `ROLL` 相）。
 *
 * 遥控骰子（ITEM-08）按原版口径钉的是**这一次掷骰的总点数**（「控制骰子点数，决定前进步数」），
 * 不是「第一颗」—— 开着汽车（3 颗）也能只走 3 步。既然总点数已定，其余那颗都不再掷，
 * 所以这一手不消耗随机数（与旧的「只钉第一颗、后面照掷」是两种账）。
 */
function drawDice(state: GameState, p: Player, diceCount: number): number[] {
  if (p.fixedDice !== null) {
    const v = p.fixedDice;
    p.fixedDice = null;
    log(state, `遥控骰子生效：本次掷骰固定为 ${v} 点`);
    return [v];
  }
  const rolls: number[] = [];
  for (let i = 0; i < diceCount; i++) {
    const r = rollDie(state.rngState);
    state.rngState = r.nextState;
    rolls.push(r.value);
  }
  return rolls;
}

function rollDice(state: GameState, action: Extract<PlayerAction, { type: 'ROLL_DICE' }>): void {
  assertLegal(state, action);
  const p = currentPlayer(state);
  state.turnStage = 'start';
  if (consumeTurnDelay(state, p)) return;

  state.turnStage = 'roll';
  // 骰子个数（CORE-03）：步行 1 颗、机车 2 颗、汽车 3 颗；玩家可自选本次使用几颗（默认用满）。
  // 骰子数合法性（1..maxDice 的整数）已由 checkRollDice 校验。
  const diceCount = action.diceCount ?? Math.max(1, Math.min(3, p.diceCount));
  const rolls = drawDice(state, p, diceCount);
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
  // 朝向 = 邻接表里「正要去那格」的下标；环上 1 恒等于顺时针，与旧的 direction = 1 同义
  let heading = p.heading;
  let crossedStart = false;
  state.turnStage = 'move';
  let moved = 0;
  /** 这一手逐格走过的格子（给表现层播，规则不读） */
  const path: number[] = [];
  let steppedOnMine = false;
  let bittenByDog = false;
  /** 本次移动中**踩到**的布设炸弹：不截停（只有路障拦人），但附上之后剩下的步数才开始倒数 */
  let pickedBombAt = -1;
  /** 移动途中撞上的驻留神明所在格（null = 没撞上；路障等截停优先时保持 null） */
  let godCell: number | null = null;
  for (let i = 0; i < steps; i++) {
    // 岔路口随机拐（原版规则）：环上排除「刚离开那格」后只剩一条路，因此不抽 RNG、回放逐位不变
    const stepped = stepAlong(state.board, pos, heading,
      (options) => options[randomIndex(state, options.length)]!);
    pos = stepped.next;
    heading = stepped.heading;
    path.push(pos);
    moved += 1;
    if (state.board[pos]?.type === 'start') crossedStart = true;
    if (state.roadblocks.some((o) => o.cellId === pos)) {
      state.roadblocks = state.roadblocks.filter((o) => o.cellId !== pos);
      const coneCell = state.board[pos]!;
      log(state, `${p.name} 撞上路障，被迫停在「${coneCell.name}」`);
      break;
    }
    if (state.mines.some((o) => o.cellId === pos)) {
      state.mines = state.mines.filter((o) => o.cellId !== pos);
      steppedOnMine = true;
      log(state, `${p.name} 踩中地雷，被炸伤`);
      // 不截停：地雷是「踩中生效」，不是拦截 —— 全场只有路障会拦下移动（D-49）。
      // 送医与「这一格不结算」留在循环外那段，走的步数照旧走完。
    }
    /* 布设的定时炸弹（ITEM-04 / D-48）：**踩中即附身**，但不截停 —— 只有路障有拦截功能，
       其他道具没有。附上之后剩下的路才开始算那 38 步，所以记下踩中的步序。
       身上已经背着一颗的人再接第二颗会让倒数说不清（`bombs` 只认第一条），那枚就留在原地。 */
    const trap = state.trapBombs.find((o) => o.cellId === pos);
    if (trap && !state.bombs.some((b) => b.playerId === p.id)) {
      state.trapBombs = state.trapBombs.filter((o) => o !== trap);
      state.bombs = [...state.bombs, { playerId: p.id, stepsLeft: BOMB_FUSE_STEPS }];
      pickedBombAt = moved;
      log(state, `${p.name} 踩到「${state.board[pos]!.name}」上的定时炸弹，被迫背起来（${BOMB_FUSE_STEPS} 步后爆炸）`);
    }
    // 乞丐（EVT-04 / D-46）只认**踩中**那一格，与恶犬/宝箱同口径 ⇒ 不在这里判定，
    // 挪到落定之后（见下方 `beggarOnLanding`），否则「路过乞讨格」也会被强制施舍。
    // GOD 现身机制（W2）：日切现身的驻留神明，**经过即附身**。
    // 排在路障之后：路障会 break，「被路障截停在神明格」不该既算截停又算附身（一个回合双触发）。
    // 地雷（D-49）与炸弹都不再拦人，所以它们与附身同回合发生是正常结果。
    // 因此这里只记格号并 break，附身留到循环外结算。
    if (boardGodAt(state, pos)) {
      godCell = pos;
      break;
    }
  }
  if (crossedStart) {
    p.cash += PASS_START_SALARY;
    log(state, `${p.name} 经过起点，领取薪水 ¥${PASS_START_SALARY}`);
  }
  p.position = pos;
  p.heading = heading;
  // 原地不动（停留卡）就没有路线可播：置 null，让表现层走它自己的兜底
  state.movePath = path.length > 0 ? path : null;

  // EVT-04 / D-46：**停在**乞丐那一格就必须施舍 `(500~3000) × 物价指数`，随后乞丐换一处继续行乞。
  // 乞丐 = 已破产的玩家（`bankrupt` 已把它排除出在局集合），`beggarGone` 表示被炸飞后不再行乞。
  const beggar = state.players.find((q) => q.bankrupt && !q.beggarGone && q.position === pos && q.id !== p.id);
  if (beggar) {
    const alms = scaled(state, BEGGAR_ALMS_MIN + randomIndex(state, BEGGAR_ALMS_MAX - BEGGAR_ALMS_MIN + 1));
    log(state, `${p.name} 在「${state.board[pos]!.name}」遇上乞讨的 ${beggar.name}，施舍 ¥${alms}`);
    pay(state, p, alms, beggar, { reason: 'other' });
    if (isGameOver(state)) return;
    relocateBeggar(state, beggar);
  }

  // 工程车（ITEM-12 / D-45）：18 步上限按**实际走到的步数**扣，与 7 天双限、先到为准
  if (p.bulldozerTurns > 0) {
    p.bulldozerSteps -= moved;
    if (p.bulldozerSteps <= 0) retireBulldozer(state, p, '跑满 18 步');
  }

  /* 定时炸弹（ITEM-04）：引信按**背在身上走过的步数**扣。
     本次中途才踩到的那颗，踩中之前的步数不该算进它的倒数。 */
  const bomb = state.bombs.find((b) => b.playerId === p.id);
  if (bomb) {
    bomb.stepsLeft -= pickedBombAt >= 0 ? moved - pickedBombAt : moved;
    if (bomb.stepsLeft <= 0) {
      state.bombs = state.bombs.filter((b) => b !== bomb);
      detonate(state, pos, 1, 5, '定时炸弹爆炸');
      advanceTurn(state);
      return;
    }
    log(state, `${p.name} 身上的定时炸弹还剩 ${Math.max(0, bomb.stepsLeft)} 步`);
  }

  /* 甩锅（D-48，help「碰到别人可丢给他」）：背着炸弹的人走到别人那一格 ⇒ 炸弹换人背。
     引信不重置，只是接手 —— 所以原地那位最怕来人，而背包的那个最想撞上去。
     已经在背炸弹的人不能再塞第二颗（倒数只认第一条，两颗会算不清）。 */
  if (bomb && bomb.stepsLeft > 0) {
    const victim = state.players.find(
      (q) => q.id !== p.id && !q.bankrupt && q.position === pos && !state.bombs.some((b) => b.playerId === q.id),
    );
    if (victim) {
      bomb.playerId = victim.id;
      log(state, `${p.name} 在「${state.board[pos]!.name}」撞上 ${victim.name}，把定时炸弹甩给了对方（还剩 ${bomb.stepsLeft} 步）`);
    }
  }

  // NPC-05 恶犬与 TILE-31 宝箱都只认**踩中**那一格（用户规则：路过不算撞上）。
  // 所以它们不在移动循环里，而在落定之后 —— 循环里只有路障真的拦人（D-49）。
  const dogIdx = state.npcs.findIndex((n) => n.kind === 'dog' && n.position === pos);
  if (dogIdx >= 0) {
    const dogCell = state.board[pos]!;
    state.npcs.splice(dogIdx, 1);
    if (p.diceCount <= 1) {
      log(state, `${p.name} 在「${dogCell.name}」踩中恶犬，被咬伤`);
      bittenByDog = true;
    } else {
      log(state, `${p.name} 驾车在「${dogCell.name}」撞跑了恶犬`);
    }
  }

  // NPC-05 恶犬咬伤（步行者）：住院 3 天并丧失收租权
  if (bittenByDog) {
    imposeCustody(state, p, 'hospital', DOG_HOSPITAL_DAYS);
    log(state, `${p.name} 被恶犬咬伤，住院 ${DOG_HOSPITAL_DAYS} 天并丧失收租权`);
    advanceTurn(state);
    return;
  }

  // TILE-31 宝箱：踩中才开箱，拿完这一格照常结算；本月不再回来（换月重投）
  if (state.treasureCellId === pos) {
    const treasureCell = state.board[pos]!;
    state.treasureCellId = null;
    p.points += TREASURE_POINTS;
    log(state, `${p.name} 在「${treasureCell.name}」打开宝箱，获得 ${TREASURE_POINTS} 点券！`);
  }

  const c = cellAt(state, pos);

  /* 经过即附身（GOD 现身机制）：神明随附身离场，这不算「清退」，所以不写对偶冷却。
   * R4 把次序定死了 —— **先附身，再照常结算脚下这一格**。用户的口径是「神明刚好停留在商城的
   * 格子，那么应该先触发神明的附身，然后进商城购买道具，购买完成后自动结束回合」，
   * 而不是「附身之后这一格就跳过」。于是两条连带结论：
   * - `applyGodTravel` 排在附身**之后**：刚请到的土地公 / 天使连脚下这一格一起显灵；
   * - 大 / 小穷神的附身结算能当场把人送走 ⇒ 破产者不再落格，清算交给 `advanceTurn` 的前置开拍。 */
  if (godCell !== null && boardGodAt(state, godCell)) {
    const godId = detachGodForPossession(state, godCell);
    const god = godId ? godDef(godId) : undefined;
    if (god) attachGod(godCtx(state), p, god);
    if (isGameOver(state)) return;
    if (p.bankrupt) {
      advanceTurn(state);
      return;
    }
  }

  /* 地雷（ITEM-03 / D-49）：踩中即生效，但**不拦下这一手** —— 上面那些"只认踩中"的结算
     （乞丐 / 恶犬 / 宝箱 / 神明附身）照常在落点上办完，然后人才被送去医院。
     住院期间不再办理这一格的落格事务（不买地、不缴租、不开店）。 */
  if (steppedOnMine) {
    imposeCustody(state, p, 'hospital', 3);
    log(state, `${p.name} 住院 3 天，且暂时无法收租`);
    advanceTurn(state);
    return;
  }

  // 行进显灵·落格类（GOD-01 土地公侵占 / GOD-10 天使加盖 / GOD-11 恶魔拆屋）
  applyGodTravel(godCtx(state), p, c);

  state.turnStage = 'tile_resolve';
  const landing = resolveLanding({ ...LANDING_KIT, state, self: p, cell: c, moved });
  if (landing === 'advance') advanceTurn(state);
}

function buyLand(state: GameState): void {
  assertLegal(state, { type: 'BUY_LAND' });
  const p = currentPlayer(state);
  const c = cellAt(state, p.position);
  const freeBuy = godFreeLandPurchase(p);
  // help[22]：商业用地同样「依公定价格购买」——标价即成交价，不设溢价（见 tiles.ts 的 W1 说明）
  const price = freeBuy ? 0 : landPrice(state, c);
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
  finishIfSingleStep(state);
}

function upgradeLand(state: GameState): void {
  assertLegal(state, { type: 'UPGRADE_LAND' });
  const p = currentPlayer(state);
  const c = cellAt(state, p.position);
  const prop = cellOwner(state, c.id)!.property;
  // 行进显灵·投资加倍（GOD-04/05 大/小福神）：一次加盖两层，费用按实际层数计
  const target = Math.min(MAX_GRADE, prop.grade + (godDoublesBuild(p) ? 2 : 1));
  let cost = 0;
  for (let g = prop.grade; g < target; g++) cost += landUpgradeCost(state, c, g);
  p.cash -= cost;
  const levels = target - prop.grade;
  prop.grade = target as 1 | 2 | 3 | 4 | 5;
  if (levels > 1) log(state, `福神显灵，投资加倍，一次加盖 ${levels} 层`);
  if (c.type === 'commercial') {
    log(state, `${p.name} 花费 ¥${cost} 将「${c.name}」的${FACILITIES[prop.facility!].name}升级为${gradeName(prop.grade)}（${prop.grade} 级）`);
  } else {
    log(state, `${p.name} 花费 ¥${cost} 将「${c.name}」升级为${gradeName(prop.grade)}（${prop.grade} 级）`);
  }
  finishIfSingleStep(state);
}

/** EST-07 建设：在自有商业用地上选择并建成一种设施（同一次停留可继续升级） */
function buildFacility(state: GameState, action: Extract<PlayerAction, { type: 'BUILD_FACILITY' }>): void {
  assertLegal(state, action);
  const p = currentPlayer(state);
  const c = cellAt(state, p.position);
  const owned = cellOwner(state, c.id)!;
  const def = FACILITIES[action.facility];
  const cost = facilityBuildCost(state, c, action.facility);
  p.cash -= cost;
  owned.property.facility = action.facility;
  if (godDoublesBuild(p) && def.upgradeable) {
    // 行进显灵·投资加倍（GOD-04/05）：可升级设施直接建成 2 级
    owned.property.grade = 2;
    log(state, `${p.name} 花费 ¥${cost} 在「${c.name}」建成${def.name}，福神显灵投资加倍直抵 ${gradeName(2)}`);
  } else {
    log(state, `${p.name} 花费 ¥${cost} 在「${c.name}」建成${def.name}`);
  }
  finishIfSingleStep(state);
}

/** EST-09/10 研究所立项：按所等级解锁项目，到期后由 researchTickHook 交付道具 */
function startResearch(state: GameState, action: Extract<PlayerAction, { type: 'START_RESEARCH' }>): void {
  assertLegal(state, action);
  const p = currentPlayer(state);
  const c = cellAt(state, p.position);
  const def = researchDef(action.itemId)!;
  p.research = { itemId: def.itemId, remainDays: def.days };
  log(state, `${p.name} 在「${c.name}」立项研发「${ITEMS[def.itemId]?.name ?? def.itemId}」，预计 ${def.days} 天完成`);
  finishIfSingleStep(state);
}

/** 小游戏猜位置统一入口（三仙归洞 / 七彩气球 / 企鹅挖宝：猜 0-2；记忆翻牌：牌下标） */
function minigamePick(state: GameState, action: Extract<PlayerAction, { type: 'MINIGAME_PICK' }>): void {
  assertLegal(state, action);
  const mg = state.minigame!
  if (mg.kind === 'memory') {
    memoryFlip(state, action.hole);
    return;
  }
  const p = currentPlayer(state);
  const hole = action.hole;
  if (mg.kind === 'balloon') {
    balloonPick(state, p, hole);
    return;
  }
  if (mg.kind === 'penguin') {
    penguinPick(state, p, hole);
    return;
  }
  const draw = nextRandom(state.rngState);
  state.rngState = draw.nextState;
  const ball = Math.floor(draw.value * 3);
  const hit = hole === ball;
  mg.hits.push(hit);
  const roundNo = mg.round + 1;
  if (hit) {
    log(state, `${p.name} 第 ${roundNo} 轮猜中了！`);
  } else {
    log(state, `${p.name} 第 ${roundNo} 轮猜错，球在 ${ball + 1} 号杯`);
  }

  if (mg.round < 2) {
    mg.round = (mg.round + 1) as 0 | 1 | 2;
    return;
  }

  // 3 轮结束，结算奖励
  const hits = mg.hits.filter(Boolean).length;
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
  // 下标范围 / 已配对 / 已翻开 / 次数用尽这四条规则只在 `checkMinigamePick` 写一次
  const mg = state.minigame!;
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

function finishLanding(state: GameState): void {
  assertLegal(state, { type: 'FINISH_LANDING' });
  const p = currentPlayer(state);
  log(state, `${p.name} 选择不操作，结束回合`);
  advanceTurn(state);
}

/** ECON-08：乐透行自选号码投注（现金 1000，不随物价指数缩放） */
function buyLotteryTicket(state: GameState, action: Extract<PlayerAction, { type: 'BUY_LOTTERY_TICKET' }>): void {
  assertLegal(state, action);
  const p = currentPlayer(state);
  const c = cellAt(state, p.position);
  p.cash -= LOTTERY_TICKET_COST;
  state.lotteryPool += LOTTERY_TICKET_COST;
  state.lotteryTickets.push({ playerId: p.id, number: action.number });
  log(state, `${p.name} 在「${c.name}」以 ¥${LOTTERY_TICKET_COST} 投注号码 ${action.number}，奖池累计 ¥${state.lotteryPool}`);
  finishIfSingleStep(state);
}

// ---------------------------------------------------------------------------
// NPC-01..06 特殊单位动作：保释四大恶人 + 魔法屋施法
// ---------------------------------------------------------------------------

/** CORE-04：当前玩家可否认输投降 */
function canSurrender(state: GameState): boolean {
  if (state.phase === 'lobby' || state.phase === 'game_over') return false;
  const p = state.players[state.currentPlayerIndex];
  return !!p && !p.bankrupt;
}

/**
 * 保释金（D-50）：**点券**支付，固定价、不随物价指数缩放 —— 点券那一侧的所有定价都是固定值，
 * 让它跟着物价走会让"同一件事在不同月份贵三倍"，而点券收入本身并不随物价增长。
 * 保留 `(state)` 形状是为了与 `dischargeFee` 在 UI / 落格文案里同构，调用方不必分两种写法。
 */
function bailFee(_state: GameState): number {
  return BAIL_FEE;
}

/** 出院费（固定 2000，随物价指数缩放；原版未明确金额，标注为推断值。仍是**现金**，决策人的点券账本里没有出院） */
function dischargeFee(state: GameState): number {
  return scaled(state, DISCHARGE_FEE);
}

/**
 * 魔法屋目标条件筛出的命中集合（A §三：符合条件者**全部**中招，最高值并列一起中）。
 *
 * 与旧实现的两处口径差别：
 * - **含施法者本人**（M-04）：条件不区分敌我，而玩家看不见名单 —— 把自己算进去是判断失误的后果；
 * - 只排除倒闭玩家。
 *
 * 名单**不进 `MagicOffer`**：进了就随快照下发到客户端，而这条玩法的整个赌注正是
 * 「水晶球只报标语，谁中招自己判断」（决策表 §7.6）。所以每次施法当场从活状态重算。
 */
export function magicHits(state: GameState, condition: MagicCondition): string[] {
  const pool = activePlayers(state);
  if (pool.length === 0) return [];
  /** 取最大值那一档，并列者全收（开局人人 0 地时，「土地最多的人」就是全体） */
  const top = (score: (p: Player) => number): string[] => {
    const max = Math.max(...pool.map(score));
    return pool.filter((p) => score(p) === max).map((p) => p.id);
  };
  const byDice = (test: (diceCount: number) => boolean) => pool.filter((p) => test(p.diceCount)).map((p) => p.id);
  switch (condition) {
    case 'richest':
      return top((p) => totalAssets(state, p));
    case 'most-land':
      return top((p) => p.properties.length);
    case 'most-house':
      return top((p) => p.properties.filter((q) => q.grade > 0).length);
    case 'richest-cash':
      return top((p) => p.cash);
    case 'richest-deposit':
      return top((p) => p.deposit);
    case 'richest-points':
      return top((p) => p.points);
    case 'walker':
      return byDice((n) => n <= 1);
    case 'motorbike':
      return byDice((n) => n === 2);
    case 'car':
      return byDice((n) => n >= 3);
    case 'godded':
      return pool.filter((p) => p.god !== null).map((p) => p.id);
    default: {
      const exhaustive: never = condition;
      throw new Error(`未知施法条件: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** 当前站立于监狱门外时可保释的在押恶人 */
function bailableVillains(state: GameState): VillainKind[] {
  if (state.phase !== 'awaiting_action') return [];
  const p = currentPlayer(state);
  if (p.bankrupt) return [];
  if (cellAt(state, p.position).type !== 'jail') return [];
  return state.npcs
    .filter((n) => n.kind !== 'dog' && n.jailed)
    .map((n) => n.kind as VillainKind);
}

/** NPC-01..04：在监狱门外保释一名在押恶人（收益归保释人） */
function bailPrisoner(state: GameState, action: Extract<PlayerAction, { type: 'BAIL_PRISONER' }>): void {
  assertLegal(state, action);
  const p = currentPlayer(state);
  const npc = state.npcs.find((n) => n.kind === action.npcKind)!;
  const fee = bailFee(state);
  p.points -= fee;
  npc.jailed = false;
  npc.ownerId = p.id;
  npc.daysLeft = VILLAIN_DAYS;
  npc.position = cellAt(state, p.position).id;
  log(
    state,
    `${p.name} 花费 ${fee} 点券保释了${villainDefOf(npc).name}，${VILLAIN_DAYS} 天内所获收益归 ${p.name}`,
  );
  finishIfSingleStep(state);
}

/** TILE-09 办理提前出院的费用（固定 2000，随物价指数缩放；原版未明确金额，标注为推断值） */
const DISCHARGE_FEE = 2000;

/** TILE-09 医院门外可办理出院的住院病人（help [37]「走到醫院門外時，可以替病人辦理出院」） */
function dischargeablePatients(state: GameState): string[] {
  if (state.phase !== 'awaiting_action') return [];
  const p = currentPlayer(state);
  if (p.bankrupt) return [];
  if (cellAt(state, p.position).type !== 'hospital') return [];
  return activePlayers(state)
    .filter((q) => q.id !== p.id && q.custody?.kind === 'hospital' && q.skipTurns > 0)
    .map((q) => q.id);
}

/** TILE-09：在医院门外替指定病人办理提前出院 */
function dischargePatient(state: GameState, action: Extract<PlayerAction, { type: 'DISCHARGE_PATIENT' }>): void {
  assertLegal(state, action);
  const p = currentPlayer(state);
  const target = state.players.find((q) => q.id === action.targetPlayerId)!;
  const fee = dischargeFee(state);
  p.cash -= fee;
  target.custody = null;
  target.skipTurns = 0;
  target.rentBlockedTurns = 0;
  log(state, `${p.name} 在医院门外为 ${target.name} 办理出院，支付出院费 ¥${fee}`);
  finishIfSingleStep(state);
}

/**
 * TILE-11：玩家自选一档魔法降下，符合条件者**全部**中招、依次结算（A §二.3 / §五.5）。
 *
 * 两处刻意与旧实现相反：
 * - **不走 `applyDisaster`**（M-16）：魔法屋定性为无解硬惩罚，免罪 / 嫁祸 / 复仇一律拦不住；
 * - 0 命中要等玩家把魔法选完才发现（Q-07）：名单本来就不显示，所以轮盘照开。
 */
function castMagic(state: GameState, action: Extract<PlayerAction, { type: 'CAST_MAGIC' }>): void {
  assertLegal(state, action);
  const offer = state.magic!;
  const caster = currentPlayer(state);
  const effect = MAGIC_EFFECTS[action.effect];
  const label = MAGIC_CONDITION_LABEL[offer.condition];
  state.magic = null;
  const hitIds = magicHits(state, offer.condition);
  if (hitIds.length === 0) {
    log(state, `${caster.name} 施下「${effect.name}」，但${label}这一局无人对上，女巫悻悻收回水晶球`);
    finishIfSingleStep(state);
    return;
  }
  const names = hitIds.map((id) => state.players.find((q) => q.id === id)!.name).join('、');
  log(state, `${caster.name} 施下「${effect.name}」：${label} —— ${names}`);
  let landed = 0;
  for (const id of hitIds) {
    if (applyMagicEffect(state, state.players.find((q) => q.id === id)!, effect)) landed += 1;
  }
  // 有人对上、但这一档在每个人脚下都没有落点（全员站空地 / 全没钱 / 全没地）—— 说清楚，
  // 否则玩家只会看到"施了法却什么都没发生"，分不清是规则还是 bug。
  if (landed === 0) log(state, '魔法在各人脚下都没有落点，水晶球的光熄了');
  finishIfSingleStep(state);
}

/**
 * 一档魔法对一个命中者的结算。返回 false 表示**这一档在他身上落空**（脚下没建筑可拆、
 * 没别人的地可拍、现金为零…），由 `castMagic` 汇总成"魔法无处降落"的播报。
 *
 * 作用于脚下格的三档按 Q-02/Q-03/Q-04 定案：不挑地价、不设 A 那条未解的前置。
 * 决策人补的一条口径：**脚下无论是谁的地，效果都照办** —— 站在对手的楼上就被拆一层，
 * 站在对手的空地上就替他加盖一层（是的，这可能便宜第三方）。落点不成立时只跳过这一个目标，
 * 其余命中者照常结算。唯一保留的前提是拍卖：无主之地没有卖方，拍出去等于白送一块地。
 */
function applyMagicEffect(state: GameState, target: Player, effect: MagicEffectDef): boolean {
  const here = cellAt(state, target.position);
  const under = cellOwner(state, target.position);
  switch (effect.kind) {
    case 'sell-cards': {
      // A §附把变卖拆成手牌与道具两处调用，所得点券归目标自己 —— 清手牌，不产生损失（M-13）
      if (target.cards.length === 0 && Object.keys(target.items).length === 0) return false;
      let gained = 0;
      for (const cardId of target.cards) gained += Math.floor((CARDS[cardId]?.cost ?? 0) / 2);
      for (const [itemId, count] of Object.entries(target.items)) gained += itemSellValue(itemId) * count;
      target.cards = [];
      target.items = {};
      target.points += gained;
      log(state, `${target.name} 的卡片道具全部变卖，回收 ${gained} 点券`);
      return true;
    }
    case 'fate-x3':
      // 相当于连踩三格机会格（Q-07 定：公共池 33 张，不含地图专属那 16 张）。
      // 中途被抽到倒闭就停 —— 剩下的两张没有承受者，硬抽只会把随机数白烧掉。
      for (let i = 0; i < 3 && !target.bankrupt; i++) resolveFateCard(state, target);
      return true;
    case 'jail':
      imposeCustody(state, target, 'jail', effect.days ?? 0);
      log(state, `${target.name} 被关进监狱，暂停 ${effect.days} 回合并丧失收租权`);
      claimMagicInsurance(state, target);
      return true;
    case 'hold':
      // 与停留卡 CARD-14 同一个字段：下一次前进时原地停留
      target.holdTurns += 1;
      log(state, `${target.name} 被定在「${here.name}」，下一回合原地停留`);
      return true;
    case 'demolish':
      // 拆一层（Q-03）。1 级就是空地（`GRADE_NAMES[1]`），所以平房被拆一级即还原成空地，
      // 已经在空地上再拆就没有东西可拆 —— 算落空，不越级去动地权。
      if (!under || under.property.grade <= 1) return false;
      under.property.grade = (under.property.grade - 1) as 1 | 2 | 3 | 4 | 5;
      log(
        state,
        `${target.name} 脚下的「${here.name}」被拆至${gradeName(under.property.grade)}（地主 ${under.player.name}）`,
      );
      return true;
    case 'hospital':
      imposeCustody(state, target, 'hospital', effect.days ?? 0);
      log(state, `${target.name} 住院检查 ${effect.days} 天并丧失收租权`);
      claimMagicInsurance(state, target);
      return true;
    case 'gain-card':
      // 走免费卡格那条现成通道：额满时挂 `pendingCards` 让被施法者自己弃一张
      drawChanceCard(state, target, '魔法屋');
      return true;
    case 'build-up':
      // 免费加盖一层（Q-02 定"不挑"：不查地价区间，也不查 A 那条未解的前置）。
      // 不可加盖的算落空：连锁店（help[21] 改建后不能再加盖）、已封顶、
      // 以及公园 / 加油站这类 `upgradeable:false` 的设施。
      if (!under || under.property.chain) return false;
      if (under.property.grade >= MAX_GRADE) return false;
      if (here.type === 'commercial' && !FACILITIES[under.property.facility!]?.upgradeable) return false;
      under.property.grade = (under.property.grade + 1) as 1 | 2 | 3 | 4 | 5;
      log(
        state,
        `${target.name} 脚下的「${here.name}」凭空加盖一层，现为${gradeName(under.property.grade)}（地主 ${under.player.name}）`,
      );
      return true;
    case 'to-deposit':
      if (target.cash <= 0) return false;
      target.deposit += target.cash;
      log(state, `${target.name} 手头的 ¥${target.cash} 现金全部存入银行`);
      target.cash = 0;
      return true;
    case 'turn-back': {
      // 与转向卡同一条算式：朝向存的是邻接表下标，翻一格即掉头
      const ways = boardNeighbors(state.board, target.position).length || 1;
      target.heading = (target.heading + 1) % ways;
      log(state, `${target.name} 的行进方向被拧了 180°`);
      return true;
    }
    case 'auction-cell':
      // 拍的是脚下那一格，**成交价归地主**（`beginAuction` 的 sellerId 语义）：被拍卖的是他，
      // 拿钱的也是他。A 只在坐牢/住院那条写了"记在踩屋者名下"，这档没写，就不替踩屋者加钱。
      // 无主之地不拍 —— 没有卖方，拍出去等于白送一块地，这是"脚下是谁的地都照办"之后
      // 我仍然保留的唯一一条前提。多个命中者各拍一块 → 进 `auctionQueue` 逐场开，不互相覆盖。
      if (!under || (here.type !== 'property' && here.type !== 'commercial')) return false;
      state.auctionQueue.push({ cellId: here.id, sellerId: under.player.id, trigger: 'magic' });
      log(state, `${target.name} 脚下的「${here.name}」被挂上拍卖台（地主 ${under.player.name}）`);
      return true;
    default: {
      const exhaustive: never = effect.kind;
      throw new Error(`未知魔法: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** 保险理赔（M-15 / Q-01）：在保才赔，钱给**被施法者本人**，按物价指数缩放 */
function claimMagicInsurance(state: GameState, p: Player): void {
  if (!p.insurance) return;
  const amount = scaled(state, MAGIC_INSURANCE_CLAIM);
  p.cash += amount;
  log(state, `${p.name} 的保单生效，领取保险金 ¥${amount}`);
}

// ---------------------------------------------------------------------------
// ECON-13 拍卖器：触发源（倒闭/拍卖卡/事件/银行）+ 出价轮询 + 价高者得
// ---------------------------------------------------------------------------

/** 最小加价的地板值：低价标的按 10% 算会小到可以忽略，用 ¥50 兜住 */
export const AUCTION_MIN_STEP = 50;

/** 起拍价：有地价者取其半价（含物价指数），否则 100 */
function auctionMinBid(state: GameState, cell: BoardCell): number {
  if (cell.price === undefined) return 100;
  return Math.max(1, Math.floor(scaled(state, cell.price) / 2));
}

/**
 * 最小加价（原版没有这一条，GAP 调研 §1 只钉住「PASS 下一轮仍可加价」）。
 *
 * 老实现是 +1 元，于是两个都不肯认输的竞买人可以永远打下去：实测 seed=77 / 424242
 * 在 200 回合窗口里烧完 2400 个动作仍停在 `awaiting_auction`。乘性加价把「出价次数」
 * 从 `现金 ÷ 1` 压成对数量级（150 元跟到 1.5 万约 50 次），拍卖因此必然收口。
 */
export function auctionBidStep(highestBid: number): number {
  return Math.max(AUCTION_MIN_STEP, Math.ceil((highestBid * 0.1) / 10) * 10);
}

/** 竞买人此刻至少要出多少：无人出价时为起拍价，否则为当前价 + 最小加价 */
export function nextBidAmount(a: AuctionState): number {
  return a.highestBidderId ? a.highestBid + auctionBidStep(a.highestBid) : a.minBid;
}

/**
 * 收锤判定：除最高价者之外，在场竞买人都已经在本轮让过。
 * 尚无人出价时 `highestBidderId` 为 null，条件退化成「在场者全体让过」⇒ 流拍。
 *
 * 原版是「其他人都放弃后由最后出价者得标」—— 老实现把最高价者本人也算进放弃人数，
 * 每场拍卖都要多等他放弃一次才收锤；而他明明已经是要付钱的人了。
 */
function auctionIsSettled(a: AuctionState): boolean {
  return !a.bidders.some((id) => id !== a.highestBidderId && !a.passedSinceBid.includes(id));
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
    passedSinceBid: [],
    withdrawn: [],
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

/**
 * 轮到下一位竞买人；`withdrewIndex` 非空表示该下标上的竞买人刚弃权。
 *
 * 弃权者直接从 `bidders` 移出，他后面的人正好顶到同一个下标，所以轮次不再 +1，
 * 而是对该下标取模（全场弃权则归零）。轮询人数因此单调递减 —— 这是「拍卖一定收得了口」
 * 的另一半保证：加价幅度管住出价次数，弃权管住轮次长度。
 */
function advanceBidderTurn(a: AuctionState, withdrewIndex: number | null): void {
  if (withdrewIndex !== null) a.bidders.splice(withdrewIndex, 1);
  a.turnIndex = a.bidders.length === 0 ? 0 : (withdrewIndex ?? a.turnIndex + 1) % a.bidders.length;
}

function auctionBid(state: GameState, action: Extract<PlayerAction, { type: 'AUCTION_BID' }>): void {
  assertLegal(state, action);
  const a = state.auction!;
  const bidder = currentBidder(state);
  a.highestBid = action.amount;
  a.highestBidderId = bidder.id;
  // 有人加价 ⇒ 这一圈重新数
  a.passedSinceBid = [];
  log(state, `【拍卖】${bidder.name} 出价 ¥${action.amount}`);
  advanceBidderTurn(a, null);
  // 其余人早已弃权 ⇒ 当场成交，不必再空转一轮
  if (auctionIsSettled(a)) settleAuction(state);
}

/** 本轮让过（原版 PASS）：不加价，但保留下一轮加价的权利 */
function auctionPass(state: GameState): void {
  assertLegal(state, { type: 'AUCTION_PASS' });
  const a = state.auction!;
  const bidder = currentBidder(state);
  a.passedSinceBid = [...a.passedSinceBid, bidder.id];
  log(state, `【拍卖】${bidder.name} 本轮让过（下一轮仍可加价）`);
  advanceBidderTurn(a, null);
  if (auctionIsSettled(a)) settleAuction(state);
}

/** 弃权退出本场拍卖（原版 GIVE UP）：此后不再被轮到 */
function auctionGiveUp(state: GameState): void {
  assertLegal(state, { type: 'AUCTION_GIVE_UP' });
  const a = state.auction!;
  const idx = a.turnIndex;
  const bidder = currentBidder(state);
  a.withdrawn = [...a.withdrawn, bidder.id];
  a.passedSinceBid = [...a.passedSinceBid, bidder.id];
  log(state, `【拍卖】${bidder.name} 弃权，退出「${state.board[a.cellId]?.name ?? ''}」的争夺`);
  advanceBidderTurn(a, idx);
  if (auctionIsSettled(a)) settleAuction(state);
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
/**
 * 银行类动作的取数。
 * 「轮到当前玩家 + 拥有银行权限 + 非例假日」三条规则只在 `bankRefusal` 里写一次（由各 check 调用），
 * 这里只负责取值 —— 走到这里时 assertLegal 已经放行。
 */
function bankContext(state: GameState): { p: Player; bank: BankAccess } {
  return { p: currentPlayer(state), bank: state.bankAccess! };
}

/** 存款：现金 → 存款 */
function depositMoney(state: GameState, amount: number): void {
  assertLegal(state, { type: 'DEPOSIT', amount });
  const { p } = bankContext(state);
  p.cash -= amount;
  p.deposit += amount;
  log(state, `${p.name} 存入 ¥${amount}（存款余额 ¥${p.deposit}）`);
}

/** 取款：存款 → 现金 */
function withdrawMoney(state: GameState, amount: number): void {
  assertLegal(state, { type: 'WITHDRAW', amount });
  const { p } = bankContext(state);
  p.deposit -= amount;
  p.cash += amount;
  log(state, `${p.name} 取出 ¥${amount}（存款余额 ¥${p.deposit}）`);
}

/** 贷款：无利息，3 个月后到期强制全额归还 */
function takeLoan(state: GameState, amount: number): void {
  assertLegal(state, { type: 'TAKE_LOAN', amount });
  const { p } = bankContext(state);
  const today = gameDate(state);
  const dueSerial = toSerial(addMonths({ year: today.year, month: today.month, day: today.day }, LOAN_TERM_MONTHS));
  const dueDayIndex = dueSerial - toSerial(state.calendar.start);
  p.loan = { principal: amount, takenAtDayIndex: state.calendar.elapsedDays, dueDayIndex };
  p.cash += amount;
  log(state, `${p.name} 向银行借款 ¥${amount}，${LOAN_TERM_MONTHS} 个月后到期（第 ${dueDayIndex} 天）`);
}

/** 还贷：可部分或全额提前归还（现金支付） */
function repayLoan(state: GameState, amount: number): void {
  assertLegal(state, { type: 'REPAY_LOAN', amount });
  const { p } = bankContext(state);
  const principal = p.loan!.principal;
  const paid = Math.min(amount, principal);
  p.cash -= paid;
  const remaining = principal - paid;
  if (remaining <= 0) {
    p.loan = null;
    log(state, `${p.name} 提前还清贷款 ¥${principal}`);
  } else {
    p.loan!.principal = remaining;
    log(state, `${p.name} 归还贷款 ¥${paid}（剩余 ¥${remaining}）`);
  }
}

/**
 * 卡片/道具效果体所需的引擎能力集合。
 *
 * 效果体本身住在 `cards.ts` / `items.ts`（与各自的数据定义同处一个文件），
 * 那两个模块不能反向 import 本文件（会形成循环依赖），故由此处注入。
 * 各 helper 的签名与引擎内部函数保持一致，搬迁过去的作用代码无须重排参数。
 */
const EFFECT_KIT: EffectKit = {
  log,
  pay,
  payCash,
  cellAt,
  cellOwner,
  propOf,
  consumeCard,
  consumeItem,
  randomIndex,
  routeSegment,
  blockRent,
  imposeCustody,
  applyDisaster,
  stockById,
  activePlayers,
  isShopCell,
  isBankCell,
  detonate,
  beginAuction,
  attachGod: (state, p, def) => attachGod(godCtx(state), p, def),
  nearestGodFor: (state, p) => nearestGodFor(godCtx(state), p),
  godSummonRefusal: (state) => godSummonRefusal(state),
  clearBoardGods: (state, cellIds, reason) => clearBoardGodsOnCells(godCtx(state), cellIds, reason),
  claimBoardGod: (state, godId) => {
    const god = state.boardGods.find((g) => g.godId === godId);
    return god ? detachGodForPossession(state, god.cellId) !== null : false;
  },
  summonGod: (state, p) => summonGod(godCtx(state), p),
  applyGodRentModifier: (state, p, rent, cellName) => applyGodRentModifier(godCtx(state), p, rent, cellName),
  unluckyMultiplier,
  drawChanceCard,
  randomPick,
  builtProperties,
  destroyBuilding,
  isGameOver,
  streetLabel,
  ownedStreets,
  unownedLandCells,
  playersWithLand,
  playersWithShares,
  totalSharesOf,
  isStockSuspended,
};

/**
 * 落格 handler 的能力集合：通用 `EFFECT_KIT` 加几款只有「落脚某格」才用到的引擎内部函数。
 * 拆出来是为了让 `rollDice` 的调用点保持一行；`state` / `self` / `cell` / `moved` 每次落格注入。
 */
const LANDING_KIT: Omit<CellLandingCtx, 'state' | 'self' | 'cell' | 'moved'> = {
  ...EFFECT_KIT,
  // R4：落格 handler 用它决定「这一格到底开不开窗」——问的就是注册表那一句，与按钮同源
  actRefusal: (state, action) => actionRefusal(state, action),
  tryFreePass,
  propertyRent,
  bailFee,
  resolveFateCard,
  resolveNewsEvent,
};

/**
 * 卡片统一入口（CARD-01..30）。
 * 阶段校验 → 注入效果上下文 → 委托 `CardDef.apply` → 消耗一张手牌。
 */
function useCard(state: GameState, action: Extract<PlayerAction, { type: 'USE_CARD' }>): void {
  assertLegal(state, action);
  const p = currentPlayer(state);
  const card = CARDS[action.cardId]!;

  card.apply!({
    ...EFFECT_KIT,
    state,
    self: p,
    action,
    card,
    /**
     * 已校验的目标格：跑 def 的同一个谓词，拒绝理由原样抛出。
     * 「缺省取脚下」的老行为已经删除 —— 那会让没选值的卡静默打到脚下那一格。
     */
    targetCell: (): number => {
      const reason = card.targetSpec?.check?.(state, p, action) ?? null;
      if (reason !== null) throw new Error(reason);
      if (action.cellId === undefined || !state.board[action.cellId]) throw new Error('请选择有效的目标格');
      return action.cellId;
    },
    targetPlayer: (): Player => {
      const reason = card.targetSpec?.check?.(state, p, action) ?? null;
      if (reason !== null) throw new Error(reason);
      const t = state.players.find((q) => q.id === action.targetPlayerId);
      if (!t) throw new Error('请选择有效的目标玩家');
      return t;
    },
  });
  consumeCard(p, card.id);
}

/** 购买卡片（CARD-*）：点券结算，手牌上限 15（波 2：货币由现金改为点券） */
function buyCard(state: GameState, action: Extract<PlayerAction, { type: 'BUY_CARD' }>): void {
  assertLegal(state, action);
  const p = currentPlayer(state);
  const card = CARDS[action.cardId]!;
  p.points -= card.cost;
  p.cards.push(card.id);
  log(state, `${p.name} 以 ${card.cost} 点券购入「${card.name}」`);
}

/** 舍弃手牌（满手时的腾位手段；仅在自己回合内可用） */
function discardCard(state: GameState, action: Extract<PlayerAction, { type: 'DISCARD_CARD' }>): void {
  // ECON-12：额满待舍弃阶段也允许 DISCARD_CARD，选定后新卡立即入栏
  assertLegal(state, action);
  // 待舍弃阶段动手的是「卡的主人」，不是「轮到谁」：两者可以不是同一个人（见 PendingCard）
  const p = state.phase === 'awaiting_discard' ? (pendingOwner(state) ?? currentPlayer(state)) : currentPlayer(state);
  consumeCard(p, action.cardId);
  log(state, `${p.name} 舍弃了卡片「${CARDS[action.cardId]?.name ?? action.cardId}」`);
  if (state.phase === 'awaiting_discard') resolvePendingCard(state);
}

/** 购买道具（ITEM-01..08）：点券结算，每种道具上限 9（MAX_ITEM_COUNT） */
function buyItem(state: GameState, action: Extract<PlayerAction, { type: 'BUY_ITEM' }>): void {
  assertLegal(state, action);
  const p = currentPlayer(state);
  const item = ITEMS[action.itemId]!;
  const cost = item.cost ?? 0;
  p.points -= cost;
  p.items[item.id] = (p.items[item.id] ?? 0) + 1;
  log(state, `${p.name} 以 ${cost} 点券购入「${item.name}」`);
}

/**
 * TILE-12 商店买/卖（help [27]）：把卡片变卖给商店回收点券。
 * 半价回收（`floor(cost / 2)`），与命运卡「变卖所有卡片道具」同口径；
 * 点券四大产出渠道之一（用户规则：宝箱 / 点券格 / 小游戏 / 变卖卡片道具）。
 */
function sellCard(state: GameState, action: Extract<PlayerAction, { type: 'SELL_CARD' }>): void {
  assertLegal(state, action);
  const p = currentPlayer(state);
  const card = CARDS[action.cardId]!;
  consumeCard(p, card.id);
  const refund = Math.floor(card.cost / 2);
  p.points += refund;
  log(state, `${p.name} 把「${card.name}」变卖给商店，回收 ${refund} 点券`);
}

/** TILE-12 商店买/卖：把道具变卖给商店回收点券（售价半价；研究所非卖品按 D-53 那套等级回收价） */
function sellItem(state: GameState, action: Extract<PlayerAction, { type: 'SELL_ITEM' }>): void {
  assertLegal(state, action);
  const p = currentPlayer(state);
  const item = ITEMS[action.itemId]!;
  const left = (p.items[item.id] ?? 0) - 1;
  if (left > 0) p.items[item.id] = left;
  else delete p.items[item.id];
  const refund = itemSellValue(item.id);
  p.points += refund;
  log(state, `${p.name} 把「${item.name}」变卖给商店，回收 ${refund} 点券`);
}

/**
 * 道具统一入口（ITEM-01..13）。
 * 持有与阶段校验 → 注入效果上下文 → 委托 `ItemDef.apply` → 消耗一个道具。
 */
function useItem(state: GameState, action: Extract<PlayerAction, { type: 'USE_ITEM' }>): void {
  assertLegal(state, action);
  const p = currentPlayer(state);
  const item = ITEMS[action.itemId]!;

  item.apply!({
    ...EFFECT_KIT,
    state,
    self: p,
    action,
    item,
    /** 已校验的目标格（谓词与卡片同一个入口，见 `targets.ts`） */
    targetCell: (): number => {
      const reason = item.targetSpec?.check?.(state, p, action) ?? null;
      if (reason !== null) throw new Error(reason);
      if (action.cellId === undefined || !state.board[action.cellId]) throw new Error('请选择有效的目标格');
      return action.cellId;
    },
    targetPlayer: (): Player => {
      const reason = item.targetSpec?.check?.(state, p, action) ?? null;
      if (reason !== null) throw new Error(reason);
      const t = state.players.find((q) => q.id === action.targetPlayerId);
      if (!t) throw new Error('请选择有效的目标玩家');
      return t;
    },
  });
  consumeItem(p, item.id);
}

/** 银行/证交所格（含 TILE-26 企业银行，CORP-09「功能与公立银行相同」） */
function isBankCell(c: BoardCell): boolean {
  return landingVenueOf(c) === 'bank';
}

/** 商店格（含 TILE-29 百货公司，CORP-12「同公立百货」） */
function isShopCell(c: BoardCell): boolean {
  return landingVenueOf(c) === 'shop';
}

/**
 * ECON-09 买入股票（help[14]「隨時可買賣」+ help[07]「買賣股票的收支，也是由銀行幫您自動轉、扣帳」）。
 *
 * - 不绑定格型：自己回合的掷骰前（awaiting_roll）与决策后（awaiting_action）都可买；
 * - **只能用存款买入**（help[07]：股票收支由银行自动转扣存款）；现金仅用于买地与升级建筑；
 * - 例假日休市、全市场停牌、个股停牌时不可交易；
 * - 零 RNG 消耗，不扰动确定性回放。
 */
function buyStock(state: GameState, action: Extract<PlayerAction, { type: 'BUY_STOCK' }>): void {
  assertLegal(state, action);
  const p = currentPlayer(state);
  const stock = stockById(state, action.stockId)!;
  // 冲击成本：按「冲击前后中点」结算（买完立刻卖不赚差价），成交后盘口被买盘推高
  const { execPrice, moved } = applyTradeImpact(state, stock, action.quantity, 'buy');
  const total = execPrice * action.quantity;
  p.deposit -= total;
  stock.remainingShares -= action.quantity;   // 供给有限：买走的从流通盘里扣，可以买到没有
  const company = companyOfStock(state, stock.id);
  // ECON-10：建仓成本按 stockId 记，公司股与虚拟股同一条账。原版的移动平均
  // （`DAT_004971a4` =（旧成本值 + 本次成本）÷ 总持股）与「累计成本 ÷ 持股」是同一个数，
  // 卖出时按比例结转均价不变 —— 所以这里只累加，除法留给展示层。
  p.stockCost = p.stockCost ?? {};
  p.stockCost[stock.id] = (p.stockCost[stock.id] ?? 0) + total;
  if (company) {
    // 一本账：面板买的也是这家公司的股东 —— 持股记进 `CompanyState.shares`（与踩格认购同一本），
    // 同样先进锁定期。否则「市价买一手 → 抢下董事长免付费 → 当场原价卖回」可以白嫖特权。
    company.shares[p.id] = (company.shares[p.id] ?? 0) + action.quantity;
    company.lockedShares[p.id] = lockedSharesOf(company, p.id) + action.quantity;
    if (company.firstHeldDayIndex[p.id] === undefined) company.firstHeldDayIndex[p.id] = state.calendar.elapsedDays;
    recomputeCompanyChairman(state, company);
  } else {
    p.stocks[stock.id] = (p.stocks[stock.id] ?? 0) + action.quantity;
  }
  log(
    state,
    `${p.name} 以存款 ¥${total.toLocaleString('zh-CN')} 买入 ${stock.name} ×${action.quantity}（成交均价 ¥${execPrice}）` +
      (company ? `，计入股东名册（持股 ${company.shares[p.id]}，本回合这批下次行动才可转手）` : '') +
      (moved ? `，买盘把盘口推高至 ¥${stock.price}` : ''),
  );
}

/** ECON-09 卖出股票（help[14]「隨時可買賣」；与buyStock 同规则，不绑定格型） */
function sellStock(state: GameState, action: Extract<PlayerAction, { type: 'SELL_STOCK' }>): void {
  assertLegal(state, action);
  const p = currentPlayer(state);
  const stock = stockById(state, action.stockId)!;
  const holding = p.stocks[stock.id] ?? 0;
  // 与买入同一套口径：结算价取冲击前后中点，成交后盘口被抛压压低
  const execPrice = stockExecPrice(stock, action.quantity, 'sell');
  const total = execPrice * action.quantity;
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
  p.deposit += total; // 股市那侧的收支一律走存款（含卖出所得）
  // 卖回来的量回到流通盘里（上限就是总股本），下一位买的人才有货可买
  stock.remainingShares = Math.min(stock.floatShares, stock.remainingShares + action.quantity);
  const { moved } = applyTradeImpact(state, stock, action.quantity, 'sell');
  const profit = total - costOut;
  const profitText = profit === 0 ? '' : `（${profit >= 0 ? '赚' : '亏'} ¥${Math.abs(profit).toLocaleString('zh-CN')}）`;
  log(
    state,
    `${p.name} 卖出 ${stock.name} ×${action.quantity} 得存款 ¥${total.toLocaleString('zh-CN')}（成交均价 ¥${execPrice}）${profitText}` +
      (moved ? `，抛压把盘口压低至 ¥${stock.price}` : ''),
  );
}

/**
 * CORP-01 / CORP-14：认购公司原始股。单次 ≤1000 张，按**面值**以现金结算。
 *
 * 踩到公司格与股市面板走的是同一个动作 —— 一级市场向公司申购，与公司直接收付现金，
 * 因此不随物价指数变化、也没有盘口冲击。新认购的部分记入 `lockedShares`，
 * 本回合结束（即下次行动）才允许在股市转手。
 * 认购后重新判定经营权（CORP-02：最大持股 + 同票先到先得），董事长换人时触发融资清算。
 */
function buyShares(state: GameState, action: Extract<PlayerAction, { type: 'BUY_SHARES' }>): void {
  assertLegal(state, action);
  const p = currentPlayer(state);
  const company = companyAtCell(state, action.cellId)!;
  const cost = company.sharePrice * action.quantity;
  p.cash -= cost;
  const subscribed = stockById(state, companyStockId(company.kind));
  if (subscribed) subscribed.remainingShares = Math.max(0, subscribed.remainingShares - action.quantity);
  // 一级认购也是这只票的成本账（按面值、现金结算），转手时与面板买入那份一起按比例结转
  if (subscribed) {
    p.stockCost = p.stockCost ?? {};
    p.stockCost[subscribed.id] = (p.stockCost[subscribed.id] ?? 0) + cost;
  }
  company.shares[p.id] = (company.shares[p.id] ?? 0) + action.quantity;
  company.lockedShares[p.id] = lockedSharesOf(company, p.id) + action.quantity;
  if (company.firstHeldDayIndex[p.id] === undefined) company.firstHeldDayIndex[p.id] = state.calendar.elapsedDays;
  const locked = lockedSharesOf(company, p.id);
  log(
    state,
    `${p.name} 以现金 ¥${cost.toLocaleString('zh-CN')} 认购${company.name} ${action.quantity} 张` +
      `（持股 ${company.shares[p.id]}，其中 ${locked} 张要到下次行动才能转手）`,
  );
  recomputeCompanyChairman(state, company);
  finishIfSingleStep(state);
}

/**
 * CORP-14：把原始股卖回股市 —— 按**当日市价**成交（吃冲击成本、进当日 K 线的量，与那 6 支虚拟股
 * 同一套行情），收入进**存款**：面板上的股票交易一律走存款，现金只用于买地、升级与踩格认购。
 * 只能卖已解锁的部分；卖到归零即退出股东名册，再进场时「先到先得」重新起算。
 */
function sellShares(state: GameState, action: Extract<PlayerAction, { type: 'SELL_SHARES' }>): void {
  assertLegal(state, action);
  const p = currentPlayer(state);
  const company = companyAtCell(state, action.cellId)!;
  const stock = stockById(state, companyStockId(company.kind))!;
  const holding = company.shares[p.id] ?? 0;
  const { execPrice } = applyTradeImpact(state, stock, action.quantity, 'sell');
  const total = execPrice * action.quantity;
  // 结转与 sellStock 同一条口径：按持股比例扣成本，均价不变（原版的移动平均）
  const costBefore = p.stockCost?.[stock.id] ?? 0;
  const costOut = holding > 0 ? Math.round((costBefore * action.quantity) / holding) : 0;
  const left = holding - action.quantity;
  if (left === 0) {
    delete company.shares[p.id];
    delete company.firstHeldDayIndex[p.id];
    delete company.lockedShares[p.id];
    if (p.stockCost) delete p.stockCost[stock.id];
  } else {
    company.shares[p.id] = left;
    if (p.stockCost) p.stockCost[stock.id] = costBefore - costOut;
  }
  p.deposit += total; // 股市那侧的钱一律进出存款（现金只归买地、升级、踩格认购）
  stock.remainingShares = Math.min(stock.floatShares, stock.remainingShares + action.quantity);
  const profit = total - costOut;
  log(
    state,
    `${p.name} 卖出 ${company.name} 原始股 ×${action.quantity}，按市价 ¥${execPrice.toLocaleString('zh-CN')} 成交，` +
      `得存款 ¥${total.toLocaleString('zh-CN')}（持股 ${left}）` +
      (costOut > 0 ? `，${profit >= 0 ? '赚' : '亏'} ¥${Math.abs(profit).toLocaleString('zh-CN')}` : ''),
  );
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
      log(state, `【特别融资】${company.name} 董事长换人，${prev.name} 的周转融资 ¥${amount} 须立即还清`);
      pay(state, prev, amount, null, { reason: 'financing' });
    }
  }
  if (nextId) {
    const next = state.players.find((q) => q.id === nextId);
    log(state, `${next?.name ?? nextId} 取得${company.name}经营权，成为董事长`);
  } else {
    log(state, `${company.name}经营权空缺`);
  }
}

/** CORP-09：特别融资可周转额 = 其他存活玩家存款总额 */
function financingCap(state: GameState, self: Player): number {
  return state.players.reduce((sum, q) => (q.id !== self.id && !q.bankrupt ? sum + q.deposit : sum), 0);
}

/** CORP-09：企业银行董事长特别融资（周转期间存款不计息） */
function specialFinancing(state: GameState, action: Extract<PlayerAction, { type: 'SPECIAL_FINANCING' }>): void {
  assertLegal(state, action);
  const p = currentPlayer(state);
  p.financing += action.amount;
  p.cash += action.amount;
  log(state, `${p.name} 以${COMPANIES.bank.name}董事长身份特别融资 ¥${action.amount}（累计 ¥${p.financing}；周转期间存款不计息）`);
  // 特别融资只发生在企业银行格 —— 那是会话窗（venue='bank'），办完还能接着存取款，所以不推进
  finishIfSingleStep(state);
}

/** CORP-13：房地产公司任选一处自有地产加盖一层，按该地地价收取施工费 */
function buildEstate(state: GameState, action: Extract<PlayerAction, { type: 'BUILD_ESTATE' }>): void {
  assertLegal(state, action);
  const p = currentPlayer(state);
  const c = cellAt(state, p.position);
  const prop = p.properties.find((q) => q.cellId === action.cellId)!;
  const target = state.board[action.cellId]!;
  const cost = scaled(state, Math.round(target.price! * ESTATE_BUILD_RATIO));
  p.cash -= cost;
  prop.grade = (prop.grade + 1) as PlayerProperty['grade'];
  const company = companyAtCell(state, c.id);
  if (company) company.surplus += cost;
  log(state, `${p.name} 通过${COMPANIES.estate.name}在「${target.name}」加盖一层（${gradeName(prop.grade)}），支付施工费 ¥${cost}`);
  finishIfSingleStep(state);
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

/**
 * 「没有可操作的玩家」的统一文案。
 * `currentPlayer` 抛它，各 `check` 也返回它 —— 必须是同一个字符串，
 * 否则老存档 / 客户端按文案做的判断会在某个动作上悄悄变样。
 */
const NO_ACTOR_MESSAGE = '当前玩家不存在';

/* ==========================================================================
 * 动作注册表（R3）：36 个玩家动作的「校验 + 执行」成对登记
 *
 * 此前门控（`availableActions`，决定按钮可否点）与引擎校验（各动作函数开头的
 * `if (…) throw`）是**同一套规则的两套并行实现**：加一个动作要改两处，两处一漂移
 * 就出现「按钮能点、引擎报错」—— golden 基线记录在案的那批被吞错误正是这个 bug 类。
 *
 * 现在每个动作只有一个 `check`：`availableActions` 由它派生布尔位，`apply` 在入口
 * 调用它并抛错，所以绕过 UI 直接塞动作给引擎照样会被拒。想改规则只有一处可改。
 *
 * 拒绝文案与重构前逐字一致（日志与客户端提示都依赖它），迁移期间由
 * `.scratch/diffcheck.sh` 的新旧引擎差分与 424 个单测共同守住。
 * ========================================================================== */

/** 该动作的实际操作者：拍卖中是轮到的竞买人（未必是当前玩家），大厅阶段可能尚无玩家 */
function actorForAction(state: GameState, action: PlayerAction): Player | null {
  if (action.type === 'START_GAME') return null;
  if (action.type === 'AUCTION_BID' || action.type === 'AUCTION_PASS' || action.type === 'AUCTION_GIVE_UP') {
    const a = state.auction;
    if (!a) return null;
    return state.players.find((q) => q.id === a.bidders[a.turnIndex]) ?? null;
  }
  // 待舍弃阶段同理：动手的是那张卡的主人。抽卡可以发生在别人的回合里（大福神显灵那类），
  // 按当前玩家判就会变成「要求一个手上没牌的人弃牌」，整局钉死在这个相位。
  if (action.type === 'DISCARD_CARD' && state.phase === 'awaiting_discard') {
    return pendingOwner(state);
  }
  return currentPlayerOrNull(state);
}

/** 门控的唯一派生入口：返回 null 表示这个动作此刻合法可执行 */
export function actionRefusal(state: GameState, action: PlayerAction): ActionRefusal {
  const spec = ACTION_SPECS[action.type] as ActionSpec;
  return spec.check(state, actorForAction(state, action), action);
}

/** 引擎侧拒绝：每个 apply 入口先跑自己的 check，外部无法塞进非法动作 */
function assertLegal(state: GameState, action: PlayerAction): void {
  const refusal = actionRefusal(state, action);
  if (refusal) throw new Error(refusal);
}

function checkStartGame(state: GameState, _p: Player | null, _action: ActionOf<'START_GAME'>): ActionRefusal {
  if (state.phase !== 'lobby') return '游戏已经开始';
  if (state.players.length < 2) return '至少需要 2 名玩家才能开始';
  return null;
}

function checkRollDice(state: GameState, p: Player | null, action: ActionOf<'ROLL_DICE'>): ActionRefusal {
  if (state.phase !== 'awaiting_roll') return '当前不能掷骰';
  if (!p) return NO_ACTOR_MESSAGE;
  const maxDice = Math.max(1, Math.min(3, p.diceCount));
  const requested = action.diceCount ?? maxDice;
  if (!Number.isInteger(requested) || requested < 1 || requested > maxDice) return `骰子数必须是 1-${maxDice} 的整数`;
  return null;
}

/**
 * R4：走出落格决策窗。
 *
 * **故意只看相位，不看 `state.landing`** —— 这是防软锁的逃生门：`awaiting_action` 有三个
 * 不是落格开窗的写入点（额满舍弃收尾、施法机会、拍卖结算交回回合），那些格子上没有可做的
 * 动作。若这里要求 `landing` 非空，玩家就会顶着一个没有出口的相位。
 */
function checkFinishLanding(state: GameState, _p: Player | null, _action: ActionOf<'FINISH_LANDING'>): ActionRefusal {
  if (state.phase !== 'awaiting_action') return '当前不在落格决策中';
  return null;
}

function checkBuyLand(state: GameState, p: Player | null, _action: ActionOf<'BUY_LAND'>): ActionRefusal {
  if (state.phase !== 'awaiting_action') return '当前不能购买地产';
  if (!p) return NO_ACTOR_MESSAGE;
  if (p.sleepwalkTurns > 0) return '梦游中无法买地';
  const c = cellAt(state, p.position);
  if ((c.type !== 'property' && c.type !== 'commercial') || c.price === undefined) return '此格不可购买';
  // SP-02：开局撒在可买格上也不给买 —— 只有「走到」的那一格才算落到
  if (standsOnOwnSpawn(p)) return '出生格不能直接购买，要先掷骰走过去';
  if (cellOwner(state, c.id)) return '该地产已有主人';
  if (godBlocksInvestment(p)) return '衰神附身，买地流拍';
  // help[22]：商业用地按自身公定地价购买，与住宅同源
  const price = godFreeLandPurchase(p) ? 0 : landPrice(state, c);
  if (p.cash < price) return '现金不足';
  return null;
}

function checkUpgradeLand(state: GameState, p: Player | null, _action: ActionOf<'UPGRADE_LAND'>): ActionRefusal {
  if (state.phase !== 'awaiting_action') return '当前不能升级地产';
  if (!p) return NO_ACTOR_MESSAGE;
  const c = cellAt(state, p.position);
  if ((c.type !== 'property' && c.type !== 'commercial') || c.price === undefined) return '此格不可升级';
  const owned = cellOwner(state, c.id);
  if (!owned || owned.player.id !== p.id) return '只能升级自己的地产';
  const prop = owned.property;
  if (c.type === 'commercial') {
    if (!prop.facility) return '请先建设施，再行升级';
    if (!facilityUpgradeable(prop)) return '该设施无法升级（EST-08/EST-11）';
  } else if (prop.chain) {
    return '连锁店不能再加盖（EST-04）';
  }
  if (prop.grade >= MAX_GRADE) return '地产已满级';
  if (godBlocksInvestment(p)) return '衰神附身，投资失败';
  // 行进显灵·投资加倍（GOD-04/05 大/小福神）：一次加盖两层，费用按实际层数计
  const target = Math.min(MAX_GRADE, prop.grade + (godDoublesBuild(p) ? 2 : 1));
  let cost = 0;
  for (let g = prop.grade; g < target; g++) cost += landUpgradeCost(state, c, g);
  if (p.cash < cost) return '现金不足';
  return null;
}

function checkBuildFacility(state: GameState, p: Player | null, action: ActionOf<'BUILD_FACILITY'>): ActionRefusal {
  if (state.phase !== 'awaiting_action') return '当前不能建设';
  if (!p) return NO_ACTOR_MESSAGE;
  const c = cellAt(state, p.position);
  if (c.type !== 'commercial' || c.price === undefined) return '此格不是商业用地';
  const owned = cellOwner(state, c.id);
  if (!owned || owned.player.id !== p.id) return '只能在自己的商业用地上建设';
  if (owned.property.facility) return '该用地已建有设施，可用改建卡变更项目';
  const def = FACILITIES[action.facility];
  if (!def) return '未知设施项目';
  if (godBlocksInvestment(p)) return '衰神附身，投资失败';
  if (p.cash < facilityBuildCost(state, c, action.facility)) return '现金不足';
  return null;
}

function checkStartResearch(state: GameState, p: Player | null, action: ActionOf<'START_RESEARCH'>): ActionRefusal {
  if (state.phase !== 'awaiting_action') return '当前不能立项研发';
  if (!p) return NO_ACTOR_MESSAGE;
  if (p.research) return '已有研发项目在进行中';
  const c = cellAt(state, p.position);
  if (c.type !== 'commercial') return '此格不是商业用地';
  const owned = cellOwner(state, c.id);
  if (!owned || owned.player.id !== p.id) return '只能在自己的研究所立项';
  if (owned.property.facility !== 'lab') return '此处不是研究所';
  const def = researchDef(action.itemId);
  if (!def) return '未知研发项目';
  if (def.level > owned.property.grade) return `研究所等级不足（需 Lv${def.level}）`;
  return null;
}

function checkUseCard(state: GameState, p: Player | null, action: ActionOf<'USE_CARD'>): ActionRefusal {
  if (!p) return NO_ACTOR_MESSAGE;
  const card = CARDS[action.cardId];
  if (!card) return '未知卡片';
  if (!p.cards.includes(card.id)) return '没有这张卡片';
  if (card.auto) return '该卡片为自动触发，不能主动使用';
  if (!card.available) return '该卡片尚未开放';
  if (state.phase !== 'awaiting_roll' && state.phase !== 'awaiting_action') return '当前不能使用卡片';
  // R4：卡片只有「掷骰前」与「掷骰后」两档（`CardPhase` 就这两个取值）。
  // `post_roll` 是唯一留在窗口里的一类：它们本身就是「对脚下这一格的回应」
  // （购地卡免买眼前这块地、改建卡改眼前这处设施、拍卖卡把眼前这块地拍出去……），
  // 拿掉它们等于把这五张卡变成手里按不动的死牌，所以这一波保留其可用性，
  // 而不是标 `available:false` 假装它们不存在（原计划的另一条路，代价见 commit 说明）。
  if (card.phase !== 'post_roll' && state.phase !== 'awaiting_roll') return '该卡片只能在掷骰前使用';
  if (card.phase === 'post_roll' && state.phase !== 'awaiting_action') return '该卡片只能在掷骰后使用';
  if (!card.apply) return '未知卡片效果';
  // 棋盘前提（如请神卡要有神可请）与**目标合法性**都在这一个谓词里 ——
  // 门控与 `apply` 共用它（见 `targets.ts`），所以「列在可用手牌里却按下去报错」这类分叉结构上不可能再出现。
  return targetRefusal(state, p, card.targetSpec, action);
}

function checkDiscardCard(state: GameState, p: Player | null, action: ActionOf<'DISCARD_CARD'>): ActionRefusal {
  // ECON-12：额满待舍弃阶段也允许 DISCARD_CARD，选定后新卡立即入栏
  if (state.phase !== 'awaiting_roll' && state.phase !== 'awaiting_action' && state.phase !== 'awaiting_discard') {
    return '当前不能舍弃卡片';
  }
  if (!p) return NO_ACTOR_MESSAGE;
  if (!p.cards.includes(action.cardId)) return '没有这张卡片';
  return null;
}

function checkBuyCard(state: GameState, p: Player | null, action: ActionOf<'BUY_CARD'>): ActionRefusal {
  if (state.phase !== 'awaiting_action') return '当前不能购买卡片';
  if (!p) return NO_ACTOR_MESSAGE;
  if (!inShop(state, p)) return '不在商店，不能购买卡片';
  const card = CARDS[action.cardId];
  if (!card || !SHOP_CARD_IDS.includes(card.id)) return '商店不出售这张卡片';
  if (p.cards.length >= MAX_HAND_CARDS) return `手牌已满（上限 ${MAX_HAND_CARDS}），请先舍弃卡片`;
  if (p.points < card.cost) return '点券不足';
  return null;
}

function checkSellCard(state: GameState, p: Player | null, action: ActionOf<'SELL_CARD'>): ActionRefusal {
  if (state.phase !== 'awaiting_action') return '当前不能变卖卡片';
  if (!p) return NO_ACTOR_MESSAGE;
  if (!inShop(state, p)) return '不在商店，不能变卖卡片';
  const card = CARDS[action.cardId];
  if (!card || !p.cards.includes(card.id)) return '没有这张卡片';
  return null;
}

function checkUseItem(state: GameState, p: Player | null, action: ActionOf<'USE_ITEM'>): ActionRefusal {
  if (!p) return NO_ACTOR_MESSAGE;
  const item = ITEMS[action.itemId];
  if (!item) return '未知道具';
  if ((p.items[item.id] ?? 0) <= 0) return '没有这个道具';
  // R4：道具全在掷骰前。这条规则**只写在这里一次** —— 旧的 `ItemDef.phase` 字段从未被读过
  // （14 件道具没有 post_roll），W4 删掉它，免得以后有人改了字段却发现行为没变。
  if (state.phase !== 'awaiting_roll') return '道具只能在掷骰前使用';
  if (!item.apply) return '未知道具效果';
  // 与卡片同一个谓词入口（`targets.ts`）：路障/地雷的视野限制、载具互斥、时光机无快照…都在这里判
  return targetRefusal(state, p, item.targetSpec, action);
}

function checkBuyItem(state: GameState, p: Player | null, action: ActionOf<'BUY_ITEM'>): ActionRefusal {
  if (state.phase !== 'awaiting_action') return '当前不能购买道具';
  if (!p) return NO_ACTOR_MESSAGE;
  if (!inShop(state, p)) return '不在商店，不能购买道具';
  const item = ITEMS[action.itemId];
  if (!item || !SHOP_ITEM_IDS.includes(item.id)) return '商店不出售这种道具';
  if ((p.items[item.id] ?? 0) >= MAX_ITEM_COUNT) return `该道具已达上限（${MAX_ITEM_COUNT} 个）`;
  if (p.points < (item.cost ?? 0)) return '点券不足';
  return null;
}

function checkSellItem(state: GameState, p: Player | null, action: ActionOf<'SELL_ITEM'>): ActionRefusal {
  if (state.phase !== 'awaiting_action') return '当前不能变卖道具';
  if (!p) return NO_ACTOR_MESSAGE;
  if (!inShop(state, p)) return '不在商店，不能变卖道具';
  const item = ITEMS[action.itemId];
  if (!item || (p.items[item.id] ?? 0) <= 0) return '没有这个道具';
  return null;
}

/** 银行类动作的共同前置（顺序与 `bankContext` 取值前的校验一致：相位 → 权限 → 例假日 → 玩家） */
function bankRefusal(state: GameState, p: Player | null): ActionRefusal {
  if (state.phase !== 'awaiting_action') return '当前不能进行银行操作';
  const bank = state.bankAccess;
  if (!bank) return '不在银行，不能进行银行操作';
  if (gameDate(state).isHoliday) return '例假日银行休市';
  if (!p) return NO_ACTOR_MESSAGE;
  return null;
}

function checkDeposit(state: GameState, p: Player | null, action: ActionOf<'DEPOSIT'>): ActionRefusal {
  const early = bankRefusal(state, p);
  if (early) return early;
  if (!state.bankAccess!.canDeposit) return '此处不能存款';
  if (!Number.isInteger(action.amount) || action.amount <= 0) return '金额必须为正整数';
  if (p!.cash < action.amount) return '现金不足';
  return null;
}

function checkWithdraw(state: GameState, p: Player | null, action: ActionOf<'WITHDRAW'>): ActionRefusal {
  const early = bankRefusal(state, p);
  if (early) return early;
  if (!state.bankAccess!.canDeposit) return '此处不能取款';
  if (!Number.isInteger(action.amount) || action.amount <= 0) return '金额必须为正整数';
  if (p!.deposit < action.amount) return '存款不足';
  return null;
}

function checkTakeLoan(state: GameState, p: Player | null, action: ActionOf<'TAKE_LOAN'>): ActionRefusal {
  const early = bankRefusal(state, p);
  if (early) return early;
  if (!state.bankAccess!.canLoan) return '此处不能贷款';
  if (state.loanBanDays > 0) return `银行挤兑中，${state.loanBanDays} 天内停止放款（EVT-01 事件 22）`;
  if (p!.loan) return '已有未还清的贷款';
  if (!Number.isInteger(action.amount) || action.amount <= 0) return '金额必须为正整数';
  if (action.amount > MAX_LOAN) return `单笔贷款上限 ¥${MAX_LOAN}`;
  return null;
}

function checkRepayLoan(state: GameState, p: Player | null, action: ActionOf<'REPAY_LOAN'>): ActionRefusal {
  const early = bankRefusal(state, p);
  if (early) return early;
  if (!state.bankAccess!.canLoan) return '此处不能还贷';
  if (!p!.loan) return '当前没有贷款';
  if (!Number.isInteger(action.amount) || action.amount <= 0) return '金额必须为正整数';
  if (p!.cash < Math.min(action.amount, p!.loan!.principal)) return '现金不足';
  return null;
}

/**
 * 股票类动作的共同前置（买卖共用，顺序与引擎逐条一致）。
 *
 * `side` 决定涨跌停闸门的方向 —— 原版判得很不对称（FUN_004295ea + 两个入口）：
 * **涨停追不进（禁买可卖）、跌停割不掉（禁卖可买）**。少掉这一条，"涨停板"就只是个
 * 数字而不是规则，玩家永远能在最高点满仓、也在最低点清仓。
 */
function stockTradeRefusal(
  state: GameState,
  p: Player | null,
  stockId: string,
  quantity: number,
  side: 'buy' | 'sell',
): ActionRefusal {
  if (!canTradeStockNow(state)) return '当前不能交易股票';
  if (!p) return NO_ACTOR_MESSAGE;
  if (p.bankrupt) return '已倒闭的玩家不能交易股票';
  const stock = stockById(state, stockId);
  if (!stock) return '未知股票';
  if (state.stockHaltAllDays > 0) return `全市场停牌中（剩余 ${state.stockHaltAllDays} 天）`;
  if (gameDate(state).isHoliday) return '例假日休市，无法买卖股票';
  if (isStockSuspended(state, stock.id)) return `${stock.name} 暂停交易中`;
  const limit = stockLimitState(stock);
  if (side === 'buy' && limit === 'up') return `${stock.name} 涨停中，无法买进`;
  if (side === 'sell' && limit === 'down') return `${stock.name} 跌停中，无法卖出`;
  if (!Number.isInteger(quantity) || quantity <= 0) return '数量必须为正整数';
  return null;
}

function checkBuyStock(state: GameState, p: Player | null, action: ActionOf<'BUY_STOCK'>): ActionRefusal {
  const early = stockTradeRefusal(state, p, action.stockId, action.quantity, 'buy');
  if (early) return early;
  const stock = stockById(state, action.stockId)!;
  // 校验用**结算价**（含冲击）而不是盘口原价：否则「刚好够钱」的那笔会扣成负存款
  const total = stockExecPrice(stock, action.quantity, 'buy') * action.quantity;
  // 股票**只能用存款买入**（help[07]：买股票的收支由银行自动转、扣帐，走存款账户）；
  // 现金不能用于炒股——现金只够买地与升级建筑。
  // 股票表里有一支的流通量本来就是 0（中國石油，见 `maps/stocks.json` 的 `_note`）：那不是
  // 「被人买光了」，是这张票根本没投放市场。两句话得分开说，否则玩家以为有人在跟它抢筹。
  if (stock.floatShares <= 0) return `${stock.name} 没有流通量，行情池里买不到这张票`;
  if (action.quantity > stock.remainingShares) {
    return `${stock.name} 的流通股只剩 ${stock.remainingShares} 张，买不到 ${action.quantity} 张（有人已经把它买光了）`;
  }
  if (p!.deposit < total) {
    return `存款不足：买入 ${stock.name} ×${action.quantity} 需 ¥${total.toLocaleString('zh-CN')}，可用存款 ¥${p!.deposit.toLocaleString('zh-CN')}（现金不能用于炒股）`;
  }
  return null;
}

function checkSellStock(state: GameState, p: Player | null, action: ActionOf<'SELL_STOCK'>): ActionRefusal {
  const early = stockTradeRefusal(state, p, action.stockId, action.quantity, 'sell');
  if (early) return early;
  // 公司股是股东名册上的账（`CompanyState.shares`），转手走 SELL_SHARES —— 那里才看得见锁定期
  if (companyOfStock(state, action.stockId)) return '公司股请在「我的原始股权益」里转手';
  if (action.quantity > (p!.stocks[action.stockId] ?? 0)) return '持股不足';
  return null;
}

function checkMinigamePick(state: GameState, _p: Player | null, action: ActionOf<'MINIGAME_PICK'>): ActionRefusal {
  if (state.phase !== 'awaiting_pick' || !state.minigame) return '当前没有进行中的小游戏';
  const mg = state.minigame;
  if (mg.kind === 'memory') {
    const index = action.hole;
    if (!Number.isInteger(index) || index < 0 || index > 7) return '牌下标必须是 0-7';
    if (mg.matched[index]) return '这张牌已配对消除';
    if (mg.revealed.includes(index)) return '这张牌已经翻开';
    if (mg.flips >= 8) return '翻牌次数已用完';
    return null;
  }
  if (action.hole !== 0 && action.hole !== 1 && action.hole !== 2) return '杯号必须是 0-2';
  return null;
}

/**
 * CORP-01 / CORP-14：认购校验。
 *
 * - **现金**按面值支付，没有现金就买不成（原始股与公司直接收付，不走存款）；
 * - 一级市场申购**不看盘口**：例假日休市、全市场停牌都挡不住认购；
 *   但只有**踩到那一格**的这一手办得成（CORP-14），股市面板里的认购走的是 BUY_STOCK；
 * - 单次上限 1000 张（CORP-01）。
 */
function checkBuyShares(state: GameState, p: Player | null, action: ActionOf<'BUY_SHARES'>): ActionRefusal {
  // CORP-14：原始股是**一级市场认购**，只有这一手真的踩到公司格、正站在它门口时才发生。
  // 不在股市面板里卖 —— 面板只负责转手（SELL_SHARES），否则「踩点投资」就变成了随时随地的现金通道。
  if (!p) return NO_ACTOR_MESSAGE;
  if (state.phase !== 'awaiting_action' || cellAt(state, p.position).type !== 'company') {
    return '原始股只在踩到公司格的那一回合认购';
  }
  if (p.bankrupt) return '已倒闭的玩家不能认购股份';
  const company = companyAtCell(state, action.cellId);
  if (!company) return '该公司不存在，不能认购股份';
  if (action.cellId !== p.position) return '没走到该公司格，不能认购其原始股';
  if (!Number.isInteger(action.quantity) || action.quantity <= 0) return '股数必须为正整数';
  if (action.quantity > MAX_SHARES_PER_BUY) return `单次认购上限 ${MAX_SHARES_PER_BUY} 张`;
  const listed = stockById(state, companyStockId(company.kind));
  if (listed && listed.floatShares <= 0) {
    return `${company.name} 这只票没有流通量，行情与公司格两条渠道都拿不到它`;
  }
  if (listed && action.quantity > listed.remainingShares) {
    return `${company.name} 的流通股只剩 ${listed.remainingShares} 张，认购不到 ${action.quantity} 张`;
  }
  const need = company.sharePrice * action.quantity;
  if (p.cash < need) {
    return `现金不足：认购 ${company.name} ×${action.quantity} 需 ¥${need.toLocaleString('zh-CN')}，可用现金 ¥${p.cash.toLocaleString('zh-CN')}`;
  }
  return null;
}

/**
 * CORP-14：卖出原始股的校验。与认购相反，这是**二级市场转手**，要有对手盘才行
 * ⇒ 受例假日休市与全市场停牌约束；且只能卖已过锁定期（下次行动）的那部分。
 */
function checkSellShares(state: GameState, p: Player | null, action: ActionOf<'SELL_SHARES'>): ActionRefusal {
  if (!canTradeStockNow(state)) return '当前不能卖出原始股';
  if (!p) return NO_ACTOR_MESSAGE;
  if (p.bankrupt) return '已倒闭的玩家不能卖出原始股';
  const company = companyAtCell(state, action.cellId);
  if (!company) return '该公司不存在，不能卖出原始股';
  if (!Number.isInteger(action.quantity) || action.quantity <= 0) return '股数必须为正整数';
  if (state.stockHaltAllDays > 0) return `全市场停牌中（剩余 ${state.stockHaltAllDays} 天）`;
  if (gameDate(state).isHoliday) return '例假日休市，无法卖出原始股';
  // 二级转手同样吃跌停闸门：割不掉就是割不掉（认购走的是面值申购，不受此限）
  const listed = stockById(state, companyStockId(company.kind));
  if (listed && stockLimitState(listed) === 'down') return `${company.name} 跌停中，无法卖出原始股`;
  const locked = lockedSharesOf(company, p.id);
  if (action.quantity > sellableSharesOf(company, p.id)) {
    return locked > 0
      ? `持股不足：手上 ${company.shares[p.id] ?? 0} 张里有 ${locked} 张是本回合认购，要到下次行动才能转手`
      : '持股不足';
  }
  return null;
}

function checkSpecialFinancing(state: GameState, p: Player | null, action: ActionOf<'SPECIAL_FINANCING'>): ActionRefusal {
  if (state.phase !== 'awaiting_action') return '当前不能特别融资';
  if (!p) return NO_ACTOR_MESSAGE;
  const c = cellAt(state, p.position);
  if (c.type !== 'company' || c.companyKind !== 'bank') return '不在企业银行，不能特别融资';
  const company = companyAtCell(state, c.id);
  if (!company || company.chairmanId !== p.id) return '只有董事长可以特别融资';
  if (!Number.isInteger(action.amount) || action.amount <= 0) return '金额必须为正整数';
  if (p.financing + action.amount > financingCap(state, p)) return `特别融资上限 ¥${financingCap(state, p)}`;
  return null;
}

function checkBuildEstate(state: GameState, p: Player | null, action: ActionOf<'BUILD_ESTATE'>): ActionRefusal {
  if (state.phase !== 'awaiting_action') return '当前不能加盖';
  if (!p) return NO_ACTOR_MESSAGE;
  const c = cellAt(state, p.position);
  if (c.type !== 'company' || c.companyKind !== 'estate') return '不在房地产公司，不能加盖';
  const prop = p.properties.find((q) => q.cellId === action.cellId);
  if (!prop) return '只能加盖自己的地产';
  if (prop.grade >= MAX_GRADE) return '该地产已满级';
  const target = state.board[action.cellId];
  if (!target || (target.type !== 'property' && target.type !== 'commercial') || target.price === undefined) {
    return '该格不可加盖';
  }
  if (target.type === 'commercial' && !prop.facility) return '商业用地需先建设施';
  if (p.cash < scaled(state, Math.round(target.price * ESTATE_BUILD_RATIO))) return '现金不足';
  return null;
}

function checkBuyLotteryTicket(state: GameState, p: Player | null, action: ActionOf<'BUY_LOTTERY_TICKET'>): ActionRefusal {
  if (state.phase !== 'awaiting_action') return '当前不能投注乐透';
  if (!p) return NO_ACTOR_MESSAGE;
  if (cellAt(state, p.position).type !== 'lottery') return '不在乐透行，不能投注';
  if (!isValidLotteryNumber(action.number)) return '号码必须是 0-99 的整数';
  if (p.cash < LOTTERY_TICKET_COST) return '现金不足';
  return null;
}

/** 拍卖三个动作共用的前提：正在拍卖中，且轮到的这位竞买人还在场 */
function auctionTurnRefusal(state: GameState, bidder: Player | null): ActionRefusal {
  if (state.phase !== 'awaiting_auction' || !state.auction) return '当前没有进行中的拍卖';
  if (!bidder) return '竞买人不存在';
  return null;
}

function checkAuctionBid(state: GameState, bidder: Player | null, action: ActionOf<'AUCTION_BID'>): ActionRefusal {
  const base = auctionTurnRefusal(state, bidder);
  if (base) return base;
  const min = nextBidAmount(state.auction!);
  if (!Number.isInteger(action.amount) || action.amount < min) return `出价不得低于 ¥${min}`;
  if (action.amount > bidder!.cash) return '出价不能超过自己的现金';
  return null;
}

function checkAuctionPass(state: GameState, bidder: Player | null, _action: ActionOf<'AUCTION_PASS'>): ActionRefusal {
  return auctionTurnRefusal(state, bidder);
}

function checkAuctionGiveUp(state: GameState, bidder: Player | null, _action: ActionOf<'AUCTION_GIVE_UP'>): ActionRefusal {
  const base = auctionTurnRefusal(state, bidder);
  if (base) return base;
  // 最高价者不能弃权：弃权是从这场拍卖里脱身，而他已经是注定要付钱的人。
  // 允许的话，「把别人挤到弃权后再自己退场」会变成一条空手套白狼的路。
  if (state.auction!.highestBidderId === bidder!.id) return '已是最高出价者，不能弃权';
  return null;
}

function checkBailPrisoner(state: GameState, p: Player | null, action: ActionOf<'BAIL_PRISONER'>): ActionRefusal {
  if (state.phase !== 'awaiting_action') return '当前不能保释';
  if (!p) return NO_ACTOR_MESSAGE;
  if (cellAt(state, p.position).type !== 'jail') return '不在监狱门外，不能保释';
  const npc = state.npcs.find((n) => n.kind === action.npcKind);
  if (!npc) return '没有这名恶人';
  if (!npc.jailed) return '这名恶人不在押';
  if (p.points < bailFee(state)) return '点券不足以支付保释金';
  return null;
}

function checkDischargePatient(state: GameState, p: Player | null, action: ActionOf<'DISCHARGE_PATIENT'>): ActionRefusal {
  if (state.phase !== 'awaiting_action') return '当前不能办理出院';
  if (!p) return NO_ACTOR_MESSAGE;
  if (cellAt(state, p.position).type !== 'hospital') return '不在医院门外，不能办理出院';
  const target = state.players.find((q) => q.id === action.targetPlayerId);
  if (!target) return '病人不存在';
  if (target.id === p.id) return '不能为自己办理出院';
  if (target.custody?.kind !== 'hospital') return '该角色当前并未住院';
  if (p.cash < dischargeFee(state)) return '现金不足以支付出院费';
  return null;
}

function checkCastMagic(state: GameState, p: Player | null, action: ActionOf<'CAST_MAGIC'>): ActionRefusal {
  if (!state.magic) return '当前没有可施法的机会';
  if (state.phase !== 'awaiting_action') return '当前不能施法';
  if (!p) return NO_ACTOR_MESSAGE;
  // 没有「目标合法吗」这一问：玩家选的是魔法，落在谁头上由条件当场筛，含施法者本人（M-03/M-04）
  if (!MAGIC_EFFECT_ORDER.includes(action.effect)) return '魔法书上没有这一档';
  return null;
}

function checkSurrender(state: GameState, p: Player | null, action: ActionOf<'SURRENDER'>): ActionRefusal {
  if (!p) return NO_ACTOR_MESSAGE;
  if (state.phase === 'lobby' || state.phase === 'game_over') return '当前不能认输';
  if (p.bankrupt) return '已倒闭的玩家无需认输';
  const avenger = state.players.find((q) => q.id === action.revengeTargetId);
  if (!avenger) return '复仇者不存在';
  if (avenger.id === p.id) return '复仇者不能是认输者本人';
  if (avenger.bankrupt) return '复仇者已倒闭';
  return null;
}

function checkPostTrade(state: GameState, seller: Player | null, action: ActionOf<'POST_TRADE'>): ActionRefusal {
  return postTradeRefusal(state, seller, action);
}

function checkBuyTrade(state: GameState, buyer: Player | null, action: ActionOf<'BUY_TRADE'>): ActionRefusal {
  return buyTradeRefusal(state, buyer, action);
}

function checkCancelTrade(state: GameState, seller: Player | null, action: ActionOf<'CANCEL_TRADE'>): ActionRefusal {
  return cancelTradeRefusal(state, seller, action);
}

/**
 * 注册表本体：`ActionSpecMap` 是映射类型，少写一个动作就编译不过，
 * `applyAction` 因此不再需要 `default: never` 的穷举兜底。
 */
const ACTION_SPECS: ActionSpecMap = {
  START_GAME: { check: checkStartGame, apply: (s) => startGame(s) },
  ROLL_DICE: { check: checkRollDice, apply: (s, a) => rollDice(s, a) },
  BUY_LAND: { check: checkBuyLand, apply: (s) => buyLand(s) },
  UPGRADE_LAND: { check: checkUpgradeLand, apply: (s) => upgradeLand(s) },
  BUILD_FACILITY: { check: checkBuildFacility, apply: (s, a) => buildFacility(s, a) },
  START_RESEARCH: { check: checkStartResearch, apply: (s, a) => startResearch(s, a) },
  FINISH_LANDING: { check: checkFinishLanding, apply: (s) => finishLanding(s) },
  USE_CARD: { check: checkUseCard, apply: (s, a) => useCard(s, a) },
  BUY_CARD: { check: checkBuyCard, apply: (s, a) => buyCard(s, a) },
  DISCARD_CARD: { check: checkDiscardCard, apply: (s, a) => discardCard(s, a) },
  USE_ITEM: { check: checkUseItem, apply: (s, a) => useItem(s, a) },
  BUY_ITEM: { check: checkBuyItem, apply: (s, a) => buyItem(s, a) },
  SELL_CARD: { check: checkSellCard, apply: (s, a) => sellCard(s, a) },
  SELL_ITEM: { check: checkSellItem, apply: (s, a) => sellItem(s, a) },
  BUY_STOCK: { check: checkBuyStock, apply: (s, a) => buyStock(s, a) },
  SELL_STOCK: { check: checkSellStock, apply: (s, a) => sellStock(s, a) },
  MINIGAME_PICK: { check: checkMinigamePick, apply: (s, a) => minigamePick(s, a) },
  DEPOSIT: { check: checkDeposit, apply: (s, a) => depositMoney(s, a.amount) },
  WITHDRAW: { check: checkWithdraw, apply: (s, a) => withdrawMoney(s, a.amount) },
  TAKE_LOAN: { check: checkTakeLoan, apply: (s, a) => takeLoan(s, a.amount) },
  REPAY_LOAN: { check: checkRepayLoan, apply: (s, a) => repayLoan(s, a.amount) },
  BUY_SHARES: { check: checkBuyShares, apply: (s, a) => buyShares(s, a) },
  SELL_SHARES: { check: checkSellShares, apply: (s, a) => sellShares(s, a) },
  BUILD_ESTATE: { check: checkBuildEstate, apply: (s, a) => buildEstate(s, a) },
  SPECIAL_FINANCING: { check: checkSpecialFinancing, apply: (s, a) => specialFinancing(s, a) },
  BUY_LOTTERY_TICKET: { check: checkBuyLotteryTicket, apply: (s, a) => buyLotteryTicket(s, a) },
  AUCTION_BID: { check: checkAuctionBid, apply: (s, a) => auctionBid(s, a) },
  AUCTION_PASS: { check: checkAuctionPass, apply: (s) => auctionPass(s) },
  AUCTION_GIVE_UP: { check: checkAuctionGiveUp, apply: (s) => auctionGiveUp(s) },
  BAIL_PRISONER: { check: checkBailPrisoner, apply: (s, a) => bailPrisoner(s, a) },
  CAST_MAGIC: { check: checkCastMagic, apply: (s, a) => castMagic(s, a) },
  DISCHARGE_PATIENT: { check: checkDischargePatient, apply: (s, a) => dischargePatient(s, a) },
  SURRENDER: { check: checkSurrender, apply: (s, a) => surrender(s, a.revengeTargetId) },
  POST_TRADE: { check: checkPostTrade, apply: (s, a) => postTrade(s, a, currentPlayer(s), (t) => log(s, t)) },
  BUY_TRADE: { check: checkBuyTrade, apply: (s, a) => buyTrade(s, a, currentPlayer(s), (t) => log(s, t)) },
  CANCEL_TRADE: { check: checkCancelTrade, apply: (s, a) => cancelTrade(s, a, currentPlayer(s), (t) => log(s, t)) },
};

/** 唯一入口：应用玩家动作并返回新状态（纯函数，不修改传入状态） */export function applyAction(state: GameState, action: PlayerAction): GameState {
  const next = clone(state);
  // 注册表按 type 分派；`ActionSpecMap` 是映射类型，缺一个动作就编译不过
  const spec = ACTION_SPECS[action.type] as ActionSpec | undefined;
  if (!spec) {
    // 动作来自客户端消息，type 在运行时不受 TS 约束：给一句可读的拒绝，别丢 TypeError
    throw new Error(`未知动作: ${JSON.stringify(action)}`);
  }
  spec.apply(next, action);
  releaseSpawnCells(next);
  return next;
}

/**
 * 踏出出生格（SP-02）：谁离开了自己那格出生点，就把出生点解除掉 —— 之后绕回同一格
 * 是真「走到」的，买地 / 进店照常放行。放在 `applyAction` 一处收口，掷骰、传送、
 * 交换位置这几条会改 `position` 的路径就都覆盖到了。
 */
function releaseSpawnCells(state: GameState): void {
  for (const p of state.players) {
    if (p.spawnCell !== null && p.position !== p.spawnCell) p.spawnCell = null;
  }
}
