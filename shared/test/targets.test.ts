import { describe, expect, it } from 'vitest';
import {
  ALL_CARD_IDS,
  ALL_ITEM_IDS,
  actionRefusal,
  actionTargets,
  applyAction,
  CARDS,
  createGame,
  type GameState,
  ITEMS,
  type PlayerAction,
  type PlayerDef,
} from '../src/index.js';
import { atLegacyStart, pinIndexOne } from './helpers/state.js';

/**
 * 目标同源属性测试（W1，见 `大富翁Online-棋盘目标选取交互规格.md` §5）。
 *
 * 要钉住的是这句话：**候选枚举与门控校验是同一个谓词** ——
 * `actionTargets` 说可选的，派单必被放行；说不可选的，派单必被拒，且拒绝理由一字不差。
 * 这条不变式以前只在人的记忆里（「门控与引擎校验同源」），目标维度一直是漏的：
 * 门控查不到目标，合法性埋在每张卡的 `apply` 里抛异常，于是「列在可用手牌里、按下去却报错」。
 *
 * 写法是**穷举 id**而不是挑几个代表：每张卡/道具的谓词都是手写的，代表样本会漏掉
 * 正好写错的那一张。
 */

const SEATS: PlayerDef[] = [
  { id: 'p1', name: '阿福', color: 0xef5350 },
  { id: 'p2', name: '小美', color: 0x42a5f5 },
  { id: 'p3', name: '约翰', color: 0xffa726 },
  { id: 'p4', name: '阿丽', color: 0x66bb6a },
];

/** 周一、非 15 号、非月末：隔离日切钩子；出生点钉回 0 号格，让「视野」有确定起点 */
function baseGame(seed = 4242): GameState {
  const g = applyAction(createGame(SEATS, seed, { startDate: { year: 2026, month: 1, day: 5 } }), { type: 'START_GAME' });
  return pinIndexOne(atLegacyStart(g));
}

/** 让当前行动者手上就有这张卡 / 这件道具，并把相位摆到该动作允许的那一段 */
function armed(state: GameState, kind: 'card' | 'item', id: string): GameState {
  const g = structuredClone(state);
  const p = g.players[g.currentPlayerIndex]!;
  // 卡与道具都是掷骰前的自由操作；只有 post_roll 那几张（购地/换地/换屋/改建/拍卖）要在落格窗里
  g.phase = kind === 'card' && CARDS[id]!.phase === 'post_roll' ? 'awaiting_action' : 'awaiting_roll';
  if (kind === 'card') p.cards = [id];
  else p.items = { ...p.items, [id]: 1 };
  return g;
}

const probe = (kind: 'card' | 'item', id: string, extra: Record<string, unknown>): PlayerAction =>
  (kind === 'card'
    ? { type: 'USE_CARD', cardId: id, ...extra }
    : { type: 'USE_ITEM', itemId: id, ...extra }) as PlayerAction;

function checkSameSource(kind: 'card' | 'item', id: string): void {
  const base = baseGame();
  const state = armed(base, kind, id);
  const actor = state.players[state.currentPlayerIndex]!;
  const spec = kind === 'card' ? CARDS[id]!.targetSpec : ITEMS[id]!.targetSpec;
  const set = actionTargets(state, actor, spec);

  // 通用项先过一遍：这个动作在**不带目标**时不该因为目标而被拒
  for (const cell of set.cells) {
    expect(actionRefusal(state, probe(kind, id, { cellId: cell })), `${id} 候选格 ${cell}`).toBeNull();
  }
  for (const bad of set.rejectedCells) {
    expect(actionRefusal(state, probe(kind, id, { cellId: bad.id })), `${id} 被拒格 ${bad.id}`).toBe(bad.reason);
  }
  for (const pid of set.players) {
    expect(actionRefusal(state, probe(kind, id, { targetPlayerId: pid })), `${id} 候选玩家 ${pid}`).toBeNull();
  }
  for (const bad of set.rejectedPlayers) {
    expect(actionRefusal(state, probe(kind, id, { targetPlayerId: bad.id })), `${id} 被拒玩家 ${bad.id}`).toBe(bad.reason);
  }
  for (const stockId of set.stocks) {
    expect(actionRefusal(state, probe(kind, id, { stockId })), `${id} 候选股票 ${stockId}`).toBeNull();
  }
  for (const diceValue of set.diceValues) {
    expect(actionRefusal(state, probe(kind, id, { diceValue })), `${id} 候选点数 ${diceValue}`).toBeNull();
  }

  // 声明了「要挑一样东西」却一个候选都拿不出 ⇒ 门控必须给得出理由（UI 才能把这张卡灰掉并说为什么）。
  // 只声明骰点的动作（遥控骰子）不在其列：它的候选恒为 1~6，不构成"挑不出东西"。
  const declaresPick = spec.cells || spec.players || spec.stocks;
  const nothingToPick = set.cells.length === 0 && set.players.length === 0 && set.stocks.length === 0;
  if (declaresPick && nothingToPick) {
    const reason = actionRefusal(state, probe(kind, id, {}));
    expect(typeof reason, `${id} 无候选却拿不到理由`).toBe('string');
  }
}

describe('目标同源：候选枚举 ⇔ 门控校验', () => {
  it('30 张卡逐个核对（候选必放行、被拒必同句理由）', () => {
    expect(ALL_CARD_IDS).toHaveLength(30);
    for (const cardId of ALL_CARD_IDS) checkSameSource('card', cardId);
  });

  it('13 件道具逐个核对（同上）', () => {
    expect(ALL_ITEM_IDS).toHaveLength(13);
    for (const itemId of ALL_ITEM_IDS) checkSameSource('item', itemId);
  });
});

describe('目标必须显式给出（W1 删掉了「缺省取脚下」）', () => {
  it('需要选格的卡不传 cellId ⇒ 门控就拒，而不是悄悄打到脚下', () => {
    const g = armed(baseGame(), 'card', 'monster');
    expect(actionRefusal(g, { type: 'USE_CARD', cardId: 'monster' })).toBe('请选择目标格');
    // 旧实现会把脚下那格当目标 —— 脚下是机会格，于是抛的是「没有可摧毁的建筑」，
    // 玩家看到的那句话与自己的操作毫无关系
    const rolled = structuredClone(g);
    rolled.players[rolled.currentPlayerIndex]!.position = 11;
    expect(actionRefusal(rolled, { type: 'USE_CARD', cardId: 'monster' })).toBe('请选择目标格');
  });

  it('脚下类卡（购地）指定别格 ⇒ 拒在「只能作用于落脚处」，不再靠忽略 cellId', () => {
    const g = armed(baseGame(), 'card', 'buy-land');
    const p = g.players[g.currentPlayerIndex]!;
    const other = g.board.find((c) => c.id !== p.position && (c.type === 'property' || c.type === 'commercial'))!;
    expect(actionRefusal(g, { type: 'USE_CARD', cardId: 'buy-land', cellId: other.id })).toContain('只能作用于落脚处');
  });

  it('拆除卡把路障 / 地雷格也算合法候选（谓词并集，枚举看得见）', () => {
    const base = armed(baseGame(), 'card', 'demolish');
    const g = structuredClone(base);
    const p = g.players[g.currentPlayerIndex]!;
    const target = g.board.find((c) => c.id !== p.position)!.id;
    g.mines = [...g.mines, { cellId: target, ownerId: 'p2' }];
    const set = actionTargets(g, g.players[g.currentPlayerIndex]!, CARDS.demolish!.targetSpec);
    expect(set.cells).toContain(target);
    expect(actionRefusal(g, { type: 'USE_CARD', cardId: 'demolish', cellId: target })).toBeNull();
  });

  it('视野类卡片把窗外对手列进「被拒」而不是干脆不列', () => {
    const base = armed(baseGame(), 'card', 'frame');
    const g = structuredClone(base);
    const p = g.players[g.currentPlayerIndex]!;
    const far = g.players.find((q) => q.id !== p.id)!;
    const near = g.players.find((q) => q.id !== p.id && q.id !== far.id)!;
    // 把 far 挪到窗外、near 挪到脚下隔壁，两类都要在结果里各归其位
    far.position = (p.position + 15) % g.board.length;
    near.position = (p.position + 1) % g.board.length;
    const set = actionTargets(g, g.players[g.currentPlayerIndex]!, CARDS.frame!.targetSpec);
    expect(set.players).toContain(near.id);
    expect(set.rejectedPlayers.map((r) => r.id)).toContain(far.id);
    expect(set.rejectedPlayers.find((r) => r.id === far.id)!.reason).toContain('不在视野内');
  });
});
