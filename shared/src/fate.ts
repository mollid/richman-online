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
 */

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