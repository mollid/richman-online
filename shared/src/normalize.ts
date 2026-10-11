import { stockFloatShares } from './stocks.js';
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

  // 股票 K 线与冲击成本（stocks）：老存档的 Stock 没有这两项，按定义表补齐
  for (const stock of state.stockMarket?.stocks ?? []) {
    stock.floatShares ??= stockFloatShares(stock.id);
    stock.candles ??= [];
  }

  // 原始股锁定期（CORP-14）：缺键当作「没有待解锁的股份」，不凭空锁住玩家的持股
  for (const company of state.companies ?? []) company.lockedShares ??= {};

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

  // 待舍弃手牌（R4）：单槽 `pendingCard` 换成队列 `pendingCards`。老热座存档里正卡在
  // awaiting_discard 的那一局，若不把旧的那一张搬进队列，就会停在「要舍弃却没有卡可舍」的
  // 死角（该相位没有 FINISH_LANDING 出口），所以这里做一次形状搬运。
  const legacyPending = state as typeof state & { pendingCard?: string | null };
  state.pendingCards ??= legacyPending.pendingCard ? [legacyPending.pendingCard] : [];
  delete legacyPending.pendingCard;

  // 老状态没有回合子阶段：按可见相位反推一个合理值（该字段不参与任何规则判定）
  if (!state.turnStage) {
    state.turnStage =
      state.phase === 'game_over' ? 'end' : state.phase === 'awaiting_roll' || state.phase === 'lobby' ? 'start' : 'tile_resolve';
  }
  return state;
}
