/**
 * 神明系统（GOD-01..12，对标 `docs/gameplay/玩法系统_游戏开发文档.md` §8.1）。
 *
 * 设计要点（波 4）：
 * - **天数制**：每位神明以「天」计时（1 天 = 所有角色各行动一次），由日切钩子 `godTickHook` 递减。
 * - **对偶转化**：财/福/穷/衰 在「大 ⇄ 小」之间循环；天使 ⇄ 恶魔；死神固定 13 天且期满**自动消失**。
 * - **附身效果**：神明附身（含转化）瞬间一次性结算。
 * - **行进显灵**：附身期间移动/落格时被动生效（抵赖租金、加倍租金、免费买地、加盖/拆屋……）。
 *
 * 本模块同时承载神明的**数据**（`GODS`）与**行为**（附身结算、显灵、日切计时），
 * 行为所需的引擎能力（日志 / 扣款 / 抽卡 / 查地权）由 `engine.ts` 注入 `GodEffectCtx`，
 * 以免数据模块反向依赖引擎形成循环。
 */

import { BOARD_SIZE } from './board.js';
import { gameDate } from './calendar.js';
import { scaled } from './economy.js';
import type { GodEffectCtx } from './effect_ctx.js';
import { nextRandom } from './rng.js';
import { MAX_GRADE } from './tiles.js';
import type { BoardCell, GameState, Player } from './types.js';

export interface GodDef {
  id: string;
  name: string;
  /** 附身效果（一次性结算） */
  possession: string;
  /** 行进显灵（附身期间被动生效），无则空串 */
  travel: string;
  /** 有效期（天） */
  durationDays: number;
  /** 期满对偶转化目标 godId；不填表示期满自动离开 */
  transformsTo?: string;
  /**
   * 神明所居格（BOARD_SIZE 圈上的格号），用于 CARD-23 请神卡「取最靠近自己的神明」。
   * 围绕神庙（TILE 神庙格 15）左右散布；缺省表示与神庙同格。
   */
  cellId?: number;
}

/** 神明有效期：常规 7 天 */
export const GOD_DURATION_DAYS = 7;
/** 死神有效期：固定 13 天（GOD-12） */
export const DEATH_DURATION_DAYS = 13;

/**
 * 十二尊神明（GOD-01..12）。
 * 转化闭环：大财神⇄小财神、大福神⇄小福神、大穷神⇄小穷神、大衰神⇄小衰神、天使⇄恶魔。
 */
export const GODS: GodDef[] = [
  {
    id: 'land-god',
    name: '土地公',
    possession: '所到之地均占为己有，不必缴过路费',
    travel: '',
    durationDays: GOD_DURATION_DAYS,
    cellId: 3,
  },
  {
    id: 'big-wealth',
    name: '大财神',
    possession: '意外获得四位数现金',
    travel: '抵赖所有租金',
    durationDays: GOD_DURATION_DAYS,
    cellId: 6,
    transformsTo: 'small-wealth',
  },
  {
    id: 'small-wealth',
    name: '小财神',
    possession: '可向其他人收取三位数现金',
    travel: '抵赖一半租金',
    durationDays: GOD_DURATION_DAYS,
    cellId: 7,
    transformsTo: 'big-wealth',
  },
  {
    id: 'big-fortune',
    name: '大福神',
    possession: '送两张卡片（内容随机）',
    travel: '买地完全免费、盖房投资铁定加倍',
    durationDays: GOD_DURATION_DAYS,
    cellId: 8,
    transformsTo: 'small-fortune',
  },
  {
    id: 'small-fortune',
    name: '小福神',
    possession: '送一张卡片',
    travel: '盖房投资加倍',
    durationDays: GOD_DURATION_DAYS,
    cellId: 9,
    transformsTo: 'big-fortune',
  },
  {
    id: 'big-poverty',
    name: '大穷神',
    possession: '损失四位数现金',
    travel: '踩到别人的地租金必定加倍',
    durationDays: GOD_DURATION_DAYS,
    cellId: 10,
    transformsTo: 'small-poverty',
  },
  {
    id: 'small-poverty',
    name: '小穷神',
    possession: '送给其他每个人三位数现金',
    travel: '租金加倍',
    durationDays: GOD_DURATION_DAYS,
    cellId: 11,
    transformsTo: 'big-poverty',
  },
  {
    id: 'big-misfortune',
    name: '大衰神',
    possession: '卡片遗失一半',
    travel: '买地绝对流标、投资注定失败',
    durationDays: GOD_DURATION_DAYS,
    cellId: 12,
    transformsTo: 'small-misfortune',
  },
  {
    id: 'small-misfortune',
    name: '小衰神',
    possession: '遗失一张卡片',
    travel: '买地流标、投资失败',
    durationDays: GOD_DURATION_DAYS,
    cellId: 13,
    transformsTo: 'big-misfortune',
  },
  {
    id: 'angel',
    name: '天使',
    possession: '所到之处一律加盖一层房屋',
    travel: '',
    durationDays: GOD_DURATION_DAYS,
    cellId: 2,
    transformsTo: 'devil',
  },
  {
    id: 'devil',
    name: '恶魔',
    possession: '所到之处一律拆掉一层房屋',
    travel: '',
    durationDays: GOD_DURATION_DAYS,
    cellId: 4,
    transformsTo: 'angel',
  },
  {
    id: 'death',
    name: '死神',
    possession: '遗失所有卡片道具，并发生一连串倒霉事',
    travel: '',
    durationDays: DEATH_DURATION_DAYS,
    cellId: 5,
  },
];

/** 按 id 查神明定义 */
export function godDef(id: string): GodDef | undefined {
  return GODS.find((g) => g.id === id);
}

/** 不祥神明（穷神/衰神/死神）——AI 优先用送神卡送走 */
export function isNegativeGod(id: string | undefined): boolean {
  if (!id) return false;
  return id.includes('poverty') || id.includes('misfortune') || id === 'death';
}

/** 神明附身效果的一句话摘要（UI 用） */
export function godSummary(def: GodDef): string {
  return def.travel ? `${def.possession}；${def.travel}` : def.possession;
}

/* ==========================================================================
 * 神明行为（GOD-01..12 的效果实现；数据定义见上方 `GODS`）
 *
 * 自 `engine.ts` 逐字迁出：神明要写日志、扣款、抽卡、查地权，这些能力都在引擎侧，
 * 由调用方注入 `GodEffectCtx`。附身 / 对偶转化 / 死神降临的**语义**属于神明系统，
 * 新增一尊神只需改本文件，不必再去引擎里加 switch 分支。
 * ========================================================================== */

/** 确定性取 [min, max] 闭区间整数（附身效果数值用，走 state.rngState） */
function godRoll(state: GameState, min: number, max: number): number {
  const draw = nextRandom(state.rngState);
  state.rngState = draw.nextState;
  return min + Math.floor(draw.value * (max - min + 1));
}

/** 随机遗失 n 张手牌（GOD-08/09），返回遗失的卡片 id */
function loseRandomCards(state: GameState, p: Player, n: number): string[] {
  const lost: string[] = [];
  for (let i = 0; i < n && p.cards.length > 0; i++) {
    lost.push(p.cards.splice(godRoll(state, 0, p.cards.length - 1), 1)[0]!);
  }
  return lost;
}

/** 当前自然月的序号（跨月即变化，用于 GOD-01 隔月冷却） */
function currentMonthIndex(state: GameState): number {
  const d = gameDate(state);
  return d.year * 12 + d.month;
}

/**
 * 请神卡（CARD-23）：取「最靠近自己」的一位神明（help/文档 CARD-23）。
 * 原版按棋盘距离取最近，改为纯计算（零抽数）；并列时取定义序靠前者。
 */
export function nearestGodFor(p: Player): GodDef {
  const dist = (cellId: number): number => {
    const d = Math.abs(cellId - p.position);
    return Math.min(d, BOARD_SIZE - d);
  };
  let best = GODS[0]!;
  let bestDist = Infinity;
  for (const def of GODS) {
    const d = dist(def.cellId ?? 5);
    if (d < bestDist) {
      bestDist = d;
      best = def;
    }
  }
  return best;
}

/** 神明附身（含期满对偶转化）：设置计时并一次性结算附身效果（GOD §8.1） */
export function attachGod(ctx: GodEffectCtx, p: Player, def: GodDef): void {
  const { state } = ctx;
  p.god = { godId: def.id, remainingDays: def.durationDays };
  ctx.log(state, `${def.name} 附身 ${p.name}！${def.possession}（持续 ${def.durationDays} 天）`);
  applyGodPossession(ctx, p, def);
}

/** 附身效果（一次性结算） */
export function applyGodPossession(ctx: GodEffectCtx, p: Player, def: GodDef): void {
  const { state } = ctx;
  switch (def.id) {
    case 'big-wealth': {
      const gain = scaled(state, godRoll(state, 1000, 3999));
      p.cash += gain;
      ctx.log(state, `大财神显灵，${p.name} 意外获得 ¥${gain}`);
      break;
    }
    case 'small-wealth': {
      const each = scaled(state, godRoll(state, 100, 999));
      ctx.log(state, `小财神显灵，${p.name} 向每位对手收取 ¥${each}`);
      for (const other of state.players) {
        if (other.id === p.id || other.bankrupt) continue;
        ctx.pay(state, other, each, p, { reason: 'god' });
      }
      break;
    }
    case 'big-fortune': {
      ctx.drawChanceCard(state, p, '大福神');
      ctx.drawChanceCard(state, p, '大福神');
      break;
    }
    case 'small-fortune': {
      ctx.drawChanceCard(state, p, '小福神');
      break;
    }
    case 'big-poverty': {
      const loss = scaled(state, godRoll(state, 1000, 3999));
      ctx.log(state, `大穷神作祟，${p.name} 损失 ¥${loss}`);
      ctx.payCash(state, p, loss, null, 'god');
      break;
    }
    case 'small-poverty': {
      const each = scaled(state, godRoll(state, 100, 999));
      ctx.log(state, `小穷神作祟，${p.name} 送给每位对手 ¥${each}`);
      for (const other of state.players) {
        if (other.id === p.id || other.bankrupt) continue;
        ctx.pay(state, p, each, other, { reason: 'god' });
        if (p.bankrupt) break;
      }
      break;
    }
    case 'big-misfortune': {
      const lost = loseRandomCards(state, p, Math.floor(p.cards.length / 2));
      ctx.log(state, `大衰神作祟，${p.name} 遗失 ${lost.length} 张卡片（剩余 ${p.cards.length} 张）`);
      break;
    }
    case 'small-misfortune': {
      const lost = loseRandomCards(state, p, 1);
      ctx.log(state, `小衰神作祟，${p.name}${lost.length > 0 ? '遗失一张卡片' : '手牌已空，无卡可失'}`);
      break;
    }
    case 'death': {
      const cardCount = p.cards.length;
      const itemCount = Object.values(p.items).reduce((a, b) => a + b, 0);
      p.cards = [];
      p.items = {};
      const loss = scaled(state, 2000);
      ctx.log(state, `死神降临！${p.name} 遗失全部 ${cardCount} 张卡片与 ${itemCount} 件道具，并遭逢一连串倒霉事损失 ¥${loss}`);
      ctx.payCash(state, p, loss, null, 'god');
      break;
    }
    default:
      // 土地公 / 天使 / 恶魔：效果在移动路径上被动生效（applyGodTravel）
      break;
  }
}

/**
 * 行进显灵·租金类（GOD-02/03/06/07）：返回调整后的应付过路费；返回 0 表示完全抵赖。
 */
export function applyGodRentModifier(ctx: GodEffectCtx, p: Player, rent: number, cellName: string): number {
  const { state } = ctx;
  const id = p.god?.godId;
  if (!id || rent <= 0) return rent;
  const name = godDef(id)?.name ?? '神明';
  if (id === 'land-god' || id === 'big-wealth') {
    ctx.log(state, `${name}显灵，${p.name} 抵赖了「${cellName}」的全部租金`);
    return 0;
  }
  if (id === 'small-wealth') {
    const half = Math.floor(rent / 2);
    ctx.log(state, `${name}显灵，「${cellName}」租金减半至 ¥${half}`);
    return half;
  }
  if (id === 'big-poverty' || id === 'small-poverty') {
    ctx.log(state, `${name}显灵，「${cellName}」租金加倍至 ¥${rent * 2}`);
    return rent * 2;
  }
  return rent;
}

/**
 * 行进显灵·落格类（GOD-01 土地公侵占 / GOD-10 天使加盖 / GOD-11 恶魔拆屋）：
 * 在落格结算前对当格生效。
 */
export function applyGodTravel(ctx: GodEffectCtx, p: Player, c: BoardCell): void {
  const { state } = ctx;
  const id = p.god?.godId;
  if (!id) return;
  if (id === 'land-god') {
    if ((c.type === 'property' || c.type === 'commercial') && c.price !== undefined && !ctx.cellOwner(state, c.id)) {
      p.properties.push({ cellId: c.id, grade: 1 });
      ctx.log(state, `土地公显灵，${p.name} 将无主之地「${c.name}」占为己有`);
    }
    return;
  }
  if (id !== 'angel' && id !== 'devil') return;
  const owned = ctx.cellOwner(state, c.id);
  if (!owned) return;
  const prop = owned.property;
  if (c.type === 'commercial' && !prop.facility) return;
  if (id === 'angel') {
    if (prop.grade >= MAX_GRADE) return;
    prop.grade = (prop.grade + 1) as 1 | 2 | 3 | 4 | 5;
    ctx.log(state, `天使显灵，「${c.name}」加盖一层至 ${prop.grade} 级`);
  } else {
    if (prop.grade <= 1) return;
    prop.grade = (prop.grade - 1) as 1 | 2 | 3 | 4 | 5;
    ctx.log(state, `恶魔显灵，「${c.name}」被拆掉一层至 ${prop.grade} 级`);
  }
}

/** 神庙摇籤：随机召唤一位神明附身（走 RNG）；土地公受隔月冷却限制（help [40]） */
export function summonGod(ctx: GodEffectCtx, p: Player): void {
  const { state } = ctx;
  const month = currentMonthIndex(state);
  const draw = nextRandom(state.rngState);
  state.rngState = draw.nextState;
  const candidates = GODS.filter((g) => g.id !== 'land-god' || state.landGodCooldownMonth !== month);
  // 全部候选都被冷却时（局内仅土地公且同月）退化为全池，保证总能附身
  const pool = candidates.length > 0 ? candidates : GODS;
  const def = pool[Math.floor(draw.value * pool.length)]!;
  if (def.id === 'land-god') state.landGodCooldownMonth = month;
  attachGod(ctx, p, def);
}

/** GOD-01..12：神明按天计时，期满对偶转化或离开（死神 13 天到期自动消失） */
export function godTickHook(ctx: GodEffectCtx): void {
  const { state } = ctx;
  for (const p of state.players) {
    if (ctx.isGameOver(state)) return;
    if (p.bankrupt || !p.god) continue;
    const current = godDef(p.god.godId);
    if (!current) {
      p.god = null;
      continue;
    }
    p.god.remainingDays -= 1;
    if (p.god.remainingDays > 0) continue;
    const next = current.transformsTo ? godDef(current.transformsTo) : undefined;
    p.god = null;
    if (next) {
      ctx.log(state, `${current.name} 期满，对偶转化为 ${next.name}`);
      attachGod(ctx, p, next);
    } else {
      ctx.log(state, `${current.name} 离开了 ${p.name}`);
    }
  }
}

/**
 * GOD-12 死神附身于「复仇者」（UI-13 认输投降：认输者指定的死神落点）。
 *
 * 原版 help[51]「死神附身時，不但會遺失所有卡片道具，還會發生一連串倒楣的事情。為期十三天」。
 * 死神是被认输者**指名**落在复仇者头上的，因此倒霉事**加倍**（multiplier = 2）：
 * 1. 清空全部卡片与道具；
 * 2. 立刻扣一笔「死神索命」损失；
 * 3. 进入霉运状态 13 天，期间负面事件与租金按2 倍放大；
 * 4. 死神本体附身 13 天（GOD-12 期满自动消失，不转化）。
 */
export function summonDeathOnAvenger(ctx: GodEffectCtx, avenger: Player, death: GodDef | undefined): void {
  const { state } = ctx;
  const cards = avenger.cards.length;
  const items = Object.values(avenger.items).reduce((a, b) => a + b, 0);
  avenger.cards = [];
  avenger.items = {};
  avenger.god = { godId: 'death', remainingDays: death?.durationDays ?? DEATH_DURATION_DAYS };
  // 霉运加倍：13 天内倒霉事按 2 倍计
  avenger.unlucky = { daysLeft: DEATH_DURATION_DAYS, multiplier: 2 };
  const loss = scaled(state, 2000 * 2); // 死神索命，加倍
  ctx.log(
    state,
    `【死神附身】${avenger.name} 被推举为复仇者：遗失全部 ${cards} 张卡片与 ${items} 件道具，` +
      `并陷入 ${DEATH_DURATION_DAYS} 天霉运（倒霉事**加倍**），当下即损失 ¥${loss}`,
  );
  ctx.payCash(state, avenger, loss, null, 'god');
}

/** 行进显灵辅助：买地完全免费（GOD-04 大福神） */
export function godFreeLandPurchase(p: Player): boolean {
  return p.god?.godId === 'big-fortune';
}

/** 行进显灵辅助：买地流标、投资失败（GOD-08/09 衰神） */
export function godBlocksInvestment(p: Player): boolean {
  return p.god?.godId === 'big-misfortune' || p.god?.godId === 'small-misfortune';
}

/** 行进显灵辅助：盖房投资加倍（GOD-04/05 大/小福神） */
export function godDoublesBuild(p: Player): boolean {
  return p.god?.godId === 'big-fortune' || p.god?.godId === 'small-fortune';
}