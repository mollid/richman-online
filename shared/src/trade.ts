/**
 * UI-06 交易指令：公布栏公开交易（help [11]「透過公佈欄，與其他的玩家公開的交易房地產、股票、卡片、道具」）。
 *
 * 设计要点：
 * - 卖方在自己回合内 `POST_TRADE` 挂出标的（地产 / 股票 / 卡片 / 道具）；
 * - 任何玩家在 `awaiting_action` 阶段都可 `BUY_TRADE` 买下他人挂牌（现金即时过手、产权即时转移）；
 * - 卖方 `CANCEL_TRADE` 撤下未成交的挂牌（不收费）；
 * - 标的一旦被转手或消耗，挂牌自动失效（每次操作前按当前持有校验）；
 * - 地产按「公定地价 × 挂牌价比例」成交时连同等级/建设/连锁店一并转移；
 * - 全程纯函数、零 RNG 消耗（不扰动确定性回放）。
 */
import { CARDS } from './cards.js';
import { ITEMS } from './items.js';
import { MAX_ITEM_COUNT } from './board.js';
import { landPrice } from './economy.js';
import type {
  ActionOf,
  ActionRefusal,
  GameState,
  Player,
  PlayerAction,
  PlayerProperty,
  TradeKind,
  TradeListing,
  TradeRecord,
} from './types.js';

/** 成交记录保留条数 */
const TRADE_HISTORY_LIMIT = 50;

/** 标的的可读描述（日志 / UI 共用） */
export function describeTarget(state: GameState, kind: TradeKind, targetId: string): string {
  switch (kind) {
    case 'land': {
      const cell = state.board[Number(targetId)];
      return cell ? `地产「${cell.name}」` : '地产';
    }
    case 'stock': {
      const stock = state.stockMarket.stocks.find((s) => s.id === targetId);
      return stock ? `股票「${stock.name}」` : '股票';
    }
    case 'card':
      return `卡片「${CARDS[targetId]?.name ?? targetId}」`;
    case 'item':
      return `道具「${ITEMS[targetId]?.name ?? targetId}」`;
    default:
      return '标的';
  }
}

/** 地产的可读描述（含等级与建设） */
function describeEstate(state: GameState, prop: PlayerProperty): string {
  const cell = state.board[prop.cellId];
  const bits = [`${prop.grade} 级`];
  if (prop.facility) bits.push(ITEM_FACILITY_NAME[prop.facility] ?? prop.facility);
  if (prop.chain) bits.push('连锁店');
  return `地产「${cell?.name ?? prop.cellId}」（${bits.join('·')}）`;
}

const ITEM_FACILITY_NAME: Record<string, string> = {
  park: '公园',
  mall: '购物中心',
  hotel: '旅馆',
  gas: '加油站',
  lab: '研究所',
};

/** 标的是否仍在卖方手中（被转手 / 消耗后挂牌自动失效） */
function stillOwns(state: GameState, listing: TradeListing, seller: Player): boolean {
  switch (listing.kind) {
    case 'land':
      return seller.properties.some((q) => q.cellId === Number(listing.targetId));
    case 'stock':
      return (seller.stocks[listing.targetId] ?? 0) > 0;
    case 'card':
      return seller.cards.includes(listing.targetId);
    case 'item':
      return (seller.items[listing.targetId] ?? 0) > 0;
    default:
      return false;
  }
}

/** 当前**有效**的挂牌（失效标的与同标的重复挂牌已被剔除），纯函数不改状态 */
export function liveTrades(state: GameState): TradeListing[] {
  const seen = new Set<string>();
  return state.trades.filter((t) => {
    if (t.closed) return false;
    const key = `${t.sellerId}:${t.kind}:${t.targetId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    const seller = state.players.find((p) => p.id === t.sellerId);
    if (!seller || seller.bankrupt) return false;
    return stillOwns(state, t, seller);
  });
}

/** 清理失效挂牌 + 同标的重复挂牌（只留最早一条） */
export function refreshTrades(state: GameState): void {
  state.trades = liveTrades(state);
}

/** 确定性挂牌 id（不用 RNG，保证回放一致） */
function nextListingId(state: GameState): string {
  const used = new Set(state.trades.map((t) => t.id));
  for (let i = 0; i < 1000; i++) {
    const id = `t${state.turn}_${state.trades.length}_${i}`;
    if (!used.has(id)) return id;
  }
  return `t${state.turn}_${state.trades.length}_x`;
}

/** 当前玩家可挂出的标的（UI-06 渲染「我要挂出」） */
export function tradableAssets(
  state: GameState,
  p: Player,
): Array<{ kind: TradeKind; targetId: string; label: string; suggestPrice: number }> {
  refreshTrades(state);
  const listed = new Set(state.trades.map((t) => `${t.kind}:${t.targetId}`));
  const out: Array<{ kind: TradeKind; targetId: string; label: string; suggestPrice: number }> = [];

  for (const prop of p.properties) {
    const cell = state.board[prop.cellId];
    if (!cell || cell.price === undefined) continue;
    if (listed.has(`land:${prop.cellId}`)) continue;
    out.push({
      kind: 'land',
      targetId: String(prop.cellId),
      label: describeEstate(state, prop),
      // 建议价与购地价同源：一律按公定地价（help[22]，商业地不设溢价）
      suggestPrice: landPrice(state, cell),
    });
  }
  for (const [stockId, qty] of Object.entries(p.stocks)) {
    if (qty <= 0) continue;
    if (listed.has(`stock:${stockId}`)) continue;
    const stock = state.stockMarket.stocks.find((s) => s.id === stockId);
    if (!stock) continue;
    out.push({
      kind: 'stock',
      targetId: stockId,
      label: `股票「${stock.name}」×${qty}（现价 ¥${stock.price}）`,
      suggestPrice: stock.price,
    });
  }
  for (const cardId of p.cards) {
    if (listed.has(`card:${cardId}`)) continue;
    out.push({
      kind: 'card',
      targetId: cardId,
      label: describeTarget(state, 'card', cardId),
      suggestPrice: CARDS[cardId]?.cost ?? 200,
    });
  }
  for (const [itemId, qty] of Object.entries(p.items)) {
    if (qty <= 0) continue;
    if (listed.has(`item:${itemId}`)) continue;
    out.push({
      kind: 'item',
      targetId: itemId,
      label: `${describeTarget(state, 'item', itemId)} ×${qty}`,
      suggestPrice: ITEMS[itemId]?.cost ?? 20,
    });
  }
  return out;
}

/** 校验标的归卖方所有；返回拒绝理由（纯函数，供门控与引擎共用） */
function ownershipRefusal(seller: Player, kind: TradeKind, targetId: string): ActionRefusal {
  switch (kind) {
    case 'land': {
      const cellId = Number(targetId);
      if (!Number.isInteger(cellId)) return '标的无效';
      if (!seller.properties.some((q) => q.cellId === cellId)) return '你并不持有这块地产';
      return null;
    }
    case 'stock':
      return (seller.stocks[targetId] ?? 0) <= 0 ? '你并不持有该股票' : null;
    case 'card':
      return seller.cards.includes(targetId) ? null : '你并不持有这张卡片';
    case 'item':
      return (seller.items[targetId] ?? 0) <= 0 ? '你并不持有这个道具' : null;
    default: {
      const exhaustive: never = kind;
      throw new Error(`未知交易类型: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** 校验标的归卖方所有 */
function assertOwned(seller: Player, kind: TradeKind, targetId: string): void {
  const refusal = ownershipRefusal(seller, kind, targetId);
  if (refusal) throw new Error(refusal);
}

/** 买方容量预检（纯函数）：先校验再动钱，避免中途失败留下半截状态 */
function buyerCapacityRefusal(buyer: Player, kind: TradeKind, targetId: string): ActionRefusal {
  switch (kind) {
    case 'land':
      if (buyer.properties.some((q) => q.cellId === Number(targetId))) return '你已经持有这块地产';
      return null;
    case 'item':
      if ((buyer.items[targetId] ?? 0) >= MAX_ITEM_COUNT) return '你的该类道具已达上限（9 个）';
      return null;
    default:
      return null;
  }
}

/** 买方容量预检 */
function assertBuyerAccepts(buyer: Player, kind: TradeKind, targetId: string): void {
  const refusal = buyerCapacityRefusal(buyer, kind, targetId);
  if (refusal) throw new Error(refusal);
}

/** POST_TRADE 校验（纯函数）：门控与引擎的唯一共同来源 */
/**
 * R4：公布栏交易收到**掷骰前**（与炒股同一扇门）。
 *
 * 这条门此前根本不存在 —— 拍卖进行中和小游戏中都能挂牌、都能买挂牌：那些相位下回合不属于
 * 任何人，交易动作却照样改写地权与现金，等于绕过回合归属动棋盘。
 */
function tradeWindowRefusal(state: GameState): ActionRefusal {
  return state.phase === 'awaiting_roll' ? null : '挂牌与买入只在掷骰前进行';
}

export function postTradeRefusal(state: GameState, seller: Player | null, action: ActionOf<'POST_TRADE'>): ActionRefusal {
  if (!seller) return '当前玩家不存在';
  const window = tradeWindowRefusal(state);
  if (window) return window;
  const price = Math.floor(action.price);
  if (!Number.isFinite(price) || price < 0) return '价格必须是非负整数';
  return ownershipRefusal(seller, action.kind, action.targetId);
}

/** UI-06：挂出标的公开求售 */
export function postTrade(
  state: GameState,
  action: Extract<PlayerAction, { type: 'POST_TRADE' }>,
  current: Player,
  logFn: (t: string) => void,
): void {
  refreshTrades(state);
  const refusal = postTradeRefusal(state, current, action);
  if (refusal) throw new Error(refusal);
  const price = Math.floor(action.price);
  const id = nextListingId(state);
  state.trades = [
    ...state.trades,
    {
      id,
      sellerId: current.id,
      kind: action.kind,
      targetId: action.targetId,
      cellId: action.kind === 'land' ? Number(action.targetId) : 0,
      price,
      postedTurn: state.turn,
      closed: false,
    },
  ];
  logFn(`${current.name} 在公布栏挂出 ${describeTarget(state, action.kind, action.targetId)}，标价 ¥${price.toLocaleString('zh-CN')}`);
}

/** UI-06：买下他人挂牌 */
/** BUY_TRADE 校验（纯函数）：挂牌必须仍在 `liveTrades` 视图里，与 refresh 后的状态一致 */
export function buyTradeRefusal(state: GameState, buyer: Player | null, action: ActionOf<'BUY_TRADE'>): ActionRefusal {
  if (!buyer) return '当前玩家不存在';
  const window = tradeWindowRefusal(state);
  if (window) return window;
  const listing = liveTrades(state).find((t) => t.id === action.listingId);
  if (!listing) return '该挂牌不存在或已失效';
  if (listing.sellerId === buyer.id) return '不能买自己的挂牌，请先撤下';
  const seller = state.players.find((p) => p.id === listing.sellerId);
  if (!seller || seller.bankrupt) return '卖方已倒闭，挂牌失效';
  if (buyer.cash < listing.price) return '现金不足以买下该挂牌';
  if (!stillOwns(state, listing, seller)) return '卖方已不再持有该标的';
  return buyerCapacityRefusal(buyer, listing.kind, listing.targetId);
}

/** UI-06：买下他人挂牌 */
export function buyTrade(
  state: GameState,
  action: Extract<PlayerAction, { type: 'BUY_TRADE' }>,
  current: Player,
  logFn: (t: string) => void,
): void {
  refreshTrades(state);
  const refusal = buyTradeRefusal(state, current, action);
  if (refusal) throw new Error(refusal);
  const listing = state.trades.find((t) => t.id === action.listingId)!;
  const seller = state.players.find((p) => p.id === listing.sellerId)!;

  const price = listing.price;
  const label = describeTarget(state, listing.kind, listing.targetId);

  // 地产：连同等级 / 建设 / 连锁店整体转移
  let movedEstate: PlayerProperty | null = null;
  if (listing.kind === 'land') {
    const cellId = Number(listing.targetId);
    movedEstate = seller.properties.find((q) => q.cellId === cellId) ?? null;
    seller.properties = seller.properties.filter((q) => q.cellId !== cellId);
    if (movedEstate) current.properties.push({ ...movedEstate });
  } else if (listing.kind === 'stock') {
    if ((seller.stocks[listing.targetId] ?? 0) <= 1) delete seller.stocks[listing.targetId];
    else seller.stocks[listing.targetId] = (seller.stocks[listing.targetId] ?? 0) - 1;
    current.stocks[listing.targetId] = (current.stocks[listing.targetId] ?? 0) + 1;
  } else if (listing.kind === 'card') {
    const idx = seller.cards.indexOf(listing.targetId);
    if (idx >= 0) seller.cards.splice(idx, 1);
    current.cards.push(listing.targetId);
  } else {
    if ((seller.items[listing.targetId] ?? 0) <= 1) delete seller.items[listing.targetId];
    else seller.items[listing.targetId] = (seller.items[listing.targetId] ?? 0) - 1;
    current.items[listing.targetId] = (current.items[listing.targetId] ?? 0) + 1;
  }

  // 过手
  current.cash -= price;
  seller.cash += price;

  listing.closed = true;
  state.trades = state.trades.filter((t) => t.id !== listing.id);
  const record: TradeRecord = {
    listingId: listing.id,
    sellerId: seller.id,
    buyerId: current.id,
    kind: listing.kind,
    targetId: listing.targetId,
    price,
    turn: state.turn,
  };
  state.tradeHistory = [...state.tradeHistory, record].slice(-TRADE_HISTORY_LIMIT);
  logFn(
    `【交易】${current.name} 以 ¥${price.toLocaleString('zh-CN')} 买下 ${seller.name} 的 ${
      movedEstate ? describeEstate(state, movedEstate) : label
    }`,
  );
}

/** UI-06：撤下自己的挂牌 */
/** CANCEL_TRADE 校验（纯函数） */
export function cancelTradeRefusal(state: GameState, seller: Player | null, action: ActionOf<'CANCEL_TRADE'>): ActionRefusal {
  if (!seller) return '当前玩家不存在';
  // 撤单也归掷骰前：否则落格窗里还能一边决策一边改挂牌，公布栏在两个回合之间反复变动
  const window = tradeWindowRefusal(state);
  if (window) return window;
  const listing = liveTrades(state).find((t) => t.id === action.listingId);
  if (!listing) return '该挂牌不存在或已失效';
  if (listing.sellerId !== seller.id) return '只能撤下自己的挂牌';
  return null;
}

/** UI-06：撤下自己的挂牌 */
export function cancelTrade(
  state: GameState,
  action: Extract<PlayerAction, { type: 'CANCEL_TRADE' }>,
  current: Player,
  logFn: (t: string) => void,
): void {
  refreshTrades(state);
  const refusal = cancelTradeRefusal(state, current, action);
  if (refusal) throw new Error(refusal);
  const listing = state.trades.find((t) => t.id === action.listingId)!;
  state.trades = state.trades.filter((t) => t.id !== listing.id);
  logFn(`${current.name} 从公布栏撤下了 ${describeTarget(state, listing.kind, listing.targetId)}`);
}