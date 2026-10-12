import { applyAction, botDecide, createGame, nextRandom } from '../../src/index.js';
import type { GameState, PlayerAction, PlayerDef } from '../../src/index.js';

/** 固定起始日期：周一、非 15 号、非月末，避免结果随运行日漂移 */
export const MONDAY = { year: 2026, month: 1, day: 5 } as const;

/** 四人局（AI 对跑用），姓名与配色固定以保证确定性 */
export const GOLDEN_PLAYERS: PlayerDef[] = [
  { id: 'bot-1', name: '一号', color: 0xef5350 },
  { id: 'bot-2', name: '二号', color: 0x42a5f5 },
  { id: 'bot-3', name: '三号', color: 0x66bb6a },
  { id: 'bot-4', name: '四号', color: 0xffa726 },
];

/**
 * 递归排序键的 JSON 序列化。
 *
 * 引擎直接 `JSON.stringify(state)` 的键序依赖对象创建顺序，重构时若改动字面量顺序
 * 会误报行为变化；这里显式稳定化，使 hash 只反映**值**的变化。
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.keys(value as object)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`);
  return `{${entries.join(',')}}`;
}

/** FNV-1a 32 位散列（足够区分状态漂移，且输出短到可写进断言字面量） */
function hash32(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export interface GoldenRun {
  /** 每 `sampleEvery` 个动作一条的 `#步数@回合:状态散列` 序列 */
  hashes: string[];
  finalState: GameState;
  /** 实际执行的动作数 */
  steps: number;
  /** 引擎抛错并被兜底吞掉的次数（重构前后必须一致，否则行为已变） */
  errors: number;
  /**
   * 被吞掉的错误原文（最多 20 条）。
   * 「决策/门控说可以、引擎却抛错」正是门控不同源的直接证据，
   * 只留计数的话会把它当成噪声掩盖掉，所以这里保留消息本身。
   */
  errorMessages: string[];
  /** 因连续拿不到合法动作而提前中止的次数 */
  stalls: number;
  /**
   * 逐步状态序列（仅在 `collectStates` 时填充）。
   * 属性测试用它遍历各种中局局面，检查「门控说可以」与「引擎真接受」是否始终一致。
   */
  states: GameState[];
}

/**
 * 确定性 bot 对跑：固定 seed + 固定 startDate + 固定决策函数 ⇒ 整局逐帧可复现。
 *
 * 这是重构期间唯一能证明「行为不变」的手段（比单点断言强），同时兼作角色特技
 * 平衡回归的模拟器。回合归属与兜底策略对齐 `server/src/rooms/GameRoom.ts` 的
 * `actingPlayerId` / `botAct`，保证测的是线上真正会跑的那条路径。
 */
export function runGoldenMatch(
  opts: {
    seed?: number;
    players?: PlayerDef[];
    /** 最大回合数（`state.turn`） */
    maxTurns?: number;
    /** 每多少个动作记一次散列 */
    sampleEvery?: number;
    /** 收集逐步状态序列（属性测试用；内存开销大，golden 默认不开） */
    collectStates?: boolean;
    /** 跑哪张图：`null` / 不填 = 自建 64 格环，数字取自 `shared/src/maps` 的原版图 */
    mapId?: number | null;
    /** 覆盖初始玩家定义（角色平衡回归用：同一份 id 注入不同 characterId） */
    decorate?: (state: GameState) => void;
  } = {},
): GoldenRun {
  const seed = opts.seed ?? 20260105;
  const maxTurns = opts.maxTurns ?? 300;
  const sampleEvery = opts.sampleEvery ?? 25;
  const collectStates = opts.collectStates ?? false;

  const defs = opts.players ?? GOLDEN_PLAYERS;
  let state = applyAction(
    createGame(defs, seed, { startDate: { ...MONDAY }, mapId: opts.mapId ?? null }),
    { type: 'START_GAME' },
  );
  opts.decorate?.(state);

  // 与 GameRoom 相同：AI 决策随机独立于 GameState.rngState，靠动作日志保证回放一致
  let botRngState = seed ^ 0x5f3759df;
  const rng = () => {
    const draw = nextRandom(botRngState);
    botRngState = draw.nextState;
    return draw.value;
  };

  const hashes: string[] = [];
  const states: GameState[] = collectStates ? [state] : [];
  const errorMessages: string[] = [];
  let steps = 0;
  let errors = 0;
  let stalls = 0;
  let consecutiveNulls = 0;

  const act = (action: PlayerAction) => {
    try {
      state = applyAction(state, action);
    } catch (e) {
      errors += 1;
      if (errorMessages.length < 20) {
        const message = e instanceof Error ? e.message : String(e);
        errorMessages.push(`${action.type} → ${message}`);
      }
      // 对齐 GameRoom.botAct 的降级：决策与规则冲突时结束回合，避免对局卡死
      if (state.phase === 'awaiting_action') {
        state = applyAction(state, { type: 'FINISH_LANDING' });
      }
    }
    steps += 1;
    if (collectStates) states.push(state);
    if (steps % sampleEvery === 0) {
      hashes.push(`#${steps}@${state.turn}:${hash32(stableStringify(state))}`);
    }
  };

  while (state.phase !== 'game_over' && state.turn <= maxTurns && steps < maxTurns * 12) {
    // ECON-12：手牌额满的舍弃阶段 bot 不决策，由驱动代为弃第一张 —— 弃的是**卡主**的牌，
    // 抽卡可以发生在别人的回合里（大福神显灵那类），按当前玩家取会拿到一只空手
    if (state.phase === 'awaiting_discard') {
      const owner = state.players.find((q) => q.id === state.pendingCards[0]?.ownerId);
      const cardId = owner?.cards[0];
      if (!cardId) {
        stalls += 1;
        break;
      }
      act({ type: 'DISCARD_CARD', cardId });
      consecutiveNulls = 0;
      continue;
    }

    const actingId =
      state.phase === 'awaiting_auction'
        ? (state.auction?.bidders[state.auction.turnIndex] ?? null)
        : (state.players[state.currentPlayerIndex]?.id ?? null);
    if (!actingId) {
      stalls += 1;
      break;
    }

    const action = botDecide(state, actingId, rng);
    if (!action) {
      consecutiveNulls += 1;
      if (consecutiveNulls >= 4) {
        stalls += 1;
        break;
      }
      // bot 无决策时推进回合，避免空转
      if (state.phase === 'awaiting_action') {
        act({ type: 'FINISH_LANDING' });
      } else if (state.phase === 'awaiting_roll') {
        act({ type: 'ROLL_DICE' });
      } else {
        stalls += 1;
        break;
      }
      continue;
    }
    consecutiveNulls = 0;
    act(action);
  }

  return { hashes, finalState: state, steps, errors, errorMessages, stalls, states };
}
