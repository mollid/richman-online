/**
 * 股票 K 线与成交量（ECON-09/10 的自定扩展，玩法文档 §3.4）。
 *
 * 原版只有「每天 ±10% 随机波动 + 新闻 ±15%」这一个数，没有历史、没有量。本模块补上
 * 三件事，并且都遵守同一条纪律：**不新增随机源**。
 * - 日 K 线：一个交易日一根，开=昨日收盘、收=今日价，高/低按当日振幅派生；
 * - 成交量：背景换手（流通股本 × 换手率 × 涨跌放大）+ 玩家真实成交，两者分开记；
 * - 冲击成本：玩家吃单会把价格推离成交前水平，力度按「成交股数 ÷ 流通股本」算。
 *
 * 为什么不新增随机源：引擎的 RNG 状态内嵌在 `GameState` 里，每天每支多抽一次就会把
 * 后续所有骰子序列打散（W2 的神明现身就是这种量级的改动）。而影线要的「这天上影长还是
 * 下影长」，正好可以借用**当日 tick 已经抽掉的那个数**（`bias`）—— 形态有了细节，
 * 抽数一次都没多。
 */

import type { GameState, Stock, StockCandle } from './types.js';
import { STOCK_DEFS } from './board.js';

/** 每支股票保留多少根日 K（超出丢最旧的；也是广播体积的上限） */
export const STOCK_CANDLE_LIMIT = 30;
/** 每日背景换手率：占流通股本的比例 */
export const STOCK_BASE_TURNOVER = 0.06;
/** 每 1 个百分点的涨跌幅额外放大多少换手（放量） */
export const STOCK_VOLUME_WAVE_GAIN = 0.08;
/** 影线单位：股价的 1%，再乘 bias 得到上下影的分配 */
export const STOCK_WICK_UNIT = 0.01;
/** 股价地板（与 tickStockMarket 原有口径一致） */
export const STOCK_MIN_PRICE = 5;

/**
 * 单日涨跌停的硬边界（百分点）。原版 `涨跌 clamp 到 [-10.0, +10.0]`（FUN_004291d6），
 * 交易闸门也按「现价 vs 开盘 ×(1±10%)」判（FUN_004295ea）—— 同一个数，两处用。
 */
export const STOCK_DAY_LIMIT_PCT = 10;
/** 个股日内噪声范围（原版 ±14%：`(rand()-0x4000)/1171`） */
export const STOCK_NOISE_PCT = 14;
/** 大盘漂移（原版 ±4%：`(rand()-0x4000)/4097`，当日全体共享一个） */
export const MARKET_DRIFT_PCT = 4;
/** 均值回归的触发位：跌破锚的 0.5 倍算腰斩、涨过 8 倍算过热（原版 fc8 / fd0 / fd4） */
export const STOCK_REVERSION_LOW = 0.5;
export const STOCK_REVERSION_HIGH = 8;

/** 今日这一支的涨停价 / 跌停价（sign = +1 涨、-1 跌），以**开盘价**为基准 */
export function stockLimitPrice(openPrice: number, sign: 1 | -1): number {
  return Math.round(openPrice * (1 + (sign * STOCK_DAY_LIMIT_PCT) / 100));
}

/**
 * 今日这一支被钉在哪块板上：涨停 / 跌停 / 平盘（原版 FUN_004295ea 判的是「现价 vs 开盘 ±10%」）。
 *
 * 这里读的是**当日行情的涨跌幅**而不是现价：现价会被玩家自己的吃单推开（冲击成本），
 * 拿它判闸门等于「一笔大卖单把自己锁成跌停、剩下的割不掉」—— 那是我们加的冲击模型造出来的牢，
 * 不是市场给的。行情把当日涨跌顶到 ±10% 时，现价必然已经在板上（新价 = 开盘 ×(1±10%)），两种判法
 * 在没有成交时逐位等价，只有成交时这一种才不会自伤。
 */
export function stockLimitState(stock: Stock): 'up' | 'down' | 'flat' {
  if (stock.lastChangePct >= STOCK_DAY_LIMIT_PCT) return 'up';
  if (stock.lastChangePct <= -STOCK_DAY_LIMIT_PCT) return 'down';
  return 'flat';
}

/**
 * 一家公司的持股值多少（CORP-14 一本账）：它挂在行情池里的那一支 `corp-<kind>` 的现价。
 * 早先按**面值**估 —— 那时面板买不到公司股，面值就是唯一的锚。现在两个渠道进的是同一本账、
 * 转手都按市价，估值也跟着走市价；踩格按面值认购省下的那一截，从此就是当场的浮盈（那正是踩点的奖励）。
 */
export function companySharePrice(state: GameState, kind: string, faceValue: number): number {
  return state.stockMarket.stocks.find((x) => x.id === `corp-${kind}`)?.price ?? faceValue;
}

/**
 * 这支股票今天的均值回归锚。
 *
 * 原版的锚 = **绑定城市的地价**（`股票表+0x04` → `城市表+0x24`，每天现读），所以地价一动，
 * 股价就有了新的去处 —— 这是「炒地皮」和「炒股」之间那条被大多数人漏掉的通道。
 * 我们的地价量级与原版 `/10000` 那套单位不是一回事（直接除会把锚压到 0.05 这种没意义的数），
 * 所以按**比值**接：锚 = 建仓价 × 今日街价 ÷ 开局街价。开局两者相等 ⇒ 锚恒等于建仓价，
 * 不会第一天就被回归力拽飞；街上涨价卡 / 地价事件把街价抬起来，锚才跟着抬。
 *
 * `cityPriceToday` 由调用方用 `economy.cityLandPrice` 现算传进来 —— 读棋盘与街道乘数是
 * 那一头的事，本模块不碰棋盘（反手 import economy 会跟 `economy → stocks` 撞成环）。
 * 没有城市绑定的股票（我们自造的 6 支虚拟股 = 原版 `+0x04 = 0`）用 `anchorPrice` 原值。
 */
export function stockAnchor(stock: Stock, cityPriceToday: number): number {
  if (!stock.cityName || !stock.cityPriceBase || cityPriceToday <= 0) return stock.anchorPrice;
  return Math.max(1, Math.round((stock.anchorPrice * cityPriceToday) / stock.cityPriceBase));
}

/** 流通股本：冲击成本与背景量的分母（原版无此项，按「各支市值相当」定标） */
export function stockFloatShares(stockId: string): number {
  return STOCK_DEFS.find((s) => s.id === stockId)?.floatShares ?? 1200;
}

/** 冲击比例：成交股数占流通股本的多大一块 */
export function stockImpactPct(stock: Stock, shares: number): number {
  return shares / Math.max(1, stock.floatShares);
}

/**
 * 当日那根 K 线（可能还在长）。没有就按「上一根收盘」开一根 —— 玩家只可能在交易日成交，
 * 所以这里不需要判断休市。
 */
export function todayCandle(state: GameState, stock: Stock): StockCandle {
  const day = state.calendar.elapsedDays;
  const last = stock.candles[stock.candles.length - 1];
  if (last && last.day === day) return last;
  const open = last ? last.close : stock.price;
  const candle: StockCandle = {
    day,
    open,
    high: open,
    low: Math.max(STOCK_MIN_PRICE, open),
    close: open,
    volume: 0,
    playerVolume: 0,
  };
  pushCandle(stock, candle);
  return candle;
}

/**
 * 收一根当日 K 线：随机游走（以及同日新闻）已经把价格定下来了，这里只负责画形。
 *
 * `open` 必须由调用方在**游走之前**取好传进来（上一根收盘，首根则是建仓价）—— 否则
 * 开盘价会等于收盘价，第一根线永远没有实体。
 * 日切时先走到这里，玩家当天的成交随后累加进同一根 —— 所以量是「背景量 + 玩家量」。
 *
 * @param bias 当日 tick 已消耗的那个随机数（0..1），只用来决定上影/下影谁长
 * @param traded 假 = 停牌：一字线、零成交
 */
export function sealDailyCandle(state: GameState, stock: Stock, open: number, bias: number, traded: boolean): void {
  const candle = todayCandle(state, stock);
  candle.open = open;
  const close = stock.price;
  const body = Math.abs(close - open);
  // 振幅：实体之外再各挂一根影线，长短由 bias 分配 —— 于是有「冲高回落」「探底回升」之别
  const span = body + Math.max(1, Math.round(stock.price * STOCK_WICK_UNIT));
  if (!traded) {
    Object.assign(candle, { close, high: close, low: close, volume: 0, playerVolume: 0 });
    return;
  }
  candle.close = close;
  candle.high = Math.max(open, close) + Math.round(span * (0.35 + 0.65 * bias));
  candle.low = Math.max(STOCK_MIN_PRICE, Math.min(open, close) - Math.round(span * (0.35 + 0.65 * (1 - bias))));
  candle.volume = stockBackgroundVolume(stock, stock.lastChangePct) + candle.playerVolume;
}

/** 背景成交量（股）：基准换手 ×（1 + 放量），涨跌幅越大量越大 */
export function stockBackgroundVolume(stock: Stock, changePct: number): number {
  const wave = 1 + Math.abs(changePct) * STOCK_VOLUME_WAVE_GAIN;
  return Math.max(1, Math.round(stock.floatShares * STOCK_BASE_TURNOVER * wave));
}

/**
 * 冲击成本怎么落地。
 *
 * 一笔成交把盘口价推开 `成交股数 ÷ 流通股本` 这么一块；但**成交价取冲击前与冲击后的中点**，
 * 理由有两条：
 * 1. 若按冲击前的价买入、成交后价格已被自己推高，那么「买完立刻卖」就是白赚 —— 往返一次
 *    必须打平，否则任何玩家都能靠来回倒腾凭空造钱；
 * 2. 买入的存款校验必须与实付同一个价，否则「刚好够钱」的那笔会扣成负存款。
 * 于是 `stockExecPrice` 同时供校验与结算使用，冲击本身仍只体现在盘口与 K 线上。
 *
 * 低价股上「股价 × 冲击比例」会四舍五入成 0，所以留了 1 元的地板：不然便宜股票永远拉不动，
 * 日 K 线也永远只有一条直线。
 */

/**
 * 给定可用存款，最多能吃下多少股（含冲击成本，且**不超过还没被买走的量**）。
 *
 * 冲击让「成本 ÷ 单价」不再成立 —— 买得越多均价越高，所以面板上的「全部」与 bot 的数量
 * 必须走这一个函数，否则算出来的量必然被引擎以「存款不足」拒绝，正是门控与引擎不同源的
 * 老 bug 类。同理，流通股可以被买光：不在这一个函数里掐掉上限，面板就会给出一颗必被拒的
 * 「全买」按钮。成本随数量单调递增 ⇒ 二分；不消耗随机数。
 */
export function maxAffordableShares(stock: Stock, money: number): number {
  const affordable = Math.floor(money / Math.max(1, stock.price));
  let hi = Math.min(affordable, stock.remainingShares ?? Number.MAX_SAFE_INTEGER);
  if (hi <= 0) return 0;
  const fits = (q: number) => stockExecPrice(stock, q, 'buy') * q <= money;
  let lo = 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  return fits(lo) ? lo : 0;
}

/** 冲击后盘口与当前盘口的价差（至少 1 元，见上） */
export function stockImpactDelta(stock: Stock, shares: number): number {
  return Math.max(1, Math.round(stock.price * stockImpactPct(stock, shares)));
}

/** 这笔成交的结算价（冲击前后的中点）；校验与扣款都用它，两边才不会打架 */
export function stockExecPrice(stock: Stock, shares: number, side: 'buy' | 'sell'): number {
  const delta = stockImpactDelta(stock, shares);
  const post = Math.max(STOCK_MIN_PRICE, side === 'buy' ? stock.price + delta : stock.price - delta);
  return Math.round((stock.price + post) / 2);
}

/** 成交落地：按结算价成交、盘口推到冲击后价，并把它画进当日 K 线。不消耗随机数。 */
export function applyTradeImpact(
  state: GameState,
  stock: Stock,
  shares: number,
  side: 'buy' | 'sell',
): { execPrice: number; moved: number } {
  const execPrice = stockExecPrice(stock, shares, side);
  const before = stock.price;
  stock.price = Math.max(
    STOCK_MIN_PRICE,
    side === 'buy' ? before + stockImpactDelta(stock, shares) : before - stockImpactDelta(stock, shares),
  );
  const candle = todayCandle(state, stock);
  candle.close = stock.price;
  candle.high = Math.max(candle.high, stock.price);
  candle.low = Math.min(candle.low, stock.price);
  candle.volume += shares;
  candle.playerVolume += shares;
  return { execPrice, moved: stock.price - before };
}

/** 最新一根（当日或最后一个交易日）；从未产生过 K 线时为 null */
export function latestCandle(stock: Stock): StockCandle | null {
  return stock.candles[stock.candles.length - 1] ?? null;
}

/** 区间内的最高/最低价，供图表定标；空序列回退到当前价 */
export function candleRange(candles: StockCandle[]): { high: number; low: number } {
  if (candles.length === 0) return { high: 0, low: 0 };
  let high = -Infinity;
  let low = Infinity;
  for (const c of candles) {
    high = Math.max(high, c.high);
    low = Math.min(low, c.low);
  }
  return { high, low };
}

/** 追加一根并保持长度上限（原地截断，避免每次复制整个数组） */
function pushCandle(stock: Stock, candle: StockCandle): void {
  const last = stock.candles[stock.candles.length - 1];
  // 同一天的第二根不追加，直接改写：日切与同日新闻/成交可能先后落到同一根上
  if (last && last.day === candle.day) {
    Object.assign(last, candle);
    return;
  }
  stock.candles.push(candle);
  if (stock.candles.length > STOCK_CANDLE_LIMIT) stock.candles.splice(0, stock.candles.length - STOCK_CANDLE_LIMIT);
}
