import { MAX_HAND_CARDS, MAX_ITEM_COUNT } from './board.js';
import { CARDS, SHOP_CARD_IDS } from './cards.js';
import type { CellLandingCtx, LandingResult } from './effect_ctx.js';
import { holdLanding, landingBlocker, landingVenueOf, openBankWindow } from './effect_ctx.js';
import { scaled } from './economy.js';
import { ITEMS, SHOP_ITEM_IDS } from './items.js';
import { nextRandom } from './rng.js';
import type { BoardCell, CompanyKind, CompanyState, GameState, Player, PlayerAction } from './types.js';

/**
 * 公司企业系统（CORP-01..13 / TILE-20..30，波 5）。
 *
 * 本模块承载公司的**数据 + 纯函数 + 落格行为**：
 * - 11 家公司定义（格位、股面值、消费方式）；
 * - 各公司消费金额基数（转轮盘结果由调用方抽取后传入）；
 * - 经营权（董事长）判定：最大持股 + 同票先到先得；
 * - 累计盈余与 15 号分红由引擎的日切钩子处理；
 * - **落格行为**（`landOnCompany`：缴费 → 强制服务 → 挂起等待认购）自 `engine.ts` 迁来，
 *   所需的引擎能力由调用方注入 `CellLandingCtx`，以免本模块反向依赖引擎形成循环。
 *
 * 通用规则（文档 §5.1）：
 * 1. 公司在地图固定格位，开局即存在，各公司股面值不同；
 * 2. 停靠时若**经营权属他人** → 按消费方式缴费，费用充作**累积盈余**；付费后可认购股份（单次 ≤1000 张）；
 * 3. **持股最多**者取得经营权（董事长），享**免付费**特权；他人反超则自动移交；
 * 4. 持股相同 → 经营权归**先入股者**；
 * 5. 每月 15 号按持股比例分配盈余；亏损由股东按比例承担。
 *
 * 与股市的关系（CORP-14，自定扩展）：公司原始股与 6 支上市股是**两档市场**——
 * - **定价**：原始股按**面值**，不涨跌、无 K 线、无冲击成本；上市股按日随机游走；
 * - **货币**：原始股**现金**结算（认购扣现金、卖出回现金）；上市股只能动用**存款**；
 * - **渠道**：认购走一级市场（踩到公司格当场申购，不看盘口，休市照样能买）；
 *   转手走二级市场（股市面板随时挂单，但**例假日休市 / 全市场停牌期间没有对手盘**）；
 * - **锁定**：任何一笔认购都要到**下次行动**才能卖（`lockedShares`，回合推进即解锁），
 *   免得同一回合里「认购 → 夺经营权 → 原价卖回」把特权白嫖一遍。
 */

/** 单次认购股份上限（CORP-01） */
export const MAX_SHARES_PER_BUY = 1000;

/** 房地产公司加盖施工费 = 该地地价 × 比例（CORP-13） */
export const ESTATE_BUILD_RATIO = 0.5;

/** CORP-05 电脑使用费（定额） */
export const COMPUTER_FEE = 800;
/** CORP-10 水费单价（每笔土地） */
export const WATER_FEE_PER_LAND = 200;
/** CORP-11 电费单价（每级建筑） */
export const POWER_FEE_PER_LEVEL = 150;
/** CORP-07 汽车保养费（持有车辆才收） */
export const CAR_MAINTENANCE_FEE = 600;
/** CORP-08 石油公司加油费（持有车辆才收） */
export const OIL_FEE = 700;
/** CORP-03 航空公司：出国旅游每日费用（转轮盘 1..3 天） */
export const AIRLINE_FEE_PER_DAY = 600;
/** CORP-04 饭店：每日消费（转轮盘 1..3 天） */
export const RESTAURANT_FEE_PER_DAY = 500;
/** CORP-06 保险公司：每日保费（转轮盘 1..3 天） */
export const INSURANCE_FEE_PER_DAY = 400;

/** 公司定义 */
export interface CompanyDef {
  kind: CompanyKind;
  /** 棋盘格 id（须与 board.ts 中 companyKind 一致） */
  cellId: number;
  /**
   * 这家公司占的全部格子。自建图一格；原版图一家公司占相邻两格（缺省就是 `[cellId]`）。
   */
  footprint?: number[];
  /** 文档对标编号 */
  tile: string;
  name: string;
  /** 股票面值（每股价格；不随物价指数变化，同股价处理） */
  sharePrice: number;
  /** 消费方式文案 */
  charge: string;
}

export const COMPANY_LIST: CompanyDef[] = [
  { kind: 'airline', cellId: 51, tile: 'TILE-20', name: '航空公司', sharePrice: 500, charge: '转轮盘决定出国天数并付费，出国期间不能收租' },
  { kind: 'restaurant', cellId: 55, tile: 'TILE-21', name: '大饭店', sharePrice: 300, charge: '转轮盘决定休息天数与消费金额' },
  { kind: 'computer', cellId: 43, tile: 'TILE-22', name: '电脑公司', sharePrice: 400, charge: '付电脑使用费（定额）' },
  { kind: 'insurance', cellId: 47, tile: 'TILE-23', name: '保险公司', sharePrice: 350, charge: '强制签约，转轮盘决定投保天数与保费' },
  { kind: 'car', cellId: 57, tile: 'TILE-24', name: '汽车公司', sharePrice: 450, charge: '付保养费（没开车不用给）' },
  { kind: 'bank', cellId: 58, tile: 'TILE-26', name: '企业银行', sharePrice: 480, charge: '同公立银行；董事长可特别融资周转' },
  { kind: 'oil', cellId: 59, tile: 'TILE-25', name: '石油公司', sharePrice: 420, charge: '付加油费（没开车不用给）' },
  { kind: 'water', cellId: 60, tile: 'TILE-27', name: '水力公司', sharePrice: 260, charge: '按拥有土地总笔数付水费' },
  { kind: 'power', cellId: 61, tile: 'TILE-28', name: '电力公司', sharePrice: 280, charge: '按房屋/连锁店/建设的级数总和付电费' },
  { kind: 'department', cellId: 62, tile: 'TILE-29', name: '百货公司', sharePrice: 520, charge: '同公立百货；董事长进入获赠一张卡片或一项道具' },
  { kind: 'estate', cellId: 63, tile: 'TILE-30', name: '房地产公司', sharePrice: 600, charge: '可任选一处加盖一层房屋，按该地地价收取施工费' },
];

/**
 * CORP-14：11 家公司同时挂在**股市**里 —— 与那 6 支虚拟股同一套行情机器
 * （日切游走、日 K 线、冲击成本、停牌 / 涨跌停 / 休市全都吃）。
 *
 * **只有一本股东账**：不管从面板买入（`corp-*`）还是踩格认购，都记进同一张 `CompanyState.shares`
 * 名册，因此一起吃经营权（先到先得）与 15 号盈余分配。两条渠道只剩价格与钱袋的差别 ——
 * 面板按**当日市价、走存款**，踩到公司格按**面值、付现金**（这就是「踩点投资」的全部意义）。
 *
 * id 必须带 `corp-` 前缀：房地产公司的 kind 是 `estate`，与虚拟的「地产股」直接撞名。
 * 流通股本按「各支市值相当（约 20 万）」定标，与 STOCK_DEFS 同一口径 —— 分母决定冲击力度，
 * 公司股不该比上市股更容易被单笔推价。
 */
export const COMPANY_TARGET_MARKET = 200_000;
export const companyStockId = (kind: CompanyKind): string => `corp-${kind}`;
/**
 * 一批公司定义 → 股市里的 `corp-*` 行。自建图与原版图共用这一条口径：
 * 流通股本按「各支市值相当」定标，面值只决定股数（面值越高，同样市值的股数越少）。
 */
export function companyStockDefs(defs: readonly CompanyDef[]) {
  return defs.map((c) => ({
    id: companyStockId(c.kind),
    name: c.name,
    initialPrice: c.sharePrice,
    floatShares: Math.max(1, Math.round(COMPANY_TARGET_MARKET / c.sharePrice)),
  }));
}
export const COMPANY_STOCK_DEFS = companyStockDefs(COMPANY_LIST);

export const COMPANIES: Record<CompanyKind, CompanyDef> = COMPANY_LIST.reduce((acc, def) => {
  acc[def.kind] = def;
  return acc;
}, {} as Record<CompanyKind, CompanyDef>);

/** 需转轮盘（1..3）决定天数/费用的公司（CORP-03/04/06） */
export const WHEEL_KINDS: ReadonlySet<CompanyKind> = new Set<CompanyKind>(['airline', 'restaurant', 'insurance']);

export function companyDef(kind: CompanyKind): CompanyDef {
  return COMPANIES[kind];
}

/** 查找某格对应的公司经营状态（原版一家公司占两格 ⇒ 按 footprint 找，不是按 cellId） */
export function companyAtCell(state: GameState, cellId: number): CompanyState | undefined {
  return state.companies.find((c) => c.footprint.includes(cellId));
}

/**
 * CORP-14：本回合刚认购、还不能进股市转手的股数。
 * 锁定表在回合推进时整表清空（见 `advanceTurn`），所以「下次行动」就是它的解锁时刻。
 */
export function lockedSharesOf(company: CompanyState, playerId: string): number {
  return company.lockedShares?.[playerId] ?? 0;
}

/** CORP-14：可在股市卖出的股数 = 持股 − 锁定 */
export function sellableSharesOf(company: CompanyState, playerId: string): number {
  return Math.max(0, (company.shares[playerId] ?? 0) - lockedSharesOf(company, playerId));
}

/**
 * CORP-01：按可用现金最多能认购几张（同时受单次上限约束）。
 * 面值定价、无冲击成本，所以「成本 ÷ 单价」就是真实上限 —— 面板的「满额」与引擎校验共用此处。
 */
export function maxCashShares(price: number, cash: number): number {
  if (price <= 0) return 0;
  return Math.min(MAX_SHARES_PER_BUY, Math.floor(cash / price));
}

/** 建造级数总和（CORP-11：房屋 + 连锁店 + 建设的级数；连锁店按其等级计） */
export function buildingLevels(p: Player): number {
  return p.properties.reduce((sum, q) => sum + q.grade, 0);
}

/**
 * 公司消费金额（含物价指数）。`roll` 为转轮盘结果（1..3），仅 airline/restaurant/insurance 使用。
 * 汽车/石油公司在没开车（未持有机车/汽车，`diceCount <= 1`）时免费（CORP-07/08）。
 * 银行/百货/房地产不按此计费（银行百货无费用，房地产按所选地价单独结算）。
 */
export function companyFee(state: GameState, kind: CompanyKind, payer: Player, roll: number): number {
  const days = Math.max(1, Math.min(3, roll));
  switch (kind) {
    case 'computer':
      return scaled(state, COMPUTER_FEE);
    case 'water':
      return scaled(state, WATER_FEE_PER_LAND * payer.properties.length);
    case 'power':
      return scaled(state, POWER_FEE_PER_LEVEL * buildingLevels(payer));
    case 'car':
      return payer.diceCount > 1 ? scaled(state, CAR_MAINTENANCE_FEE) : 0;
    case 'oil':
      return payer.diceCount > 1 ? scaled(state, OIL_FEE) : 0;
    case 'airline':
      return scaled(state, AIRLINE_FEE_PER_DAY * days);
    case 'restaurant':
      return scaled(state, RESTAURANT_FEE_PER_DAY * days);
    case 'insurance':
      return scaled(state, INSURANCE_FEE_PER_DAY * days);
    case 'bank':
    case 'department':
    case 'estate':
      return 0;
  }
}

/**
 * 经营权判定（CORP-02）：持股最多者；持股相同取**先入股**者；
 * 再相同则按玩家座次先后。破产玩家不参与计算。无持股则经营权空缺（null）。
 */export function majorityHolderId(company: CompanyState, players: Player[]): string | null {
  const order = new Map(players.map((p, i) => [p.id, i]));
  let best: string | null = null;
  let bestShares = 0;
  let bestSince = Number.MAX_SAFE_INTEGER;
  let bestRank = Number.MAX_SAFE_INTEGER;
  for (const [id, shares] of Object.entries(company.shares)) {
    if (shares <= 0) continue;
    const owner = players.find((p) => p.id === id);
    if (!owner || owner.bankrupt) continue;
    const since = company.firstHeldDayIndex[id] ?? Number.MAX_SAFE_INTEGER;
    const rank = order.get(id) ?? Number.MAX_SAFE_INTEGER;
    const better =
      best === null ||
      shares > bestShares ||
      (shares === bestShares && since < bestSince) ||
      (shares === bestShares && since === bestSince && rank < bestRank);
    if (better) {
      best = id;
      bestShares = shares;
      bestSince = since;
      bestRank = rank;
    }
  }
  return best;
}
/* ==========================================================================
 * 公司落格行为（CORP-01..13 的结算实现，自 `engine.ts` 逐字迁出）
 * ========================================================================== */

/**
 * 公司企业落格结算（CORP-01..13）。
 * - 经营权属他人 → 按消费方式缴费（费用充作累积盈余）+ 强制服务（出国/休息/投保）；
 * - 董事长本人 → 免付费，并享受专属福利（百货赠礼）；
 * - 银行/百货无论持股均提供公共服务；
 * - 结算后进入 `awaiting_action`：可认购股份（CORP-01）、房地产公司可加盖（CORP-13）、
 *   企业银行董事长可特别融资（CORP-09）。
 */
export function landOnCompany(ctx: CellLandingCtx, p: Player, c: BoardCell): LandingResult {
  const { state } = ctx;
  const company = c.companyKind ? companyAtCell(state, c.id) : undefined;
  if (!company) {
    ctx.log(state, `${p.name} 来到「${c.name}」`);
    return 'advance';
  }

  const chairmanId = company.chairmanId;
  const isChairman = chairmanId === p.id;
  const chairmanName = chairmanId ? state.players.find((q) => q.id === chairmanId)?.name ?? chairmanId : null;
  ctx.log(
    state,
    `${p.name} 来到「${company.name}」${isChairman ? '（董事长）' : chairmanName ? `（董事长：${chairmanName}）` : '（经营权空缺）'}`,
  );

  // CORP-12：百货无论经营权归属，董事长都能就地送礼（存取款的授权在下面的开窗判据里给）
  if (isChairman && company.kind === 'department') {
    grantDepartmentGift(ctx, p, company.name);
  }

  // CORP-01：经营权属他人时按消费方式缴费，费用计入累积盈余
  if (chairmanId !== null && !isChairman) {
    let roll = 0;
    if (WHEEL_KINDS.has(company.kind)) {
      const draw = nextRandom(state.rngState);
      state.rngState = draw.nextState;
      roll = 1 + Math.floor(draw.value * 3); // 转轮盘 1..3 天
    }
    const fee = companyFee(state, company.kind, p, roll);
    if (fee > 0) {
      const paid = ctx.pay(state, p, fee, null, { reason: 'company' });
      company.surplus += paid;
      ctx.log(state, `${p.name} 在「${company.name}」缴费 ¥${paid}（计入累积盈余 ¥${company.surplus}）`);
      if (p.bankrupt || ctx.isGameOver(state)) return 'stop';
      applyCompanyService(ctx, p, company.kind, roll);
    } else {
      ctx.log(state, `${p.name} 在「${company.name}」无需缴费`);
    }
  }

  // R4：公司格的窗口有两种形状。
  // - **会话窗**：企业银行（存取款 / 贷款 / 董事长特别融资）、百货公司（买卡片道具）——
  //   可以反复办理，只有「离开」才把行动权交给下一位；
  // - **单步窗**：其余 9 家 —— 认购原始股（CORP-01）或房地产公司加盖（CORP-13），
  //   选完即结束回合。用户要的正是这一条：「购买原始股后是自动结束回合，自然就锁定了这一手买的股票」。
  const venue = landingVenueOf(c);
  if (venue === 'bank') {
    // CORP-09：企业银行的公共服务不分经营权归属，任何人都能在此存取款与贷款。
    // 开窗判据与公立银行共用 `openBankWindow`：先授权再按引擎口径探路，全被拒就不开窗 ——
    // 否则例假日休市时会钉着一扇只有「关闭」的银行窗。特别融资是企业银行多出来的那一件
    // （董事长专属、不看休市），它可办就说明这扇窗确实有事。
    const blocker = openBankWindow(ctx, [{ type: 'SPECIAL_FINANCING', amount: 1 }]);
    if (blocker !== null) {
      ctx.log(state, `${company.name}：${blocker}`);
      return 'advance';
    }
    ctx.log(state, `可以在${company.name}办理存取款，办完离开结束回合`);
    return holdLanding(ctx);
  }
  if (venue === 'shop') {
    ctx.log(state, `可以在${company.name}购买卡片道具，买完离开结束回合`);
    return holdLanding(ctx);
  }
  const options: PlayerAction[] = [{ type: 'BUY_SHARES', cellId: c.id, quantity: 1 }];
  if (company.kind === 'estate') {
    // 加盖的目标是「自己名下的任一块地」，逐个问注册表，与 availableActions.estateBuildCells 同源
    options.push(...p.properties.map((q): PlayerAction => ({ type: 'BUILD_ESTATE', cellId: q.cellId })));
  }
  const blocker = landingBlocker(ctx, options);
  if (blocker !== null) {
    // 单步窗只在真有一件事可办时才弹；理由就地播报，玩家看得见「这一格为什么什么都没弹」
    ctx.log(state, `${company.name}：${blocker}`);
    return 'advance';
  }
  ctx.log(state, `可认购${company.name}原始股（面值 ¥${company.sharePrice}，付现金），或放弃结束本回合`);
  return holdLanding(ctx);
}

/** 公司强制服务（CORP-03/04/06）：出国旅游 / 饭店休息 / 强制投保 */
function applyCompanyService(ctx: CellLandingCtx, p: Player, kind: CompanyKind, roll: number): void {
  const { state } = ctx;
  const days = Math.max(1, Math.min(3, roll));
  switch (kind) {
    case 'airline':
      p.abroadTurns = Math.max(p.abroadTurns, days);
      p.skipTurns = Math.max(p.skipTurns, days);
      ctx.blockRent(p, days);
      ctx.log(state, `【航空公司】${p.name} 乘机出国旅游 ${days} 天（期间不能收租）`);
      break;
    case 'restaurant':
      p.skipTurns = Math.max(p.skipTurns, days);
      ctx.blockRent(p, days);
      ctx.log(state, `【大饭店】${p.name} 在饭店休息 ${days} 天（期间丧失收租权）`);
      break;
    case 'insurance':
      p.insurance = { daysLeft: days };
      ctx.log(state, `【保险公司】${p.name} 强制签约，投保期 ${days} 天`);
      break;
    default:
      break;
  }
}

/** CORP-12：百货公司董事长进入时获赠一张卡片或一项道具 */
function grantDepartmentGift(ctx: CellLandingCtx, p: Player, companyName: string): void {
  const { state } = ctx;
  const kindDraw = nextRandom(state.rngState);
  state.rngState = kindDraw.nextState;
  const pickDraw = nextRandom(state.rngState);
  state.rngState = pickDraw.nextState;
  if (kindDraw.value < 0.5 && p.cards.length < MAX_HAND_CARDS) {
    const cardId = SHOP_CARD_IDS[Math.floor(pickDraw.value * SHOP_CARD_IDS.length)]!;
    p.cards.push(cardId);
    ctx.log(state, `【${companyName}】董事长专享：${p.name} 获赠卡片「${CARDS[cardId]?.name ?? cardId}」`);
    return;
  }
  const itemId = SHOP_ITEM_IDS[Math.floor(pickDraw.value * SHOP_ITEM_IDS.length)]!;
  if ((p.items[itemId] ?? 0) >= MAX_ITEM_COUNT) {
    ctx.log(state, `【${companyName}】董事长专享：道具已满（上限 ${MAX_ITEM_COUNT}），赠礼作废`);
    return;
  }
  p.items[itemId] = (p.items[itemId] ?? 0) + 1;
  ctx.log(state, `【${companyName}】董事长专享：${p.name} 获赠道具「${ITEMS[itemId]?.name ?? itemId}」`);
}
