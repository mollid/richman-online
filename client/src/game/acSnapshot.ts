/**
 * 实时 view 适配层：把真实 `GameState` 派生成 ac-HUD 认识的 `{ state, view }`。
 *
 * 原型 `design/hud-ac` 读的是一份**冻结快照**（`snapshot.js`，由 tools/dump-snapshot.mts 导出）。
 * 并入 client 后不再冻结：同一个 `GameState` 每次推进都重算一遍，`hud.js` 只认结构、不认来源。
 * 派生口径与 dump-snapshot.mts 逐条对齐 —— 两处不一致就会出现「面板显示的数与引擎不符」。
 */
import {
  allAssetSummaries,
  allStockSummaries,
  availableActions,
  boardLayout,
  CARDS,
  estateGroups,
  FACILITIES,
  gameDate,
  GODS,
  godSummary,
  ITEMS,
  MAGIC_CONDITION_LABEL,
  NPC_NAMES,
  priceIndex,
  TREASURE_POINTS,
  type GameState,
} from '@richman/shared';

/** 棋盘每格归属：cellId → playerId（小地图描边、dock 格块、world 上色共用） */
export type AcOwners = Record<number, string>;

/**
 * 棋盘上的「活物」：玩家放的障碍、挂在身上的炸弹、路上走的特殊单位、破产后行乞的乞丐。
 *
 * 为什么要在这一层派生出来（而不是让 `hud.js` 自己扒 `GameState`）：点选与格子详情要能
 * 一句话回答「这格上有什么、是谁放的」，而这个说法**只能有一份**。两处各扒一遍，
 * 就会出现「面板显示的与引擎算的不是同一件事」—— 那正是本项目反复踩过的那类 bug。
 */
export interface AcEntities {
  /** `kind: 'bomb'` = 布设在格上、还没人被附身的定时炸弹（D-48），描边取放置者色 */
  obstacles: Array<{ kind: 'roadblock' | 'mine' | 'bomb'; cellId: number; ownerId: string; ownerName: string }>;
  bombs: Array<{ playerId: string; cellId: number; stepsLeft: number; name: string }>;
  npcs: Array<{ kind: string; cellId: number; ownerId: string | null; ownerName: string | null; jailed: boolean; name: string }>;
  beggars: Array<{ playerId: string; cellId: number; name: string }>;
}

export interface AcSnapshot {
  state: GameState;
  view: {
    date: ReturnType<typeof gameDate>;
    priceIndex: number;
    assets: ReturnType<typeof allAssetSummaries>;
    stocks: ReturnType<typeof allStockSummaries>;
    estates: Record<string, ReturnType<typeof estateGroups>>;
    actions: ReturnType<typeof availableActions>;
    /**
     * 「能不能打开股市面板」与「市场开没开」是两件事。
     *
     * `actions.canTradeStock` 里含 `isMarketOpen`，例假日 / 全市场停牌时是 false；
     * 但股市面板除了 6 支上市股，还挂着**公司原始股**——一级市场按面值向公司申购，
     * 引擎的 `checkBuyShares` 不受休市与停牌约束（面板自己的文案也写着「休市中：可认购，暂不能卖出」）。
     * 若拿 canTradeStock 当门户，玩家在休市日就永远打不开面板，那半张表直接消失。
     *
     * 所以门户口径取**引擎的 canTradeStockNow**：自己回合（掷骰前 / 决策后）且未破产即可打开；
     * 市场状态只用来决定面板里「上市股」那几个按钮的可用性。
     */
    canOpenStock: boolean;
    owners: AcOwners;
    /**
     * 棋盘几何（世界坐标）。`null` = 这张图没带坐标，渲染层退回「64 格 = 17×17 外圈」的老算法。
     *
     * 由 shared 的 `boardLayout` 算，3D 场景与右下小地图共用同一份 —— 两处各算一次必然错位。
     */
    layout: ReturnType<typeof boardLayout>;
    gods: Array<{ godId: string; cellId: number; ttlDays: number; bornDay: number; name: string; emoji: string; summary: string }>;
    /** 障碍 / 炸弹 / 特殊单位 / 乞丐（见 `AcEntities`） */
    entities: AcEntities;
    /**
     * TILE-31 宝箱：驻留实体此刻在哪一格（null = 场上没有，本月已被拿走）。
     * 点券数值一并给出 —— 表现层不自己写死规则里的数字。
     */
    treasureCellId: number | null;
    treasurePoints: number;
    myPlayerId: string | null;
    currentCell: GameState['board'][number] | undefined;
    names: {
      cards: Record<string, { name: string; desc: string; cost: number }>;
      items: Record<string, { name: string; desc: string; cost: number | null }>;
      facilities: Record<string, { name: string; desc: string }>;
      /** 魔法屋标语表：hud.js 里不许再抄一份规则文案（它不参与 typecheck，改模型时没人拦得住） */
      magicConditions: Record<string, string>;
      godList: Array<{ id: string; name: string; possession: string; travel: string; days: number }>;
    };
  };
}

const mapDefs = <T, R>(src: Record<string, T>, f: (v: T) => R): Record<string, R> =>
  Object.fromEntries(Object.entries(src).map(([k, v]) => [k, f(v)]));

/**
 * 建一帧 HUD 快照。
 * @param game      真实引擎状态
 * @param myPlayerId 联机时为我方 id；热座为 null（此时「我」= 当前行动者，因为同一台机器轮流操作）
 */
export function buildAcSnapshot(game: GameState, myPlayerId: string | null): AcSnapshot {
  const owners: AcOwners = {};
  for (const p of game.players) for (const prop of p.properties) owners[prop.cellId] = p.id;

  const meId = myPlayerId ?? game.players[game.currentPlayerIndex]?.id ?? null;
  const me = meId ? game.players.find((p) => p.id === meId) : undefined;
  const acting = game.players[game.currentPlayerIndex];

  /* 与 shared 的 canTradeStockNow 同口径：掷骰前与决策后都算「自己回合」 */
  const canOpenStock =
    (game.phase === 'awaiting_roll' || game.phase === 'awaiting_action') && !!acting && !acting.bankrupt;

  const gods = game.boardGods.map((bg) => {
    const def = GODS.find((g) => g.id === bg.godId);
    return {
      godId: bg.godId,
      cellId: bg.cellId,
      ttlDays: bg.ttlDays,
      bornDay: bg.bornDay,
      name: def?.name ?? bg.godId,
      emoji: def ? godEmoji(def.id) : '✨',
      summary: def ? godSummary(def) : '',
    };
  });

  /* 棋盘活物：一格上有什么、谁放的、还剩几步，全部在这里说清一次（口径唯一） */
  const nameOf = (pid: string) => game.players.find((p) => p.id === pid)?.name ?? pid;
  const entities: AcEntities = {
    obstacles: [
      ...game.roadblocks.map((o) => ({ kind: 'roadblock' as const, cellId: o.cellId, ownerId: o.ownerId, ownerName: nameOf(o.ownerId) })),
      ...game.mines.map((o) => ({ kind: 'mine' as const, cellId: o.cellId, ownerId: o.ownerId, ownerName: nameOf(o.ownerId) })),
      // 布设在格上的炸弹（D-48）：与路障地雷同一类「谁放的」要说得出来源
      ...game.trapBombs.map((o) => ({ kind: 'bomb' as const, cellId: o.cellId, ownerId: o.ownerId, ownerName: nameOf(o.ownerId) })),
    ],
    // 挂身炸弹跟着携带者的位置走；找不到人时给 -1，渲染层按「不上屏」处理
    bombs: game.bombs.map((b) => ({
      playerId: b.playerId,
      cellId: game.players.find((p) => p.id === b.playerId)?.position ?? -1,
      stepsLeft: b.stepsLeft,
      name: nameOf(b.playerId),
    })),
    npcs: game.npcs.map((n) => ({
      kind: n.kind,
      cellId: n.position,
      ownerId: n.ownerId,
      ownerName: n.ownerId ? nameOf(n.ownerId) : null,
      jailed: n.jailed,
      name: NPC_NAMES[n.kind] ?? n.kind,
    })),
    // 乞丐 = 破产且还没被炸飞的玩家（D-46），点选与详情都要能认出这一格站着要施舍的人
    beggars: game.players
      .filter((p) => p.bankrupt && !p.beggarGone)
      .map((p) => ({ playerId: p.id, cellId: p.position, name: p.name })),
  };

  return {
    state: game,
    view: {
      date: gameDate(game),
      priceIndex: priceIndex(game),
      assets: allAssetSummaries(game),
      stocks: allStockSummaries(game),
      estates: Object.fromEntries(game.players.map((p) => [p.id, estateGroups(game, p)])),
      actions: availableActions(game),
      canOpenStock,
      owners,
      layout: boardLayout(game.board),
      gods,
      entities,
      treasureCellId: game.treasureCellId,
      treasurePoints: TREASURE_POINTS,
      myPlayerId: meId,
      currentCell: game.board[me?.position ?? 0],
      names: {
        cards: mapDefs(CARDS, (v) => ({ name: v.name, desc: v.description, cost: v.cost })),
        items: mapDefs(ITEMS, (v) => ({ name: v.name, desc: v.description, cost: v.cost })),
        facilities: mapDefs(FACILITIES, (v) => ({ name: v.name, desc: v.description })),
        magicConditions: { ...MAGIC_CONDITION_LABEL },
        godList: GODS.map((g) => ({ id: g.id, name: g.name, possession: g.possession, travel: g.travel, days: g.durationDays })),
      },
    },
  };
}

/** 神明 emoji：与 hud.js 的 GOD_EMOJI 同源（原型只做展示，缺项回落 ✨） */
const GOD_EMOJI: Record<string, string> = {
  'land-god': '🏮',
  'big-wealth': '💰',
  'small-wealth': '🪙',
  'big-fortune': '🍀',
  'small-fortune': '🌱',
  'big-poverty': '🕳️',
  'small-poverty': '🧦',
  'big-misfortune': '⚡',
  'small-misfortune': '🌧️',
  angel: '😇',
  devil: '😈',
  death: '💀',
};
const godEmoji = (id: string): string => GOD_EMOJI[id] ?? '✨';
