/**
 * 落格结算 handler map（TILE-01..31，对标 `docs/gameplay/玩法系统_游戏开发文档.md` §5）。
 *
 * 为什么要有这个文件：`rollDice` 曾是 591 行的单体函数，前半段是「逐格移动」
 * （路障 / 地雷 / 恶犬 / 乞讨者 / 过起点薪水），后半段是一条 18 分支的
 * `if (c.type === …)` 长链。移动循环与落格结算混在一起，导致「经过某格」与
 * 「停在该格」的语义差别只能靠人脑区分；新增一种格子要在这条链里找插入点，
 * 插入顺序还会悄悄改变判定优先级。
 *
 * 现在：移动循环留在 `engine.rollDice`，落格分派改为按 `CellType` 查本表。
 * `Record<CellType, …>` 提供编译期穷举保护 —— 加一种格型必须在此补 handler。
 *
 * 协议（见 `effect_ctx.ts` 的 `LandingResult`）：
 * - `advance` 本格结算完毕，引擎统一推进回合；
 * - `hold` 本格开了落格决策窗（`holdLanding`），等玩家当场决策；
 * - `stop` 不推进（对局已结束，或该格把后续交给了别的流程）。
 *
 * R4 的写法纪律：**没有第四种出口**。每格要么 `holdLanding(ctx)` 开窗（会话型格子可反复办理，
 * 只有 `FINISH_LANDING` 才推进），要么先 `landingBlocker(...)` 探一下有没有事可做、
 * 无事就 `advance` 让回合自动走。玩家手上不再有「结束回合」那颗按钮，所以
 * 「开窗却没有任何合法动作」= 直接卡死整局；这条不变式由 `landingBlocker` 与
 * `checkFinishLanding`（只看相位、不看凭据的逃生门）两层守住，并由 `economy.test.ts`
 * 的属性测试每帧验证。
 */

import { TREASURE_POINTS } from './board.js';
import { landOnCompany } from './companies.js';
import type { CellLandingCtx, LandingResult } from './effect_ctx.js';
import { holdLanding, landingBlocker } from './effect_ctx.js';
import { landPrice, scaled } from './economy.js';
import { CRIME_JAIL_DAYS, FATE_MAP_IDS, fateCardById, renderFateText } from './fate.js';
import { LOTTERY_TICKET_COST } from './lottery.js';
import { CURSES, CURSE_ORDER, MAGIC_CONDITIONS, MAGIC_CONDITION_LABEL } from './npc.js';
import { nextRandom } from './rng.js';
import {
  FACILITIES,
  FACILITY_ORDER,
  HOTEL_MAX_DAYS,
  MAX_GRADE,
  RESEARCH_ORDER,
  facilitySpendBase,
  facilityUpgradeable,
  gasFee,
  gradeName,
  vehicleLabel,
  vehicleLevel,
} from './tiles.js';
import type { CellType, MagicOffer, MinigameState, PlayerAction, VillainKind } from './types.js';

/**
 * EVT-02：机会/危险格的违法事件风险。
 * 判定用**只读派生随机**（`nextRandom(state.rngState).value` 读而不写回），
 * 因此不改变 RNG 抽数序列，对既有确定性回放零影响。
 */
const CRIME_CHANCE = 0.35;

/** 起点格（TILE 起点）：正好停在起点只播报，薪水已在移动循环里按「经过」发放 */
function onLandingStart(ctx: CellLandingCtx): LandingResult {
  const { state, self: p } = ctx;
  ctx.log(state, `${p.name} 正好停在起点`);
  return 'advance';
}

/** TILE-17 机会/危险格：命运卡池抽签（help[28]）+ 附带的违法事件风险（EVT-02） */
function onLandingChance(ctx: CellLandingCtx): LandingResult {
  const { state, self: p } = ctx;
  ctx.resolveFateCard(state, p);
  if (ctx.isGameOver(state)) return 'stop';
  // EVT-02：机会/危险格附带违法事件风险（只读派生随机，不消耗 RNG 抽数）
  const crimeRoll = nextRandom(state.rngState);
  if (crimeRoll.value < CRIME_CHANCE) {
    // 案由取自命运卡「地图专属池」（id 33–48 全是违法坐牢事件）：用同一读数值派生，零抽数
    const causeId =
      FATE_MAP_IDS[
        Math.min(FATE_MAP_IDS.length - 1, Math.floor((crimeRoll.value / CRIME_CHANCE) * FATE_MAP_IDS.length))
      ]!;
    const cause = fateCardById(causeId);
    const days = cause?.days ?? CRIME_JAIL_DAYS;
    ctx.applyDisaster(state, p, 'jail', null, (v) => {
      v.skipTurns = Math.max(v.skipTurns, days);
      v.custody = { kind: 'jail', daysLeft: Math.max(v.skipTurns, days) };
      ctx.blockRent(v, days);
    });
    ctx.log(state, `【违法事件】${renderFateText(cause ?? { id: causeId, text: '卷入违法案件', effect: 'jail' }, { days })}`);
    if (ctx.isGameOver(state)) return 'stop';
  }
  return 'advance';
}

/** 税务格：按当前现金 10% 计税（固定比例，金额过物价指数） */
function onLandingTax(ctx: CellLandingCtx): LandingResult {
  const { state, self: p } = ctx;
  const tax = scaled(state, Math.floor(p.cash * 0.1));
  if (ctx.tryFreePass(state, p, tax)) return 'advance';
  ctx.log(state, `${p.name} 需缴税 ¥${tax}`);
  ctx.payCash(state, p, tax, null, 'tax');
  return ctx.isGameOver(state) ? 'stop' : 'advance';
}

/**
 * TILE-09 医院：住院不能出门且丧失收租权利，每天 1000 医药费（help [37]）。
 * 医药费按住院天数在日切钩子逐日收取；此处只办入住。
 *
 * R4：这一格原先无条件 `'advance'`，于是 `DISCHARGE_PATIENT` 是一条**永远打不出来**的动作
 * —— 站在医院门外却没有任何窗口能替别人办理出院。现在门外确有别的住院病人（且办得起）时才开窗。
 */
function onLandingHospital(ctx: CellLandingCtx): LandingResult {
  const { state, self: p } = ctx;
  p.skipTurns = Math.max(p.skipTurns, 1);
  p.custody = { kind: 'hospital', daysLeft: Math.max(p.skipTurns, 1) };
  ctx.blockRent(p, 1);
  ctx.log(state, `${p.name} 办理住院（住院期间丧失收租权，每天需付医药费）`);
  // 只替**别人**办理：自己刚入住，立刻交出院费把自己捞出去等于没住院
  const patients = state.players.filter((q) => q.id !== p.id && q.custody?.kind === 'hospital' && q.skipTurns > 0);
  const blocker = landingBlocker(ctx, patients.map((q): PlayerAction => ({ type: 'DISCHARGE_PATIENT', targetPlayerId: q.id })));
  if (blocker !== null) return 'advance';
  ctx.log(state, `医院门外有 ${patients.length} 位住院病人，可代为办理提前出院`);
  return holdLanding(ctx);
}

/** TILE-10 监狱：落地不停留在牢内（安全），可在监狱门外保释在押恶人（help [34]） */
function onLandingJail(ctx: CellLandingCtx): LandingResult {
  const { state, self: p, cell: c } = ctx;
  const jailed = state.npcs.filter((n) => n.jailed && n.kind !== 'dog');
  const blocker = landingBlocker(
    ctx,
    jailed.map((n): PlayerAction => ({ type: 'BAIL_PRISONER', npcKind: n.kind as VillainKind })),
  );
  ctx.log(
    state,
    `${p.name} 来到「${c.name}」门外（安全无恙）` +
      (blocker === null
        ? `，可花 ¥${ctx.bailFee(state)} 保释在押恶人`
        : jailed.length === 0
          ? '，当前没有在押恶人'
          : `，${blocker}`),
  );
  return blocker === null ? holdLanding(ctx) : 'advance';
}

/**
 * TILE-12 卡片屋：**会话窗**（`venue='shop'`）。
 * 买一张、再买一张、把不要的变卖给商店……买完不推进回合，只有「离开商店」（`FINISH_LANDING`）
 * 才把行动权交给下一位 —— 这正是原版「进去买东西，买完离开」的体感。
 */
function onLandingShop(ctx: CellLandingCtx): LandingResult {
  const { state, self: p, cell: c } = ctx;
  ctx.state.phase = 'awaiting_action';
  ctx.log(state, `${p.name} 来到${c.name}，可以购买卡片道具；买完点「离开商店」结束回合`);
  return holdLanding(ctx);
}

/**
 * TILE-08 公立银行 / TILE-26 企业银行：**会话窗**（`venue='bank'`），停留当格开放存取款与贷款。
 *
 * 但只在「真有事可办」时才开：例假日休市且没有贷款可还的这一格，推进回合就是它的正确结算，
 * 钉在窗口里只能靠逃生门出来。
 */
function onLandingBank(ctx: CellLandingCtx): LandingResult {
  const { state, self: p, cell: c } = ctx;
  // 先授权再探路：银行四项校验读的都是 `state.bankAccess`，顺序倒了会得到「当前不能进行银行操作」，
  // 于是每格银行都被判成「无事可做」—— 门控与引擎同源的含义就是**按引擎的口径去问**。
  state.bankAccess = { canDeposit: true, canLoan: true, cellId: c.id };
  const blocker = landingBlocker(ctx, [
    { type: 'DEPOSIT', amount: 1 },
    { type: 'WITHDRAW', amount: 1 },
    { type: 'TAKE_LOAN', amount: 1 },
    { type: 'REPAY_LOAN', amount: 1 },
  ]);
  if (blocker !== null) {
    // 例假日休市且无贷款可还：这一格确实没事，把刚给的权限收回去（别留给下一位）
    state.bankAccess = null;
    ctx.log(state, `${p.name} 来到${c.name}，${blocker}`);
    return 'advance';
  }
  ctx.log(state, `${p.name} 来到${c.name}，可以存取款与贷款；办完点「离开银行」结束回合`);
  return holdLanding(ctx);
}

/** TILE 神庙：摇籤随机召唤一位神明附身 */
function onLandingGod(ctx: CellLandingCtx): LandingResult {
  const { state, self: p } = ctx;
  ctx.log(state, `${p.name} 进入神庙祈福`);
  ctx.summonGod(state, p);
  return 'advance';
}

/** 游戏厅四选一（EVT-03/05/06）：三仙归洞 / 记忆翻牌 / 七彩气球 / 企鹅挖宝 */
function onLandingGame(ctx: CellLandingCtx): LandingResult {
  const { state, self: p } = ctx;
  const kindRoll = nextRandom(state.rngState);
  state.rngState = kindRoll.nextState;
  const pick = Math.floor(kindRoll.value * 4);
  const blank = (): MinigameState => ({
    kind: 'shells',
    round: 0,
    hits: [],
    symbols: [],
    revealed: [],
    matched: [],
    flips: 0,
  });
  if (pick === 1) {
    // 记忆翻牌：4 对图案洗牌
    const symbols: number[] = [];
    for (let i = 0; i < 4; i++) symbols.push(i, i);
    for (let i = symbols.length - 1; i > 0; i--) {
      const draw = nextRandom(state.rngState);
      state.rngState = draw.nextState;
      const j = Math.floor(draw.value * (i + 1));
      const tmp = symbols[i]!;
      symbols[i] = symbols[j]!;
      symbols[j] = tmp;
    }
    state.minigame = { ...blank(), kind: 'memory', symbols, matched: Array(8).fill(false) };
    state.phase = 'awaiting_pick';
    ctx.log(state, `${p.name} 进入游戏厅玩「记忆翻牌」：8 张牌 4 对图案，翻完全部配对奖励翻倍！`);
  } else if (pick === 2) {
    // EVT-05 七彩气球：3 轮，踩中气球得奖、踩到炸弹提前结束
    state.minigame = { ...blank(), kind: 'balloon', exploded: false };
    state.phase = 'awaiting_pick';
    ctx.log(state, `${p.name} 进入游戏厅玩「七彩气球」：共 3 轮，小心别踩到炸弹！`);
  } else if (pick === 3) {
    // EVT-06 企鹅挖宝：3 轮，帮企鹅挖出冰下的宝物
    state.minigame = { ...blank(), kind: 'penguin' };
    state.phase = 'awaiting_pick';
    ctx.log(state, `${p.name} 进入游戏厅玩「企鹅挖宝」：共 3 轮，挖中宝物越多奖励越高！`);
  } else {
    state.minigame = blank();
    state.phase = 'awaiting_pick';
    ctx.log(state, `${p.name} 进入游戏厅玩「三仙归洞」：共 3 轮，猜中越多奖励越高！`);
  }
  return 'hold';
}

/**
 * TILE-01 住宅用地（EST-01..05）：无主可买 / 自家可加盖 / 他人付租。
 * 租金管道依次过：涨价查封 → 神明显灵 → GOD-12 霉运倍率 → 免费卡反制 → 同盟联合收费。
 */
function onLandingProperty(ctx: CellLandingCtx): LandingResult {
  const { state, self: p, cell: c } = ctx;
  if (c.price === undefined || c.baseRent === undefined) throw new Error(`未知格类型: ${c.type}`);
  const owned = ctx.cellOwner(state, c.id);

  // 工程车（ITEM-12）：走到哪拆到哪
  if (p.bulldozerTurns > 0 && owned && owned.player.id !== p.id && owned.property.grade > 1) {
    owned.property.grade = (owned.property.grade - 1) as 1 | 2 | 3 | 4 | 5;
    ctx.log(state, `工程车轰鸣，${owned.player.name} 的「${c.name}」被拆至 ${owned.property.grade} 级`);
  }

  if (!owned) {
    // R4：买地是**单步窗** —— 买下或放弃都直接推进回合。买不成（钱不够 / 梦游 / 衰神 / 还站在出生格）
    // 就根本不开窗，理由写进播报，玩家看得见「这一格为什么什么都没弹」。
    const price = landPrice(state, c);
    const blocker = landingBlocker(ctx, [{ type: 'BUY_LAND' }]);
    ctx.log(state, `${p.name} 来到无主地产「${c.name}」（售价 ¥${price}${blocker === null ? '' : `，${blocker}`}）`);
    return blocker === null ? holdLanding(ctx) : 'advance';
  }
  if (owned.player.id === p.id) {
    // EST-02 住宅可加盖至 5 级；EST-04 连锁店不能再加盖
    if (!owned.property.chain && owned.property.grade < MAX_GRADE) {
      const blocker = landingBlocker(ctx, [{ type: 'UPGRADE_LAND' }]);
      ctx.log(
        state,
        `${p.name} 回到自家「${c.name}」（${gradeName(owned.property.grade)}）${blocker === null ? '' : `，${blocker}`}`,
      );
      return blocker === null ? holdLanding(ctx) : 'advance';
    }
    ctx.log(state, `${p.name} 回到${owned.property.chain ? '连锁店' : '满级地产'}「${c.name}」`);
    return 'advance';
  }

  // 丧失收租权（坐牢/冬眠/梦游）；出国旅游期间同样不能收租（CORP-03）
  if (owned.player.rentBlockedTurns > 0 || owned.player.abroadTurns > 0) {
    const blocked =
      owned.player.rentBlockedTurns > 0
        ? `正在停留中（剩余 ${owned.player.rentBlockedTurns} 天）`
        : `正在国外旅游（剩余 ${owned.player.abroadTurns} 天）`;
    ctx.log(state, `${owned.player.name} ${blocked}，无权收租`);
    return 'advance';
  }

  // 同盟卡（CARD-29）：互不收过路费
  if (p.alliance && p.alliance.with === owned.player.id) {
    ctx.log(state, `${p.name} 与 ${owned.player.name} 处于同盟，互免过路费`);
    return 'advance';
  }

  const effect = state.rentEffects.find((e) => e.cells.includes(c.id));
  if (effect?.kind === 'seal') {
    ctx.log(state, `「${c.name}」所在的街道被查封，本次免收过路费`);
    return 'advance';
  }
  let rent = ctx.propertyRent(state, c, owned);
  if (effect?.kind === 'raise') {
    rent *= 2;
    ctx.log(state, `「${c.name}」所在的街道正在涨价，过路费加倍`);
  }
  // 行进显灵·租金类（抵赖 / 减半 / 加倍）
  rent = ctx.applyGodRentModifier(state, p, rent, c.name);
  // GOD-12 霉运：付出去的过路费按霉运倍率上浮（倒霉事加倍）
  const bad = ctx.unluckyMultiplier(p);
  if (bad > 1) {
    rent *= bad;
    ctx.log(state, `${p.name} 霉运缠身，过路费被霉运抬高 ${bad} 倍`);
  }
  if (rent <= 0) return 'advance';

  if (ctx.tryFreePass(state, p, rent)) return 'advance';
  ctx.log(state, `${p.name} 进入 ${owned.player.name} 的「${c.name}」，需付租金 ¥${rent}`);
  ctx.pay(state, p, rent, owned.player, { toDeposit: true, reason: 'rent' });
  // NPC-04 窃取租金：记录本地上次收取的租金，供窃取租金型恶人作案
  owned.property.lastRent = rent;

  // CARD-29 同盟联合收费（CARD-29「與對手房地產聯合收費，所得各算各的」）：
  // 地主有盟友、且该盟友在同一街道也持有地产时，本笔租金由地主与其盟友平分。
  const ownerAlly = owned.player.alliance
    ? state.players.find((q) => q.id === owned.player.alliance!.with)
    : undefined;
  const allyHoldsSameStreet = ownerAlly
    && !ownerAlly.bankrupt
    && ownerAlly.properties.some((q) => {
      const allyCell = state.board[q.cellId];
      return allyCell?.street != null && allyCell.street === c.street;
    });
  if (allyHoldsSameStreet) {
    const allyHalf = Math.floor(rent / 2);
    ownerAlly!.deposit += allyHalf;
    ctx.log(state, `同盟联合收费：${allyHalf} 归盟友 ${ownerAlly!.name}，其余归 ${owned.player.name}`);
  }
  return ctx.isGameOver(state) ? 'stop' : 'advance';
}

/**
 * TILE-02..07 商业用地与设施（EST-06..12）：无主可买 / 自家可建设或加盖 /
 * 他人则按设施消费（加油站按步数、购物中心与旅馆转轮盘）。
 */
function onLandingCommercial(ctx: CellLandingCtx): LandingResult {
  const { state, self: p, cell: c, moved } = ctx;
  if (c.price === undefined) throw new Error(`未知格类型: ${c.type}`);
  const owned = ctx.cellOwner(state, c.id);
  if (!owned) {
    const price = landPrice(state, c);
    const blocker = landingBlocker(ctx, [{ type: 'BUY_LAND' }]);
    ctx.log(
      state,
      `${p.name} 来到无主商业用地「${c.name}」（购地价 ¥${price}；首次只能购地，再次抵达才可建设）${blocker === null ? '' : `，${blocker}`}`,
    );
    return blocker === null ? holdLanding(ctx) : 'advance';
  }
  if (owned.player.id === p.id) {
    // R4：建设 / 加盖 / 研发各自成为**单步终结动作** —— 选完即推进回合。
    // 于是取消了旧规里「同一次停留先建设再加盖」的组合：想接着加盖就得再走一圈。
    if (!owned.property.facility) {
      const blocker = landingBlocker(ctx, FACILITY_ORDER.map((f): PlayerAction => ({ type: 'BUILD_FACILITY', facility: f })));
      ctx.log(state, `${p.name} 回到自有商业用地「${c.name}」${blocker === null ? '，可以开工建设' : `，${blocker}`}`);
      return blocker === null ? holdLanding(ctx) : 'advance';
    }
    if (facilityUpgradeable(owned.property) && owned.property.grade < MAX_GRADE) {
      const blocker = landingBlocker(ctx, [{ type: 'UPGRADE_LAND' }]);
      ctx.log(
        state,
        `${p.name} 回到自己的${FACILITIES[owned.property.facility].name}「${c.name}」（${gradeName(owned.property.grade)}）${blocker === null ? '' : `，${blocker}`}`,
      );
      return blocker === null ? holdLanding(ctx) : 'advance';
    }
    if (owned.property.facility === 'lab') {
      const blocker = landingBlocker(ctx, RESEARCH_ORDER.map((r): PlayerAction => ({ type: 'START_RESEARCH', itemId: r.itemId })));
      ctx.log(state, `${p.name} 回到自己的研究所「${c.name}」${blocker === null ? '，可以立项研发' : `，${blocker}`}`);
      return blocker === null ? holdLanding(ctx) : 'advance';
    }
    ctx.log(state, `${p.name} 在自己的「${c.name}」稍作停留`);
    return 'advance';
  }

  const prop = owned.property;
  if (!prop.facility) {
    ctx.log(state, `${owned.player.name} 的「${c.name}」尚未建设，${p.name} 无需付费`);
    return 'advance';
  }
  const def = FACILITIES[prop.facility];
  if (!def.charges) {
    // EST-08 公园 / EST-09 研究所：不向使用者收费
    ctx.log(state, `「${c.name}」的${def.name}免费开放，${p.name} 安全落脚`);
    return 'advance';
  }
  if (prop.facility === 'gas') {
    // EST-11 / TILE-05：按行走步数 × 交通工具等级收费
    const level = vehicleLevel(p);
    const fee = ctx.applyGodRentModifier(state, p, gasFee(state, moved, level), c.name);
    if (fee <= 0) return 'advance';
    ctx.log(state, `${p.name} 在「${c.name}」加油（${moved} 步 × ${vehicleLabel(level)}），需付 ¥${fee}`);
    if (ctx.tryFreePass(state, p, fee)) return 'advance';
    ctx.pay(state, p, fee, owned.player, { toDeposit: true, reason: 'rent' });
    return ctx.isGameOver(state) ? 'stop' : 'advance';
  }
  // EST-12 / TILE-06/07：购物中心 / 旅馆转轮盘决定消费金额（旅馆另加强制休息天数）
  const spin = nextRandom(state.rngState);
  state.rngState = spin.nextState;
  const multiplier = 1 + Math.floor(spin.value * 3); // 1..3 档
  const amount = ctx.applyGodRentModifier(state, p, scaled(state, facilitySpendBase(c, prop.grade) * multiplier), c.name);
  let days = 0;
  if (prop.facility === 'hotel') {
    const rest = nextRandom(state.rngState);
    state.rngState = rest.nextState;
    days = 1 + Math.floor(rest.value * HOTEL_MAX_DAYS); // 1..3 天
  }
  if (amount > 0) {
    ctx.log(state, `${p.name} 在「${c.name}」的${def.name}消费，轮盘判定需付 ¥${amount}${days > 0 ? `，并强制休息 ${days} 天` : ''}`);
    if (ctx.tryFreePass(state, p, amount)) return 'advance';
    ctx.pay(state, p, amount, owned.player, { toDeposit: true, reason: 'rent' });
    if (ctx.isGameOver(state)) return 'stop';
  } else {
    ctx.log(state, `${p.name} 在「${c.name}」的${def.name}落脚${days > 0 ? `，并强制休息 ${days} 天` : ''}`);
  }
  if (days > 0) {
    p.skipTurns = Math.max(p.skipTurns, days);
    ctx.blockRent(p, days);
    ctx.log(state, `${p.name} 在旅馆休息 ${days} 天，期间丧失收租权`);
  }
  return 'advance';
}

/** TILE-13 免费卡片格 */
function onLandingFreeCard(ctx: CellLandingCtx): LandingResult {
  const { state, self: p } = ctx;
  ctx.drawChanceCard(state, p, '卡片屋');
  return 'advance';
}

/** TILE-14/15/16 点券格 */
function onLandingPoints(ctx: CellLandingCtx): LandingResult {
  const { state, self: p, cell: c } = ctx;
  const gain = c.pointsGain ?? 10;
  p.points += gain;
  ctx.log(state, `${p.name} 在「${c.name}」获得 ${gain} 点券`);
  return 'advance';
}

/** TILE-31 宝箱（点数来源，待验证） */
function onLandingTreasure(ctx: CellLandingCtx): LandingResult {
  const { state, self: p, cell: c } = ctx;
  p.points += TREASURE_POINTS;
  ctx.log(state, `${p.name} 打开「${c.name}」，获得 ${TREASURE_POINTS} 点券！`);
  return 'advance';
}

/** TILE-18 新闻格：游标轮询触发 36 条新闻事件池中的一条（EVT-01） */
function onLandingNews(ctx: CellLandingCtx): LandingResult {
  const { state } = ctx;
  ctx.resolveNewsEvent(state);
  return ctx.isGameOver(state) ? 'stop' : 'advance';
}

/** TILE-19 乐透行：自选号码投注（ECON-08），每月 15 号开奖。买一张就结束本回合（R4 单步窗） */
function onLandingLottery(ctx: CellLandingCtx): LandingResult {
  const { state, self: p, cell: c } = ctx;
  const blocker = landingBlocker(ctx, [{ type: 'BUY_LOTTERY_TICKET', number: 0 }]);
  ctx.log(
    state,
    `${p.name} 来到「${c.name}」：可自选号码投注 ¥${LOTTERY_TICKET_COST}（每月 15 号开奖）${blocker === null ? '' : `，${blocker}`}`,
  );
  return blocker === null ? holdLanding(ctx) : 'advance';
}

/** TILE-11 魔法屋（NPC-06 女巫）：水晶球给出施法条件 + 诅咒，由玩家指定受罚者 */
function onLandingMagic(ctx: CellLandingCtx): LandingResult {
  const { state, self: p, cell: c } = ctx;
  const conditionRoll = nextRandom(state.rngState);
  state.rngState = conditionRoll.nextState;
  const condition = MAGIC_CONDITIONS[Math.floor(conditionRoll.value * MAGIC_CONDITIONS.length)]!.kind;
  const curseRoll = nextRandom(state.rngState);
  state.rngState = curseRoll.nextState;
  const curse = CURSE_ORDER[Math.floor(curseRoll.value * CURSE_ORDER.length)]!;
  const curseDef = CURSES[curse];
  const candidateIds = ctx.magicCandidates(state, p, condition);
  const offer: MagicOffer = {
    condition,
    curse,
    candidateIds,
    amount: curse === 'fine' ? scaled(state, curseDef.amount ?? 0) : 0,
    days: curseDef.days ?? 0,
  };
  state.magic = offer;
  // R4：单步窗 —— 施完法就结束回合。0 个候选时今天也照样开窗，玩家面对一个没有任何按钮的面板，
  // 只能靠逃生门出来；现在直接推进，并把「悻悻收回水晶球」这条本就写好的播报留在原位。
  const blocker = landingBlocker(ctx, candidateIds.map((id): PlayerAction => ({ type: 'CAST_MAGIC', targetPlayerId: id })));
  ctx.log(
    state,
    `${p.name} 进入「${c.name}」，女巫的水晶球亮起：${MAGIC_CONDITION_LABEL[condition]}；若施法，将降下「${curseDef.name}」`,
  );
  if (blocker !== null) {
    ctx.log(state, '当前没有符合条件的受罚对象，女巫悻悻收回水晶球');
    return 'advance';
  }
  return holdLanding(ctx);
}

/** TILE-20..30 公司企业（CORP-01..13）：消费与服务结算见 `companies.ts` */
function onLandingCompany(ctx: CellLandingCtx): LandingResult {
  return landOnCompany(ctx, ctx.self, ctx.cell);
}

/** 未预期的格型：与原实现的兜底分支同文案，保证日志与错误信息零漂移 */
function onUnexpectedLanding(ctx: CellLandingCtx): LandingResult {
  throw new Error(`未知格类型: ${ctx.cell.type}`);
}

/**
 * 格型 → 落格 handler。
 * `start` 之外的每一格都在此登记；未在表内的格型走 `onUnexpectedLanding`，
 * 其报错文案与原实现的链尾兜底一致。
 */
export const CELL_HANDLERS: Record<CellType, (ctx: CellLandingCtx) => LandingResult> = {
  start: onLandingStart,
  property: onLandingProperty,
  commercial: onLandingCommercial,
  chance: onLandingChance,
  news: onLandingNews,
  'free-card': onLandingFreeCard,
  points: onLandingPoints,
  lottery: onLandingLottery,
  magic: onLandingMagic,
  treasure: onLandingTreasure,
  tax: onLandingTax,
  hospital: onLandingHospital,
  jail: onLandingJail,
  bank: onLandingBank,
  shop: onLandingShop,
  god: onLandingGod,
  game: onLandingGame,
  company: onLandingCompany,
};

/** 落格分派入口：按格型查表执行，返回值交给 `rollDice` 决定回合是否推进 */
export function resolveLanding(ctx: CellLandingCtx): LandingResult {
  return (CELL_HANDLERS[ctx.cell.type] ?? onUnexpectedLanding)(ctx);
}
