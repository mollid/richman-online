import { Client, type Room } from 'colyseus.js';
import { availableActions, normalizeGameState, type GameState, type PlayerAction } from '@richman/shared';
import type { GameSession } from './session.js';
import { getSettings } from '../game/settings.js';

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
  /** 距这房「最后一个玩家真的发了消息」过了多久。服务端每 30s 刷一次，够显示用 */
  idleSec: number;
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

  /** 创建或加入房间并建立会话（TIME-06：建房时上报 OPTION 起始日期） */
  static async connect(opts: {
    playerName: string;
    roomId?: string;
    seed?: number;
    maxDays?: number | null;
    mapId?: number | null;
    /** 想要的角色。服务端按「先到先得」裁决，被抢走会另给一个没人占的，不会拒绝加入 */
    characterId?: string | null;
    /** 私密房：不进大厅列表，只能凭房间码加入。只对建房有效 */
    isPrivate?: boolean;
  }): Promise<ColyseusSession> {
    const client = new Client(serverUrl());
    const token = localStorage.getItem('richman.token') ?? undefined;
    const room = opts.roomId
      ? await client.joinById(opts.roomId, { name: opts.playerName, token, characterId: opts.characterId })
      : await client.create('game', {
          name: opts.playerName,
          seed: opts.seed,
          token,
          characterId: opts.characterId,
          isPrivate: opts.isPrivate === true,
          startDate: getSettings().startDate ?? undefined,
          // 建房者选的天数上限：null 要原样送达（那是「显式不限」），所以只在有值时才带这个键
          ...(opts.maxDays === undefined ? {} : { maxDays: opts.maxDays }),
          // 地图同理：0 号是合法地图，不能用「有值才带」以外的真值判断
          ...(opts.mapId === undefined ? {} : { mapId: opts.mapId }),
        });
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
      metadata?: { phase?: string; players?: number; maxPlayers?: number; idleSec?: number };
    }>;
    return rooms
      .filter((r) => r.metadata?.phase === 'lobby')
      .map((r) => ({
        roomId: r.roomId,
        players: r.metadata?.players ?? r.clients,
        maxPlayers: r.metadata?.maxPlayers ?? r.maxClients,
        phase: 'lobby',
        idleSec: r.metadata?.idleSec ?? 0,
      }));
  }

  private attachRoom(room: Room<unknown>): void {
    this.room = room;

    room.onMessage<RemoteSnapshot>('state', (snapshot) => {
      // 房间快照是「外部 GameState 进入内存」的第三个入口，一样要先过 normalize：
      // 服务端与客户端不同步时（例如 dev 服务没重启）缺字段会在这里补上，
      // 而不是等 UI 拿着 undefined 去 .map 把整棵 React 树炸掉。
      this.game = normalizeGameState(snapshot.game);
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
    turnStage: 'start',
    boardGods: [],
    // 房间状态还没到手的占位：没有神明会现身
    spawnGods: false,
    godPairBanUntil: {},
    dice: null,
    movePath: null,
    turn: 0,
    round: 1,
    seed: 0,
    mapId: null,
    rngState: 0,
    log: [{ turn: 0, text: '正在同步房间状态…' }],
    winnerId: null,
    endReason: null,
    maxDays: null,
    stockMarket: { stocks: [] },
    roadblocks: [],
    mines: [],
    trapBombs: [],
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
    lotteryTickets: [],
    auction: null,
    auctionQueue: [],
    companies: [],
    newsCursor: 0,
    streetPriceFactors: {},
    stockHaltAllDays: 0,
    loanBanDays: 0,
    npcs: [],
    treasureCellId: null,
    treasureMonth: 0,
    magic: null,
    landGodCooldownMonth: 0,
    pendingCards: [],
    landing: null,
    trades: [],
    tradeHistory: [],
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






