/** 棋盘格类型 */
export type CellType =
  | 'start'    // 起点：经过/停留发放薪水
  | 'property' // 地产：可购买/升级/收租
  | 'chance'   // 机会：抽卡片
  | 'tax'      // 缴税
  | 'hospital' // 医院：停留 1 回合
  | 'jail'     // 监狱：停留 2 回合
  | 'game'     // 游戏厅：三仙归洞猜杯小游戏
  | 'shop'     // 商店：购买卡片
  | 'bank'     // 银行/证交所：买卖股票
  | 'god'      // 神庙：召唤神仙附身
  | 'neutral'; // 中性格：暂无效果

/** 地产分区 */
export type PropertyGroup = 'residential' | 'commercial' | 'industrial' | 'tech' | 'coastal' | 'financial';

export interface BoardCell {
  id: number;
  type: CellType;
  name: string;
  /** 地产：购买价格 */
  price?: number;
  /** 地产：每级租金基数（租金 = grade * baseRent） */
  baseRent?: number;
  group?: PropertyGroup;
}

export interface PlayerProperty {
  cellId: number;
  /** 1=平地已购 2=小屋 3=大厦（级） */
  grade: 1 | 2 | 3;
}

/** 神仙附身状态 */
export interface GodStatus {
  godId: string;
  /** 剩余生效回合数（每次自己回合开始时 -1） */
  remainingTurns: number;
}

/** 创建玩家时的定义 */
export interface PlayerDef {
  id: string;
  name: string;
  color: number;
}

export interface Player {
  id: string;
  name: string;
  /** PixiJS 可用的 0xRRGGBB 颜色 */
  color: number;
  cash: number;
  position: number;
  properties: PlayerProperty[];
  /** 手持卡片（cardId 列表，上限 6 张） */
  cards: string[];
  /** 持股：stockId -> 数量 */
  stocks: Record<string, number>;
  /** 神仙附身状态 */
  god: GodStatus | null;
  /** 剩余跳过回合数（医院/监狱） */
  skipTurns: number;
  /** 行进方向：1=顺时针 -1=逆时针（转向卡改变） */
  direction: 1 | -1;
  /** 乌龟卡减速剩余次数（掷骰步数减半） */
  slowTurns: number;
  /** 免租剩余次数（经过他人地产免租） */
  freeRentTurns: number;
  bankrupt: boolean;
  online: boolean;
}

export type Phase =
  | 'lobby'        // 等待玩家加入/开始
  | 'awaiting_roll'    // 等待当前玩家掷骰
  | 'awaiting_action'  // 等待当前玩家决策（买地/卡片/股票/结束）
  | 'awaiting_pick'    // 小游戏进行中：等待猜杯
  | 'game_over';

/** 小游戏状态（游戏厅随机二选一） */
export interface MinigameState {
  kind: 'shells' | 'memory';
  /** shells：当前第几轮（0-2，共 3 轮） */
  round: 0 | 1 | 2;
  /** shells：每轮命中记录 */
  hits: boolean[];
  /** memory：8 张牌的图案（0-3 各两张，已洗牌） */
  symbols: number[];
  /** memory：当前翻开未配对的牌下标 */
  revealed: number[];
  /** memory：每张牌是否已配对消除 */
  matched: boolean[];
  /** memory：已用翻牌次数 */
  flips: number;
}

export interface LogEntry {
  turn: number;
  text: string;
}

export interface Stock {
  id: string;
  name: string;
  /** 当前股价 */
  price: number;
  /** 最近一次波动百分比（含新闻影响） */
  lastChangePct: number;
}

export interface StockMarket {
  stocks: Stock[];
}

export interface GameState {
  players: Player[];
  board: BoardCell[];
  currentPlayerIndex: number;
  phase: Phase;
  /** 最近一次掷骰结果（用于客户端走格子动画） */
  dice: [number, number] | null;
  turn: number;
  /** 回合数（每循环一圈 +1，股票随回合波动） */
  round: number;
  /** 确定性 RNG 状态（可回放/防作弊校验） */
  rngState: number;
  log: LogEntry[];
  winnerId: string | null;
  /** 股票市场 */
  stockMarket: StockMarket;
  /** 遥控骰子等效果锁定的下一次骰子点数 */
  pendingFixedDice: number | null;
  /** 路障所在格（其他玩家经过必须停下，锥筒随之消失） */
  roadblocks: number[];
  /** 进行中的小游戏 */
  minigame: MinigameState | null;
}

export type PlayerAction =
  | { type: 'START_GAME' }
  | { type: 'ROLL_DICE' }
  | { type: 'BUY_LAND' }
  | { type: 'UPGRADE_LAND' }
  | { type: 'END_TURN' }
  | { type: 'USE_CARD'; cardId: string; targetPlayerId?: string; stockId?: string; diceValue?: number }
  | { type: 'BUY_CARD'; cardId: string }
  | { type: 'BUY_STOCK'; stockId: string; quantity: number }
  | { type: 'SELL_STOCK'; stockId: string; quantity: number }
  | { type: 'MINIGAME_PICK'; hole: number };

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
  /** 当前阶段可使用的卡片 id 列表 */
  usableCards: string[];
}






