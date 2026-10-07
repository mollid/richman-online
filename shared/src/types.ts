/** 棋盘格类型 */
export type CellType =
  | 'start'    // 起点：经过/停留发放薪水
  | 'property' // 地产：可购买/升级/收租
  | 'chance'   // 机会：随机现金事件（后续版本替换为卡片系统）
  | 'tax'      // 缴税
  | 'hospital' // 医院：停留 1 回合
  | 'jail'     // 监狱：停留 2 回合
  | 'neutral'; // 中性格：银行/公园等，暂无效果

/** 地产分区（同分区后续可做垄断加成） */
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

export interface Player {
  id: string;
  name: string;
  /** PixiJS 可用的 0xRRGGBB 颜色 */
  color: number;
  cash: number;
  position: number;
  properties: PlayerProperty[];
  /** 剩余跳过回合数（医院/监狱） */
  skipTurns: number;
  bankrupt: boolean;
  online: boolean;
}

export type Phase =
  | 'lobby'        // 等待玩家加入/开始
  | 'awaiting_roll'    // 等待当前玩家掷骰
  | 'awaiting_action'  // 等待当前玩家决策（买地/升级/结束）
  | 'game_over';

export interface LogEntry {
  turn: number;
  text: string;
}

export interface GameState {
  players: Player[];
  board: BoardCell[];
  currentPlayerIndex: number;
  phase: Phase;
  /** 最近一次掷骰结果（用于客户端走格子动画） */
  dice: [number, number] | null;
  turn: number;
  /** 确定性 RNG 状态（可回放/防作弊校验） */
  rngState: number;
  log: LogEntry[];
  winnerId: string | null;
}

export type PlayerAction =
  | { type: 'START_GAME' }
  | { type: 'ROLL_DICE' }
  | { type: 'BUY_LAND' }
  | { type: 'UPGRADE_LAND' }
  | { type: 'END_TURN' };
