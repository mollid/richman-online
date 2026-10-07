import { Client, type Room } from 'colyseus.js';
import { availableActions, type GameState, type PlayerAction } from '@richman/shared';
import type { GameSession } from './session.js';

export interface RemoteSnapshot {
  game: GameState;
  actions: ReturnType<typeof availableActions>;
}

export interface ChatMessage {
  fromId: string;
  fromName: string;
  text: string;
}

export type ConnectionState = 'connected' | 'reconnecting' | 'closed';

export interface RoomSummary {
  roomId: string;
  players: number;
  maxPlayers: number;
  phase: string;
}

const STORAGE_KEY = 'richman.session';

function serverUrl(): string {
  const envUrl = (import.meta.env?.VITE_SERVER_URL as string | undefined) ?? undefined;
  return envUrl ?? `ws://${window.location.hostname}:2567`;
}

/** M3/M4：联机会话（连接 Colyseus 权威服务器，接收快照广播） */
export class ColyseusSession implements GameSession {
  private client: Client;
  private room: Room<unknown>;
  private game: GameState;
  private chatHistory: ChatMessage[] = [];
  private listeners = new Set<(g: GameState) => void>();
  private messageHandlers = new Set<(message: string) => void>();
  private chatHandlers = new Set<(messages: ChatMessage[]) => void>();
  private connectionHandlers = new Set<(state: ConnectionState) => void>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private manuallyClosed = false;
  private playerName: string;

  constructor(room: Room<unknown>, playerName: string, initialGame: GameState) {
    this.client = new Client(serverUrl());
    this.room = room;
    this.playerName = playerName;
    this.game = initialGame;
    this.attachRoom(room);
    this.persistSession();
  }

  /** 创建或加入房间并建立会话 */
  static async connect(opts: { playerName: string; roomId?: string; seed?: number }): Promise<ColyseusSession> {
    const client = new Client(serverUrl());
    const token = localStorage.getItem('richman.token') ?? undefined;
    const room = opts.roomId
      ? await client.joinById(opts.roomId, { name: opts.playerName, token })
      : await client.create('game', { name: opts.playerName, seed: opts.seed, token });
    return new ColyseusSession(room, opts.playerName, emptyState());
  }

  /** 页面刷新后恢复上次对局（利用 Colyseus 重连令牌） */
  static async resumeLast(): Promise<ColyseusSession | null> {
    const saved = readSavedSession();
    if (!saved) return null;
    try {
      const client = new Client(serverUrl());
      const room = await client.reconnect(saved.token);
      return new ColyseusSession(room, saved.name, emptyState());
    } catch {
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }
  }

  /** 获取大厅阶段的公开房间列表（Colyseus matchmake HTTP 接口） */
  static async listRooms(): Promise<RoomSummary[]> {
    const base = serverUrl().replace(/^ws/, 'http');
    const res = await fetch(`${base}/api/rooms`);
    if (!res.ok) throw new Error(`获取房间列表失败 (${res.status})`);
    const rooms = (await res.json()) as Array<{
      roomId: string;
      clients: number;
      maxClients: number;
      metadata?: { phase?: string; players?: number; maxPlayers?: number };
    }>;
    return rooms
      .filter((r) => r.metadata?.phase === 'lobby')
      .map((r) => ({
        roomId: r.roomId,
        players: r.metadata?.players ?? r.clients,
        maxPlayers: r.metadata?.maxPlayers ?? r.maxClients,
        phase: 'lobby',
      }));
  }

  private attachRoom(room: Room<unknown>): void {
    this.room = room;

    room.onMessage<RemoteSnapshot>('state', (snapshot) => {
      this.game = snapshot.game;
      for (const fn of this.listeners) fn(this.game);
    });

    room.onMessage<{ message: string }>('error', (message) => {
      for (const fn of this.messageHandlers) fn(message.message);
    });

    room.onMessage<ChatMessage>('chat', (message) => {
      this.chatHistory = [...this.chatHistory.slice(-49), message];
      for (const fn of this.chatHandlers) fn(this.chatHistory);
    });

    room.onLeave(() => {
      if (this.manuallyClosed) {
        this.notifyConnection('closed');
        return;
      }
      this.notifyConnection('reconnecting');
      this.scheduleReconnect();
    });

    room.onError(() => {
      if (!this.manuallyClosed) {
        this.notifyConnection('reconnecting');
        this.scheduleReconnect();
      }
    });

    room.send('get_state', {});
    this.notifyConnection('connected');
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.manuallyClosed) return;
    if (this.reconnectAttempts >= 10) {
      this.notifyConnection('closed');
      localStorage.removeItem(STORAGE_KEY);
      return;
    }
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      const saved = readSavedSession();
      if (!saved || this.manuallyClosed) return;
      try {
        const room = await this.client.reconnect(saved.token);
        this.reconnectAttempts = 0;
        if (!this.manuallyClosed) {
          this.attachRoom(room);
          this.persistSession();
        } else {
          void room.leave(true);
        }
      } catch {
        this.reconnectAttempts += 1;
        this.notifyConnection('reconnecting');
        this.scheduleReconnect();
      }
    }, 3000);
  }

  private notifyConnection(state: ConnectionState): void {
    for (const fn of this.connectionHandlers) fn(state);
  }

  private persistSession(): void {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ token: this.room.reconnectionToken, name: this.playerName }),
      );
    } catch {
      // localStorage 不可用时忽略
    }
  }

  get myPlayerId(): string | null {
    return this.room.sessionId;
  }

  get roomId(): string {
    return this.room.roomId;
  }

  getGame(): GameState {
    return this.game;
  }

  getChatHistory(): ChatMessage[] {
    return this.chatHistory;
  }

  sendChat(text: string): void {
    this.room.send('chat', { text });
  }

  dispatch(action: PlayerAction): void {
    this.room.send('action', { action });
  }

  startGame(): void {
    this.room.send('start_game', {});
  }

  addBot(): void {
    this.room.send('add_bot', {});
  }

  onError(fn: (message: string) => void): () => void {
    this.messageHandlers.add(fn);
    return () => this.messageHandlers.delete(fn);
  }

  onChat(fn: (messages: ChatMessage[]) => void): () => void {
    this.chatHandlers.add(fn);
    fn(this.chatHistory);
    return () => this.chatHandlers.delete(fn);
  }

  onConnectionChange(fn: (state: ConnectionState) => void): () => void {
    this.connectionHandlers.add(fn);
    return () => this.connectionHandlers.delete(fn);
  }

  subscribe(fn: (g: GameState) => void): () => void {
    this.listeners.add(fn);
    fn(this.game);
    return () => this.listeners.delete(fn);
  }

  destroy(): void {
    this.manuallyClosed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.listeners.clear();
    this.chatHandlers.clear();
    this.connectionHandlers.clear();
    localStorage.removeItem(STORAGE_KEY);
    void this.room.leave(true);
  }
}

function emptyState(): GameState {
  return {
    players: [],
    board: [],
    currentPlayerIndex: 0,
    phase: 'lobby',
    dice: null,
    turn: 0,
    round: 1,
    rngState: 0,
    log: [{ turn: 0, text: '正在同步房间状态…' }],
    winnerId: null,
    stockMarket: { stocks: [] },
    pendingFixedDice: null,
    roadblocks: [],
    mines: [],
    bombs: [],
    stockHalts: [],
    rentEffects: [],
    lastRoundSnapshot: null,
    minigame: null,
    calendar: { start: { year: 1980, month: 1, day: 1 }, elapsedDays: 0 },
    initialCashPerPlayer: 15000,
    initialPlayerCount: 0,
    bankAccess: null,
    lotteryPool: 0,
  };
}

/** 是否存在可恢复的会话（页面刷新后回到上次对局） */
export function hasSavedSession(): boolean {
  return readSavedSession() !== null;
}

function readSavedSession(): { token: string; name: string } | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { token?: string; name?: string };
    if (!parsed.token || !parsed.name) return null;
    return { token: parsed.token, name: parsed.name };
  } catch {
    return null;
  }
}






