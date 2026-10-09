/**
 * 命运卡池（49 条，id 0–48）。
 *
 * 数据来源：`docs/extraction/fate_pool_数据表_2026-09-27.txt`（自 mytbk/rich4 反汇编还原，
 * 原文表编号 #0185–#0233，即 id = 编号 − 185；牌面图索引表 ref_00475fb4，效果表 ref_00475ef0）。
 * 原文为繁体，此处与 `news.ts` 一致转为简体；`%d` / `％` 换成 `{amount}`（金额或百分比），
 * `%s` 换成 `{player}`。
 *
 * 池划分与原版一致：
 * - 公共池 = id 0–32（33 张），全地图共用（`FATE_PUBLIC_IDS`）。
 * - 地图专属池 = id 33–48（16 张），原版按 `table[map_gid*16+id]` 取用；
 *   本作用作「机会格违法事件」的案由文本来源（`FATE_MAP_IDS`）。
 *
 * 说明：金额与天数为推断值，原版未在拆解报告中逐条核实。
 * 本池放在常量模块，**不进 GameState**（快照体积约束）。
 *
 * 效果结算在 `FATE_EFFECTS`（本文件末尾），按效果种类建表；`engine.ts` 负责抽签、
 * 算缩放金额、拼日志，并注入 `FateEffectCtx` 里的引擎能力。
 */

import { MAX_HAND_CARDS } from './board.js';
import { CARDS } from './cards.js';
import type { BuildingRef, FateEffectCtx } from './effect_ctx.js';
import { ITEMS } from './items.js';

export type FateEffectKind =
  | 'demolish-house' | 'requisition-land' | 'fake-loan' | 'check-bounce' | 'bank-hack'
  | 'birthday-cards' | 'forced-abroad' | 'abduct' | 'stock-default' | 'sell-all-stocks'
  | 'lose-bike' | 'crash-car' | 'ditch-hospital' | 'bike-hospital'
  | 'jaywalk-fine' | 'helmet-fine' | 'speeding-fine' | 'treat-all' | 'litter-fine' | 'dog-fine'
  | 'found-money' | 'lose-wallet' | 'inherit' | 'bad-loan' | 'invoice-win'
  | 'pay-insurance' | 'claim-insurance' | 'sell-all-cards'
  | 'jail';

export interface FateCardDef {
  id: number;
  /** 简体中文牌面；`{player}` / `{amount}` 为占位符 */
  text: string;
  effect: FateEffectKind;
  /** 需金额的效果：元 或 百分比（见 `bank-hack` / `stock-default`） */
  amount?: number;
  /** 需天数的效果（住院/坐牢/出国/绑架） */
  days?: number;
}

/** 49 张命运牌（id 0..48，顺序即原版效果表顺序） */
export const FATE_CARDS: FateCardDef[] = [
  // ---- 公共池（0–32） ----
  { id: 0, text: '强制拆除房屋一栋', effect: 'demolish-house' },
  { id: 1, text: '强制征收土地一处', effect: 'requisition-land' },
  { id: 2, text: '人头被盗用冒贷 {amount} 元', effect: 'fake-loan', amount: 3000 },
  { id: 3, text: '支票跳票，银行拒绝往来一个月', effect: 'check-bounce' },
  { id: 4, text: '侵入银行电脑，挪用其他人存款 {amount}％', effect: 'bank-hack', amount: 10 },
  { id: 5, text: '今天是你生日，向每人收取一张卡片', effect: 'birthday-cards' },
  { id: 6, text: '强迫出国观光 {days} 天', effect: 'forced-abroad', days: 5 },
  { id: 7, text: '被外星人绑架 {days} 天', effect: 'abduct', days: 5 },
  { id: 8, text: '股票违约交割，损失股票 {amount}％', effect: 'stock-default', amount: 20 },
  { id: 9, text: '变卖所有股票求现', effect: 'sell-all-stocks' },
  { id: 10, text: '机车被偷遗失', effect: 'lose-bike' },
  { id: 11, text: '汽车撞电线杆全毁', effect: 'crash-car' },
  { id: 12, text: '掉进水沟就医 {days} 天', effect: 'ditch-hospital', days: 2 },
  { id: 13, text: '骑机车摔伤住院 {days} 天', effect: 'bike-hospital', days: 2 },
  { id: 14, text: '行人闯越马路罚款 {amount} 元', effect: 'jaywalk-fine', amount: 1200 },
  { id: 15, text: '骑机车未戴安全帽罚款 {amount} 元', effect: 'helmet-fine', amount: 1500 },
  { id: 16, text: '汽车超速罚款 {amount} 元', effect: 'speeding-fine', amount: 3000 },
  { id: 17, text: '请所有人吃大餐，花费 {amount} 元', effect: 'treat-all', amount: 6000 },
  { id: 18, text: '乱丢垃圾罚款 {amount} 元', effect: 'litter-fine', amount: 1200 },
  { id: 19, text: '你家小狗乱大小便罚款 {amount} 元', effect: 'dog-fine', amount: 1500 },
  { id: 20, text: '在路边捡到 {amount} 元', effect: 'found-money', amount: 1000 },
  { id: 21, text: '在路边捡到 {amount} 元', effect: 'found-money', amount: 3000 },
  { id: 22, text: '在路边捡到 {amount} 元', effect: 'found-money', amount: 8000 },
  { id: 23, text: '遗失钱包损失 {amount} 元', effect: 'lose-wallet', amount: 1500 },
  { id: 24, text: '遗失钱包损失 {amount} 元', effect: 'lose-wallet', amount: 4000 },
  { id: 25, text: '意外获得遗产 {amount} 元', effect: 'inherit', amount: 20000 },
  { id: 26, text: '被倒会损失 {amount} 元', effect: 'bad-loan', amount: 6000 },
  { id: 27, text: '发票中奖 {amount} 元', effect: 'invoice-win', amount: 1000 },
  { id: 28, text: '发票中奖 {amount} 元', effect: 'invoice-win', amount: 5000 },
  { id: 29, text: '发票中奖 {amount} 元', effect: 'invoice-win', amount: 12000 },
  { id: 30, text: '付保险金 {amount} 元', effect: 'pay-insurance', amount: 3000 },
  { id: 31, text: '领取保险金 {amount} 元', effect: 'claim-insurance', amount: 10000 },
  { id: 32, text: '变卖所有卡片道具', effect: 'sell-all-cards' },

  // ---- 地图专属池（33–48，本作用作机会格违法事件案由） ----
  { id: 33, text: '酒醉大闹警局坐牢 {days} 天', effect: 'jail', days: 2 },
  { id: 34, text: '妨碍风化坐牢 {days} 天', effect: 'jail', days: 2 },
  { id: 35, text: '走私毒品坐牢 {days} 天', effect: 'jail', days: 3 },
  { id: 36, text: '贩卖大补帖坐牢 {days} 天', effect: 'jail', days: 2 },
  { id: 37, text: '酒醉大闹警局坐牢 {days} 天', effect: 'jail', days: 3 },
  { id: 38, text: '违法聚众示威坐牢 {days} 天', effect: 'jail', days: 2 },
  { id: 39, text: '猎捕保育动物坐牢 {days} 天', effect: 'jail', days: 3 },
  { id: 40, text: '盗卖国宝坐牢 {days} 天', effect: 'jail', days: 3 },
  { id: 41, text: '诱骗未成年少女拘役 {days} 天', effect: 'jail', days: 4 },
  { id: 42, text: '妨碍风化坐牢 {days} 天', effect: 'jail', days: 3 },
  { id: 43, text: '走私毒品坐牢 {days} 天', effect: 'jail', days: 4 },
  { id: 44, text: '施放毒气坐牢 {days} 天', effect: 'jail', days: 4 },
  { id: 45, text: '非法持有枪械坐牢 {days} 天', effect: 'jail', days: 3 },
  { id: 46, text: '殴打警员坐牢 {days} 天', effect: 'jail', days: 4 },
  { id: 47, text: '猎捕保育动物坐牢 {days} 天', effect: 'jail', days: 4 },
  { id: 48, text: '盗卖国家机密坐牢 {days} 天', effect: 'jail', days: 5 },
];

/** 公共池 = id 0..32（33 张），全地图共用 */
export const FATE_PUBLIC_COUNT = 33;

/** 公共池 id 列表（引擎抽签用） */
export const FATE_PUBLIC_IDS: number[] = FATE_CARDS.slice(0, FATE_PUBLIC_COUNT).map((c) => c.id);

/** 地图专属池 = id 33..48（16 张），本作用作「机会格违法事件」的案由文本来源 */
export const FATE_MAP_IDS: number[] = FATE_CARDS.slice(FATE_PUBLIC_COUNT).map((c) => c.id);

export const FATE_CARD_COUNT = 49;

export function fateCardById(id: number): FateCardDef | undefined {
  return FATE_CARDS.find((c) => c.id === id);
}

/** 占位符 {street}/{player}/{amount}/{days} 未提供时渲染为空串（与 renderNewsText 同规则） */
export function renderFateText(def: FateCardDef, params: Record<string, string | number> = {}): string {
  return def.text.replace(/\{(street|player|amount|days)\}/g, (_m, key: string) => {
    const v = params[key];
    return v === undefined ? '' : String(v);
  });
}

/** EVT-02：机会/危险格违法事件的默认拘役天数（命运卡 `jail` 未标 days 时同样取此值） */
export const CRIME_JAIL_DAYS = 2;

/**
 * 命运卡效果结算表（按 `FateEffectKind` 建表，而非按 49 张牌建表：
 * 多张牌共用同一效果，例如「在路边捡到 {amount} 元」有 3 张、罚款类有 5 张）。
 *
 * 返回值即日志尾部的补充说明文本（原先 switch 各分支里的 `extra`），
 * 由 `engine.ts` 的 `applyFateEffect` 统一拼成
 * 「【命运】X 抽到「牌面」 —— 说明」这一条日志。
 */
export const FATE_EFFECTS: Record<FateEffectKind, (ctx: FateEffectCtx) => string> = {
  'demolish-house': ({ state, randomPick, builtProperties, destroyBuilding }) => {
    const ref = randomPick(state, builtProperties(state));
    if (ref) {
      destroyBuilding(ref);
      return `「${ref.cell.name}」建筑被强制拆除`;
    }
    return '（无人拥有可拆的建筑，无事发生）';
  },
  'requisition-land': ({ state, activePlayers, randomPick }) => {
    const pool: BuildingRef[] = [];
    for (const q of activePlayers(state)) {
      for (const prop of q.properties) pool.push({ player: q, prop, cell: state.board[prop.cellId]! });
    }
    const ref = randomPick(state, pool);
    if (ref) {
      ref.player.properties = ref.player.properties.filter((q) => q !== ref.prop);
      return `${ref.player.name} 的「${ref.cell.name}」被强制征收`;
    }
    return '（无人拥有土地，无事发生）';
  },
  'fake-loan': ({ state, self: p, money, payCash, renderParams }) => {
    renderParams.amount = money;
    payCash(state, p, money, null, 'other');
    return `被冒名贷款，损失 ¥${money}`;
  },
  'check-bounce': ({ state }) => {
    state.loanBanDays = 30;
    return '银行拒绝往来 30 天（停止放款）';
  },
  'bank-hack': ({ state, self: p, def, activePlayers, renderParams }) => {
    const pct = def.amount ?? 10;
    renderParams.amount = pct;
    let stolen = 0;
    for (const q of activePlayers(state)) {
      if (q.id === p.id) continue;
      const take = Math.floor((q.deposit * pct) / 100);
      if (take <= 0) continue;
      q.deposit -= take;
      stolen += take;
    }
    p.deposit += stolen;
    return `挪用他人存款共 ¥${stolen}`;
  },
  'birthday-cards': ({ state, self: p, activePlayers }) => {
    let got = 0;
    for (const q of activePlayers(state)) {
      if (q.id === p.id || q.cards.length === 0) continue;
      if (p.cards.length >= MAX_HAND_CARDS) break;
      p.cards.push(q.cards.shift()!);
      got += 1;
    }
    return `向每人收取一张卡片，共得 ${got} 张`;
  },
  'forced-abroad': ({ self: p, def, renderParams }) => {
    const days = def.days ?? 5;
    renderParams.days = days;
    p.abroadTurns = Math.max(p.abroadTurns, days);
    return `被迫出国观光 ${days} 天（期间不能收租）`;
  },
  abduct: ({ state, self: p, def, blockRent, renderParams }) => {
    const days = def.days ?? 5;
    renderParams.days = days;
    p.skipTurns = Math.max(p.skipTurns, days);
    blockRent(p, days);
    return `被外星人绑架 ${days} 天（暂停行动并丧失收租权）`;
  },
  'stock-default': ({ self: p, def, renderParams }) => {
    const pct = def.amount ?? 20;
    renderParams.amount = pct;
    for (const [stockId, qty] of Object.entries(p.stocks)) {
      const lost = Math.floor((qty * pct) / 100);
      if (lost <= 0) continue;
      const left = qty - lost;
      if (left > 0) p.stocks[stockId] = left;
      else delete p.stocks[stockId];
    }
    return `违约交割损失 ${pct}% 持股`;
  },
  'sell-all-stocks': ({ state, self: p, stockById }) => {
    let total = 0;
    for (const [stockId, qty] of Object.entries(p.stocks)) {
      const stock = stockById(state, stockId);
      if (!stock || qty <= 0) continue;
      total += stock.price * qty;
      delete p.stocks[stockId];
      if (p.stockCost) delete p.stockCost[stockId];
    }
    p.cash += total;
    return `变卖所有股票求现 ¥${total}`;
  },
  'lose-bike': ({ self: p }) => {
    p.diceCount = 1;
    return '交通工具损毁，恢复步行（1 颗骰子）';
  },
  'crash-car': ({ self: p }) => {
    p.diceCount = 1;
    return '交通工具损毁，恢复步行（1 颗骰子）';
  },
  'ditch-hospital': ({ state, self: p, def, blockRent, renderParams }) => {
    const days = def.days ?? 2;
    renderParams.days = days;
    p.skipTurns = Math.max(p.skipTurns, days);
    p.custody = { kind: 'hospital', daysLeft: Math.max(p.skipTurns, days) };
    blockRent(p, days);
    return `就医住院 ${days} 天（暂停行动并丧失收租权）`;
  },
  'bike-hospital': ({ state, self: p, def, blockRent, renderParams }) => {
    const days = def.days ?? 2;
    renderParams.days = days;
    p.skipTurns = Math.max(p.skipTurns, days);
    p.custody = { kind: 'hospital', daysLeft: Math.max(p.skipTurns, days) };
    blockRent(p, days);
    return `就医住院 ${days} 天（暂停行动并丧失收租权）`;
  },
  'jaywalk-fine': payFine,
  'helmet-fine': payFine,
  'speeding-fine': payFine,
  'litter-fine': payFine,
  'dog-fine': payFine,
  'treat-all': ({ state, self: p, money, activePlayers, pay, renderParams }) => {
    renderParams.amount = money;
    const others = activePlayers(state).filter((q) => q.id !== p.id);
    const share = others.length > 0 ? Math.floor(money / others.length) : 0;
    for (const q of others) {
      if (share > 0) pay(state, p, share, q, { toDeposit: true, reason: 'other' });
    }
    return `请所有人吃大餐，共花 ¥${share * others.length}`;
  },
  'found-money': gainMoney,
  inherit: gainMoney,
  'invoice-win': gainMoney,
  'lose-wallet': loseMoney,
  'bad-loan': loseMoney,
  'pay-insurance': ({ state, self: p, money, payCash, renderParams }) => {
    renderParams.amount = money;
    payCash(state, p, money, null, 'other');
    return `支付保险金 ¥${money}`;
  },
  'claim-insurance': ({ self: p, money, renderParams }) => {
    renderParams.amount = money;
    if (p.insurance) {
      p.cash += money;
      return `领取保险金 ¥${money}`;
    }
    return '（无有效保单，未获理赔）';
  },
  'sell-all-cards': ({ self: p }) => {
    let gained = 0;
    for (const cardId of p.cards) gained += Math.floor((CARDS[cardId]?.cost ?? 0) / 2);
    for (const [itemId, count] of Object.entries(p.items)) {
      gained += Math.floor((ITEMS[itemId]?.cost ?? 0) / 2) * count;
    }
    p.cards = [];
    p.items = {};
    p.points += gained;
    return `变卖所有卡片道具，回收 ${gained} 点券`;
  },
  jail: ({ state, self: p, def, blockRent, applyDisaster, renderParams }) => {
    const days = def.days ?? CRIME_JAIL_DAYS;
    renderParams.days = days;
    applyDisaster(state, p, 'jail', null, (v) => {
      v.skipTurns = Math.max(v.skipTurns, days);
      v.custody = { kind: 'jail', daysLeft: Math.max(v.skipTurns, days) };
      blockRent(v, days);
    });
    return `坐牢 ${days} 天（丧失收租权）`;
  },
};

/** 罚款类命运（闯越马路/未戴安全帽/超速/乱丢垃圾/狗）共用 */
function payFine(ctx: FateEffectCtx): string {
  const { state, self: p, money, payCash, renderParams } = ctx;
  renderParams.amount = money;
  payCash(state, p, money, null, 'other');
  return `罚款 ¥${money}`;
}

/** 拾得/遗产/发票中奖类命运共用 */
function gainMoney(ctx: FateEffectCtx): string {
  const { self: p, money, renderParams } = ctx;
  renderParams.amount = money;
  p.cash += money;
  return `获得 ¥${money}`;
}

/** 遗失钱包/被倒会类命运共用 */
function loseMoney(ctx: FateEffectCtx): string {
  const { state, self: p, money, payCash, renderParams } = ctx;
  renderParams.amount = money;
  payCash(state, p, money, null, 'other');
  return `损失 ¥${money}`;
}