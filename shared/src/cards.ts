import { MAX_HAND_CARDS, MAX_ITEM_COUNT } from './board.js';
import type { CardEffectCtx } from './effect_ctx.js';
import { scaled, upgradeCost } from './economy.js';
import { godDef } from './gods.js';
import { clearBoardGodsOnCells, godSummonRefusal } from './godspawn.js';
import { ITEMS } from './items.js';
import { FACILITIES, MAX_GRADE, facilityUpgradeable, gradeName, viewportCells } from './tiles.js';
import type { GameState, Player } from './types.js';

/**
 * 卡片系统（CARD-01 – CARD-30，对标 `docs/gameplay/玩法系统_游戏开发文档.md` §6）。
 *
 * 通用规则：
 * - 全游戏共 30 种卡片，每人最多持有 15 张（`MAX_HAND_CARDS`）；
 * - 卡片**只能以点券购买**（`cost` 单位为点券），不能以现金购买；
 * - 「自动」卡片（复仇/嫁祸/免费/免罪）不主动使用，由反制栈在受击时自动触发。
 *
 * 反制关系（§6.1）：免罪 → 陷害/梦游/乌龟/牢狱；嫁祸/复仇 → 陷害/梦游；查封 ⇄ 涨价；红卡 ⇄ 黑卡。
 *
 * 每张卡的**效果体写在自己的定义里**（`apply`），由 `engine.ts` 注入 `CardEffectCtx` 调用：
 * 新增一张卡只改本文件一处，效果与其校验不会分处两地而各说各话。
 */

/** 卡片可用时机 */
export type CardPhase = 'pre_roll' | 'post_roll' | 'any';

/** 卡片目标类型（决定 UI 需要收集哪些参数） */
export type CardTarget = 'none' | 'player' | 'land' | 'building' | 'stock';

export interface CardDef {
  id: string;
  name: string;
  description: string;
  /** 商店售价（点券） */
  cost: number;
  phase: CardPhase;
  target: CardTarget;
  /** 需要选择股票（红卡/黑卡） */
  needsStock?: boolean;
  /** 自动触发（不可主动使用） */
  auto?: boolean;
  /** 反制它的卡片 id（仅用于 UI 提示） */
  counteredBy?: string[];
  /**
   * 是否已开放。拍卖卡依赖波 6 的拍卖系统，当前入库但不开放
   * （不进商店货架、不进机会池）。
   */
  available: boolean;
  /**
   * 能否使用这张卡的**额外棋盘前提**（时机 / 是否持有 / 是否自动这些通用项由引擎判）。
   * 返回字符串 = 拒绝理由。
   *
   * 为什么要有它：像「请神卡」这类卡的合法性取决于局面（此刻棋盘上有没有神可请），
   * 而 `checkUseCard` 只查得到卡片自身的条件。没有 guard 就会出现
   * 「卡片列在可用手牌里、按下去却报错」—— 门控与引擎同源的老毛病。
   */
  guard?: (state: GameState, actor: Player) => string | null;
  /**
   * 卡片效果。自动触发类（`auto`）没有本函数，由反制栈处理。
   * 校验不通过时抛错（引擎把错误回传给客户端），副作用直接写 `ctx.state`。
   * 函数内 `return` 表示「本卡已生效、正常结束」，等价于原先 switch 里的 `break`。
   */
  apply?: (ctx: CardEffectCtx) => void;
}

/** 红卡 ⇄ 黑卡共用一套逻辑，靠 `ctx.card.id` 区分方向（CARD-24/25） */
function applyStockHalt(ctx: CardEffectCtx): void {
  const { state, self: p, action, card, stockById, log } = ctx;
  const stock = action.stockId ? stockById(state, action.stockId) : undefined;
  if (!stock) throw new Error('请选择有效的股票');
  const kind = card.id === 'red-card' ? 'up' : 'down';
  const opposite = state.stockHalts.find((h) => h.stockId === stock.id && h.kind !== kind);
  if (opposite) {
    state.stockHalts = state.stockHalts.filter((h) => h !== opposite);
    log(state, `${p.name} 使用「${card.name}」，与反向操作互相抵消，${stock.name} 恢复自由涨跌`);
  } else {
    state.stockHalts = state.stockHalts.filter((h) => h.stockId !== stock.id);
    state.stockHalts.push({ stockId: stock.id, kind, daysLeft: 3 });
    const pct = kind === 'up' ? 15 : -15;
    stock.price = Math.max(5, Math.round(stock.price * (1 + pct / 100)));
    log(state, `${p.name} 使用「${card.name}」，${stock.name} ${kind === 'up' ? '涨停' : '跌停'}板 3 天（现价 ¥${stock.price}）`);
  }
}

/** 涨价卡 ⇄ 查封卡共用一套逻辑，同路段的旧效果被覆盖（CARD-27/28） */
function applyRentEffect(ctx: CardEffectCtx): void {
  const { state, self: p, card, anyCellId, routeSegment, log } = ctx;
  const id = anyCellId();
  const c = state.board[id]!;
  if (c.type !== 'property') throw new Error('目标必须是土地');
  const cells = routeSegment(state, id);
  const kind = card.id === 'raise-rent' ? 'raise' : 'seal';
  // 查封 ⇄ 涨价 互反：同路段的旧效果被覆盖
  state.rentEffects = state.rentEffects.filter((e) => !e.cells.some((x) => cells.includes(x)));
  state.rentEffects.push({ kind, daysLeft: 5, cells, ownerId: p.id });
  log(state, `${p.name} 使用「${card.name}」，路段「${c.name}」${kind === 'raise' ? '加倍收取过路费' : '免收过路费'} 5 天`);
}

export const CARDS: Record<string, CardDef> = {
  // ---- CARD-01..05 现金属性 + 地产置换 ----
  'even-all': {
    id: 'even-all',
    name: '均富卡',
    description: '将所有人的现金平分（余数归使用者）',
    cost: 200,
    phase: 'any',
    target: 'none',
    available: true,
    apply: ({ state, self: p, log }) => {
      const active = state.players.filter((q) => !q.bankrupt);
      const pool = active.reduce((sum, q) => sum + q.cash, 0);
      const avg = Math.floor(pool / active.length);
      for (const q of active) q.cash = avg;
      p.cash += pool - avg * active.length; // 余数归使用者（V0 简化）
      log(state, `${p.name} 使用「均富卡」，所有玩家现金变为 ¥${avg}`);
    },
  },
  'even-target': {
    id: 'even-target',
    name: '均贫卡',
    description: '将指定对手与自己的现金平分（余数归使用者）',
    cost: 200,
    phase: 'any',
    target: 'player',
    available: true,
    apply: ({ state, self: p, targetPlayer, log }) => {
      const t = targetPlayer();
      const pool = p.cash + t.cash;
      const avg = Math.floor(pool / 2);
      p.cash = avg + (pool - avg * 2);
      t.cash = avg;
      log(state, `${p.name} 对 ${t.name} 使用「均贫卡」，双方现金变为 ¥${avg}`);
    },
  },
  'buy-land': {
    id: 'buy-land',
    name: '购地卡',
    description: '以市价强制收购脚下他人的土地（连同房屋一并取得）',
    cost: 35,
    phase: 'post_roll',
    target: 'land',
    available: true,
    apply: ({ state, self: p, cellOwner, log }) => {
      // CARD-03 使用时机「走到别人的地时」：只能强制收购**脚下**的他人土地
      const id = p.position;
      const c = state.board[id]!;
      if (c.type !== 'property' && c.type !== 'commercial') throw new Error('目标不是土地');
      if (c.price === undefined) throw new Error('目标不是土地');
      const owned = cellOwner(state, id);
      if (!owned) throw new Error('该土地无主，无需收购');
      if (owned.player.id === p.id) throw new Error('这里已经是你的土地');
      let base = c.price;
      for (let g = 1; g < owned.property.grade; g++) base += upgradeCost(c.price, g);
      const value = scaled(state, base);
      if (p.cash < value) throw new Error(`现金不足（需 ¥${value}），购地失败`);
      p.cash -= value;
      owned.player.properties = owned.player.properties.filter((q) => q.cellId !== id);
      // 连房屋（等级/设施/连锁店状态）一并取得
      p.properties.push({ ...owned.property });
      log(state, `${p.name} 使用「购地卡」，以 ¥${value} 强制收购 ${owned.player.name} 的「${c.name}」（含 ${gradeName(owned.property.grade)}）`);
    },
  },
  'swap-land': {
    id: 'swap-land',
    name: '换地卡',
    description: '以脚下土地换取同类型（住宅换住宅 / 商业换商业）的其他土地',
    cost: 25,
    phase: 'post_roll',
    target: 'land',
    available: true,
    apply: ({ state, self: p, requireCellId, propOf, cellOwner, log }) => {
      const toId = requireCellId();
      if (toId === p.position) throw new Error('请选择与脚下不同的土地');
      // CARD-04「视窗内其他土地」：在线版以脚下 4×4（16 格）视窗近似
      if (!viewportCells(p.position).includes(toId)) throw new Error('目标土地不在视窗（4×4）范围内');
      const fromCell = state.board[p.position]!;
      const toCell = state.board[toId]!;
      if (fromCell.type !== toCell.type) throw new Error('只能同类互换（住宅换住宅 / 商业换商业）');
      if (fromCell.type !== 'property' && fromCell.type !== 'commercial') throw new Error('换地双方都必须是土地');
      const mine = propOf(p, p.position);
      if (!mine) throw new Error('脚下的土地不属于你');
      const owned = cellOwner(state, toId);
      if (!owned) throw new Error('目标土地无主');
      if (owned.player.id === p.id) throw new Error('目标土地已属于你');
      owned.player.properties = owned.player.properties.filter((q) => q.cellId !== toId);
      p.properties = p.properties.filter((q) => q.cellId !== p.position);
      p.properties.push(owned.property);
      owned.player.properties.push(mine);
      log(state, `${p.name} 使用「换地卡」，以「${fromCell.name}」换取 ${owned.player.name} 的「${toCell.name}」`);
    },
  },
  'swap-house': {
    id: 'swap-house',
    name: '换屋卡',
    description: '以脚下房屋换取同类型的其他房屋（仅房屋等级互换，地权不变）',
    cost: 20,
    phase: 'post_roll',
    target: 'land',
    available: true,
    apply: ({ state, self: p, requireCellId, propOf, cellOwner, log }) => {
      const toId = requireCellId();
      if (toId === p.position) throw new Error('请选择与脚下不同的土地');
      // CARD-05「视窗内其他房屋」：在线版以脚下 4×4（16 格）视窗近似
      if (!viewportCells(p.position).includes(toId)) throw new Error('目标房屋不在视窗（4×4）范围内');
      const fromCell = state.board[p.position]!;
      const toCell = state.board[toId]!;
      if (fromCell.type !== toCell.type) throw new Error('只能同类互换（住宅换住宅 / 商业换商业）');
      if (fromCell.type !== 'property' && fromCell.type !== 'commercial') throw new Error('换屋双方都必须是土地');
      const mine = propOf(p, p.position);
      if (!mine) throw new Error('脚下的土地不属于你');
      const owned = cellOwner(state, toId);
      if (!owned) throw new Error('目标土地无主');
      if (owned.player.id === p.id) throw new Error('目标土地已属于你');
      const grade = mine.grade;
      mine.grade = owned.property.grade;
      owned.property.grade = grade;
      log(state, `${p.name} 使用「换屋卡」，以「${fromCell.name}」的房屋换取 ${owned.player.name}「${toCell.name}」的房屋`);
    },
  },
  // ---- CARD-06..08 移动 / 改建 / 拍卖 ----
  turnaround: {
    id: 'turnaround',
    name: '转向卡',
    description: '所有玩家行进方向 180° 反转',
    cost: 20,
    phase: 'any',
    target: 'none',
    available: true,
    apply: ({ state, self: p, log }) => {
      for (const q of state.players) {
        if (!q.bankrupt) q.direction = q.direction === 1 ? -1 : 1;
      }
      log(state, `${p.name} 使用「转向卡」，所有玩家行进方向 180° 反转`);
    },
  },
  rebuild: {
    id: 'rebuild',
    name: '改建卡',
    description: '住宅：一般建筑 ⇄ 连锁店互转（改建后不能再加盖）；商业用地：变更设施项目',
    cost: 15,
    phase: 'post_roll',
    target: 'land',
    available: true,
    apply: ({ state, self: p, action, cellOwner, log }) => {
      // CARD-07 使用时机「走到任何有建筑的土地上」：只能改建**脚下**的土地（含他人的）
      const id = p.position;
      const c = state.board[id]!;
      const owned = cellOwner(state, id);
      if (!owned) throw new Error('目标土地上没有建筑');
      if (c.type === 'property') {
        // CARD-07：住宅建筑 ⇄ 连锁商店互转（EST-04；改建后不能再加盖）
        owned.property.chain = !owned.property.chain;
        log(state, `${p.name} 使用「改建卡」，将 ${owned.player.name} 的「${c.name}」${owned.property.chain ? '改建为连锁店（不能再加盖）' : '改回一般建筑'}`);
      } else if (c.type === 'commercial') {
        // CARD-07：变更商业用地设施项目（EST-07）
        const current = owned.property.facility;
        if (!current) throw new Error('该商业用地尚未建设，无法变更设施项目');
        const next = action.facility;
        if (!next || !FACILITIES[next]) throw new Error('请选择新的设施项目');
        if (next === current) throw new Error('设施项目没有变化');
        owned.property.facility = next;
        log(state, `${p.name} 使用「改建卡」，将「${c.name}」的${FACILITIES[current].name}变更为${FACILITIES[next].name}`);
      } else {
        throw new Error('改建卡只能用于住宅建筑或商业用地设施');
      }
    },
  },
  auction: {
    id: 'auction',
    name: '拍卖卡',
    description: '拍卖脚下土地，所得归使用者（使用者本人不参与竞价）',
    cost: 20,
    phase: 'post_roll',
    target: 'land',
    available: true,
    apply: ({ state, self: p, anyCellId, cellOwner, beginAuction, log }) => {
      // CARD-08：拍卖脚下土地，所得归使用者，且使用者本人不参与该拍卖会
      const id = anyCellId();
      const c = state.board[id]!;
      if (c.type !== 'property' && c.type !== 'commercial') throw new Error('目标必须是土地');
      const owned = cellOwner(state, id);
      if (!owned) throw new Error('该土地无主，无法拍卖');
      log(state, `${p.name} 使用「拍卖卡」，将 ${owned.player.name} 的「${c.name}」送上拍卖台（所得归 ${p.name}）`);
      beginAuction(state, { cellId: id, sellerId: p.id, trigger: 'card', afterComplete: 'resume' });
    },
  },
  // ---- CARD-09..13 路段 / 建筑 / 抢夺 ----
  'angel-road': {
    id: 'angel-road',
    name: '天使卡',
    description: '指定路段的所有房屋各加盖一层',
    cost: 160,
    phase: 'any',
    target: 'land',
    available: true,
    apply: ({ state, self: p, anyCellId, cellOwner, routeSegment, log }) => {
      const id = anyCellId();
      const c = state.board[id]!;
      if (c.type !== 'property' && c.type !== 'commercial') throw new Error('目标必须是土地');
      const cells = routeSegment(state, id);
      let count = 0;
      for (const cellId of cells) {
        const owned = cellOwner(state, cellId);
        if (!owned) continue;
        const cc = state.board[cellId]!;
        if (cc.type === 'commercial') {
          // 商业用地：只有可升级的已建设施能加盖（EST-07/08/11）
          if (!facilityUpgradeable(owned.property) || owned.property.grade >= MAX_GRADE) continue;
        } else if (owned.property.chain || owned.property.grade >= MAX_GRADE) {
          continue; // 连锁店不能再加盖（EST-04）
        }
        owned.property.grade = (owned.property.grade + 1) as 1 | 2 | 3 | 4 | 5;
        count += 1;
      }
      if (count === 0) throw new Error('该路段没有可加盖的房屋');
      log(state, `${p.name} 使用「天使卡」，路段「${c.name}」共 ${count} 处房屋加盖一层`);
    },
  },
  'devil-road': {
    id: 'devil-road',
    name: '恶魔卡',
    description: '指定路段夷为平地',
    cost: 180,
    phase: 'any',
    target: 'land',
    available: true,
    apply: ({ state, self: p, anyCellId, routeSegment, log }) => {
      const id = anyCellId();
      const c = state.board[id]!;
      if (c.type !== 'property' && c.type !== 'commercial') throw new Error('目标必须是土地');
      const cells = routeSegment(state, id);
      let count = 0;
      for (const q of state.players) {
        const before = q.properties.length;
        q.properties = q.properties.filter((prop) => !cells.includes(prop.cellId));
        count += before - q.properties.length;
      }
      if (count === 0) throw new Error('该路段没有可拆除的建筑');
      log(state, `${p.name} 使用「恶魔卡」，路段「${c.name}」共 ${count} 处地产被夷为平地`);
    },
  },
  monster: {
    id: 'monster',
    name: '怪兽卡',
    description: '彻底摧毁一栋建筑，还原为平地',
    cost: 60,
    phase: 'any',
    target: 'building',
    available: true,
    apply: ({ state, self: p, anyCellId, cellOwner, log }) => {
      const id = anyCellId();
      const owned = cellOwner(state, id);
      if (!owned || owned.property.grade < 2) throw new Error('目标没有可摧毁的建筑');
      owned.property.grade = 1;
      log(state, `${p.name} 使用「怪兽卡」，${owned.player.name} 的「${state.board[id]!.name}」建筑被彻底摧毁`);
    },
  },
  demolish: {
    id: 'demolish',
    name: '拆除卡',
    description: '建筑拆除一个等级；也可拆除路面道具（地雷 / 路障）',
    cost: 15,
    phase: 'any',
    target: 'building',
    available: true,
    apply: ({ state, self: p, anyCellId, cellOwner, log }) => {
      const id = anyCellId();
      const owned = cellOwner(state, id);
      if (owned && owned.property.grade > 1) {
        owned.property.grade = (owned.property.grade - 1) as 1 | 2 | 3 | 4 | 5;
        log(state, `${p.name} 使用「拆除卡」，${owned.player.name} 的「${state.board[id]!.name}」被拆至 ${owned.property.grade} 级`);
      } else if (state.mines.includes(id)) {
        state.mines = state.mines.filter((m) => m !== id);
        log(state, `${p.name} 使用「拆除卡」，清除了「${state.board[id]!.name}」的地雷`);
      } else if (state.roadblocks.includes(id)) {
        state.roadblocks = state.roadblocks.filter((m) => m !== id);
        log(state, `${p.name} 使用「拆除卡」，清除了「${state.board[id]!.name}」的路障`);
      } else {
        throw new Error('目标没有可拆除的建筑或道具');
      }
    },
  },
  snatch: {
    id: 'snatch',
    name: '抢夺卡',
    description: '抢走对手的一张卡片或一个道具',
    cost: 25,
    phase: 'any',
    target: 'player',
    available: true,
    apply: ({ state, self: p, targetPlayer, randomIndex, consumeCard, consumeItem, log }) => {
      const t = targetPlayer();
      const pool: string[] = [];
      for (const cid of t.cards) pool.push(`card:${cid}`);
      for (const [iid, n] of Object.entries(t.items)) for (let k = 0; k < n; k++) pool.push(`item:${iid}`);
      if (pool.length === 0) throw new Error('对方没有可抢夺的卡片或道具');
      const [kind, id] = pool[randomIndex(state, pool.length)]!.split(':') as ['card' | 'item', string];
      if (kind === 'card') {
        if (p.cards.length >= MAX_HAND_CARDS) throw new Error('你的手牌已满，无法接收抢夺物');
        consumeCard(t, id);
        p.cards.push(id);
        log(state, `${p.name} 使用「抢夺卡」，抢走 ${t.name} 的卡片「${CARDS[id]?.name ?? id}」`);
      } else {
        if ((p.items[id] ?? 0) >= MAX_ITEM_COUNT) throw new Error('你的道具已满，无法接收抢夺物');
        consumeItem(t, id);
        p.items[id] = (p.items[id] ?? 0) + 1;
        log(state, `${p.name} 使用「抢夺卡」，抢走 ${t.name} 的「${ITEMS[id]?.name ?? id}」`);
      }
    },
  },
  // ---- CARD-14..21 停留 / 睡眠 / 陷害 / 反制 ----
  hold: {
    id: 'hold',
    name: '停留卡',
    description: '使对手下一次前进时停留在原地',
    cost: 20,
    phase: 'any',
    target: 'player',
    available: true,
    apply: ({ state, self: p, action, log }) => {
      // CARD-14 停留卡：可对对手使用（阻断其前进）；也可对自己使用——
      // 原地再停留一回合，用于再次停留自有商业用地继续加盖升级（用户规则）
      const t = action.targetPlayerId
        ? state.players.find((q) => q.id === action.targetPlayerId && !q.bankrupt)
        : p;
      if (!t) throw new Error('请选择有效的目标玩家');
      t.holdTurns += 1;
      if (t.id === p.id) {
        log(state, `${p.name} 对自己使用「停留卡」，下一次掷骰将原地停留（可继续加盖/经营当格）`);
      } else {
        log(state, `${p.name} 对 ${t.name} 使用「停留卡」，其下一次前进将原地不动`);
      }
    },
  },
  hibernate: {
    id: 'hibernate',
    name: '冬眠卡',
    description: '所有对手睡眠 5 天，丧失收租权利',
    cost: 100,
    phase: 'any',
    target: 'none',
    available: true,
    apply: ({ state, self: p, blockRent, log }) => {
      const others = state.players.filter((q) => !q.bankrupt && q.id !== p.id);
      if (!others.length) throw new Error('没有其他对手');
      for (const q of others) {
        q.skipTurns = Math.max(q.skipTurns, 5);
        blockRent(q, 5);
      }
      log(state, `${p.name} 使用「冬眠卡」，所有对手睡眠 5 天并丧失收租权利`);
    },
  },
  sleepwalk: {
    id: 'sleepwalk',
    name: '梦游卡',
    description: '指定对手梦游 5 天：丧失收租与买地权利',
    cost: 25,
    phase: 'any',
    target: 'player',
    counteredBy: ['absolve', 'shift-blame', 'revenge'],
    available: true,
    apply: ({ state, self: p, targetPlayer, applyDisaster, blockRent, log }) => {
      const t = targetPlayer();
      applyDisaster(state, t, 'sleepwalk', p, (v) => {
        v.sleepwalkTurns = Math.max(v.sleepwalkTurns, 5);
        blockRent(v, 5);
        log(state, `${v.name} 陷入梦游 5 天，丧失收租与买地权利`);
      });
    },
  },
  frame: {
    id: 'frame',
    name: '陷害卡',
    description: '使指定对手坐牢 5 天，丧失收租权利',
    cost: 20,
    phase: 'any',
    target: 'player',
    counteredBy: ['absolve', 'shift-blame', 'revenge'],
    available: true,
    apply: ({ state, self: p, targetPlayer, applyDisaster, blockRent, log }) => {
      const t = targetPlayer();
      applyDisaster(state, t, 'frame', p, (v) => {
        v.skipTurns = Math.max(v.skipTurns, 5);
        blockRent(v, 5);
        log(state, `${v.name} 被陷害入狱 5 天，丧失收租权利`);
      });
    },
  },
  revenge: {
    id: 'revenge',
    name: '复仇卡',
    description: '被害入狱、被陷害、被催眠时自动拖害你的人一起下水',
    cost: 20,
    phase: 'any',
    target: 'none',
    auto: true,
    available: true,
  },
  'shift-blame': {
    id: 'shift-blame',
    name: '嫁祸卡',
    description: '遭遇灾难时自动转嫁给他人，让其代为受过',
    cost: 40,
    phase: 'any',
    target: 'none',
    auto: true,
    available: true,
  },
  'free-pass': {
    id: 'free-pass',
    name: '免费卡',
    description: '租金 / 罚金 / 税金超过 2000 × 物价指数（或超过剩余资金）时自动抵用一次',
    cost: 25,
    phase: 'any',
    target: 'none',
    auto: true,
    available: true,
  },
  absolve: {
    id: 'absolve',
    name: '免罪卡',
    description: '自动抵消一次牢狱之灾（含陷害 / 梦游 / 乌龟卡）',
    cost: 25,
    phase: 'any',
    target: 'none',
    auto: true,
    available: true,
  },
  // ---- CARD-22..25 神明 / 股价 ----
  'send-god': {
    id: 'send-god',
    name: '送神卡',
    description: '送走附身的神明；也可拆走身上的定时炸弹',
    cost: 10,
    phase: 'any',
    target: 'none',
    available: true,
    apply: ({ state, self: p, log, cellsAhead, clearBoardGods }) => {
      let done = false;
      const bomb = state.bombs.find((b) => b.playerId === p.id);
      if (bomb) {
        state.bombs = state.bombs.filter((b) => b !== bomb);
        log(state, `${p.name} 使用「送神卡」，拆走了身上的定时炸弹`);
        done = true;
      }
      if (p.god) {
        const godName = godDef(p.god.godId)?.name ?? '神明';
        p.god = null;
        log(state, `${p.name} 使用「送神卡」，送走了 ${godName}`);
        done = true;
      }
      // 既未被附身也没带炸弹时，退而请走前方 9 步内**驻留在棋盘上**的神明（W2）：
      // 神明会挡在必经之路上，经过就被动附身，提前送走等于给自己让路。
      if (!done && clearBoardGods(state, cellsAhead(state, p.position, p.direction, 9), '被送神卡请回') > 0) {
        log(state, `${p.name} 使用「送神卡」，请走了前方 9 步内的驻留神明`);
        return;
      }
      if (!done) throw new Error('身上没有神明或定时炸弹，前方也没有驻留的神明');
    },
  },
  'invite-god': {
    id: 'invite-god',
    name: '请神卡',
    description: '请来最靠近自己的神明附身',
    cost: 20,
    phase: 'any',
    target: 'none',
    available: true,
    guard: (state) => godSummonRefusal(state),
    apply: ({ state, self: p, nearestGodFor, attachGod, claimBoardGod, log }) => {
      // CARD-23 请神：召唤此刻在场、且离自己最近的一位神明（纯计算，零抽数）
      const def = nearestGodFor(state, p);
      if (!def) throw new Error('棋盘上此刻没有可请的神明');
      // 请到身上就等于离开棋盘（不算清退，所以不写对偶冷却）
      claimBoardGod(state, def.id);
      log(state, `${p.name} 请神，召唤了最靠近自己的 ${def.name}`);
      attachGod(state, p, def);
    },
  },
  'red-card': {
    id: 'red-card',
    name: '红卡',
    description: '炒作指定公司股价，其股票涨停板 3 天',
    cost: 60,
    phase: 'any',
    target: 'stock',
    needsStock: true,
    counteredBy: ['black-card'],
    available: true,
    apply: applyStockHalt,
  },
  'black-card': {
    id: 'black-card',
    name: '黑卡',
    description: '打压指定公司股价，其股票跌停板 3 天',
    cost: 30,
    phase: 'any',
    target: 'stock',
    needsStock: true,
    counteredBy: ['red-card'],
    available: true,
    apply: applyStockHalt,
  },
  // ---- CARD-26..30 税务 / 路租 / 同盟 / 乌龟 ----
  'tax-audit': {
    id: 'tax-audit',
    name: '查税卡',
    description: '强制收取指定者 20% 的现金税',
    cost: 35,
    phase: 'any',
    target: 'player',
    counteredBy: ['free-pass', 'shift-blame'],
    available: true,
    apply: ({ state, self: p, targetPlayer, consumeCard, randomIndex, pay, log }) => {
      const t = targetPlayer();
      if (consumeCard(t, 'free-pass')) {
        log(state, `${t.name} 使用「免费卡」，抵免了查税`);
        return;
      }
      if (t.cards.includes('shift-blame')) {
        const others = state.players.filter((q) => !q.bankrupt && q.id !== t.id && q.id !== p.id);
        const victim = others.length > 0 ? others[randomIndex(state, others.length)]! : p;
        consumeCard(t, 'shift-blame');
        log(state, `${t.name} 使用「嫁祸卡」，把查税转嫁给 ${victim.name}`);
        pay(state, victim, Math.floor(victim.cash * 0.2), p, { reason: 'card' });
        return;
      }
      const tax = Math.floor(t.cash * 0.2);
      log(state, `${p.name} 使用「查税卡」，强制收取 ${t.name} 20% 现金税 ¥${tax}`);
      pay(state, t, tax, p, { reason: 'card' });
    },
  },
  'raise-rent': {
    id: 'raise-rent',
    name: '涨价卡',
    description: '5 天内整条街加倍收取过路费',
    cost: 35,
    phase: 'any',
    target: 'land',
    counteredBy: ['seal-rent'],
    available: true,
    apply: applyRentEffect,
  },
  'seal-rent': {
    id: 'seal-rent',
    name: '查封卡',
    description: '5 天内整条街免收过路费',
    cost: 35,
    phase: 'any',
    target: 'land',
    counteredBy: ['raise-rent'],
    available: true,
    apply: applyRentEffect,
  },
  alliance: {
    id: 'alliance',
    name: '同盟卡',
    description: '与指定对手同盟 7 天：互相不收过路费',
    cost: 40,
    phase: 'any',
    target: 'player',
    available: true,
    apply: ({ state, self: p, targetPlayer, log }) => {
      const t = targetPlayer();
      p.alliance = { with: t.id, daysLeft: 7 };
      t.alliance = { with: p.id, daysLeft: 7 };
      log(state, `${p.name} 与 ${t.name} 结盟 7 天：互不收过路费，在对方地产上联合收费各得一半`);
    },
  },
  turtle: {
    id: 'turtle',
    name: '乌龟卡',
    description: '所有人 3 天内一次只走一步',
    cost: 70,
    phase: 'any',
    target: 'none',
    counteredBy: ['absolve'],
    available: true,
    apply: ({ state, self: p, applyDisaster, log }) => {
      for (const q of state.players) {
        if (q.bankrupt) continue;
        if (q.id === p.id) {
          q.turtleTurns = Math.max(q.turtleTurns, 3);
          log(state, `${q.name} 受乌龟卡影响，3 天内一次只走一步`);
          continue;
        }
        applyDisaster(state, q, 'turtle', p, (v) => {
          v.turtleTurns = Math.max(v.turtleTurns, 3);
          log(state, `${v.name} 受乌龟卡影响，3 天内一次只走一步`);
        });
      }
    },
  },
};

/** 全部卡片 id（含未开放） */
export const ALL_CARD_IDS = Object.keys(CARDS);

/** 商店在售卡片（已开放的全部卡片，含自动触发类） */
export const SHOP_CARD_IDS = ALL_CARD_IDS.filter((id) => CARDS[id]!.available);

/**
 * 机会格抽卡池：排除重型的路段卡（天使/恶魔）与纯自动反制卡（复仇/嫁祸），
 * 以及需要选目标土地的拍卖卡，保证机会格产出均衡。
 */
export const CHANCE_CARD_POOL = [
  'even-all',
  'even-target',
  'buy-land',
  'swap-land',
  'swap-house',
  'turnaround',
  'rebuild',
  'monster',
  'demolish',
  'snatch',
  'hold',
  'hibernate',
  'sleepwalk',
  'frame',
  'absolve',
  'free-pass',
  'send-god',
  'invite-god',
  'red-card',
  'black-card',
  'tax-audit',
  'raise-rent',
  'seal-rent',
  'alliance',
  'turtle',
];
