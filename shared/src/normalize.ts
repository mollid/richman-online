import { stockFloatShares } from './stocks.js';
import { COMPANIES } from './companies.js';
import { landingVenueOf } from './effect_ctx.js';
import type { GameState } from './types.js';

/**
 * 给 `GameState` 幂等地补齐**新增字段的默认值**。
 *
 * 目的是「缺字段的旧对象进了内存也能照常跑」，不是「复现历史」：本项目处于开发阶段，
 * 老录像与老存档不做保底，所以默认值取**当前规则的默认值**即可（新机制默认就是开的）。
 * 以后给 `GameState` 加字段，只在这里补默认值。
 *
 * 只在**外部 GameState 进入内存**的三个入口调用：
 * - `client/src/net/session.ts` 的 `loadHotseatGame`（本地存档可能是重构前存的）；
 * - `shared/src/replay.ts` 的 `ReplayEngine`（外部传入的录像记录）；
 * - `client/src/net/remote.ts` 的房间快照（服务端可能与客户端不同源，例如 dev 服务没重启）。
 * 引擎内部构造的状态本就带齐全部字段，无需再走这里。
 */
export function normalizeGameState(state: GameState): GameState {
  // 随机出生（SP-01）：出生点按 (seed, seat) 派生，老对象没有 seed 就退回当前 RNG 状态
  //（出生点在入局时已经落到 `Player.position` 上，这里补的值只影响此后新加入的座位）
  state.seed ??= state.rngState ?? 0;

  // 出生格押着不放（SP-02）：老存档的玩家没有这一项，按「早已踏出过」补 ——
  // 把 null 当默认值意味着不封锁 TA 现在站的格子，比反过来猜「这格是出生格、不许买」安全。
  for (const p of state.players ?? []) p.spawnCell ??= null;

  // 神明现身机制（W2）：缺键按「开启但场上没有神明」补
  state.boardGods ??= [];
  state.spawnGods ??= true;
  if (!state.godPairBanUntil) state.godPairBanUntil = {};

  // 股票 K 线与冲击成本（stocks）：老存档的 Stock 没有这些项，按定义表补齐。
  // 开盘/锚退回**当前价**（等于承认「今天还没走过」），闸门因此判平盘；波动系数 1 = 与原版同形。
  for (const stock of state.stockMarket?.stocks ?? []) {
    stock.floatShares ??= stockFloatShares(stock.id);
    stock.candles ??= [];
    stock.openPrice ??= stock.price;
    stock.anchorPrice ??= stock.price;
    stock.volatility ??= 1;
    // 剩余流通股：老对象没这个键时按「一股都还没被买走」补 —— 与「还没人交易」的默认一致，
    // 比补成 0（整支票立刻买不到）安全。
    stock.remainingShares ??= stock.floatShares;
  }

  // 原始股锁定期（CORP-14）：缺键当作「没有待解锁的股份」，不凭空锁住玩家的持股。
  // R6 给公司加了 name / footprint：名字退回那张种类表（就是它原先显示的值），
  // footprint 退回「只占脚下这一格」—— 自建图本来就是一格一公司。
  for (const company of state.companies ?? []) {
    company.lockedShares ??= {};
    company.name ??= COMPANIES[company.kind]?.name ?? company.kind;
    company.tile ??= COMPANIES[company.kind]?.tile ?? '';
    company.footprint ??= [company.cellId];
  }

  // 落格决策窗（R4）：老存档没有这个键。若正停在 awaiting_action，就按「格型 → venue」那张
  // 唯一的表**就地补一扇窗** —— 凭据的 cellId 取行动者脚下格，与开窗时的写法一致。
  // 补成 null 也能跑（`checkFinishLanding` 不看它），但商店/银行弹层就认不出自己该给哪颗出口。
  if (state.landing === undefined) {
    const actor = state.players?.[state.currentPlayerIndex ?? -1];
    const held = state.phase === 'awaiting_action' ? state.board?.[actor?.position ?? -1] : undefined;
    state.landing = held ? { cellId: held.id, venue: landingVenueOf(held), turn: state.turn } : null;
  }

  // 结束条件（W4）：缺键按「不限天数」补 —— 上限是一种限制，旧局面没有它就继续按原规则跑
  state.maxDays ??= null;
  if (state.endReason === undefined) state.endReason = null;

  // 拍卖器换规则（W3）：老存档里记的是「连续放弃次数」`passes`，新规则按「谁让过」判定，
  // 人数无法从计数还原 ⇒ 保守当作没人让过（下一圈重新数）。只会最多多轮一轮，不会收不了口。
  const legacyAuction = state.auction as (typeof state.auction & { passes?: number }) | null;
  if (legacyAuction) {
    legacyAuction.passedSinceBid ??= [];
    legacyAuction.withdrawn ??= [];
    delete legacyAuction.passes;
  }

  // ECON-12 待舍弃队列：每条要带归属（见 `PendingCard`）。开发阶段不为老形状兜底。
  state.pendingCards ??= [];

  // 宝箱（TILE-31）改成驻留实体：老对象没有这两个键，按「此刻场上没有宝箱、本月还没投过」补，
  // 下一个换月的日切钩子会照常投一只出来。
  state.treasureCellId ??= null;
  state.treasureMonth ??= 0;

  // 老状态没有回合子阶段：按可见相位反推一个合理值（该字段不参与任何规则判定）
  if (!state.turnStage) {
    state.turnStage =
      state.phase === 'game_over' ? 'end' : state.phase === 'awaiting_roll' || state.phase === 'lobby' ? 'start' : 'tile_resolve';
  }
  return state;
}
