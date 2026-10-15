import { Room } from '@colyseus/core';
import type { Client } from '@colyseus/core';
import {
  addPlayer,
  applyAction,
  availableActions,
  botDecide,
  characterById,
  createGame,
  forceGameOver,
  nextRandom,
  pushLog,
  removePlayer,
  resolveCharacter,
  resolveMaxDays,
  setLobbyCharacter,
  setLobbyReady,
  ONLINE_DEFAULT_MAX_DAYS,
  type DateSerial,
  type GameState,
  type PlayerAction,
} from '@richman/shared';

/**
 * 房间不再自带颜色表与名字表：两者都跟着角色走（`characters.ts` 是唯一出处），
 * 否则会出现「头像说关老吉、描边是座位色、名字又是第四个默认名」这种一人三个身份。
 */
const OFFLINE_AUTO_ACT_DELAY_MS = 3000;
const RECONNECT_TIMEOUT_SEC = 60;

/**
 * 房间空闲多久算死。只掐着「客户端真的发了消息」计时：浏览器后台不会掐 WS，
 * 所以一个开着页走人的房主在服务端看来是活连接，`autoDispose` 永远等不到空房。
 * 15 分钟够想清楚一步棋，又不至于让 AFK 的房主把房间一直钉在大厅里。
 * 环境变量是给测试留的：收房行为必须真等一次才看得出问题。
 */
export const ROOM_IDLE_TIMEOUT_SEC = Number(process.env.RICHMAN_ROOM_IDLE_TIMEOUT_SEC ?? 15 * 60);
/** 扫描粒度：阈值是分钟级，30s 一次足够，也不至于让元数据写得太密 */
const ROOM_SWEEP_INTERVAL_MS = 30 * 1000;

/** 系统时钟 → 日期序列（仅在本文件与 LocalHotseatSession 各读一次） */
function todaySerial(): DateSerial {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
}

/** TIME-06：校验客户端上报的起始日期（含真实月长与闰年） */
function isValidDateSerial(d: unknown): d is DateSerial {
  if (!d || typeof d !== 'object') return false;
  const { year, month, day } = d as DateSerial;
  if (!Number.isInteger(year) || year < 1980 || year > 2999) return false;
  if (!Number.isInteger(month) || month < 1 || month > 12) return false;
  if (!Number.isInteger(day) || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1]!;
}

interface AuthResult {
  userId?: string;
  username?: string;
}

/**
 * 权威对战房间：
 * - 全部规则计算通过 @richman/shared 引擎完成，客户端只负责表现
 * - 每次状态变化后广播完整快照（回合制游戏足够，后续可优化为增量同步）
 * - 内置聊天、断线重连（60s 窗口）与掉线托管、账号绑定与战绩入库
 */
export class GameRoom extends Room {
  maxClients = 4;
  private game!: GameState;
  private autoActTimer: ReturnType<typeof setTimeout> | null = null;
  private seed = 0;
  private startDate!: DateSerial;
  private recordSaved = false;
  private userIds = new Map<string, string>();
  private actionLog: Array<{ turn: number; action: PlayerAction }> = [];
  private botIds = new Set<string>();
  private botTimer: ReturnType<typeof setTimeout> | null = null;
  private botRngState = 1;
  private botCounter = 0;
  /** 私密房不进大厅列表（见 index.ts 的 /api/rooms），但房间码照样能加 */
  private isPrivate = false;
  private lastActivityAt = Date.now();
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  /** 元数据里那份 phase：收房扫描要照抄回去，不必再从 game.phase 反推 */
  private listedPhase: 'lobby' | 'playing' | 'finished' = 'lobby';

  /** 携带 token 的玩家绑定账号，其余以游客身份进入 */
  async onAuth(_client: Client, options: { token?: string }): Promise<AuthResult | boolean> {
    const token = (options.token ?? '').trim();
    if (!token) return true;
    try {
      const { getSessionUser } = await import('../storage.js');
      const user = await getSessionUser(token);
      if (!user) return true; // token 无效时降级为游客，不阻断进入房间
      return { userId: user.id, username: user.username };
    } catch {
      return true;
    }
  }

  onCreate(options: {
    seed?: number;
    maxPlayers?: number;
    startDate?: DateSerial;
    maxDays?: number | null;
    mapId?: number | null;
    isPrivate?: boolean;
  }) {
    this.maxClients = Math.min(Math.max(options.maxPlayers ?? 4, 2), 4);
    this.isPrivate = options.isPrivate === true;
    this.seed = options.seed ?? Date.now() % 2147483647;
    this.botRngState = this.seed;
    this.startDate = isValidDateSerial(options.startDate) ? options.startDate : todaySerial();
    // CORE-04 / 玩法文档 §14 第 2 项：联机默认打满 60 天就按总资产结算，长局收得了口。
    // 房主显式传 0 / null 才是「不限天数」；没传这个参数时用默认值，而不是当成不限。
    this.game = createGame([], this.seed, {
      startDate: this.startDate,
      maxDays: options.maxDays === undefined ? ONLINE_DEFAULT_MAX_DAYS : resolveMaxDays(options.maxDays),
      // 地图同理要区分「没传」与「传了 null（自建默认图）」，而 0 号是合法地图
      mapId: options.mapId ?? null,
    });
    this.touch();
    this.updateMetadata('lobby');
    this.idleTimer = setInterval(() => this.sweepIdle(), ROOM_SWEEP_INTERVAL_MS);

    this.onTracked('add_bot', (client) => {
      try {
        if (this.game.phase !== 'lobby') throw new Error('对局已开始，无法添加 AI');
        if (this.game.players.length >= this.maxClients) throw new Error('房间已满');
        // AI 也占一个角色（先到先得那套同样适用），名字就是「AI·角色名」——
        // 房间不再另存一份 bot 名表，否则又出现"头像一个名字、牌子上另一个"
        const characterId = resolveCharacter(null, this.game.players.map((p) => p.characterId));
        const ch = characterById(characterId)!;
        const botId = `bot-${this.game.players.length}-${this.botCounter++}`;
        this.game = addPlayer(this.game, {
          id: botId,
          name: `AI·${ch.name}`,
          color: ch.color,
          characterId,
        });
        this.botIds.add(botId);
        this.updateMetadata('lobby');
        this.broadcastState();
      } catch (e) {
        this.sendError(client, e);
      }
    });

    this.onTracked('start_game', (client) => {
      try {
        // 「全员准备」是规则，交给引擎挡；「谁能按」是房间权限，留在这里
        if (client.sessionId !== this.game.hostId) throw new Error('只有房主能开始对局');
        this.game = applyAction(this.game, { type: 'START_GAME' });
        this.actionLog.push({ turn: this.game.turn, action: { type: 'START_GAME' } });
        this.updateMetadata('playing');
        this.broadcastState();
      } catch (e) {
        this.sendError(client, e);
      }
    });

    this.onTracked('kick', (client, message: { playerId?: unknown }) => {
      try {
        if (this.game.phase !== 'lobby') throw new Error('对局已开始，不能请人出去');
        if (client.sessionId !== this.game.hostId) throw new Error('只有房主能请人出房间');
        const id = typeof message.playerId === 'string' ? message.playerId : '';
        if (id === client.sessionId) throw new Error('不能把自己请出去');
        if (!this.game.players.some((p) => p.id === id)) throw new Error('没有这个玩家');
        if (this.botIds.delete(id)) {
          // AI 没有连接可切，直接从名单里摘掉
          this.game = removePlayer(this.game, id);
          this.broadcastState();
          return;
        }
        // 先递一句为什么再切断：不然对方只看到一次莫名断线，然后开始 30s 重连退避
        const target = this.clients.getById(id);
        target?.send('kicked', {});
        // 4000 = WS_CLOSE_CONSENTED：走「自愿离开」那条 onLeave，不进 60s 重连窗口留幽灵位
        target?.leave(4000);
      } catch (e) {
        this.sendError(client, e);
      }
    });

    this.onTracked('get_state', (client) => {
      client.send('state', { game: this.game, actions: availableActions(this.game) });
    });

    // 测试模式钩子（仅 RICHMAN_TEST_MODE=1 时注册）：走真实 game_over/战绩流程
    if (process.env.RICHMAN_TEST_MODE === '1') {
      this.onTracked('test_finish', (client) => {
        this.game = forceGameOver(this.game, client.sessionId);
        this.broadcastState();
      });
    }

    this.onTracked('chat', (client, message: { text?: unknown }) => {
      const text = typeof message.text === 'string' ? message.text.trim().slice(0, 120) : '';
      if (!text) return;
      const player = this.game.players.find((p) => p.id === client.sessionId);
      this.broadcast('chat', {
        fromId: client.sessionId,
        fromName: player?.name ?? '未知玩家',
        text,
      });
    });

    this.onTracked('action', (client, message: { action: PlayerAction }) => {
      try {
        // 开局只认 'start_game' 那条通道：房主校验挂在那儿，从 action 递进来等于绕权限
        if (message.action.type === 'START_GAME') throw new Error('请用「开始对局」开局');
        this.assertCurrentPlayer(client);
        this.game = applyAction(this.game, message.action);
        this.actionLog.push({ turn: this.game.turn, action: message.action });
        this.broadcastState();
      } catch (e) {
        this.sendError(client, e);
      }
    });

    this.onTracked('set_ready', (client, message: { ready?: unknown }) => {
      try {
        this.game = setLobbyReady(this.game, client.sessionId, message.ready === true);
        this.broadcastState();
      } catch (e) {
        this.sendError(client, e);
      }
    });

    this.onTracked('set_character', (client, message: { characterId?: unknown }) => {
      try {
        const id = typeof message.characterId === 'string' ? message.characterId : '';
        this.game = setLobbyCharacter(this.game, client.sessionId, id);
        this.broadcastState();
      } catch (e) {
        this.sendError(client, e);
      }
    });
  }

  onJoin(client: Client, options: { name?: string; characterId?: string }, auth?: AuthResult) {
    if (this.game.phase !== 'lobby') {
      throw new Error('对局已开始，无法加入');
    }
    if (auth?.userId) this.userIds.set(client.sessionId, auth.userId);
    // 角色先到先得（决策人定）：被人抢走就按表序给一个没人占的，不因此把人拒之门外
    const requested = options.characterId;
    const characterId = resolveCharacter(requested, this.game.players.map((p) => p.characterId));
    const ch = characterById(characterId)!;
    const rawName = (auth?.username ?? options.name ?? '').trim().slice(0, 8);
    const name = rawName || ch.name;
    this.game = addPlayer(this.game, {
      id: client.sessionId,
      // 没填名字就用角色名：房间不再另有一份「默认名」表，免得头像与名字对不上
      name,
      color: ch.color,
      characterId,
      // 真人进房先算「没准备」，AI 与热座走默认 true —— 准备是点出来的，不是白送出来的
      ready: false,
    });
    // 换角必须出声：不然被抢的人只看见自己莫名奇妙换了个角色
    if (requested && requested !== characterId) {
      pushLog(this.game, `${name} 想选 ${characterById(requested)?.name ?? requested}，已被占，改用 ${ch.name}`);
    }
    this.touch();
    this.updateMetadata('lobby');
    this.broadcastState();
  }

  async onLeave(client: Client, consented: boolean) {
    // 显式退出（consented）不保留重连；异常断开（刷新/断网）保留窗口，
    // 否则房间会被立即 dispose，旧连接后续推送全部报
    // 「room has been disposed」，客户端表现为联机失败。
    if (!consented) {
      try {
        await this.allowReconnection(client, RECONNECT_TIMEOUT_SEC);
      } catch {
        // 重连超时或期间无重连：走下面的正常离场流程
      }
    }

    if (this.game.phase === 'lobby') {
      this.game = removePlayer(this.game, client.sessionId);
      this.userIds.delete(client.sessionId);
      this.updateMetadata('lobby');
      this.broadcastState();
      return;
    }

    this.setOnline(client.sessionId, false);
    this.scheduleAutoAct();
  }

  onDispose() {
    if (this.autoActTimer) clearTimeout(this.autoActTimer);
    if (this.botTimer) clearTimeout(this.botTimer);
    if (this.idleTimer) clearInterval(this.idleTimer);
  }

  /**
   * 记一次「客户端真的说了话」。只挂着连接不发消息不算：那正是房主开着页走人的样子。
   */
  private touch() {
    this.lastActivityAt = Date.now();
  }

  /**
   * 包一层再注册，免得哪天新加一条消息忘了刷活跃时间 —— 漏一条就等于给那类消息
   * 开了个「永不超时」的口子，而这种口子只会在大厅里多出一个僵尸房时才被发现。
   */
  private onTracked<T>(type: string, handler: (client: Client, message: T) => void) {
    this.onMessage<T>(type, (client, message) => {
      this.touch();
      handler(client, message);
    });
  }

  /**
   * 空闲收房。只管还没开打的房：一旦进了对局，「没人发消息」可能是真有人在长考，
   * 而那时列表里本来就没有它（列表只列 lobby），留着不碍事。
   * `disconnect()` 走的是 consented 关闭，被收的一方不会进入 60s 重连窗口。
   */
  private sweepIdle() {
    // 列表只列 lobby，也就只有 lobby 需要往元数据里刷活跃时间
    if (this.listedPhase !== 'lobby') return;
    const idleSec = Math.round((Date.now() - this.lastActivityAt) / 1000);
    // 分两段：到点先只把 idleSec 写进元数据，让 /api/rooms 把它从列表里摘掉；
    // 再晚一个扫描周期才真收。中间那 30s 是给「刚好回来的人」留的宽限 —— 房间码照样进得来。
    if (idleSec < ROOM_IDLE_TIMEOUT_SEC + ROOM_SWEEP_INTERVAL_MS / 1000) {
      this.updateMetadata('lobby');
      return;
    }
    console.log(`[room] ${this.roomId} 开局后 ${Math.round(idleSec / 60)} 分钟无人应答，收房`);
    void this.disconnect();
  }

  private setOnline(sessionId: string, online: boolean) {
    const p = this.game.players.find((q) => q.id === sessionId);
    if (p) p.online = online;
    this.broadcastState();
  }

  /** 更新房间元数据（供大厅房间列表展示与过滤） */
  private updateMetadata(phase: 'lobby' | 'playing' | 'finished') {
    this.listedPhase = phase;
    void this.setMetadata({
      phase,
      players: this.game.players.length,
      maxPlayers: this.maxClients,
      private: this.isPrivate,
      // 发给列表的是「距今多少秒」而不是时间戳：客户端与服务器的钟不必对得上
      idleSec: Math.round((Date.now() - this.lastActivityAt) / 1000),
    });
  }

  private assertCurrentPlayer(client: Client) {
    const actingId = this.actingPlayerId();
    if (!actingId || actingId !== client.sessionId) {
      throw new Error(this.game.phase === 'awaiting_auction' ? '还没轮到你出价' : '还没轮到你操作');
    }
  }

  /** 当前应行动的玩家：拍卖会由竞买人轮流主拍、额满舍弃由**卡主**弃牌，其余情况为当前回合玩家 */
  private actingPlayerId(): string | null {
    if (this.game.phase === 'awaiting_auction') {
      const a = this.game.auction;
      return a ? a.bidders[a.turnIndex] ?? null : null;
    }
    if (this.game.phase === 'awaiting_discard') {
      // 抽卡可能发生在别人的回合里（大福神显灵那类）：该弃牌的是拿到那张卡的人，不是轮到的人
      return this.game.pendingCards[0]?.ownerId ?? null;
    }
    return this.game.players[this.game.currentPlayerIndex]?.id ?? null;
  }

  private scheduleAutoAct() {
    if (this.autoActTimer) return;
    this.autoActTimer = setTimeout(() => {
      this.autoActTimer = null;
      this.autoActForOffline();
    }, OFFLINE_AUTO_ACT_DELAY_MS);
  }

  /** 掉线玩家托管：拍卖里弃权退出，其余自动掷骰 + 结束回合 */
  private autoActForOffline() {
    if (this.game.phase === 'awaiting_auction') {
      const bidder = this.actingPlayerId();
      const p = bidder ? this.game.players.find((q) => q.id === bidder) : undefined;
      if (!p || p.online) return;
      // 不在场的人不该留在竞价轮次里：PASS 会保留资格，于是每一轮都要等他一个
      // `OFFLINE_AUTO_ACT_DELAY_MS`；直接弃权退出，拍卖立刻能往下走。
      // 但他若已是最高出价者就不能弃权（已经是要付钱的人），那时只能让过。
      const canGiveUp = this.game.auction && this.game.auction.highestBidderId !== bidder;
      try {
        const action = canGiveUp ? { type: 'AUCTION_GIVE_UP' as const } : { type: 'AUCTION_PASS' as const };
        this.game = applyAction(this.game, action);
        this.actionLog.push({ turn: this.game.turn, action });
        this.broadcastState();
        this.scheduleAutoAct();
      } catch {
        // 托管失败忽略，等待下一轮调度
      }
      return;
    }
    if (this.game.phase !== 'awaiting_roll' && this.game.phase !== 'awaiting_action') return;
    const current = this.game.players[this.game.currentPlayerIndex];
    if (!current || current.online) return;
    try {
      this.game = applyAction(this.game, { type: 'ROLL_DICE' });
      if (this.game.phase === 'awaiting_action') {
        const still = this.game.players[this.game.currentPlayerIndex];
        if (still && !still.online) {
          this.game = applyAction(this.game, { type: 'FINISH_LANDING' });
        }
      }
      this.broadcastState();
      const next = this.game.players[this.game.currentPlayerIndex];
      if (next && !next.online && this.game.phase !== 'game_over') {
        this.scheduleAutoAct();
      }
    } catch {
      // 托管失败忽略，等待下一轮调度
    }
  }

  private sendError(client: Client, e: unknown) {
    const message = e instanceof Error ? e.message : '非法操作';
    client.send('error', { message });
  }

  private broadcastState() {
    if (this.game.phase === 'game_over' && this.metadata?.phase !== 'finished') {
      this.updateMetadata('finished');
      this.trySaveRecord();
    }
    this.broadcast('state', { game: this.game, actions: availableActions(this.game) });
    this.maybeScheduleBotAct();
  }

  /** 若当前行动者是 AI，安排其行动 */
  private maybeScheduleBotAct() {
    if (this.botTimer) return;
    if (this.game.phase === 'lobby' || this.game.phase === 'game_over') return;
    const actingId = this.actingPlayerId();
    if (!actingId || !this.botIds.has(actingId)) return;
    this.botTimer = setTimeout(() => {
      this.botTimer = null;
      this.botAct();
    }, 700);
  }

  /** 执行一次 AI 动作（动作会进入 actionLog，因此回放完全一致） */
  private botAct() {
    if (this.game.phase === 'lobby' || this.game.phase === 'game_over') return;
    const actingId = this.actingPlayerId();
    if (!actingId || !this.botIds.has(actingId)) return;
    const rng = () => {
      const draw = nextRandom(this.botRngState);
      this.botRngState = draw.nextState;
      return draw.value;
    };
    // R4：AI 在落格窗里可以真的「什么都不想做」（botDecide 返回 null）。
    // 那时必须替它离开这一格 —— 窗口不会自己关，而直接 return 会让房间冻在
    // `awaiting_action`：`maybeScheduleBotAct` 只在广播时重排，没有广播就没有下一次定时。
    const action = botDecide(this.game, actingId, rng) ?? (availableActions(this.game).canFinishLanding ? ({ type: 'FINISH_LANDING' } as PlayerAction) : null);
    if (!action) return;
    try {
      this.game = applyAction(this.game, action);
      this.actionLog.push({ turn: this.game.turn, action });
      this.broadcastState();
    } catch (e) {
      // 决策与规则冲突时降级为走出落格窗，避免 AI 卡死（同上一条：窗口是唯一的出口）
      if (this.game.phase === 'awaiting_action') {
        this.game = applyAction(this.game, { type: 'FINISH_LANDING' });
        this.actionLog.push({ turn: this.game.turn, action: { type: 'FINISH_LANDING' } });
        this.broadcastState();
      } else {
        console.warn('[bot] 决策执行失败:', e instanceof Error ? e.message : e);
      }
    }
  }

  /** 对局结束后写入战绩（尽力而为，不阻塞广播） */
  private trySaveRecord(): void {
    if (this.recordSaved) return;
    this.recordSaved = true;
    const winner = this.game.players.find((p) => p.id === this.game.winnerId);
    void import('../storage.js').then(({ saveGameRecord }) =>
      saveGameRecord({
        roomId: this.roomId,
        seed: this.seed,
        startDate: this.startDate,
        winnerName: winner?.name ?? null,
        turns: this.game.turn,
        rounds: this.game.round,
        actions: this.actionLog,
        // 建局参数与座位序一并入库，否则回放复现不出这一局（天数上限、回合轮转都靠它）
        maxDays: this.game.maxDays,
        mapId: this.game.mapId,
        players: this.game.players.map((p) => ({
          id: p.id,
          userId: this.userIds.get(p.id) ?? null,
          playerName: p.name,
          color: p.color,
          cash: p.cash,
          bankrupt: p.bankrupt,
          // 角色也要入库：光靠座位回落的话，改一次 `characters.ts` 就会让老录像
          // 复现出不同性别与头像 —— 魔法屋那两条性别条件会打在人身上
          characterId: p.characterId,
        })),
      }),
    );
  }
}


