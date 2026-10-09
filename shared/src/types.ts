/**
 * 棋盘格类型（波 3 扩棋盘后覆盖文档 §9 全部 TILE-01..30 + TILE-31）。
 * 括号内为文档对标编号。
 */
export type CellType =
  | 'start'     // 起点：经过/停留发放薪水
  | 'property'  // TILE-01 空地/住宅用地：可购买、可加盖 5 级
  | 'commercial'// TILE-02 商业用地：首次只买地，再次走到可选 5 种建设
  | 'chance'    // TILE-17 机会/危险格：抽命运卡池（help[28]），并可能因违法事件坐牢
  | 'news'      // TILE-18 新闻格：触发新闻事件
  | 'free-card' // TILE-13 免费卡片格：免费获得一张卡片
  | 'points'    // TILE-14/15/16 点券格：+10/+30/+50 点券
  | 'lottery'   // TILE-19 乐透行：投注（波 6 开放开奖）
  | 'magic'     // TILE-11 魔法屋：女巫施法（波 8 开放）
  | 'treasure'  // TILE-31 宝箱：获得 500 点券（待验证格）
  | 'tax'       // 缴税格
  | 'hospital'  // TILE-09 医院：住院不能出门且丧失收租权
  | 'jail'      // TILE-10 监狱：坐牢失去自由
  | 'game'      // 游戏厅：小游戏
  | 'shop'      // TILE-12 卡片店/道具店
  | 'bank'      // TILE-08/26 银行：存取款；停留可贷款
  | 'god'       // 神庙：召唤神仙附身
  | 'company';  // TILE-20..30 公司企业（波 5 开放经营）

/** 地产分区（仅用于配色与展示） */
export type PropertyGroup = 'residential' | 'commercial' | 'industrial' | 'tech' | 'coastal' | 'financial';

/** 商业用地设施（EST-07：TILE-03..07） */
export type FacilityType = 'park' | 'mall' | 'hotel' | 'gas' | 'lab';

/** 公司企业类型（TILE-20..30 / CORP-03..13，波 5 开放经营） */
export type CompanyKind =
  | 'airline'    // TILE-20 航空公司
  | 'restaurant' // TILE-21 饭店
  | 'computer'   // TILE-22 电脑公司
  | 'insurance'  // TILE-23 保险公司
  | 'car'        // TILE-24 汽车公司
  | 'oil'        // TILE-25 石油公司
  | 'bank'       // TILE-26 银行（公司）
  | 'water'      // TILE-27 水力公司
  | 'power'      // TILE-28 电力公司
  | 'department' // TILE-29 百货公司
  | 'estate';    // TILE-30 房地产公司

export interface BoardCell {
  id: number;
  type: CellType;
  name: string;
  /** 地产/商业用地：购买价格（不含物价指数） */
  price?: number;
  /** 地产：每级租金基数（租金 = grade * baseRent，含指数） */
  baseRent?: number;
  group?: PropertyGroup;
  /** 银行细分：公立银行可存取款；证交所可买卖股票；企业银行归波 5 */
  bankKind?: 'public' | 'exchange' | 'corporate';
  /**
   * 所属路段（EST-03）：同路段的地产租金联合计算。
   * 取值 = 该连续同类地产段的起始格 id，如 `street-8`（8/9/10 号商业地）。
   */
  street?: string;
  /** 点券格发放点数（TILE-14/15/16） */
  pointsGain?: number;
  /** 公司格类型（TILE-20..30） */
  companyKind?: CompanyKind;
}

export interface PlayerProperty {
  cellId: number;
  /** 等级 1..5（EST-02：住宅可加盖 5 级；EST-07：商业建设除公园/加油站外 5 级） */
  grade: 1 | 2 | 3 | 4 | 5;
  /** 商业用地已建成的设施（EST-07）；为空表示只买了地 */
  facility?: FacilityType;
  /** 连锁店（EST-04）：改建卡改建而成，不能再加盖，租金按店面总数计算（EST-05） */
  chain?: boolean;
  /** NPC-04 窃取租金：该地最近一次收取到的租金（无人收租时为 null） */
  lastRent?: number | null;
}

/** 神仙附身状态（GOD-01..12：天数制，日切时递减） */
export interface GodStatus {
  godId: string;
  /** 剩余生效天数（每完成一整天 -1；期满按对偶规则转化或离开） */
  remainingDays: number;
}

/** 驻留在棋盘上的一尊神明（GOD 现身机制，W2） */
export interface BoardGod {
  /** `GODS[].id`；死神不参与随机现身（只由认输投降 / 魔法屋渠道降临） */
  godId: string;
  /** 驻留格（BOARD_SIZE 圈上的格号），玩家经过即附身 */
  cellId: number;
  /** 剩余驻留天数；日切递减，≤0 即离开并让对偶进入冷却 */
  ttlDays: number;
  /** 现身当天的 `elapsedDays` */
  bornDay: number;
}

/** 保险状态（ECON-07 / CORP-06）：强制签约，按天计时 */
export interface InsuranceStatus {
  /** 保险有效期剩余天数 */
  daysLeft: number;
}

/** 公司经营状态（CORP-01..13 / TILE-20..30，波 5） */
export interface CompanyState {
  kind: CompanyKind;
  /** 棋盘格 id */
  cellId: number;
  /** 股票面值（每股价格；不随物价指数变化） */
  sharePrice: number;
  /** 累积盈余：消费费用累积（可为负 = 负债），每月 15 号按持股比例分配 */
  surplus: number;
  /** 持股：playerId -> 股数 */
  shares: Record<string, number>;
  /** 现任董事长（最大持股 + 同票先到先得）；null = 经营权空缺 */
  chairmanId: string | null;
  /** 首次入股日（同票先到先得判定）：playerId -> elapsedDays */
  firstHeldDayIndex: Record<string, number>;
}

/** 创建玩家时的定义 */
export interface PlayerDef {
  id: string;
  name: string;
  color: number;
}

/** 公历日期（month 1-12），确定性回放的时间基线 */
export interface DateSerial {
  year: number;
  month: number;
  day: number;
}

/** 银行贷款状态（无利息，到期全额归还） */
export interface LoanStatus {
  /** 未还本金 */
  principal: number;
  takenAtDayIndex: number;
  /** elapsedDays >= dueDayIndex 时强制还清 */
  dueDayIndex: number;
}

/** 游戏日历：日期由「起始日期 + 流逝天数」全量派生 */
export interface GameCalendar {
  /** createGame 时捕获一次，之后不再读系统时钟 */
  start: DateSerial;
  /** 开局 0；每完成一整圈 +1 */
  elapsedDays: number;
}

/** 本回合银行访问权限，回合结束清空 */
export interface BankAccess {
  canDeposit: boolean;
  canLoan: boolean;
  cellId: number;
}

/** 同盟状态（CARD-29）：与指定玩家互不收租 */
export interface AllianceStatus {
  with: string;
  daysLeft: number;
}

/** 乐透投注单（ECON-08）：号码 + 投注者，每月 15 号开奖后清空 */
export interface LotteryTicket {
  playerId: string;
  number: number;
}

/** 拍卖触发源（ECON-13） */
export type AuctionTrigger =
  | 'bankrupt' // 有人倒闭，名下土地被拍卖
  | 'card'     // 拍卖卡（CARD-08）
  | 'event'    // 事件引发（EVT-03）
  | 'bank';    // 银行拍卖土地

/**
 * 拍卖会状态机（ECON-13）：有现金者可参与，价高者得。
 *
 * 轮询语义按原版（`docs/gameplay/GAP调研记录_2026-09-24.md` §1，官方 Wiki「拍賣」条目）：
 * **PASS 只是本轮让过、下一轮仍可加价；GIVE UP 才是退出本场拍卖**。所以这里同时记
 * 「在场竞买人」（`bidders`，弃权者移出）与「自上次出价以来让过的人」
 * （`passedSinceBid`）—— 只有一计的话，要么弃权者被反复轮到，要么让过一轮就再也回不来。
 */
export interface AuctionState {
  /** 被拍卖的土地格 id */
  cellId: number;
  /** 所得归属玩家 id；null = 归银行（倒闭清算 / 银行拍卖） */
  sellerId: string | null;
  trigger: AuctionTrigger;
  /** 仍在场的竞买人 id（按座位顺序；弃权者已移出，无现金者从不开拍） */
  bidders: string[];
  /** 当前轮到第几位竞买人 */
  turnIndex: number;
  /** 起拍价 */
  minBid: number;
  /** 当前最高价；0 表示尚无人出价 */
  highestBid: number;
  highestBidderId: string | null;
  /**
   * 自上次出价以来「本轮让过（PASS / GIVE UP）」的竞买人 id。
   * 除最高价者外，在场竞买人全都让过即收锤；尚无人出价时全体让过即流拍。
   */
  passedSinceBid: string[];
  /** 已弃权退出本场拍卖的竞买人 id（只为界面显示与复盘，判定一律看 `bidders`） */
  withdrawn: string[];
  /** 收锤后：'resume' 回到当前玩家的决策阶段；'advance' 继续推进回合 */
  afterComplete: 'resume' | 'advance';
}

/** 待开拍的拍卖标的（倒闭清算等一并入队，逐件开拍） */
export interface PendingAuction {
  cellId: number;
  sellerId: string | null;
  trigger: AuctionTrigger;
}

/** UI-06 公布栏可公开交易的标的种类 */
export type TradeKind = 'land' | 'stock' | 'card' | 'item';
/** 公布栏上的一条公开挂牌（help [11]「透過公佈欄，與其他的玩家公開的交易房地產、股票、卡片、道具」） */
export interface TradeListing {
  id: string;
  sellerId: string;
  kind: TradeKind;
  /** land：格号；stock：股票 id；card：卡片 id；item：道具 id */
  targetId: string;
  /** land：挂牌格号（冗余便于 UI 直接渲染）；其余为 0 */
  cellId: number;
  /** land：单价；stock：单价；card：单价；item：单价 */
  price: number;
  /** 挂牌时回合号（用于排序与过期判定） */
  postedTurn: number;
  /** 是否已被成交/撤下 */
  closed: boolean;
}

/** 成交记录（报表与日志用） */
export interface TradeRecord {
  listingId: string;
  sellerId: string;
  buyerId: string;
  kind: TradeKind;
  targetId: string;
  price: number;
  turn: number;
}

export interface Player {
  id: string;
  name: string;
  /** PixiJS 可用的 0xRRGGBB 颜色 */
  color: number;
  cash: number;
  /** 银行存款（月末结算利息；租金入账、可被动用于支付） */
  deposit: number;
  /** 点券（卡片/道具唯一货币，波 2 启用商店） */
  points: number;
  /** 当前贷款；null 表示无贷款 */
  loan: LoanStatus | null;
  /** 波 5 预留：各股票建仓成本，用于计算持股浮动盈亏 */
  stockCost?: Record<string, number>;
  position: number;
  properties: PlayerProperty[];
  /** 手持卡片（cardId 列表，上限 MAX_HAND_CARDS=15 张） */
  cards: string[];
  /** 持有道具：itemId -> 数量（每种上限 MAX_ITEM_COUNT=9） */
  items: Record<string, number>;
  /** 持股：stockId -> 数量 */
  stocks: Record<string, number>;
  /** 神仙附身状态 */
  god: GodStatus | null;
  /** 剩余跳过回合数（医院/监狱/冬眠/陷害） */
  skipTurns: number;
  /** 行进方向：1=顺时针 -1=逆时针（转向卡改变） */
  direction: 1 | -1;
  /** 停留卡（CARD-14）：下一次前进时停留在原地 */
  holdTurns: number;
  /** 丧失收租权剩余天数（坐牢/冬眠/梦游） */
  rentBlockedTurns: number;
  /** 梦游卡（CARD-16）剩余天数：丧失收租与买地权利 */
  sleepwalkTurns: number;
  /** 乌龟卡（CARD-30）剩余天数：一次只走一步 */
  turtleTurns: number;
  /** 工程车（ITEM-12）剩余回合：走到哪拆到哪 */
  bulldozerTurns: number;
  /** 研究所研发队列（EST-09/10）：进行中的项目与剩余天数；null 表示空闲 */
  research: { itemId: string; remainDays: number } | null;
  /** 骰子个数（1 默认；机车 2；汽车 3） */
  diceCount: number;
  /** 同盟状态 */
  alliance: AllianceStatus | null;
  /** 出国旅游剩余天数（CORP-03）：出国期间不能收租 */
  abroadTurns: number;
  /** 保险状态（ECON-07 / CORP-06） */
  insurance: InsuranceStatus | null;
  /** 企业银行董事长特别融资未还额（CORP-09）；0 表示无 */
  financing: number;
  /**
   * 在押/住院记录（EVT-01 事件 0–3 用）：区分「监狱」与「医院」以便延长或提前开释。
   * `skipTurns` 仍是真正的停留天数来源，本字段只做身份与剩余天数的记账。
   */
  custody: CustodyStatus | null;
  /**
   * 霉运状态（GOD-12 死神「一連串倒楣的事情」）：
   * 剩余天数与倍率。倍率 2 = 倒霉事**加倍**（认输投降后被指定为复仇者时进入）。
   * 期间所有负面事件（火星/水灾等）与租金倍增按此倍率放大；剩余天数归零自动清除。
   */
  unlucky: UnluckyStatus | null;
  bankrupt: boolean;
  online: boolean;
}

/** 霉运状态（GOD-12） */
export interface UnluckyStatus {
  /** 剩余天数 */
  daysLeft: number;
  /** 倒霉事倍率：1 = 正常，2 = 加倍（死神附身于复仇者时） */
  multiplier: number;
}

/** 在押 / 住院身份（EVT-01 事件 0–3） */
export interface CustodyStatus {
  kind: 'jail' | 'hospital';
  daysLeft: number;
}

/**
 * NPC 特殊单位（NPC-01..06，波 8）。
 * - 四大恶人（小偷/收保护费/行抢/窃取租金）：被玩家保释出狱后在路上活动，收益归保释人；
 * - 恶犬：随机在路上出没，步行者被咬伤住院，驾车者可将其撞跑。
 */
export interface NpcUnit {
  kind: 'thief' | 'protection' | 'robber' | 'rent-thief' | 'dog';
  /** 所在格 */
  position: number;
  /** 保释人 id；null 表示无主（在押待保释的恶人 / 无主恶犬） */
  ownerId: string | null;
  /** 剩余活动天数；<= 0 时自动离场 */
  daysLeft: number;
  /** 是否仍在监狱中待保释（四大恶人） */
  jailed: boolean;
}

export type Phase =
  | 'lobby'        // 等待玩家加入/开始
  | 'awaiting_roll'    // 等待当前玩家掷骰
  | 'awaiting_action'  // 等待当前玩家决策（买地/卡片/股票/结束）
  | 'awaiting_pick'    // 小游戏进行中：等待猜杯
  | 'awaiting_auction' // 拍卖会进行中：等待当前竞买人出价/放弃
  | 'awaiting_discard'  // ECON-12：手牌额满，等待玩家选择舍弃哪一张
  | 'game_over';

/**
 * 回合内子阶段（CORE-02 相位机的「回合流」那一半），与 `Phase` 正交：
 * `Phase` 表示**现在轮到谁做什么**（玩家可见、UI 门控用），
 * `TurnStage` 表示**当前这一回合走到第几步**（回合流程内部用）。
 *
 * 之所以新开一个字段而不是给 `Phase` 加值：420 个测试与全部 UI 门控都在断言 `Phase`，
 * 把「移动中」「落格中」塞进那条枚举会牵动全局。
 *
 * **禁止用 `TurnStage` 参与任何规则判定** —— 它是回合流程的**表现用**读数（动画、日志、
 * 调试面板），规则一旦读它，同一条规则就分裂成「按相位」与「按子阶段」两套口径，而这两套
 * 没有理由保持一致；外部状态缺这个键时（由 `normalizeGameState` 反推）也只是显示少一格，
 * 不该让局面随之改变。它只用于观测，以及供 AI / 托管判断回合位置。
 */
export type TurnStage = 'start' | 'roll' | 'move' | 'tile_resolve' | 'end';

/** 小游戏状态（游戏厅随机四选一：三仙归洞 / 记忆翻牌 / 七彩气球 / 企鹅挖宝） */
export interface MinigameState {
  kind: 'shells' | 'memory' | 'balloon' | 'penguin';
  /** shells/balloon/penguin：当前第几轮（0-2，共 3 轮） */
  round: 0 | 1 | 2;
  /** shells/balloon/penguin：每轮命中记录 */
  hits: boolean[];
  /** memory：8 张牌的图案（0-3 各两张，已洗牌） */
  symbols: number[];
  /** memory：当前翻开未配对的牌下标 */
  revealed: number[];
  /** memory：每张牌是否已配对消除 */
  matched: boolean[];
  /** memory：已用翻牌次数 */
  flips: number;
  /** balloon：本轮是否已踩到炸弹（提前结束，剩余轮次作废） */
  exploded?: boolean;
}

export interface LogEntry {
  turn: number;
  text: string;
}

/**
 * 一个交易日的 K 线（ECON-09/10 自定扩展，玩法文档 §3.4）。
 * 开=上一根收盘，收=当日成交价，高/低按振幅派生；量分「背景换手」与「玩家真实成交」两笔。
 */
export interface StockCandle {
  /** 该根对应的 `calendar.elapsedDays` */
  day: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** 当日成交量（股）= 背景量 + playerVolume */
  volume: number;
  /** 其中玩家真实成交的股数（买卖都计） */
  playerVolume: number;
}

export interface Stock {
  id: string;
  name: string;
  /** 当前股价 */
  price: number;
  /** 最近一次波动百分比（含新闻与冲击成本） */
  lastChangePct: number;
  /**
   * 流通股本（股）：冲击成本与背景成交量的分母。
   * 原版无此项，按「各支市值相当」定标 —— 大盘股同样一笔成交推动更小。
   */
  floatShares: number;
  /** 最近 `STOCK_CANDLE_LIMIT` 根日 K 线，末尾为当日（可能仍在增长） */
  candles: StockCandle[];
}

export interface StockMarket {
  stocks: Stock[];
}

/** 红卡/黑卡造成的涨跌停（CARD-24/25）；EVT-01 事件 26/27 的停牌（suspend）复用同一列表 */
export interface StockHalt {
  stockId: string;
  /** up=涨停板（不允许下跌） down=跌停板（不允许上涨） suspend=暂停交易（EVT-01 事件 26/27） */
  kind: 'up' | 'down' | 'suspend';
  daysLeft: number;
}

/** 涨价卡/查封卡对整条街的过路费修正（CARD-27/28） */
export interface RentEffect {
  kind: 'raise' | 'seal';
  daysLeft: number;
  cells: number[];
  /** 施加者（用于日志与解除同盟判定） */
  ownerId: string;
}

/** 定时炸弹（ITEM-04）：附身在玩家身上，走满步数后爆炸 */
export interface ActiveBomb {
  playerId: string;
  stepsLeft: number;
}

/** 时光机（ITEM-10）用的轻量回合快照 */
export interface RoundSnapshot {
  players: Array<{
    id: string;
    position: number;
    cash: number;
    deposit: number;
    properties: PlayerProperty[];
    stocks: Record<string, number>;
  }>;
}

export interface GameState {
  players: Player[];
  board: BoardCell[];
  currentPlayerIndex: number;
  phase: Phase;
  /** 回合内子阶段（见 `TurnStage` 的用途与限制） */
  turnStage: TurnStage;
  /** 最近一次掷骰结果（用于客户端走格子动画；骰子个数随机车/汽车变化） */
  dice: number[] | null;
  turn: number;
  /** 回合数（每循环一圈 +1，股票随回合波动） */
  round: number;
  /** 确定性 RNG 状态（可回放/防作弊校验） */
  rngState: number;
  log: LogEntry[];
  winnerId: string | null;
  /**
   * 本局如何收的场（CORE-04 / 玩法文档 §14 第 2 项）：
   * - `bankrupt`：对手全部破产，唯一存活者获胜（原版唯一结局）
   * - `daylimit`：打满 `maxDays` 天，按总资产排名结算（联机新增，长局收不了口的保险）
   * null 表示尚未结束。名次表由 UI 现算（`allAssetSummaries`），这里不另存一份。
   */
  endReason: 'bankrupt' | 'daylimit' | null;
  /** 天数上限（`null` = 不限）。到点由日切钩子收场，热座默认不限 */
  maxDays: number | null;
  /** 股票市场 */
  stockMarket: StockMarket;
  /** 遥控骰子等效果锁定的下一次骰子点数 */
  pendingFixedDice: number | null;
  /** 路障所在格（其他玩家经过必须停下，锥筒随之消失） */
  roadblocks: number[];
  /** 地雷所在格（ITEM-03：踩中住院 3 天） */
  mines: number[];
  /** 进行中的定时炸弹（ITEM-04） */
  bombs: ActiveBomb[];
  /** 红卡/黑卡造成的涨跌停列表 */
  stockHalts: StockHalt[];
  /** 涨价卡/查封卡对整条街的过路费修正 */
  rentEffects: RentEffect[];
  /** 上一回合开始时的轻量快照（时光机 ITEM-10 用） */
  lastRoundSnapshot: RoundSnapshot | null;
  /** 进行中的小游戏 */
  minigame: MinigameState | null;
  /** 游戏日历（时间系统基线） */
  calendar: GameCalendar;
  /** 开局单人初始资金（startGame 冻结，物价指数分母） */
  initialCashPerPlayer: number;
  /** 开局玩家人数（startGame 冻结，物价指数分母） */
  initialPlayerCount: number;
  /** 本回合银行访问权限（回合结束清空） */
  bankAccess: BankAccess | null;
  /** 乐透奖池（波 6 启用：罚金汇总 + 投注累加，每月 15 号开奖） */
  lotteryPool: number;
  /** 在售乐透投注单（每月 15 号开奖后清空） */
  lotteryTickets: LotteryTicket[];
  /** 进行中的拍卖会（ECON-13）；null 表示无 */
  auction: AuctionState | null;
  /** 待开拍的拍卖标的队列（倒闭清算等）；逐件开拍 */
  auctionQueue: PendingAuction[];
  /** 11 家公司企业的经营状态（CORP-01..13，波 5） */
  companies: CompanyState[];
  /** 新闻事件池游标（EVT-01：从该 id 起轮询，取第一条满足前提的事件） */
  newsCursor: number;
  /** 街道地价乘数（EVT-01 事件 6/14 永久生效）：street -> 乘数，缺省 1 */
  streetPriceFactors: Record<string, number>;
  /** 股市全面停牌剩余天数（EVT-01 事件 26）；> 0 时全市场不可交易 */
  stockHaltAllDays: number;
  /** 银行停止放款剩余天数（EVT-01 事件 22）；> 0 时不可贷款 */
  loanBanDays: number;
  /** NPC 特殊单位（NPC-01..06：四大恶人 + 恶犬） */
  npcs: NpcUnit[];
  /** TILE-11 魔法屋：女巫水晶球的当次施法机会（NPC-06）；null 表示无 */
  magic: MagicOffer | null;
  /**
   * GOD-01 土地公冷却（help [40]「隔月才會再出現」）：记录本局月份序号，
   * 同一自然月内不再随机到土地公；跨月后恢复可出现。为 0 表示尚未出现过。
   */
  landGodCooldownMonth: number;

  /**
   * 神明现身机制（GOD-01..12 / W2）：驻留在棋盘上的神明，最多 `GOD_MAX_ON_BOARD` 尊。
   * 空数组就是「此刻无人驻留」，开关本身在 `spawnGods`。
   */
  boardGods: BoardGod[];
  /**
   * 神明是否随机现身驻留（GOD 现身机制，W2）。新开的局默认开启。
   *
   * 关掉它的唯一用途是**测试隔离**：这条机制会在日切消耗 RNG 抽数，进而改变后续掷骰序列，
   * 所以断言固定骰子序列与逐日金额的测试文件都把它关掉（同 `pinIndexOne` 冻结物价指数）。
   */
  spawnGods: boolean;
  /** 对偶神的再现身冷却：`godPairKey(...)` → 该 `elapsedDays` 之前不得再现身 */
  godPairBanUntil: Record<string, number>;
  /** ECON-12：手牌额满时待玩家选择舍弃的卡片 id；null 表示无 */
  pendingCard: string | null;
  /** UI-06 公布栏：当前所有公开挂牌 */
  trades: TradeListing[];
  /** UI-06 成交记录（保留最近 50 条） */
  tradeHistory: TradeRecord[];
}

/** TILE-11 魔法屋：施法条件（决定候选受罚者） */
export type MagicCondition = 'all' | 'ahead' | 'behind' | 'vehicle' | 'landowner';

/** 四大恶人（NPC-01..04） */
export type VillainKind = 'thief' | 'protection' | 'robber' | 'rent-thief';

/** TILE-11 魔法屋：女巫的惩罚（诅咒）种类 */
export type CurseKind = 'fine' | 'jail' | 'hospital' | 'abroad' | 'lose-card';

/** TILE-11 魔法屋：女巫水晶球给出的当次施法机会 */
export interface MagicOffer {
  condition: MagicCondition;
  curse: CurseKind;
  /** 满足条件的候选受罚者 id 列表 */
  candidateIds: string[];
  /** fine 类诅咒金额（已按物价指数缩放） */
  amount: number;
  /** hospital / jail / abroad 类诅咒天数 */
  days: number;
}

/**
 * 支付用途。`'stock'` = ECON-09 买入股票的支出（钱进股市，不属于「意外损失」，不汇入乐透奖池）。
 * 无收款方且属于「运气/事件等意外损失」的支出会汇总进乐透奖池（见 `LOTTERY_PENALTY_REASONS`）。
 */
export type PayReason =
  | 'rent'
  | 'tax'
  | 'god'
  | 'news'
  | 'minigame'
  | 'loan'
  | 'card'
  | 'company'
  | 'financing'
  | 'stock'
  | 'other';

/** 可被免罪/嫁祸/复仇反制栈拦截的灾祸类型 */
export type DisasterKind = 'jail' | 'frame' | 'sleepwalk' | 'turtle';

export type PlayerAction =
  | { type: 'START_GAME' }
  | { type: 'ROLL_DICE'; diceCount?: number }
  | { type: 'BUY_LAND' }
  | { type: 'UPGRADE_LAND' }
  | { type: 'END_TURN' }
  | { type: 'USE_CARD'; cardId: string; targetPlayerId?: string; stockId?: string; diceValue?: number; cellId?: number; facility?: FacilityType }
  | { type: 'BUY_CARD'; cardId: string }
  | { type: 'DISCARD_CARD'; cardId: string }
  | { type: 'BUY_ITEM'; itemId: string }
  /** TILE-12：在商店把一张手牌变卖给商店，回收半价点券（点券产出渠道之一） */
  | { type: 'SELL_CARD'; cardId: string }
  /** TILE-12：在商店把一个道具变卖给商店，回收半价点券（点券产出渠道之一） */
  | { type: 'SELL_ITEM'; itemId: string }
  | { type: 'USE_ITEM'; itemId: string; targetPlayerId?: string; cellId?: number; diceValue?: number }
  | { type: 'BUILD_FACILITY'; facility: FacilityType }
  | { type: 'START_RESEARCH'; itemId: string }
  | { type: 'BUY_STOCK'; stockId: string; quantity: number }
  | { type: 'SELL_STOCK'; stockId: string; quantity: number }
  | { type: 'MINIGAME_PICK'; hole: number }
  | { type: 'DEPOSIT'; amount: number }
  | { type: 'WITHDRAW'; amount: number }
  | { type: 'TAKE_LOAN'; amount: number }
  | { type: 'REPAY_LOAN'; amount: number }
  /** CORP-01：认购公司股份（单次 ≤1000 张） */
  | { type: 'BUY_SHARES'; cellId: number; quantity: number }
  /** CORP-13：房地产公司任选一处加盖一层 */
  | { type: 'BUILD_ESTATE'; cellId: number }
  /** CORP-09：企业银行董事长特别融资 */
  | { type: 'SPECIAL_FINANCING'; amount: number }
  /** ECON-08：在乐透行自选号码投注（现金 1000） */
  | { type: 'BUY_LOTTERY_TICKET'; number: number }
  /** ECON-13：拍卖出价 */
  | { type: 'AUCTION_BID'; amount: number }
  /** ECON-13：拍卖本轮让过（下一轮仍可加价，原版的 PASS） */
  | { type: 'AUCTION_PASS' }
  /**
   * ECON-13：拍卖弃权 —— 退出本场拍卖，此后不再被轮到（原版的 GIVE UP）。
   * 与 PASS 是两条不同规则：合成一个按钮就会出现「想让过却被踢出局」，
   * 而拆开后才有可证明的收口 —— 弃权者移出 `bidders`，轮询人数单调递减。
   */
  | { type: 'AUCTION_GIVE_UP' }
  /** NPC-01..04：在监狱门外保释四大恶人（收益归保释人） */
  | { type: 'BAIL_PRISONER'; npcKind: VillainKind }
  /** TILE-11 魔法屋（NPC-06）：女巫施法，指定受罚者 */
  | { type: 'CAST_MAGIC'; targetPlayerId: string }
  /** TILE-09 医院（help [37]）：在医院门外替指定病人办理提前出院 */
  | { type: 'DISCHARGE_PATIENT'; targetPlayerId: string }
  /**
   * CORE-04 / UI-13：认输投降（help [13]「魔法屋的女巫會替您召喚死神，附身在您指定的人身上」）。
   * 认输者**指定**一位「复仇者」：死神附身于他——清空其全部卡片与道具、
   * 13 天霉运加倍（倒霉事按 2 倍放大）、当下即遭一笔「索命」损失；认输者本人干净退出。
   */
  | { type: 'SURRENDER'; revengeTargetId: string }
  /** UI-06 公布栏：挂出标的公开求售 */
  | { type: 'POST_TRADE'; kind: TradeKind; targetId: string; price: number }
  /** UI-06 公布栏：买下他人挂牌 */
  | { type: 'BUY_TRADE'; listingId: string }
  /** UI-06 公布栏：撤下自己的挂牌 */
  | { type: 'CANCEL_TRADE'; listingId: string };

/** 所有玩家动作的类型标签（共 34 个） */
export type ActionType = PlayerAction['type'];

/** 取某个动作的载荷类型 */
export type ActionOf<T extends ActionType> = Extract<PlayerAction, { type: T }>;

/**
 * 动作校验结果：`null` = 允许执行；字符串 = 拒绝理由。
 * 字符串的内容就是引擎 `throw new Error(...)` 的原文 —— 两者必须是同一份文本。
 */
export type ActionRefusal = string | null;

/**
 * 动作规格：**校验与执行成对同处**（重构波 R3 的核心结构改动）。
 *
 * 为什么：此前门控（`availableActions`，决定按钮可点）与引擎校验（各动作函数开头的
 * `if (…) throw`）是**两套并行实现的同一套规则**。加一个动作要改两处，两处一漂移就
 * 出现「按钮能点、引擎报错」—— golden 基线里记录在案的那批被吞错误正是这个 bug 类。
 * 现在 `availableActions` 的每个布尔位都由 `check` 派生，结构上不可能再分叉；
 * `apply` 自己在入口调用 `check` 并抛错，所以引擎侧仍然不可被绕过。
 *
 * `actor`：该动作的实际操作者。拍卖中是轮到的竞买人（未必是当前玩家），
 * 大厅阶段可能尚无玩家（传 null），其余动作用当前玩家。
 */
export interface ActionSpec<A extends PlayerAction = PlayerAction> {
  check(state: GameState, actor: Player | null, action: A): ActionRefusal;
  apply(state: GameState, action: A): void;
}

/** 动作注册表类型：少注册一个动作就编译不过 */
export type ActionSpecMap = { [A in PlayerAction as A['type']]: ActionSpec<A> };

/** 可用动作集合（UI 按此渲染按钮） */
export interface AvailableActions {
  canRoll: boolean;
  canBuy: boolean;
  canUpgrade: boolean;
  canEnd: boolean;
  canShop: boolean;
  canTradeStock: boolean;
  /** 小游戏猜杯可用 */
  canPick: boolean;
  /** 银行可存款 */
  canDeposit: boolean;
  /** 银行可取款 */
  canWithdraw: boolean;
  /** 银行可贷款 */
  canLoan: boolean;
  /** 可提前还贷 */
  canRepayLoan: boolean;
  /** 今天为例假日（股市/银行休市） */
  isHoliday: boolean;
  /** CORP-01：站立于公司格可认购股份 */
  canBuyShares: boolean;
  /** 当前公司股票面值（非公司格为 0） */
  sharePrice: number;
  /** 单次认购上限（股数；受现金与 MAX_SHARES_PER_BUY 约束） */
  shareQuantityLimit: number;
  /** CORP-13：房地产公司可加盖 */
  canBuildEstate: boolean;
  /** CORP-13：可加盖的自有地产格 id 列表 */
  estateBuildCells: number[];
  /** CORP-09：企业银行董事长可特别融资 */
  canFinancing: boolean;
  /** CORP-09：特别融资剩余可周转额度 */
  financingRemaining: number;
  /** 站上自有商业用地（已购地未建设）时可建设的设施（EST-07） */
  buildableFacilities: FacilityType[];
  /** 站上自有研究所时可立项的研发项目（EST-10） */
  researchableItems: string[];
  /** 当前阶段可使用的卡片 id 列表 */
  usableCards: string[];
  /** 当前阶段可使用的道具 id 列表 */
  usableItems: string[];
  /** ECON-08：站立于乐透行可自选号码投注 */
  canBuyLottery: boolean;
  /** ECON-08：单注价格（现金） */
  lotteryTicketCost: number;
  /** ECON-13：进行中的拍卖会（无则 null，UI 据此渲染竞价面板） */
  auction: AuctionState | null;
  /**
   * ECON-13：下一次出价的最低金额（起拍价或「当前价 + 最小加价」）。
   * 由与引擎校验同一个的 `nextBidAmount` 得出 —— 面板自己算加价就会跟校验漂移。
   * 无拍卖进行时为 0。
   */
  auctionMinBid: number;
  /** ECON-13：本轮让过（PASS）—— 下一轮仍可加价 */
  canAuctionPass: boolean;
  /** ECON-13：弃权退出本场拍卖（GIVE UP）；当前最高价者不可弃权 */
  canAuctionGiveUp: boolean;
  /** NPC-01..04：站立于监狱门外时可保释的在押恶人种类 */
  bailableVillains: VillainKind[];
  /** NPC-01..04：保释金（现金，已按物价指数缩放） */
  bailFee: number;
  /** TILE-11：当前魔法屋施法机会（无则 null，UI 据此渲染女巫面板） */
  magic: MagicOffer | null;
  /** TILE-09 医院门外可办理出院的住院病人 id 列表（help [37]） */
  dischargeablePatients: string[];
  /** TILE-09：办理提前出院的费用（固定金额，已按物价指数缩放） */
  dischargeFee: number;
  /** CORE-04：当前是否可认输投降（对局进行中且自己尚未倒闭） */
  canSurrender: boolean;
  /** ECON-12：待舍弃的卡片 id（非 null 时 phase 为 awaiting_discard，UI 渲染舍弃弹窗） */
  pendingCard: string | null;
  /** UI-06：当前玩家可挂出的标的（_owned 且未挂牌），UI 据此渲染「我要挂出」 */
  tradableAssets: Array<{ kind: TradeKind; targetId: string; label: string; suggestPrice: number }>;
  /** UI-06：当前玩家现金（决定能否买入） */
  tradeCash: number;
  /** UI-13：认输时可指定的复仇者候选（存活且非自己）；不可认输时为空 */
  revengeCandidates: Player[];
}
