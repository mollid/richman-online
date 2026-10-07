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