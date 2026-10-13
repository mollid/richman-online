import { MAX_ITEM_COUNT, pathAhead } from './board.js';
import type { ItemEffectCtx } from './effect_ctx.js';
import { MAX_GRADE, facilityUpgradeable } from './tiles.js';
import { needCell, needPlayer, ownerOfCell, type TargetCheck, type TargetSpec } from './targets.js';

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

export interface ItemDef {
  id: string;
  name: string;
  description: string;
  /** 商店售价（点券）；非卖品为 null */
  cost: number | null;
  /**
   * 变卖回收价（点券）。研究所非卖品没有 `cost`，但仍然可以在商店变卖（D-45：工程车 135）；
   * 省略时按售价半价回收。
   */
  sellValue?: number;
  /**
   * 目标声明：候选从哪儿来 + **唯一那份**合法性谓词（见 `targets.ts`）。
   * 必填，理由同 `CardDef.targetSpec` —— 道具原本连 `guard` 都没有，
   * 「此处有玩家停留，不能埋雷」这类前提只能在 `apply` 里抛异常，门控完全看不见。
   */
  targetSpec: TargetSpec;
  /** 研究所研发等级；null 表示商店可售 */
  researchLevel: number | null;
  /**
   * 道具效果。校验不通过时抛错，副作用直接写 `ctx.state`。
   * 函数内 `return` 等价于原先 switch 里的 `break`。
   */
  apply?: (ctx: ItemEffectCtx) => void;
}

// ---------------------------------------------------------------------------
// 目标谓词（W1）：与卡片同一套积木。「能不能选这个目标」只写在这里一遍，
// 门控（`checkUseItem`）、候选枚举（`actionTargets`）与效果体都读它。
// ---------------------------------------------------------------------------

/** 路障 / 地雷：只能在**视野内**布设（决策人定案，与 help [88][95]「視窗範圍內的……道路」同源），且那一格不能站着别的玩家 */
function obstacleCheck(kind: 'roadblocks' | 'mines'): TargetCheck {
  const what = kind === 'mines' ? '地雷' : '路障';
  return (state, actor, want) => {
    const base = needCell('view')(state, actor, want);
    if (base) return base;
    const id = want.cellId!;
    if (state[kind].some((o) => o.cellId === id)) return `此处已有${what}`;
    if (state.players.some((q) => !q.bankrupt && q.id !== actor.id && q.position === id)) {
      return `此处有玩家停留，不能${kind === 'mines' ? '埋设' : '设置'}${what}`;
    }
    return null;
  };
}

/** 机器娃娃：前方 9 步内得有可清之物（障碍 / 挂身炸弹 / 恶犬 / 驻留神明），否则这张是空转 */
const checkRobotDoll: TargetCheck = (state, actor) => {
  const ahead = pathAhead(state.board, actor.position, actor.heading, 9);
  const hasObstacle =
    state.roadblocks.some((o) => ahead.includes(o.cellId)) || state.mines.some((o) => ahead.includes(o.cellId));
  const hasBomb = state.bombs.some((b) =>
    state.players.some((q) => q.id === b.playerId && !q.bankrupt && ahead.includes(q.position)),
  );
  const hasDog = state.npcs.some((n) => n.kind === 'dog' && !n.jailed && ahead.includes(n.position));
  const hasGod = state.boardGods.some((g) => ahead.includes(g.cellId));
  return hasObstacle || hasBomb || hasDog || hasGod ? null : '前方 9 步内没有障碍物或特殊单位';
};

/** 载具互斥（D-33）：已经在同一种载具上就别再烧一件（A：已是機車→无效） */
function vehicleCheck(level: 2 | 3): TargetCheck {
  return (_state, actor) =>
    actor.diceCount === level ? (level === 2 ? '已经骑在机车上了' : '已经开上汽车了') : null;
}

/** 定时炸弹：不传目标 = 装自己身上；传了就必须是视野内、身上没炸弹的对手 */
const checkTimeBomb: TargetCheck = (state, actor, want) => {
  if (want.targetPlayerId === undefined) {
    return state.bombs.some((b) => b.playerId === actor.id) ? '身上已有定时炸弹' : null;
  }
  const base = needPlayer()(state, actor, want);
  if (base) return base;
  return state.bombs.some((b) => b.playerId === want.targetPlayerId) ? '对方身上已有定时炸弹' : null;
};

/** 传送机：目标格必须空着且不是脚下；带人时那人得在视野内 */
const checkTeleporter: TargetCheck = (state, actor, want) => {
  if (want.cellId !== undefined) {
    const base = needCell('any')(state, actor, want);
    if (base) return base;
    if (want.cellId === actor.position) return '请选择与脚下不同的地点';
    if (state.players.some((q) => !q.bankrupt && q.position === want.cellId)) return '目标道路已有玩家停留';
  }
  if (want.targetPlayerId !== undefined) return needPlayer()(state, actor, want);
  return null;
};

/** 机器工人：自己名下、且那一格确实还能加盖 */
const checkRobotWorker: TargetCheck = (state, actor, want) => {
  const base = needCell('own-land')(state, actor, want);
  if (base) return base;
  const owned = ownerOfCell(state, want.cellId!)!;
  if (state.board[want.cellId!]!.type === 'commercial') {
    if (!owned.property.facility) return '商业用地需先建设施，机器工人无处加盖';
    if (!facilityUpgradeable(owned.property)) return '该设施无法升级（EST-08/EST-11）';
  }
  if (owned.property.chain) return '连锁店不能再加盖（EST-04）';
  if (owned.property.grade >= MAX_GRADE) return '该土地已是最高等级';
  return null;
};

/** 工程车：一次只开一辆（D-45） */
const checkBulldozer: TargetCheck = (_state, actor) => (actor.bulldozerTurns > 0 ? '工程车已经在开' : null);

/** 时光机：得有上一回合可回 */
const checkTimeMachine: TargetCheck = (state) => (state.lastRoundSnapshot ? null : '暂无上一回合记录，无法回到过去');

/** 遥控骰子：点数 1~6 */
const checkRemoteDice: TargetCheck = (_state, _actor, want) =>
  want.diceValue === undefined || (Number.isInteger(want.diceValue) && want.diceValue >= 1 && want.diceValue <= 6)
    ? null
    : '请指定 1-6 的点数';

export const ITEMS: Record<string, ItemDef> = {
  'robot-doll': {
    id: 'robot-doll',
    name: '机器娃娃',
    description: '打扫前方 9 步：路障 / 地雷 / 定时炸弹 / 恶犬 / 驻留神明（四大恶人与附身神明不受影响）',
    // 原价文档标注「待确认」，此处取 INTERIM 估值 60 点
    cost: 60,
    targetSpec: { check: checkRobotDoll },
    researchLevel: null,
    apply: ({ state, self: p, log, clearBoardGods }) => {
      // ITEM-01 / D-32：只清路上障碍与恶犬、驻留神明；四大恶人（小偷/收保护费/行抢/窃取租金）
      // 与**已附身**在人身上的神明不归它管 —— 附身神明走送神符（D-27 同一条口径）。
      // 「前方 9 步内有没有可清之物」由 `checkRobotDoll` 把住，不会空烧一张道具。
      const ahead = pathAhead(state.board, p.position, p.heading, 9);
      const beforeRoad = state.roadblocks.length;
      const beforeMine = state.mines.length;
      state.roadblocks = state.roadblocks.filter((o) => !ahead.includes(o.cellId));
      state.mines = state.mines.filter((o) => !ahead.includes(o.cellId));
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
      const beforeDog = state.npcs.length;
      state.npcs = state.npcs.filter((n) => n.kind !== 'dog' || n.jailed || !ahead.includes(n.position));
      const kickedDogs = beforeDog - state.npcs.length;
      // W2：神明除附身在人身上之外，还会**驻留在棋盘格上**，一并扫走
      const sweptGods = clearBoardGods(state, ahead, '被机器娃娃扫走');
      const detail = [
        cleared > 0 ? `${cleared} 处障碍` : '',
        kickedDogs > 0 ? `${kickedDogs} 只恶犬` : '',
        sweptGods > 0 ? `${sweptGods} 尊驻留神明` : '',
      ].filter(Boolean).join('、');
      log(state, `${p.name} 使用「机器娃娃」，清除前方 9 步内 ${detail}`);
    },
  },
  roadblock: {
    id: 'roadblock',
    name: '路障',
    description: '在视野内的道路放置路障，经过者被截停',
    cost: 30,
    targetSpec: { cells: 'view', check: obstacleCheck('roadblocks') },
    researchLevel: null,
    apply: ({ state, self: p, targetCell, log }) => {
      // ITEM-02：在视野内、没有他人停留的道路上设置路障（可挡自己也可害别人）。
      // 视野 / 已有路障 / 有人站着三条前提都在 `obstacleCheck` 里，所以棋盘能把不可选的格直接灰掉。
      const id = targetCell();
      state.roadblocks = [...state.roadblocks, { cellId: id, ownerId: p.id }];
      log(state, `${p.name} 在「${state.board[id]!.name}」设置路障（经过者被截停）`);
    },
  },
  mine: {
    id: 'mine',
    name: '地雷',
    description: '在视野内的道路埋设地雷，踩中者住院 3 天（也可能害到自己）',
    cost: 25,
    targetSpec: { cells: 'view', check: obstacleCheck('mines') },
    researchLevel: null,
    apply: ({ state, self: p, targetCell, log }) => {
      // ITEM-03：埋设地雷，踩中者住院 3 天（也可能害到自己）
      const id = targetCell();
      state.mines = [...state.mines, { cellId: id, ownerId: p.id }];
      log(state, `${p.name} 在「${state.board[id]!.name}」埋设地雷（踩中住院 3 天）`);
    },
  },
  'time-bomb': {
    id: 'time-bomb',
    name: '定时炸弹',
    description: '附身后走满 38 步自动爆炸，威力范围内人住院 5 天、房屋倒塌；也可直接丢给视野内的对手',
    cost: 25,
    // 不选人 = 装自己身上，所以候选池是「视野内对手」而不是「必须选一个」
    targetSpec: { players: 'visible', check: checkTimeBomb },
    researchLevel: null,
    apply: ({ state, self: p, action, targetPlayer, log }) => {
      // ITEM-04：附身走满 38 步爆炸；若指定 targetPlayerId 则直接转手丢给该玩家
      if (action.targetPlayerId) {
        const victim = targetPlayer();
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
    description: '骰子数增加至 2 个（前进更远）；已开汽车时改用机车，汽车收回道具栏',
    cost: 80,
    targetSpec: { check: vehicleCheck(2) },
    researchLevel: null,
    apply: ({ state, self: p, log }) => {
      // ITEM-05 / D-33：载具互斥由 `vehicleCheck(2)` 把住；换装时**旧载具归还道具槽**
      // （A：原汽車→汽車槽 +1 归还）。
      // ITEM-05 / D-33：载具互斥由 `vehicleCheck(2)` 把住；换装时**旧载具归还道具槽**
      // （A：原汽車→汽車槽 +1 归还）。
      if (p.diceCount >= 3) {
        p.items.car = Math.min(MAX_ITEM_COUNT, (p.items.car ?? 0) + 1);
        log(state, `${p.name} 下车改骑机车，汽车收回道具栏`);
      }
      p.diceCount = 2;
      log(state, `${p.name} 骑上机车，骰子数增至 2 个`);
    },
  },
  car: {
    id: 'car',
    name: '汽车',
    description: '骰子数增加至 3 个（前进更远）；已骑机车时改用汽车，机车收回道具栏',
    cost: 150,
    targetSpec: { check: vehicleCheck(3) },
    researchLevel: null,
    apply: ({ state, self: p, log }) => {
      // ITEM-06 / D-33：同机车，换装时旧载具归还道具槽
      if (p.diceCount === 2) {
        p.items.motorbike = Math.min(MAX_ITEM_COUNT, (p.items.motorbike ?? 0) + 1);
        log(state, `${p.name} 下车改开汽车，机车收回道具栏`);
      }
      p.diceCount = 3;
      log(state, `${p.name} 开上汽车，骰子数增至 3 个`);
    },
  },
  missile: {
    id: 'missile',
    name: '飞弹',
    description: '轰炸目标格 3×3 范围，范围内房屋各拆低一级，被炸者住院 3 天',
    cost: 100,
    // 射程全局：help [91] 明写「使用範圍：地圖上的任何地點」，故不套视野限制
    targetSpec: { cells: 'any', check: needCell('any') },
    researchLevel: null,
    apply: ({ state, targetCell, detonate }) => {
      // ITEM-07 / D-36：原 exe 的「半径 100」在我们的离散格上换算为 3×3（前后各 1 格）；
      // 伤害按决策改为**每处拆低 1 级**（核弹仍为夷为平地）。
      const id = targetCell();
      detonate(state, id, 1, 3, `飞弹轰炸「${state.board[id]!.name}」`, 1);
    },
  },
  'remote-dice-item': {
    id: 'remote-dice-item',
    name: '遥控骰子',
    description: '控制下一次掷骰的点数（1-6）',
    cost: 30,
    targetSpec: { dice: true, check: checkRemoteDice },
    researchLevel: null,
    apply: ({ state, self: p, action, log }) => {
      // ITEM-08：控制下一次掷骰点数（点数范围由 `checkRemoteDice` 把住）
      state.pendingFixedDice = action.diceValue!;
      log(state, `${p.name} 使用遥控骰子，下一次掷骰固定为 ${action.diceValue} 点`);
    },
  },
  'robot-worker': {
    id: 'robot-worker',
    name: '机器工人',
    description: '在自家土地上免费加盖一级房屋',
    cost: null,
    targetSpec: { cells: 'own-land', check: checkRobotWorker },
    researchLevel: 1,
    apply: ({ state, self: p, targetCell, cellOwner, log }) => {
      // ITEM-09（研究所 Lv1）：在自家土地免费加盖一级；
      // 商业用地须与现场加盖同规：先建设施，且公园/加油站不可升级（EST-08/11）——
      // 这些前提全在 `checkRobotWorker` 里，所以棋盘能把「不能加盖的那几格」直接灰掉。
      const id = targetCell();
      const owned = cellOwner(state, id)!;
      owned.property.grade = (owned.property.grade + 1) as 1 | 2 | 3 | 4 | 5;
      log(state, `${p.name} 使用机器工人，「${state.board[id]!.name}」免费加盖至 ${owned.property.grade} 级`);
    },
  },
  'time-machine': {
    id: 'time-machine',
    name: '时光机',
    description: '回到过去：所有人回复为上一回合的状态',
    cost: null,
    targetSpec: { check: checkTimeMachine },
    researchLevel: 2,
    apply: ({ state, self: p, log }) => {
      // ITEM-10（研究所 Lv2）：所有人回复上一回合状态（位置/现金/存款/地产/持股）
      const snap = state.lastRoundSnapshot!;
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
    description: '瞬间移动到地图上的指定空道路；也可把视野内的一名对手一并传送过去',
    cost: null,
    targetSpec: { cells: 'any', players: 'visible', check: checkTeleporter },
    researchLevel: 3,
    apply: ({ state, self: p, action, targetCell, activePlayers, log }) => {
      // ITEM-11（研究所 Lv3）：瞬间移动到指定空道路，本回合不再前进；
      // 指定 targetPlayerId 时可把**他人**连同其附属一起传送到目标格（不结算落点事件）
      const id = targetCell();
      const mover = activePlayers(state).find((q) => q.id === p.id)!;
      const targets = action.targetPlayerId
        ? activePlayers(state).filter((q) => q.id === action.targetPlayerId)
        : [mover];
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
    description: '开动 18 步或 7 天（先到为准）：停在他人建筑上先付拆前的过路费，再把建筑夷为平地；期间机车/汽车暂停使用',
    cost: null,
    // D-45：研究所 Lv4 的非卖品，但占一个道具栏、可在商店变卖回收 135 点券
    sellValue: 135,
    targetSpec: { check: checkBulldozer },
    researchLevel: 4,
    apply: ({ state, self: p, log }) => {
      // ITEM-12（研究所 Lv4）/ D-45：双限 = 18 步与 7 天，先到为准；
      // 开工程车期间**载具暂停**（记下原 `diceCount`，完工后原样交还），不是把它炸毁。
      p.bulldozerSavedDiceCount = p.diceCount;
      p.diceCount = 1;
      p.bulldozerTurns = 7;
      p.bulldozerSteps = 18;
      log(
        state,
        p.bulldozerSavedDiceCount > 1
          ? `${p.name} 启动工程车（18 步 / 7 天），机车/汽车暂时停用`
          : `${p.name} 启动工程车（18 步 / 7 天）`,
      );
    },
  },
  nuke: {
    id: 'nuke',
    name: '核子飞弹',
    description: '全图任选目标，7 格范围内人屋俱毁，被炸者住院 3 天',
    cost: null,
    // 射程全局（D-37），与飞弹同为「地圖上的任何地點」
    targetSpec: { cells: 'any', check: needCell('any') },
    researchLevel: 5,
    apply: ({ state, targetCell, detonate }) => {
      // ITEM-13（研究所 Lv5）：大范围轰炸（7 格），被炸者住院 3 天
      const id = targetCell();
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
