/**
 * 从真实引擎跑一局 bot 对跑，导出一个**动作面最宽**的中局状态（连同胞生视图）给原型直接读。
 * 只读：不改 shared、不写主目录，产物落在同级的 `snapshot.js`。
 *
 * 用法（仓库根）：pnpm --filter @richman/shared exec tsx ../design/hud-ac/tools/dump-snapshot.mts
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  applyAction,
  availableActions,
  boardLayout,
  botDecide,
  CARDS,
  createGame,
  estateGroups,
  FACILITIES,
  gameDate,
  GODS,
  godSummary,
  ITEMS,
  nextRandom,
  NPC_NAMES,
  allAssetSummaries,
  allStockSummaries,
  priceIndex,
  TREASURE_POINTS,
} from '../../../shared/src/index.js';
import type { GameState, PlayerAction, PlayerDef } from '../../../shared/src/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};

const STOP_TURN = Number(arg('turns', '90'));
const SEED = Number(arg('seed', '20260105'));
const OUT = path.resolve(HERE, '..', arg('out', 'snapshot.js'));

const map = <T, R>(src: Record<string, T>, f: (v: T) => R): Record<string, R> =>
  Object.fromEntries(Object.entries(src).map(([k, v]) => [k, f(v)]));

/**
 * 岛民名 + 动物森林配色，只为原型好看，与规则无关。
 * `characterId` 一并给出：棋子贴图走 `char_<characterId>@v6.png`，缺了它四枚棋子全是兜底圆片。
 */
const DEFS: PlayerDef[] = [
  { id: 'bot-1', name: '阿绿', color: 0x6fbf5a, characterId: 'afu' },
  { id: 'bot-2', name: '阿蓝', color: 0x5fc4e0, characterId: 'xiaomei' },
  { id: 'bot-3', name: '阿黄', color: 0xffd45e, characterId: 'tiexiong' },
  { id: 'bot-4', name: '阿粉', color: 0xf2909e, characterId: 'huadasao' },
];

let state: GameState = applyAction(
  createGame(DEFS, SEED, { startDate: { year: 2026, month: 1, day: 5 } }),
  { type: 'START_GAME' },
);

let botRngState = SEED ^ 0x5f3759df;
const rng = () => {
  const draw = nextRandom(botRngState);
  botRngState = draw.nextState;
  return draw.value;
};

/** 候选局面评分：门控位为真的越多 + 状态字段越满，HUD 上有东西可摆 */
function richness(s: GameState): number {
  const a = availableActions(s) as unknown as Record<string, unknown>;
  let score = 0;
  for (const v of Object.values(a)) {
    if (v === true) score += 3;
    else if (Array.isArray(v)) score += v.length;
    else if (v && typeof v === 'object') score += 4;
    else if (typeof v === 'number') score += v > 0 ? 1 : 0;
  }
  if (s.auction) score += 12;
  if (s.magic) score += 8;
  // 主动作行能点亮几个按钮，比旁支面板更值得展示
  if (s.phase === 'awaiting_action') score += 8;
  if (a.canBuy === true) score += 10;
  if (a.canUpgrade === true) score += 6;
  if (a.canBuyShares === true) score += 5;
  if (a.canDeposit === true || a.canWithdraw === true) score += 3;
  score += s.boardGods.length * 3;
  score += s.trades.filter((t) => !t.closed).length * 2;
  score += s.npcs.length;
  score += s.players.reduce((n, p) => n + p.cards.length + Object.keys(p.items).length, 0);
  return score;
}

const DECIDE_ATTEMPTS = 4;
let steps = 0;
let best: { state: GameState; score: number; turn: number } | null = null;

while (state.phase !== 'game_over' && state.turn < STOP_TURN && steps < STOP_TURN * 14) {
  const score = richness(state);
  if (!best || score > best.score) best = { state, score, turn: state.turn };

  let action: PlayerAction | null = null;
  if (state.phase === 'awaiting_discard') {
    action = { type: 'DISCARD_CARD', cardId: state.players[state.currentPlayerIndex]?.cards[0] ?? '' };
  } else {
    const actingId =
      state.phase === 'awaiting_auction'
        ? (state.auction?.bidders[state.auction.turnIndex] ?? null)
        : (state.players[state.currentPlayerIndex]?.id ?? null);
    if (!actingId) break;
    for (let attempt = 0; attempt < DECIDE_ATTEMPTS && !action; attempt += 1) {
      action = botDecide(state, actingId, rng);
    }
  }
  if (!action) {
    if (state.phase === 'awaiting_action') action = { type: 'END_TURN' };
    else if (state.phase === 'awaiting_roll') action = { type: 'ROLL_DICE' };
    else break;
  }
  try {
    state = applyAction(state, action);
  } catch {
    if (state.phase === 'awaiting_action') state = applyAction(state, { type: 'END_TURN' });
    else break;
  }
  steps += 1;
}

const picked = best!.state;

/** 每格归属（原型小棋盘据此上色）：cellId -> playerId */
const owners: Record<number, string> = {};
for (const p of picked.players) for (const prop of p.properties) owners[prop.cellId] = p.id;

const me = picked.players[picked.currentPlayerIndex];
const gods = picked.boardGods.map((bg) => {
  const god = GODS.find((g) => g.id === bg.godId);
  return { ...bg, name: god?.name ?? bg.godId, emoji: god?.emoji ?? '✨', summary: god ? godSummary(god) : '' };
});

/* 棋盘活物：与 `client/src/game/acSnapshot.ts` 的 `entities` 同形状。
   这张快照是**冻结**的，所以它必须自己把「谁放的 / 还剩几步」这类说法算全，
   否则 world.js 的 `syncEntities()` 会拿到 undefined 直接 return（场景里一个实体都不画）。 */
const nameOf = (pid: string) => picked.players.find((p) => p.id === pid)?.name ?? pid;
const entities = {
  obstacles: [
    ...picked.roadblocks.map((o) => ({ kind: 'roadblock' as const, cellId: o.cellId, ownerId: o.ownerId, ownerName: nameOf(o.ownerId) })),
    ...picked.mines.map((o) => ({ kind: 'mine' as const, cellId: o.cellId, ownerId: o.ownerId, ownerName: nameOf(o.ownerId) })),
    ...picked.trapBombs.map((o) => ({ kind: 'bomb' as const, cellId: o.cellId, ownerId: o.ownerId, ownerName: nameOf(o.ownerId) })),
  ],
  // 挂身炸弹跟着携带者走；找不到人给 -1，渲染层按「不上屏」处理
  bombs: picked.bombs.map((b) => ({
    playerId: b.playerId,
    cellId: picked.players.find((p) => p.id === b.playerId)?.position ?? -1,
    stepsLeft: b.stepsLeft,
    name: nameOf(b.playerId),
  })),
  npcs: picked.npcs.map((n) => ({
    kind: n.kind,
    cellId: n.position,
    ownerId: n.ownerId,
    ownerName: n.ownerId ? nameOf(n.ownerId) : null,
    jailed: n.jailed,
    name: NPC_NAMES[n.kind] ?? n.kind,
  })),
  beggars: picked.players
    .filter((p) => p.bankrupt && !p.beggarGone)
    .map((p) => ({ playerId: p.id, cellId: p.position, name: p.name })),
};

const snapshot = {
  generatedAt: new Date().toISOString(),
  engine: { turn: picked.turn, round: picked.round, steps, seed: SEED, score: best!.score, scannedTurns: STOP_TURN },
  state: picked,
  view: {
    date: gameDate(picked),
    priceIndex: priceIndex(picked),
    assets: allAssetSummaries(picked),
    stocks: allStockSummaries(picked),
    estates: Object.fromEntries(picked.players.map((p) => [p.id, estateGroups(picked, p)])),
    actions: availableActions(picked),
    owners,
    /* 地图自带坐标 ⇒ 把世界布局一起带上：否则 world.js 退回「17×17 外圈」兜底算法，
       3D 场景里的格子落位与真机对不上，和「改前 / 改后」并排看就是两副不同的棋盘。 */
    layout: boardLayout(picked.board),
    gods,
    entities,
    treasureCellId: picked.treasureCellId,
    treasurePoints: TREASURE_POINTS,
    myPlayerId: me?.id ?? null,
    currentCell: picked.board[me?.position ?? 0],
    /** 原型只要文案，所以把定义表压成 id -> 展示字段，省掉在浏览器里重建 shared */
    names: {
      cards: map(CARDS, (v) => ({ name: v.name, desc: v.description, cost: v.cost })),
      items: map(ITEMS, (v) => ({ name: v.name, desc: v.description, cost: v.cost })),
      facilities: map(FACILITIES, (v) => ({ name: v.name, desc: v.description })),
      godList: GODS.map((g) => ({ id: g.id, name: g.name, possession: g.possession, travel: g.travel, days: g.durationDays })),
    },
  },
};

writeFileSync(OUT, `// 由 tools/dump-snapshot.mts 生成，请勿手改。\nglobalThis.GAME_SNAPSHOT = ${JSON.stringify(snapshot)};\n`, 'utf8');

console.log(
  JSON.stringify(
    {
      out: path.relative(process.cwd(), OUT),
      bytes: JSON.stringify(snapshot).length,
      pickedTurn: picked.turn,
      score: best!.score,
      phase: picked.phase,
      current: me?.name,
      cell: `${me?.position}:${picked.board[me?.position ?? 0]?.name}`,
      ownedCells: Object.keys(owners).length,
      gods: gods.map((g) => g.name),
      auction: !!picked.auction,
      magic: !!picked.magic,
      trades: picked.trades.filter((t) => !t.closed).length,
      npcs: picked.npcs.length,
      candles: picked.stockMarket.stocks.map((s) => s.candles.length),
      chairman: picked.companies.filter((c) => c.chairmanId).map((c) => `${c.kind}→${c.chairmanId}`),
      actionBits: Object.entries(availableActions(picked) as unknown as Record<string, unknown>)
        .filter(([, v]) => v === true)
        .map(([k]) => k),
    },
    null,
    1,
  ),
);
