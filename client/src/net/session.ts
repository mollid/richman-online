import type { ChatMessage } from './remote.js';
import type { ReplayRecord } from './auth.js';
import {
  actingPlayerId,
  applyAction,
  autoSkipAction,
  availableActions,
  botDecide,
  characterById,
  characterOfSeat,
  createGame,
  nextRandom,
  normalizeGameState,
  type DateSerial,
  type GameState,
  type PlayerAction,
} from '@richman/shared';
import { getSettings } from '../game/settings.js';

/** 会话抽象：本地热座与联机共用同一套 UI */
export interface GameSession {
  getGame(): GameState;
  dispatch(action: PlayerAction): void;
  subscribe(fn: (game: GameState) => void): () => void;
  destroy(): void;
  /** 本人玩家 id；热座模式为 null（所有人共用一台设备轮流操作） */
  readonly myPlayerId: string | null;
  /**
   * 由会话层自己代打的座位 id（单人模式里的 AI）。
   * UI 用它把这些座位的操作按钮灰掉 —— 少了这一层，热座里的人会替 AI 掷骰，
   * 而引擎只认「轮到谁」，不认「谁在点」。
   */
  readonly autoPlayerIds?: ReadonlySet<string>;
  /** 联机房间码；热座为 undefined */
  readonly roomId?: string;
  /** 联机模式由房主触发开局 */
  startGame?(): void;
  /** 联机模式：向房间添加 AI 玩家 */
  addBot?(): void;
  /** 联机大厅：准备 / 取消准备 */
  setReady?(ready: boolean): void;
  /** 联机大厅：换角色。服务端换完会把自己退回未准备 */
  setCharacter?(characterId: string): void;
  /** 联机大厅：房主把某人请出房间（凭房间码还能再进来，不是封禁） */
  kick?(playerId: string): void;
  /** 联机模式：服务器错误消息订阅 */
  onError?(fn: (message: string) => void): () => void;
  /** 单人模式：把当前局面写进浏览器存档（联机局由服务端 authoritative，不给） */
  saveToBrowser?(): boolean;
  /** 单人模式：拼一份本局回放（只在终局有意义，联机局不上云所以也不给） */
  toReplayRecord?(): ReplayRecord;
  /** 联机模式：聊天 */
  sendChat?(text: string): void;
  onChat?(fn: (messages: ChatMessage[]) => void): () => void;
  /** 联机模式：连接状态变化 */
  onConnectionChange?(fn: (state: 'connected' | 'reconnecting' | 'closed' | 'kicked') => void): () => void;
}

/** UI-12 自动存档的 localStorage 键（每回合记录一次快照） */
const AUTOSAVE_KEY = 'richman.autosave';

/** 起始日期：优先取 OPTION 设置（TIME-06），缺省用系统日期 */
function resolveStartDate(): DateSerial {
  const configured = getSettings().startDate;
  if (configured) {
    return { year: configured.year, month: configured.month, day: configured.day };
  }
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
}

/** UI-03 存储 / 读取：热座模式的对局存档接口 */
export interface HotseatSave {
  game: GameState;
  /** 动作日志跟着存档一起走：不带它的话，读档续玩的那一局收工时只剩后半段回放 */
  actions: Array<{ turn: number; action: PlayerAction }>;
}

export function saveHotseatGame(game: GameState, actions: HotseatSave['actions'] = [], slot = 'auto'): boolean {
  try {
    localStorage.setItem(`${AUTOSAVE_KEY}.${slot}`, JSON.stringify({ savedAt: Date.now(), game, actions }));
    return true;
  } catch {
    return false;
  }
}

export function loadHotseatGame(slot = 'auto'): HotseatSave | null {
  try {
    const raw = localStorage.getItem(`${AUTOSAVE_KEY}.${slot}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { game?: GameState; actions?: HotseatSave['actions'] };
    if (!parsed.game) return null;
    // 存档可能来自重构前的版本：补齐新增字段默认值，保证老档可继续玩且行为不变
    return { game: normalizeGameState(parsed.game), actions: parsed.actions ?? [] };
  } catch {
    return null;
  }
}

export function clearHotseatGame(slot = 'auto'): void {
  try {
    localStorage.removeItem(`${AUTOSAVE_KEY}.${slot}`);
  } catch {
    /* 忽略存储异常 */
  }
}

/** M1：本地热座会话（真人座位共用一台设备轮流操作，AI 座位由会话层代打） */
/** 单人开局时的一个座位：角色 + 由谁操作 */
export interface HotseatSeat {
  characterId: string;
  /** `'bot'` 的座位不进人类操作队列，改由 `botDecide` 自动行动 */
  kind: 'human' | 'bot';
}

export interface HotseatOptions {
  /** 座位序即数组下标；`resume` 分支不读它，所以读档时可以不给 */
  seats?: HotseatSeat[];
  seed?: number;
  maxDays?: number | null;
  mapId?: number | null;
  initialCash?: number | null;
  /** UI-03 读档：直接沿用存档状态与它自带的动作日志，其余建局参数忽略 */
  resume?: HotseatSave | null;
}

export class LocalHotseatSession implements GameSession {
  private game: GameState;
  private listeners = new Set<(g: GameState) => void>();
  /** 停留态（在押 / 住院 / 出国）自动跳过回合的定时；与联机 GameRoom 用同一份判据 */
  private autoSkipTimer: ReturnType<typeof setTimeout> | null = null;
  /** AI 座位的局内 id：联机那侧同样以 `bot-` 前缀认，读档回来也不用另存一张表 */
  private readonly botIds = new Set<string>();
  private botTimer: ReturnType<typeof setTimeout> | null = null;
  private botRngState = 1;
  /**
   * 本局动作日志（含 START_GAME）：单人局不上云，收工时用它拼一份回放塞进浏览器本地。
   * 与联机那侧同一份形状，所以 `ReplayEngine` 不必为单人另开一条路。
   */
  private actionLog: Array<{ turn: number; action: PlayerAction }> = [];
  /** 这些座位不由本设备操作 —— UI 据此把按钮灰掉，免得替 AI 掷骰 */
  readonly autoPlayerIds: ReadonlySet<string> = this.botIds;
  readonly myPlayerId = null;

  constructor(opts: HotseatOptions) {
    if (opts.resume) {
      this.game = opts.resume.game;
      this.actionLog = [...opts.resume.actions];
      for (const p of this.game.players) if (p.id.startsWith('bot-')) this.botIds.add(p.id);
      this.botRngState = this.game.seed >>> 0;
      return;
    }
    const seed = opts.seed ?? Date.now() % 2147483647;
    // 座位号即数组下标：AI 用 `bot-<座位>`、真人用 `local-<座位>`，
    // 名字跟着角色走（`characters.ts` 是唯一出处），AI 前缀与联机的「AI·角色名」同一套口径。
    const players = (opts.seats ?? []).map((seat, i) => {
      const ch = characterById(seat.characterId) ?? characterOfSeat(i);
      return {
        id: `${seat.kind === 'bot' ? 'bot' : 'local'}-${i}`,
        name: seat.kind === 'bot' ? `AI·${ch.name}` : ch.name,
        color: ch.color,
        characterId: ch.id,
      };
    });
    for (const p of players) if (p.id.startsWith('bot-')) this.botIds.add(p.id);
    this.botRngState = seed >>> 0;
    // CORE-04 / §14 第 2 项：热座默认不限天数（结束条件仍只有「对手全破产」），上限由开局面板选
    this.game = applyAction(
      createGame(players, seed, {
        startDate: resolveStartDate(),
        maxDays: opts.maxDays ?? null,
        mapId: opts.mapId ?? null,
        initialCash: opts.initialCash ?? null,
      }),
      { type: 'START_GAME' },
    );
    this.actionLog.push({ turn: this.game.turn, action: { type: 'START_GAME' } });
  }

  /**
   * 本局回放数据（单人局只落浏览器，不上云）。
   * 形状与服务端 `/api/records/*` 下发的完全一致，所以播放器与「我的回放」列表不必分两种。
   */
  toReplayRecord(): ReplayRecord {
    return {
      id: `local-${this.game.seed}-${this.game.turn}`,
      room_id: '单人模式',
      winner_name: this.game.players.find((p) => p.id === this.game.winnerId)?.name ?? null,
      player_count: this.game.players.length,
      turns: this.game.turn,
      rounds: this.game.round,
      finished_at: new Date().toISOString(),
      players: this.game.players.map((p) => ({
        player_name: p.name,
        color: p.color,
        cash: p.cash,
        bankrupt: p.bankrupt,
        player_key: p.id,
        character_id: p.characterId,
      })),
      seed: this.game.seed,
      start_date: this.game.calendar.start,
      max_days: this.game.maxDays,
      map_id: this.game.mapId,
      initial_cash: this.game.initialCashPerPlayer,
      actions: this.actionLog,
    };
  }

  getGame(): GameState {
    return this.game;
  }

  /** UI-03 手动存档：连同动作日志一起落盘，读档续玩的那局才还拼得出完整回放 */
  saveToBrowser(): boolean {
    return saveHotseatGame(this.game, this.actionLog, 'auto');
  }

  dispatch(action: PlayerAction): void {
    this.game = applyAction(this.game, action);
    this.actionLog.push({ turn: this.game.turn, action });
    // UI-12 自动存档：每回合（turn 变化）记录一次快照
    if (getSettings().autoSave) saveHotseatGame(this.game, this.actionLog);
    for (const fn of this.listeners) fn(this.game);
    this.scheduleAutoSkip();
    this.scheduleBotAct();
  }

  subscribe(fn: (g: GameState) => void): () => void {
    this.listeners.add(fn);
    fn(this.game);
    // 读档进来的那一局可能正停在牢里：一挂上就把自动跳过排上
    this.scheduleAutoSkip();
    this.scheduleBotAct();
    return () => this.listeners.delete(fn);
  }

  destroy(): void {
    if (this.autoSkipTimer) clearTimeout(this.autoSkipTimer);
    this.autoSkipTimer = null;
    if (this.botTimer) clearTimeout(this.botTimer);
    this.botTimer = null;
    this.listeners.clear();
  }

  /**
   * 停留态（在押 / 住院 / 出国）的回合由会话层替他走完。判据与联机那侧同源（`autoSkipAction`），
   * 两边各写一套迟早漂移。1.2 秒只够读完「🚔 在押中，本回合自动跳过」那条播报 ——
   * 再长就开始让人觉得卡住了。
   */
  private scheduleAutoSkip(): void {
    if (this.autoSkipTimer) clearTimeout(this.autoSkipTimer);
    if (!autoSkipAction(this.game)) return;
    this.autoSkipTimer = setTimeout(() => {
      this.autoSkipTimer = null;
      // 到点再对一次表：这一瞬间玩家可能已经自己把窗关掉了，照旧发就会吃一句「当前不在落格决策中」
      const action = autoSkipAction(this.game);
      if (action) this.dispatch(action);
    }, 1200);
  }

  /**
   * 轮到 AI 座位时安排它出手。判据与节奏照联机那侧（`GameRoom.maybeScheduleBotAct`）：
   * 700ms 只够看清名牌亮了一下，再长就成了「卡住了」。
   */
  private scheduleBotAct(): void {
    if (this.botTimer) return;
    if (this.game.phase === 'game_over') return;
    const actingId = actingPlayerId(this.game);
    if (!actingId || !this.botIds.has(actingId)) return;
    this.botTimer = setTimeout(() => {
      this.botTimer = null;
      this.botAct(actingId);
    }, 700);
  }

  private botAct(actingId: string): void {
    if (this.game.phase === 'game_over') return;
    if (actingPlayerId(this.game) !== actingId) return;
    // 停留态交给 `scheduleAutoSkip` 走完：让 AI 去撞那些被引擎拒绝的动作，
    // 只会抛在这条定时里 —— 抛了就没有下一次 dispatch，这一局就此冻住。
    if (autoSkipAction(this.game)) return;
    const rng = () => {
      const draw = nextRandom(this.botRngState);
      this.botRngState = draw.nextState;
      return draw.value;
    };
    // AI 在落格窗里可以真的「什么都不想做」（`botDecide` 返回 null）。那时必须替它离开这一格，
    // 否则窗口不会自己关，而这一手没有 dispatch 也就排不出下一次定时。
    const action =
      botDecide(this.game, actingId, rng) ??
      (availableActions(this.game).canFinishLanding ? ({ type: 'FINISH_LANDING' } as PlayerAction) : null);
    if (!action) return;
    try {
      this.dispatch(action);
    } catch {
      // 决策与规则冲突时降级为走出落格窗，避免 AI 卡死（同上一条：窗口是唯一的出口）
      if (this.game.phase === 'awaiting_action') this.dispatch({ type: 'FINISH_LANDING' } as PlayerAction);
    }
  }
}


