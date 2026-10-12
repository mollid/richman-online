import { pathAhead } from './board.js';
import type { CardPhase } from './cards.js';
import { godDef } from './gods.js';
import type { ItemEffectCtx } from './effect_ctx.js';
import { MAX_GRADE, facilityUpgradeable } from './tiles.js';

/**
 * 道具系统（ITEM-01 – ITEM-13，对标 `docs/gameplay/玩法系统_游戏开发文档.md` §7）。
 *
 * 通用规则：
 * - 每一种道具最多拥有 9 个（`MAX_ITEM_COUNT`），额满无法再容纳；
 * - 道具以**点券购买**；
 * - ITEM-09..13 为研究所**非卖品**（`researchLevel` 非空）：波 2 先入库并实现效果，
 *   波 3 开放研究所后才可获得，故不进商店货架。
 *
 * 与卡片同理：每件道具的效果体写在自己的定义里（`apply`），由 `engine.ts` 注入
 * `ItemEffectCtx` 调用，新增一件道具只改本文件一处。
 */

/**
 * 道具目标类型：
 * - none 无目标；
 * - cell 需选地图格；
 * - land 需选己方土地；
 * - player 需选一名对手（可留空表示不指定，用于炸弹留给自己 / 传送机只移自己）。
 */
export type ItemTarget = 'none' | 'cell' | 'land' | 'player';

export interface ItemDef {
  id: string;
  name: string;
  description: string;
  /** 商店售价（点券）；非卖品为 null */
  cost: number | null;
  phase: CardPhase;
  target: ItemTarget;
  /** 需要指定骰子点数（遥控骰子） */
  needsDiceValue?: boolean;
  /** 研究所研发等级；null 表示商店可售 */
  researchLevel: number | null;
  /**
   * 道具效果。校验不通过时抛错，副作用直接写 `ctx.state`。
   * 函数内 `return` 等价于原先 switch 里的 `break`。
   */
  apply?: (ctx: ItemEffectCtx) => void;
}

export const ITEMS: Record<string, ItemDef> = {
  'robot-doll': {
    id: 'robot-doll',
    name: '机器娃娃',
    description: '踢除前方 9 步内的一切障碍物（路障 / 地雷 / 定时炸弹）',
    // 原价文档标注「待确认」，此处取 INTERIM 估值 60 点
    cost: 60,
    phase: 'any',
    target: 'none',
    researchLevel: null,
    apply: ({ state, self: p, log, clearBoardGods }) => {
      // ITEM-01：踢除前方 9 步内的路障 / 地雷 / 定时炸弹
      const ahead = pathAhead(state.board, p.position, p.heading, 9);
      const beforeRoad = state.roadblocks.length;
      const beforeMine = state.mines.length;
      state.roadblocks = state.roadblocks.filter((id) => !ahead.includes(id));
      state.mines = state.mines.filter((id) => !ahead.includes(id));
      let defused = 0;
      for (const q of state.players) {
        if (q.bankrupt || !ahead.includes(q.position)) continue;
        const bomb = state.bombs.find((b) => b.playerId === q.id);
        if (bomb) {
          state.bombs = state.bombs.filter((b) => b !== bomb);
          defused += 1;
        }
      }
      const cleared = beforeRoad - state.roadblocks.length + (beforeMine - state.mines.length) + defused;
      // ITEM-01 补齐：同时踢除前方 9 步内的特殊人物（恶犬 / 在外的四大恶人）与神明
      const beforeNpc = state.npcs.length;
      state.npcs = state.npcs.filter((n) => n.jailed || !ahead.includes(n.position));
      const kickedNpcs = beforeNpc - state.npcs.length;
      let kickedGods = 0;
      for (const q of state.players) {
        if (q.bankrupt || !q.god || !ahead.includes(q.position)) continue;
        log(state, `${p.name} 的机器娃娃赶走了 ${q.name} 身上的${godDef(q.god.godId)?.name ?? q.god.godId}`);
        q.god = null;
        kickedGods += 1;
      }
      // W2：神明除附身在人身上之外，还会**驻留在棋盘格上**，一并扫走
      const sweptGods = clearBoardGods(state, ahead, '被机器娃娃扫走');
      const total = cleared + kickedNpcs + kickedGods + sweptGods;
      if (total === 0) throw new Error('前方 9 步内没有障碍物或特殊单位');
      const detail = [
        cleared > 0 ? `${cleared} 处障碍` : '',
        kickedNpcs > 0 ? `${kickedNpcs} 个特殊人物` : '',
        kickedGods > 0 ? `${kickedGods} 位神明` : '',
        sweptGods > 0 ? `${sweptGods} 尊驻留神明` : '',
      ].filter(Boolean).join('、');
      log(state, `${p.name} 使用「机器娃娃」，清除前方 9 步内 ${detail}`);
    },
  },
  roadblock: {
    id: 'roadblock',
    name: '路障',
    description: '在选定道路放置路障，经过者被截停',
    cost: 30,
    phase: 'any',
    target: 'cell',
    researchLevel: null,
    apply: ({ state, self: p, anyCellId, log }) => {
      // ITEM-02：在没有他人停留的道路上设置路障（可挡自己也可害别人）
      const id = anyCellId();
      if (state.roadblocks.includes(id)) throw new Error('此处已有路障');
      if (state.players.some((q) => !q.bankrupt && q.id !== p.id && q.position === id)) {
        throw new Error('此处有玩家停留，不能放置路障');
      }
      state.roadblocks = [...state.roadblocks, id];
      log(state, `${p.name} 在「${state.board[id]!.name}」设置路障`);
    },
  },
  mine: {
    id: 'mine',
    name: '地雷',
    description: '在选定道路埋设地雷，踩中者住院 3 天（也可能害到自己）',
    cost: 25,
    phase: 'any',
    target: 'cell',
    researchLevel: null,
    apply: ({ state, self: p, anyCellId, log }) => {
      // ITEM-03：埋设地雷，踩中者住院 3 天（也可能害到自己）
      const id = anyCellId();
      if (state.mines.includes(id)) throw new Error('此处已有地雷');
      if (state.players.some((q) => !q.bankrupt && q.id !== p.id && q.position === id)) {
        throw new Error('此处有玩家停留，不能埋设地雷');
      }
      state.mines = [...state.mines, id];
      log(state, `${p.name} 在「${state.board[id]!.name}」埋设地雷`);
    },
  },
  'time-bomb': {
    id: 'time-bomb',
    name: '定时炸弹',
    description: '附身后走满 38 步自动爆炸，威力范围内人住院 5 天、房屋倒塌；也可直接丢给对手',
    cost: 25,
    phase: 'any',
    target: 'player',
    researchLevel: null,
    apply: ({ state, self: p, action, log }) => {
      // ITEM-04：附身走满 38 步爆炸；若指定 targetPlayerId 则直接转手丢给该玩家
      if (state.bombs.some((b) => b.playerId === p.id)) throw new Error('身上已有定时炸弹');
      if (action.targetPlayerId) {
        const victim = state.players.find((q) => q.id === action.targetPlayerId);
        if (!victim) throw new Error('目标玩家不存在');
        if (victim.id === p.id) throw new Error('不能把炸弹丢给自己');
        if (victim.bankrupt) throw new Error('不能把炸弹丢给已倒闭的玩家');
        if (state.bombs.some((b) => b.playerId === victim.id)) throw new Error('对方身上已有定时炸弹');
        state.bombs = [...state.bombs, { playerId: victim.id, stepsLeft: 38 }];
        log(state, `${p.name} 把定时炸弹丢给了 ${victim.name}（38 步后爆炸）`);
        return;
      }
      state.bombs = [...state.bombs, { playerId: p.id, stepsLeft: 38 }];
      log(state, `${p.name} 装上定时炸弹（38 步后爆炸），快蹭给别人！`);
    },
  },
  motorbike: {
    id: 'motorbike',
    name: '机车',
    description: '骰子数增加至 2 个（前进更远）',
    cost: 80,
    phase: 'any',
    target: 'none',
    researchLevel: null,
    apply: ({ state, self: p, log }) => {
      // ITEM-05：骰子数增至 2 个
      p.diceCount = Math.max(p.diceCount, 2);
      log(state, `${p.name} 骑上机车，骰子数增至 2 个`);
    },
  },
  car: {
    id: 'car',
    name: '汽车',
    description: '骰子数增加至 3 个（前进更远）',
    cost: 150,
    phase: 'any',
    target: 'none',
    researchLevel: null,
    apply: ({ state, self: p, log }) => {
      // ITEM-06：骰子数增至 3 个
      p.diceCount = Math.max(p.diceCount, 3);
      log(state, `${p.name} 开上汽车，骰子数增至 3 个`);
    },
  },
  missile: {
    id: 'missile',
    name: '飞弹',
    description: '轰炸目标格范围，人屋俱毁，被炸者住院 3 天',
    cost: 100,
    phase: 'any',
    target: 'cell',
    researchLevel: null,
    apply: ({ state, anyCellId, detonate }) => {
      // ITEM-07：3×3 范围轰炸，人屋俱毁，被炸者住院 3 天
      const id = anyCellId();
      detonate(state, id, 1, 3, `飞弹轰炸「${state.board[id]!.name}」`);
    },
  },
  'remote-dice-item': {
    id: 'remote-dice-item',
    name: '遥控骰子',
    description: '控制下一次掷骰的点数（1-6）',
    cost: 30,
    phase: 'pre_roll',
    target: 'none',
    needsDiceValue: true,
    researchLevel: null,
    apply: ({ state, self: p, action, log }) => {
      // ITEM-08：控制下一次掷骰点数
      const v = action.diceValue;
      if (v === undefined || !Number.isInteger(v) || v < 1 || v > 6) throw new Error('请指定 1-6 的点数');
      state.pendingFixedDice = v;
      log(state, `${p.name} 使用遥控骰子，下一次掷骰固定为 ${v} 点`);
    },
  },
  'robot-worker': {
    id: 'robot-worker',
    name: '机器工人',
    description: '在选定土地上免费加盖一级房屋',
    cost: null,
    phase: 'any',
    target: 'land',
    researchLevel: 1,
    apply: ({ state, self: p, anyCellId, cellOwner, log }) => {
      // ITEM-09（研究所 Lv1）：在自家土地免费加盖一级；
      // 商业用地须与现场加盖同规：先建设施，且公园/加油站不可升级（EST-08/11）
      const id = anyCellId();
      const owned = cellOwner(state, id);
      if (!owned || owned.player.id !== p.id) throw new Error('只能加盖自己的土地');
      const targetCell = state.board[id]!;
      if (targetCell.type === 'commercial') {
        if (!owned.property.facility) throw new Error('商业用地需先建设施，机器工人无处加盖');
        if (!facilityUpgradeable(owned.property)) throw new Error('该设施无法升级（EST-08/EST-11）');
      }
      if (owned.property.chain) throw new Error('连锁店不能再加盖（EST-04）');
      if (owned.property.grade >= MAX_GRADE) throw new Error('该土地已是最高等级');
      owned.property.grade = (owned.property.grade + 1) as 1 | 2 | 3 | 4 | 5;
      log(state, `${p.name} 使用机器工人，「${targetCell.name}」免费加盖至 ${owned.property.grade} 级`);
    },
  },
  'time-machine': {
    id: 'time-machine',
    name: '时光机',
    description: '回到过去：所有人回复为上一回合的状态',
    cost: null,
    phase: 'any',
    target: 'none',
    researchLevel: 2,
    apply: ({ state, self: p, log }) => {
      // ITEM-10（研究所 Lv2）：所有人回复上一回合状态（位置/现金/存款/地产/持股）
      const snap = state.lastRoundSnapshot;
      if (!snap) throw new Error('暂无上一回合记录，无法回到过去');
      for (const q of state.players) {
        const s = snap.players.find((r) => r.id === q.id);
        if (!s) continue;
        q.position = s.position;
        q.cash = s.cash;
        q.deposit = s.deposit;
        q.properties = s.properties.map((prop) => ({ ...prop }));
        q.stocks = { ...s.stocks };
      }
      log(state, `${p.name} 使用时光机，所有人回复到上一回合的状态`);
    },
  },
  teleporter: {
    id: 'teleporter',
    name: '传送机',
    description: '瞬间移动到地图上的指定格；也可把对手一并传送过去',
    cost: null,
    phase: 'any',
    target: 'cell',
    researchLevel: 3,
    apply: ({ state, self: p, action, anyCellId, activePlayers, log }) => {
      // ITEM-11（研究所 Lv3）：瞬间移动到指定空道路，本回合不再前进；
      // 指定 targetPlayerId 时可把**他人**连同其附属一起传送到目标格（不结算落点事件）
      const id = anyCellId();
      const moved = activePlayers(state).filter((q) => !q.bankrupt);
      if (moved.some((q) => q.position === id)) throw new Error('目标道路已有玩家停留');
      const mover = moved.find((q) => q.id === p.id)!;
      if (id === mover.position) throw new Error('请选择与脚下不同的地点');
      const targets = action.targetPlayerId
        ? moved.filter((q) => q.id === action.targetPlayerId)
        : [mover];
      if (targets.length === 0) throw new Error('目标玩家不存在');
      for (const q of targets) {
        q.position = id;
        // 传送不结算落点事件（ITEM-11 语义），但保留在路上的人物/恶人相对关系
      }
      const label = targets.length > 1
        ? `${p.name} 使用传送机，把 ${targets.map((q) => q.name).join('、')} 一起传送到「${state.board[id]!.name}」`
        : `${p.name} 使用传送机，瞬间移动到「${state.board[id]!.name}」`;
      log(state, label);
    },
  },
  bulldozer: {
    id: 'bulldozer',
    name: '工程车',
    description: '开动 7 回合，走到哪拆到哪（拆除他人房屋一个等级）',
    cost: null,
    phase: 'any',
    target: 'none',
    researchLevel: 4,
    apply: ({ state, self: p, log }) => {
      // ITEM-12（研究所 Lv4）：7 回合内走到哪拆到哪
      p.bulldozerTurns = 7;
      log(state, `${p.name} 启动工程车，7 回合内走到哪拆到哪`);
    },
  },
  nuke: {
    id: 'nuke',
    name: '核子飞弹',
    description: '大范围轰炸，人屋俱毁，被炸者住院 3 天',
    cost: null,
    phase: 'any',
    target: 'cell',
    researchLevel: 5,
    apply: ({ state, anyCellId, detonate }) => {
      // ITEM-13（研究所 Lv5）：大范围轰炸（7 格），被炸者住院 3 天
      const id = anyCellId();
      detonate(state, id, 3, 3, `核子飞弹轰炸「${state.board[id]!.name}」`);
    },
  },
};

/** 全部道具 id */
export const ALL_ITEM_IDS = Object.keys(ITEMS);

/** 商店在售道具（研究所非卖品除外） */
export const SHOP_ITEM_IDS = ALL_ITEM_IDS.filter((id) => ITEMS[id]!.researchLevel === null);

/**
 * 开局赠送的道具（用户规则：玩家初始各持 1 件）。
 * 「炸弹」取地雷（ITEM-03，可埋设的爆炸物）；机器工人为研究所非卖品，开局直接持有。
 */
export const STARTING_ITEMS: Readonly<Record<string, number>> = {
  'robot-doll': 1,
  'remote-dice-item': 1,
  roadblock: 1,
  'time-bomb': 1,
  mine: 1,
  'robot-worker': 1,
};
