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
  CARDS,
  estateGroups,
  FACILITIES,
  gameDate,
  GODS,
  godSummary,
  ITEMS,
  priceIndex,
  type GameState,
} from '@richman/shared';

/** 棋盘每格归属：cellId → playerId（小地图描边、dock 格块、world 上色共用） */
export type AcOwners = Record<number, string>;

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
    gods: Array<{ godId: string; cellId: number; ttlDays: number; bornDay: number; name: string; emoji: string; summary: string }>;
    myPlayerId: string | null;
    currentCell: GameState['board'][number] | undefined;
    names: {
      cards: Record<string, { name: string; desc: string; cost: number }>;
      items: Record<string, { name: string; desc: string; cost: number | null }>;
      facilities: Record<string, { name: string; desc: string }>;
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
      gods,
      myPlayerId: meId,
      currentCell: game.board[me?.position ?? 0],
      names: {
        cards: mapDefs(CARDS, (v) => ({ name: v.name, desc: v.description, cost: v.cost })),
        items: mapDefs(ITEMS, (v) => ({ name: v.name, desc: v.description, cost: v.cost })),
        facilities: mapDefs(FACILITIES, (v) => ({ name: v.name, desc: v.description })),
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
