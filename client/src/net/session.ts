import type { ChatMessage } from './remote.js';
import { applyAction, createGame, normalizeGameState, type DateSerial, type GameState, type PlayerAction } from '@richman/shared';
import { getSettings } from '../game/settings.js';

/** 会话抽象：本地热座与联机共用同一套 UI */
export interface GameSession {
  getGame(): GameState;
  dispatch(action: PlayerAction): void;
  subscribe(fn: (game: GameState) => void): () => void;
  destroy(): void;
  /** 本人玩家 id；热座模式为 null（所有人共用一台设备轮流操作） */
  readonly myPlayerId: string | null;
  /** 联机房间码；热座为 undefined */
  readonly roomId?: string;
  /** 联机模式由房主触发开局 */
  startGame?(): void;
  /** 联机模式：向房间添加 AI 玩家 */
  addBot?(): void;
  /** 联机模式：服务器错误消息订阅 */
  onError?(fn: (message: string) => void): () => void;
  /** 联机模式：聊天 */
  sendChat?(text: string): void;
  onChat?(fn: (messages: ChatMessage[]) => void): () => void;
  /** 联机模式：连接状态变化 */
  onConnectionChange?(fn: (state: 'connected' | 'reconnecting' | 'closed') => void): () => void;
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
export function saveHotseatGame(game: GameState, slot = 'auto'): boolean {
  try {
    localStorage.setItem(`${AUTOSAVE_KEY}.${slot}`, JSON.stringify({ savedAt: Date.now(), game }));
    return true;
  } catch {
    return false;
  }
}

export function loadHotseatGame(slot = 'auto'): GameState | null {
  try {
    const raw = localStorage.getItem(`${AUTOSAVE_KEY}.${slot}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { game?: GameState };
    // 存档可能来自重构前的版本：补齐新增字段默认值，保证老档可继续玩且行为不变
    return parsed.game ? normalizeGameState(parsed.game) : null;
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

/** M1：本地热座会话（所有人共用一台设备轮流操作） */
export class LocalHotseatSession implements GameSession {
  private game: GameState;
  private listeners = new Set<(g: GameState) => void>();
  readonly myPlayerId = null;

  constructor(playerCount: number, seed = Date.now() % 2147483647, resume?: GameState | null) {
    if (resume) {
      // UI-03 读档：直接沿用存档状态
      this.game = resume;
      return;
    }
    const names = ['阿福', '小美', '大宝', '金宝'];
    const colors = [0xef5350, 0x42a5f5, 0x66bb6a, 0xffee58];
    const players = Array.from({ length: playerCount }, (_, i) => ({
      id: `local-${i}`,
      name: names[i]!,
      color: colors[i]!,
    }));
    this.game = applyAction(createGame(players, seed, { startDate: resolveStartDate() }), { type: 'START_GAME' });
  }

  getGame(): GameState {
    return this.game;
  }

  dispatch(action: PlayerAction): void {
    this.game = applyAction(this.game, action);
    // UI-12 自动存档：每回合（turn 变化）记录一次快照
    if (getSettings().autoSave) saveHotseatGame(this.game);
    for (const fn of this.listeners) fn(this.game);
  }

  subscribe(fn: (g: GameState) => void): () => void {
    this.listeners.add(fn);
    fn(this.game);
    return () => this.listeners.delete(fn);
  }

  destroy(): void {
    this.listeners.clear();
  }
}


