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
  allAssetSummaries,
  allStockSummaries,
  priceIndex,
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

/** 岛民名 + 动物森林配色，只为原型好看，与规则无关 */
const DEFS: PlayerDef[] = [
  { id: 'bot-1', name: '阿绿', color: 0x6fbf5a },
  { id: 'bot-2', name: '阿蓝', color: 0x5fc4e0 },
  { id: 'bot-3', name: '阿黄', color: 0xffd45e },
  { id: 'bot-4', name: '阿粉', color: 0xf2909e },
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
    gods,
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
