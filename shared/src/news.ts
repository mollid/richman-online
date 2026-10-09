/**
 * EVT-01 新闻事件池（36 条，id 0–35）。
 *
 * 数据来源：`docs/extraction/news_事件池拆解报告.md`（自 mytbk/rich4 带注释反汇编还原），
 * 原文/分类/效果/数值常量均照抄该报告，不另作演绎。
 *
 * 与原版一致的机制：
 * - 游标从 `state.newsCursor` 起在池内轮询，对每条先做前提检查（check_news），
 *   抽到第一条满足的即播出；一圈全不满足则「本期无事」。
 * - 标题栏六类：无责任新闻 / 政府公告 / 社会新闻 / 路况报道 / 气象报道 / 财经新闻。
 *
 * 与报告的差异（因本作波 1–6 已落地股票 / 公司 / 贷款 / 拍卖 / 监狱 / 医院）：
 * 报告中标 ⏸ 的条目依赖的系统均已具备，故 36 条全部可触发（见 `supportedNewsEvents`）。
 * 本池放在常量模块，**不进 GameState**（快照体积约束）。
 */

import type { NewsEffectCtx } from './effect_ctx.js';
import { propertyValue, scaled } from './economy.js';
import type { Player } from './types.js';

export type NewsCategory = 'no-fault' | 'government' | 'social' | 'traffic' | 'weather' | 'finance';

/** 欢乐/悲伤两类（EVT-01） */
export type NewsMood = 'happy' | 'sad';

export type NewsEffectKind =
  | 'clear-jail'
  | 'extend-jail'
  | 'clear-hospital'
  | 'extend-hospital'
  | 'destroy-one'
  | 'street-up'
  | 'auction-land'
  | 'reward-most-land'
  | 'subsidize-least-land'
  | 'reward-top-shareholder'
  | 'income-tax'
  | 'land-tax'
  | 'securities-tax'
  | 'street-down'
  | 'burn-house'
  | 'halt-walkers'
  | 'halt-riders'
  | 'destroy-many'
  | 'loan-ban'
  | 'deposit-dividend'
  | 'stock-crash'
  | 'stock-rally'
  | 'stock-halt-all'
  | 'stock-halt-one'
  | 'stock-resume-one'
  | 'company-jail'
  | 'company-fine'
  | 'company-gain'
  | 'company-loss'
  | 'company-profit-double';

export interface NewsEventDef {
  id: number;
  category: NewsCategory;
  mood: NewsMood;
  /** 原文模板；`{street}` / `{player}` / `{company}` / `{stock}` / `{amount}` 为占位符 */
  text: string;
  effect: NewsEffectKind;
  /** 金钱类效果的**基础**金额（过物价指数） */
  amount?: number;
  /** 比例类效果（0.05 = 5%） */
  rate?: number;
  /** 天数类效果 */
  days?: number;
  /** 地价乘数（1.3 / 0.7） */
  factor?: number;
}

export const NEWS_CATEGORY_LABEL: Record<NewsCategory, string> = {
  'no-fault': '无责任新闻',
  government: '政府公告',
  social: '社会新闻',
  traffic: '路况报道',
  weather: '气象报道',
  finance: '财经新闻',
};

/** 全量 36 条事件池（id 0–35，顺序与原版一致） */
export const NEWS_EVENTS: NewsEventDef[] = [
  // ---- 无责任新闻（0–5） ----
  { id: 0, category: 'no-fault', mood: 'happy', text: '狱中囚犯无罪开释', effect: 'clear-jail' },
  { id: 1, category: 'no-fault', mood: 'sad', text: '狱中囚犯延长刑期 3 天', effect: 'extend-jail', days: 3 },
  { id: 2, category: 'no-fault', mood: 'happy', text: '住院中病患提前出院', effect: 'clear-hospital' },
  { id: 3, category: 'no-fault', mood: 'sad', text: '住院中病患延长住院 3 天', effect: 'extend-hospital', days: 3 },
  { id: 4, category: 'no-fault', mood: 'sad', text: '外星人攻打地球', effect: 'destroy-one' },
  { id: 5, category: 'no-fault', mood: 'sad', text: '外星怪兽袭击{street}，摧毁建筑一栋', effect: 'destroy-one' },

  // ---- 政府公告（6–13） ----
  { id: 6, category: 'government', mood: 'happy', text: '{street}公告地价调涨 30%', effect: 'street-up', factor: 1.3 },
  { id: 7, category: 'government', mood: 'happy', text: '公开拍卖{street}公有土地一处', effect: 'auction-land' },
  { id: 8, category: 'government', mood: 'happy', text: '公开表扬第一大地主，{player}获得 {amount} 元奖励', effect: 'reward-most-land', amount: 10000 },
  { id: 9, category: 'government', mood: 'happy', text: '公开补助土地最少者，{player}获得 {amount} 元补助', effect: 'subsidize-least-land', amount: 10000 },
  { id: 10, category: 'government', mood: 'happy', text: '公开表扬股市第一大户，{player}获得 {amount} 元奖励', effect: 'reward-top-shareholder', amount: 10000 },
  { id: 11, category: 'government', mood: 'sad', text: '所有人缴交所得税 5%', effect: 'income-tax', rate: 0.05 },
  { id: 12, category: 'government', mood: 'sad', text: '所有人缴交地价税 5%', effect: 'land-tax', rate: 0.05 },
  { id: 13, category: 'government', mood: 'sad', text: '所有人缴交证交税 5%', effect: 'securities-tax', rate: 0.05 },

  // ---- 社会新闻（14–15） ----
  { id: 14, category: 'social', mood: 'sad', text: '{street}房屋闹鬼，地价下跌 30%', effect: 'street-down', factor: 0.7 },
  { id: 15, category: 'social', mood: 'sad', text: '{street}一处民宅瓦斯爆炸，房屋失火', effect: 'burn-house' },

  // ---- 路况报道（16–17） ----
  { id: 16, category: 'traffic', mood: 'sad', text: '豪雨特报，行人休息一回合', effect: 'halt-walkers', days: 1 },
  { id: 17, category: 'traffic', mood: 'sad', text: '交通阻塞，汽车停止一回合', effect: 'halt-riders', days: 1 },

  // ---- 气象报道（18–21） ----
  { id: 18, category: 'weather', mood: 'sad', text: '{street}强烈地震，房屋倒塌', effect: 'destroy-many' },
  { id: 19, category: 'weather', mood: 'sad', text: '{street}山洪爆发，土地流失', effect: 'destroy-many' },
  { id: 20, category: 'weather', mood: 'sad', text: '超级台风侵袭{street}，多处房屋受损', effect: 'destroy-many' },
  { id: 21, category: 'weather', mood: 'sad', text: '龙卷风侵袭{street}，摧毁房屋一栋', effect: 'destroy-one' },

  // ---- 财经新闻（22–35） ----
  { id: 22, category: 'finance', mood: 'sad', text: '银行挤兑，停止放款 15 天', effect: 'loan-ban', days: 15 },
  { id: 23, category: 'finance', mood: 'happy', text: '银行加发 10% 储金红利', effect: 'deposit-dividend', rate: 0.1 },
  { id: 24, category: 'finance', mood: 'sad', text: '股市低迷不振，重挫崩盘', effect: 'stock-crash' },
  { id: 25, category: 'finance', mood: 'happy', text: '股市气势如虹，全面上涨', effect: 'stock-rally' },
  { id: 26, category: 'finance', mood: 'sad', text: '股市暂停交易 10 天', effect: 'stock-halt-all', days: 10 },
  { id: 27, category: 'finance', mood: 'sad', text: '{stock}股票暂停交易 10 天', effect: 'stock-halt-one', days: 10 },
  { id: 28, category: 'finance', mood: 'happy', text: '{stock}股票恢复上市交易', effect: 'stock-resume-one' },
  { id: 29, category: 'finance', mood: 'sad', text: '{company}违法超贷，经营者{player}坐牢 5 天', effect: 'company-jail', days: 5 },
  { id: 30, category: 'finance', mood: 'sad', text: '{company}工厂排放污水，罚款 {amount} 元', effect: 'company-fine', amount: 10000 },
  { id: 31, category: 'finance', mood: 'happy', text: '{company}海外投资，获利 {amount} 元', effect: 'company-gain', amount: 20000 },
  { id: 32, category: 'finance', mood: 'sad', text: '{company}海外投资，亏损 {amount} 元', effect: 'company-loss', amount: 20000 },
  { id: 33, category: 'finance', mood: 'sad', text: '{company}违规开发山坡地，罚款 {amount} 元', effect: 'company-fine', amount: 10000 },
  { id: 34, category: 'finance', mood: 'sad', text: '{company}制造噪音公害，罚款 {amount} 元', effect: 'company-fine', amount: 5000 },
  { id: 35, category: 'finance', mood: 'happy', text: '{company}获利调高一倍', effect: 'company-profit-double' },
];

/** 事件总数（用于断言/UI） */
export const NEWS_EVENT_COUNT = NEWS_EVENTS.length;

/**
 * 当前引擎可触发的事件子集。
 * 报告中标 ⏸ 的条目（股票 / 公司 / 贷款 / 拍卖 / 监狱 / 医院）依赖的系统已在波 1–6 落地，
 * 故此处暂为全量；保留该函数作为后续按版本裁剪的单一出口。
 */
export function supportedNewsEvents(): NewsEventDef[] {
  return NEWS_EVENTS;
}

export function newsEventById(id: number): NewsEventDef | undefined {
  return NEWS_EVENTS.find((e) => e.id === id);
}

/** 按模板渲染正文（未提供的占位符替换为空串） */
export function renderNewsText(def: NewsEventDef, params: Partial<Record<'street' | 'player' | 'company' | 'stock' | 'amount', string>> = {}): string {
  return def.text.replace(/\{(street|player|company|stock|amount)\}/g, (_m, key: string) => params[key as keyof typeof params] ?? '');
}

/** EVT-01 事件 16/17：豪雨/交通阻塞强制停留天数 */
const TRAFFIC_HALT_DAYS = 1;
/** EVT-01 事件 24/25：股市全面崩盘/上涨的幅度（%） */
const STOCK_NEWS_PCT = 10;

/** 事件 0–3：在押 / 住院者的开释与延期（四条新闻共用一体，按 `def.effect` 分流） */
function custodyEvent(ctx: NewsEffectCtx): string {
  const { state, def, activePlayers, blockRent } = ctx;
  const kind: 'jail' | 'hospital' = def.effect.endsWith('jail') ? 'jail' : 'hospital';
  const clearing = def.effect.startsWith('clear');
  const days = def.days ?? 0;
  const targets = activePlayers(state).filter((q) => q.custody?.kind === kind);
  for (const v of targets) {
    if (clearing) {
      v.skipTurns = 0;
      v.custody = null;
      v.rentBlockedTurns = 0;
    } else {
      v.skipTurns += days;
      v.custody!.daysLeft += days;
      blockRent(v, days);
    }
  }
  return targets.length ? targets.map((v) => v.name).join('、') : '无人在押';
}

/** 随机拆掉一栋已建成建筑；`describe` 生成播报尾注（事件 4/21 与 15 的措辞不同） */
function demolishOne(ctx: NewsEffectCtx, describe: (name: string) => string): string {
  const { state, params, randomPick, builtProperties, streetLabel, destroyBuilding } = ctx;
  const ref = randomPick(state, builtProperties(state));
  if (!ref) return '';
  params.street = ref.cell.street ? streetLabel(state, ref.cell.street) : ref.cell.name;
  const extra = describe(ref.cell.name);
  destroyBuilding(ref);
  return extra;
}

/** 事件 6/14：路段地价涨跌（永久生效于买地价与租金） */
function streetPriceEvent(ctx: NewsEffectCtx): string {
  const { state, def, params, randomPick, ownedStreets, streetLabel } = ctx;
  const street = randomPick(state, ownedStreets(state));
  if (!street) return '';
  const factor = def.factor ?? 1;
  state.streetPriceFactors[street] = (state.streetPriceFactors[street] ?? 1) * factor;
  params.street = streetLabel(state, street);
  return `该路段地价 ×${factor}`;
}

/**
 * 事件 11/12/13：三项税收的共用征收循环。
 * 报告：税率 0.05 直接作用于名义值（现金 / 地价+造价 / 股票市值），不乘物价指数；
 * 物价指数只用于固定金额（奖励、罚款、门票等）。
 */
function collectTax(ctx: NewsEffectCtx, baseOf: (q: Player) => number): string | null {
  const { state, def, activePlayers, payCash, isGameOver } = ctx;
  const rate = def.rate ?? 0;
  let sum = 0;
  for (const q of activePlayers(state)) {
    const tax = Math.floor(baseOf(q) * rate);
    if (tax <= 0) continue;
    sum += tax;
    payCash(state, q, tax, null, 'news');
    if (isGameOver(state)) return null;
  }
  return `合计征收 ¥${sum}`;
}

/** 事件 30/31/32/33/34：随机一家公司的累积盈余增减 */
function surplusDelta(ctx: NewsEffectCtx, sign: 1 | -1): string {
  const { state, def, params, randomPick } = ctx;
  const company = randomPick(state, state.companies);
  if (!company) return '';
  const delta = scaled(state, def.amount ?? 0);
  company.surplus += sign * delta;
  params.company = state.board[company.cellId]?.name ?? '';
  params.amount = String(delta);
  return `累积盈余 ${sign > 0 ? '+' : '-'}¥${delta}`;
}

/** 事件 24/25：全市场涨跌（已停牌或个股暂停交易的除外） */
function stockSwing(ctx: NewsEffectCtx, sign: 1 | -1): string {
  const { state, isStockSuspended } = ctx;
  for (const s of state.stockMarket.stocks) {
    if (state.stockHaltAllDays > 0 || isStockSuspended(state, s.id)) continue;
    const pct = sign * STOCK_NEWS_PCT;
    s.price = Math.max(5, Math.round(s.price * (1 + pct / 100)));
    s.lastChangePct = pct;
  }
  return `全市场${sign > 0 ? '上涨' : '下跌'} ${STOCK_NEWS_PCT}%`;
}

/**
 * 新闻效果行为表（自 `engine.ts` 的 `applyNewsEvent` switch 逐字迁出）。
 *
 * 键与 `NewsEffectKind` 一一对应，`Record` 即编译期穷举保护：新增一种效果必须在此
 * 补一条实现，不会再出现「事件池写了、引擎 switch 漏了」的静默失配。
 *
 * 返回值 = 播报括弧里的补充说明（原 `extra` 变量），空串表示不追加；
 * **`null` 表示对局已结束** —— 税收类事件逐人征收时若有人因此破产，原实现是中途
 * `return` 且不再播报，`engine.applyNewsEvent` 据此跳过这条新闻日志。
 */
export const NEWS_EFFECTS: Record<NewsEffectKind, (ctx: NewsEffectCtx) => string | null> = {
  // ---- 事件 0–3：囚犯 / 病患的开释与延期 ----
  'clear-jail': custodyEvent,
  'extend-jail': custodyEvent,
  'clear-hospital': custodyEvent,
  'extend-hospital': custodyEvent,

  // ---- 事件 4/5/21/15：摧毁建筑 ----
  'destroy-one': (ctx) => demolishOne(ctx, (name) => `「${name}」建筑被摧毁`),
  'burn-house': (ctx) => demolishOne(ctx, (name) => `「${name}」付之一炬，建筑归零`),
  'destroy-many': (ctx) => {
    const { state, params, randomPick, builtProperties, streetLabel, destroyBuilding } = ctx;
    const names: string[] = [];
    let street = '';
    for (let i = 0; i < 2; i++) {
      const ref = randomPick(state, builtProperties(state));
      if (!ref) break;
      if (!street && ref.cell.street) street = streetLabel(state, ref.cell.street);
      names.push(ref.cell.name);
      destroyBuilding(ref);
    }
    params.street = street;
    return names.length ? `${names.join('、')} 建筑受损` : '';
  },

  // ---- 事件 6/14：地价涨跌 ----
  'street-up': streetPriceEvent,
  'street-down': streetPriceEvent,

  // ---- 事件 7：公开拍卖公有土地 ----
  'auction-land': (ctx) => {
    const { state, params, randomPick, unownedLandCells, streetLabel } = ctx;
    const cell = randomPick(state, unownedLandCells(state));
    if (!cell) return '';
    state.auctionQueue.push({ cellId: cell.id, sellerId: null, trigger: 'event' });
    params.street = cell.street ? streetLabel(state, cell.street) : cell.name;
    return `「${cell.name}」交付拍卖`;
  },

  // ---- 事件 8/9/10：政府奖励与补助 ----
  'reward-most-land': (ctx) => {
    const { state, def, params, playersWithLand } = ctx;
    const cands = playersWithLand(state);
    const best = cands.reduce((a, b) => (b.properties.length > a.properties.length ? b : a));
    const gain = scaled(state, def.amount ?? 0);
    best.deposit += gain; // 报告：奖金入存款
    params.player = best.name;
    params.amount = String(gain);
    return '';
  },
  'subsidize-least-land': (ctx) => {
    const { state, def, params, playersWithLand } = ctx;
    const cands = playersWithLand(state);
    const least = cands.reduce((a, b) => (b.properties.length < a.properties.length ? b : a));
    const gain = scaled(state, def.amount ?? 0);
    least.cash += gain;
    params.player = least.name;
    params.amount = String(gain);
    return '';
  },
  'reward-top-shareholder': (ctx) => {
    const { state, def, params, playersWithShares, totalSharesOf } = ctx;
    const cands = playersWithShares(state);
    const best = cands.reduce((a, b) => (totalSharesOf(state, b) > totalSharesOf(state, a) ? b : a));
    const gain = scaled(state, def.amount ?? 0);
    best.cash += gain;
    params.player = best.name;
    params.amount = String(gain);
    return '';
  },

  // ---- 事件 11/12/13：三项税收 ----
  'income-tax': (ctx) => collectTax(ctx, (q) => q.cash),
  'land-tax': (ctx) => collectTax(ctx, (q) => q.properties.reduce((sum, prop) => sum + propertyValue(ctx.state, prop), 0)),
  'securities-tax': (ctx) =>
    collectTax(ctx, (q) => {
      let base = 0;
      for (const [stockId, qty] of Object.entries(q.stocks)) {
        const stock = ctx.stockById(ctx.state, stockId);
        if (stock) base += stock.price * qty;
      }
      return base;
    }),

  // ---- 事件 16/17：路况报道 ----
  'halt-walkers': haltTraffic,
  'halt-riders': haltTraffic,

  // ---- 事件 22/23：银行业务 ----
  'loan-ban': (ctx) => {
    const days = ctx.def.days ?? 15;
    ctx.state.loanBanDays = days;
    return `${days} 天内停止放款`;
  },
  'deposit-dividend': (ctx) => {
    const { state, def, activePlayers } = ctx;
    const rate = def.rate ?? 0;
    let sum = 0;
    for (const q of activePlayers(state)) {
      const bonus = Math.round(q.deposit * rate);
      if (bonus <= 0) continue;
      q.deposit += bonus;
      sum += bonus;
    }
    return `合计派发 ¥${sum}`;
  },

  // ---- 事件 24–28：股市行情 ----
  'stock-crash': (ctx) => stockSwing(ctx, -1),
  'stock-rally': (ctx) => stockSwing(ctx, 1),
  'stock-halt-all': (ctx) => {
    const days = ctx.def.days ?? 10;
    ctx.state.stockHaltAllDays = days;
    return `全市场停牌 ${days} 天`;
  },
  'stock-halt-one': (ctx) => {
    const { state, def, params, randomPick, isStockSuspended } = ctx;
    const days = def.days ?? 10;
    const stock = randomPick(state, state.stockMarket.stocks.filter((s) => !isStockSuspended(state, s.id)));
    if (!stock) return '';
    state.stockHalts.push({ stockId: stock.id, kind: 'suspend', daysLeft: days });
    params.stock = stock.name;
    return `停牌 ${days} 天`;
  },
  'stock-resume-one': (ctx) => {
    const { state, params, randomPick, isStockSuspended } = ctx;
    const stock = randomPick(state, state.stockMarket.stocks.filter((s) => isStockSuspended(state, s.id)));
    if (!stock) return '';
    state.stockHalts = state.stockHalts.filter((h) => !(h.stockId === stock.id && h.kind === 'suspend'));
    params.stock = stock.name;
    return '恢复上市交易';
  },

  // ---- 事件 29–35：公司企业 ----
  'company-jail': (ctx) => {
    const { state, def, params, randomPick, applyDisaster, blockRent, isGameOver } = ctx;
    const company = randomPick(state, state.companies.filter((c) => c.chairmanId !== null));
    const victim = company ? state.players.find((q) => q.id === company.chairmanId) : undefined;
    if (!company || !victim || victim.bankrupt) return '';
    const days = def.days ?? 5;
    applyDisaster(state, victim, 'jail', null, (v) => {
      v.skipTurns = Math.max(v.skipTurns, days);
      v.custody = { kind: 'jail', daysLeft: Math.max(v.skipTurns, days) };
      blockRent(v, days);
    });
    params.company = state.board[company.cellId]?.name ?? '';
    params.player = victim.name;
    const extra = `${victim.name} 坐牢 ${days} 天`;
    if (isGameOver(state)) return null;
    return extra;
  },
  'company-fine': (ctx) => surplusDelta(ctx, -1),
  'company-gain': (ctx) => surplusDelta(ctx, 1),
  'company-loss': (ctx) => surplusDelta(ctx, -1),
  'company-profit-double': (ctx) => {
    const { state, params, randomPick } = ctx;
    const company = randomPick(state, state.companies);
    if (!company) return '';
    company.surplus *= 2;
    params.company = state.board[company.cellId]?.name ?? '';
    return `累积盈余翻倍至 ¥${company.surplus}`;
  },
};

/** 事件 16/17：行人（骰子 ≤1）/ 汽车（骰子 >1）强制停留 */
function haltTraffic(ctx: NewsEffectCtx): string {
  const { state, def, activePlayers, blockRent } = ctx;
  const days = def.days ?? TRAFFIC_HALT_DAYS;
  const walking = def.effect === 'halt-walkers';
  const targets = activePlayers(state).filter((q) => (walking ? q.diceCount <= 1 : q.diceCount > 1));
  for (const v of targets) {
    v.skipTurns = Math.max(v.skipTurns, days);
    blockRent(v, days);
  }
  return targets.length ? `${targets.map((v) => v.name).join('、')} 停留 ${days} 天` : '无人受影响';
}