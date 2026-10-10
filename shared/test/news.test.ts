import { describe, expect, it } from 'vitest';
import {
  applyAction,
  availableActions,
  BOARD_SIZE,
  createGame,
  landPrice,
  landRent,
  NEWS_CATEGORY_LABEL,
  NEWS_EVENT_COUNT,
  NEWS_EVENTS,
  nextRandom,
  newsEventById,
  renderNewsText,
  supportedNewsEvents,
} from '../src/index.js';
import type { GameState, PlayerDef } from '../src/index.js';
import { pinIndexOne } from './helpers/state.js';

/**
 * 波 7 新闻格 / 违法事件 / 小游戏扩容测试
 * （对标文档 §9 EVT-01/02/05/06、TILE-17/18，数据源 docs/extraction/news_事件池拆解报告.md）：
 * - EVT-01 36 条新闻事件池：游标轮询 + check_news 前提过滤 + 30 种效果；
 * - EVT-02 机会格违法事件：只读派生随机（不额外消耗抽数）判定坐牢；
 * - EVT-05/06 游戏厅四选一：三仙归洞 / 记忆翻牌 / 七彩气球 / 企鹅挖宝。
 */

/** 三人局：单次掷骰不会触发回合回绕（避免日切钩子干扰断言） */
const PLAYERS: PlayerDef[] = [
  { id: 'p1', name: '阿福', color: 0xef5350 },
  { id: 'p2', name: '小美', color: 0x42a5f5 },
  { id: 'p3', name: '老王', color: 0x66bb6a },
];

/** 周一、非 15 号、非月末：隔离日切钩子 */
const MONDAY = { year: 2026, month: 1, day: 5 } as const;

function newGame(seed = 42): GameState {
  const g = applyAction(createGame(PLAYERS, seed, { startDate: { ...MONDAY } }), { type: 'START_GAME' });
  // 机车（diceCount=2）：默认基础上便于「步行 vs 汽车」类事件筛选
  for (const p of g.players) p.diceCount = 2;
  return g;
}

/**
 * 把当前玩家摆到能以 steps 步落到 targetCell 的位置（不经过起点）。
 * 用 `pendingFixedDice` 固定骰子 → 掷骰本身不消耗抽数，落格结算消耗的抽数可精确断言。
 */
function landOn(state: GameState, targetCell: number, steps = 6): GameState {
  const s = structuredClone(state);
  const p = s.players[s.currentPlayerIndex]!;
  p.diceCount = 1; // 单颗骰子，与 pendingFixedDice 一致
  p.position = (targetCell - steps + BOARD_SIZE) % BOARD_SIZE;
  s.pendingFixedDice = steps;
  return s;
}

/** 让 p0 以固定 6 步落到 35 号银行格（不经过起点） */
function landOnBank(state: GameState): GameState {
  const s = structuredClone(state);
  s.currentPlayerIndex = 0;
  const p = s.players[0]!;
  p.diceCount = 1;
  p.position = 29; // 29 + 6 = 35
  s.phase = 'awaiting_roll';
  s.pendingFixedDice = 6;
  return applyAction(s, { type: 'ROLL_DICE' });
}

/** 落到 44 号报社（TILE-18 新闻格），并把游标拨到指定事件 id */
function newsState(cursor: number, mutate?: (s: GameState) => void, lander = 0): GameState {
  const s = newGame(9001 + cursor);
  s.newsCursor = cursor;
  s.currentPlayerIndex = lander;
  mutate?.(s);
  pinIndexOne(s);
  return landOn(s, 44, 6);
}

/** 找一个 `nextRandom(seed).value ∈ [min, max)` 的种子 */
function seedForNextInRange(min: number, max: number): number {
  for (let s = 1; s <= 500000; s++) {
    const v = nextRandom(s).value;
    if (v >= min && v < max) return s;
  }
  throw new Error(`找不到 nextRandom ∈ [${min}, ${max}) 的种子`);
}

/** 游戏厅四选一对应的抽数区间：pick = floor(value × 4) */
const KIND_RANGE: Record<'shells' | 'memory' | 'balloon' | 'penguin', [number, number]> = {
  shells: [0, 0.25],
  memory: [0.25, 0.5],
  balloon: [0.5, 0.75],
  penguin: [0.75, 1],
};

/** 落到 17 号游戏厅并指定抽中的小游戏 */
function landOnGame(kind: 'shells' | 'memory' | 'balloon' | 'penguin'): GameState {
  const [min, max] = KIND_RANGE[kind];
  const s = landOn(newGame(7777), 17, 6);
  s.rngState = seedForNextInRange(min, max);
  return applyAction(s, { type: 'ROLL_DICE' });
}

describe('EVT-01 新闻事件池数据', () => {
  it('池共 36 条，id 连续 0–35，六个标题栏齐全', () => {
    expect(NEWS_EVENT_COUNT).toBe(36);
    expect(NEWS_EVENTS.map((e) => e.id)).toEqual(Array.from({ length: 36 }, (_, i) => i));
    const cats = new Set(NEWS_EVENTS.map((e) => e.category));
    expect(cats).toEqual(new Set(['no-fault', 'government', 'social', 'traffic', 'weather', 'finance']));
    for (const e of NEWS_EVENTS) {
      expect(e.text.length).toBeGreaterThan(0);
      expect(NEWS_CATEGORY_LABEL[e.category]).toBeTruthy();
      expect(['happy', 'sad']).toContain(e.mood);
    }
    expect(supportedNewsEvents()).toHaveLength(36);
  });

  it('占位符渲染：提供则替换，未提供则留空', () => {
    expect(renderNewsText(newsEventById(8)!, { player: '阿福', amount: '10000' })).toBe(
      '公开表扬第一大地主，阿福获得 10000 元奖励',
    );
    expect(renderNewsText(newsEventById(5)!)).toBe('外星怪兽袭击，摧毁建筑一栋');
  });
});

describe('TILE-18 新闻格：游标轮询 + 前提过滤', () => {
  it('新局游标自 0 起跳过不满足前提的 0–6 条，命中公开拍卖（事件 7 / EVT-03）', () => {
    const r = applyAction(newsState(0), { type: 'ROLL_DICE' });
    expect(r.players[0]!.position).toBe(44);
    expect(r.newsCursor).toBe(8);
    expect(r.phase).toBe('awaiting_auction');
    expect(r.auction?.trigger).toBe('event');
    expect(r.log.some((e) => e.text.includes('公开拍卖'))).toBe(true);
  });

  it('新闻格播出后按标题栏分类并推进回合（非拍卖类事件）', () => {
    const r = applyAction(newsState(22), { type: 'ROLL_DICE' });
    expect(r.players[0]!.position).toBe(44);
    expect(r.phase).toBe('awaiting_roll');
    expect(r.dice).not.toBeNull(); // 回合推进不再抹点数：骰子动画与面板要读这一手
    expect(r.log.some((e) => e.text.startsWith('【新闻】财经新闻｜'))).toBe(true);
  });
});

describe('EVT-01 无责任新闻（在押 / 住院）', () => {
  it('事件 0：无罪开释，清空停留与禁租', () => {
    const r = applyAction(
      newsState(
        0,
        (s) => {
          s.players[0]!.custody = { kind: 'jail', daysLeft: 3 };
          s.players[0]!.skipTurns = 3;
          s.players[0]!.rentBlockedTurns = 3;
        },
        1,
      ),
      { type: 'ROLL_DICE' },
    );
    expect(r.players[0]!.custody).toBeNull();
    expect(r.players[0]!.skipTurns).toBe(0);
    expect(r.players[0]!.rentBlockedTurns).toBe(0);
  });

  it('事件 2：住院病患提前出院', () => {
    const r = applyAction(
      newsState(
        2,
        (s) => {
          s.players[0]!.custody = { kind: 'hospital', daysLeft: 2 };
          s.players[0]!.skipTurns = 2;
        },
        1,
      ),
      { type: 'ROLL_DICE' },
    );
    expect(r.players[0]!.custody).toBeNull();
    expect(r.players[0]!.skipTurns).toBe(0);
  });

  it('事件 1：狱中囚犯延长刑期 3 天', () => {
    const r = applyAction(
      newsState(
        1,
        (s) => {
          s.players[0]!.custody = { kind: 'jail', daysLeft: 2 };
          s.players[0]!.skipTurns = 2;
        },
        1,
      ),
      { type: 'ROLL_DICE' },
    );
    expect(r.players[0]!.skipTurns).toBe(5);
    expect(r.players[0]!.custody!.daysLeft).toBe(5);
  });
});

describe('EVT-01 政府公告：税收与奖励', () => {
  it('事件 11：所有人缴交所得税 5%', () => {
    const r = applyAction(newsState(11), { type: 'ROLL_DICE' });
    for (const p of r.players) expect(p.cash).toBe(15000 - 750);
  });

  it('事件 12：所有人缴交地价税 5%（按不动产现值）', () => {
    const r = applyAction(
      newsState(12, (s) => {
        s.players[0]!.properties = [{ cellId: 4, grade: 1 }]; // 成都路 ¥350
      }),
      { type: 'ROLL_DICE' },
    );
    expect(r.players[0]!.cash).toBe(15000 - 17);
    expect(r.players[1]!.cash).toBe(15000);
  });

  it('事件 13：所有人缴交证交税 5%（按持股市值）', () => {
    const r = applyAction(
      newsState(13, (s) => {
        s.players[0]!.stocks['tech'] = 10; // 科技股 ¥120 × 10 = 1200
      }),
      { type: 'ROLL_DICE' },
    );
    expect(r.players[0]!.cash).toBe(15000 - 60);
    expect(r.players[1]!.cash).toBe(15000);
  });

  it('事件 8：表扬第一大地主，奖金入存款', () => {
    const r = applyAction(
      newsState(8, (s) => {
        s.players[0]!.properties = [
          { cellId: 4, grade: 1 },
          { cellId: 6, grade: 1 },
        ];
      }),
      { type: 'ROLL_DICE' },
    );
    expect(r.players[0]!.deposit).toBe(10000);
    expect(r.players[1]!.deposit).toBe(0);
  });
});

describe('EVT-01 地价涨跌（事件 6 / 14）', () => {
  it('事件 6：公告地价调涨 30%，买地价与租金同步上涨', () => {
    const r = applyAction(
      newsState(6, (s) => {
        s.players[0]!.properties = [{ cellId: 4, grade: 1 }];
      }),
      { type: 'ROLL_DICE' },
    );
    expect(r.streetPriceFactors['street-4']).toBeCloseTo(1.3, 6);
    expect(landPrice(r, r.board[4]!)).toBe(455); // 350 × 1.3
    expect(landRent(r, r.board[4]!, 1)).toBe(117); // 90 × 1.3
  });

  it('事件 14：闹鬼地价下跌 30%', () => {
    const r = applyAction(
      newsState(14, (s) => {
        s.players[0]!.properties = [{ cellId: 4, grade: 1 }];
      }),
      { type: 'ROLL_DICE' },
    );
    expect(r.streetPriceFactors['street-4']).toBeCloseTo(0.7, 6);
    expect(landPrice(r, r.board[4]!)).toBe(245); // 350 × 0.7
  });
});

describe('EVT-01 路况报道（事件 16 / 17）', () => {
  it('事件 16：豪雨特报，步行者（1 颗骰子）停留 1 天', () => {
    const r = applyAction(newsState(16), { type: 'ROLL_DICE' });
    expect(r.players[0]!.diceCount).toBe(1);
    expect(r.players[0]!.skipTurns).toBeGreaterThanOrEqual(1);
    expect(r.players[1]!.skipTurns).toBe(0); // 汽车不受影响
  });

  it('事件 17：交通阻塞，汽车（2 颗骰子以上）停留 1 天', () => {
    const r = applyAction(newsState(17), { type: 'ROLL_DICE' });
    expect(r.players[0]!.skipTurns).toBe(0); // 步行者不受影响
    expect(r.players[1]!.skipTurns).toBeGreaterThanOrEqual(1);
  });
});

describe('EVT-01 银行业务（事件 22 / 23）', () => {
  it('事件 22：银行挤兑，15 天内停止放款', () => {
    const r = applyAction(newsState(22), { type: 'ROLL_DICE' });
    expect(r.loanBanDays).toBe(15);
    expect(r.log.some((e) => e.text.includes('停止放款'))).toBe(true);

    // 挤兑期间在银行也不能贷款
    const atBank = landOnBank(r);
    expect(atBank.players[0]!.position).toBe(35);
    expect(availableActions(atBank).canLoan).toBe(false);
    expect(() => applyAction(atBank, { type: 'TAKE_LOAN', amount: 1000 })).toThrow('停止放款');
  });

  it('事件 23：银行加发 10% 储金红利', () => {
    const r = applyAction(
      newsState(23, (s) => {
        s.players[0]!.deposit = 1000;
        s.players[1]!.deposit = 2000;
      }),
      { type: 'ROLL_DICE' },
    );
    expect(r.players[0]!.deposit).toBe(1100);
    expect(r.players[1]!.deposit).toBe(2200);
  });
});

describe('EVT-01 财经新闻：股市（事件 24–28）', () => {
  it('事件 24：股市崩盘，全市场下跌 10%', () => {
    const r = applyAction(newsState(24), { type: 'ROLL_DICE' });
    expect(r.stockMarket.stocks.find((s) => s.id === 'tech')!.price).toBe(108); // 120 → 108
    expect(r.stockMarket.stocks.every((s) => s.lastChangePct === -10)).toBe(true);
  });

  it('事件 25：股市气势如虹，全市场上涨 10%', () => {
    const r = applyAction(newsState(25), { type: 'ROLL_DICE' });
    expect(r.stockMarket.stocks.find((s) => s.id === 'tech')!.price).toBe(132); // 120 → 132
    expect(r.stockMarket.stocks.every((s) => s.lastChangePct === 10)).toBe(true);
  });

  it('事件 26：股市暂停交易 10 天，期间不可买卖股票', () => {
    const r = applyAction(newsState(26), { type: 'ROLL_DICE' });
    expect(r.stockHaltAllDays).toBe(10);

    const atBank = landOnBank(r);
    expect(atBank.players[0]!.position).toBe(35);
    expect(availableActions(atBank).canTradeStock).toBe(false);
    expect(() => applyAction(atBank, { type: 'BUY_STOCK', stockId: 'tech', quantity: 1 })).toThrow('停牌');
  });

  it('事件 27 / 28：单支股票暂停交易 10 天后复牌', () => {
    const halted = applyAction(newsState(27), { type: 'ROLL_DICE' });
    expect(halted.newsCursor).toBe(28);
    expect(halted.stockHalts.filter((h) => h.kind === 'suspend')).toHaveLength(1);

    // 轮到 p1：从 44 落到 50 号电视台，游标 28 → 复牌
    const resumed = applyAction(landOn(halted, 50, 6), { type: 'ROLL_DICE' });
    expect(resumed.players[1]!.position).toBe(50);
    expect(resumed.stockHalts.filter((h) => h.kind === 'suspend')).toHaveLength(0);
  });
});

describe('EVT-01 财经新闻：公司企业（事件 29–35）', () => {
  it('事件 30：公司违规被罚款，累积盈余减少 10000', () => {
    const r = applyAction(
      newsState(30, (s) => {
        s.companies[0]!.chairmanId = 'p1';
      }),
      { type: 'ROLL_DICE' },
    );
    expect(r.companies.reduce((sum, c) => sum + c.surplus, 0)).toBe(-10000);
  });

  it('事件 35：公司获利调高一倍', () => {
    const r = applyAction(
      newsState(35, (s) => {
        s.companies[0]!.chairmanId = 'p1';
        for (const c of s.companies) c.surplus = 1000;
      }),
      { type: 'ROLL_DICE' },
    );
    expect(r.companies.filter((c) => c.surplus === 2000)).toHaveLength(1);
    expect(r.companies.filter((c) => c.surplus === 1000)).toHaveLength(10);
  });

  it('事件 29：公司违法超贷，董事长坐牢 5 天', () => {
    const r = applyAction(
      newsState(29, (s) => {
        s.companies[0]!.chairmanId = 'p2';
      }),
      { type: 'ROLL_DICE' },
    );
    expect(r.players[1]!.custody?.kind).toBe('jail');
    expect(r.players[1]!.skipTurns).toBe(5);
    expect(r.players[1]!.rentBlockedTurns).toBeGreaterThanOrEqual(5);
  });
});

describe('EVT-02 机会格违法事件（TILE-17）', () => {
  it('落格概率判定成立时坐牢 2 天并禁租', () => {
    let found: GameState | null = null;
    for (let seed = 1; seed <= 3000 && !found; seed++) {
      const r = applyAction(landOn(newGame(seed), 3, 3), { type: 'ROLL_DICE' });
      if (r.players[0]!.custody?.kind === 'jail') found = r;
    }
    expect(found).not.toBeNull();
    const r = found!;
    expect(r.players[0]!.position).toBe(3);
    expect(r.players[0]!.skipTurns).toBeGreaterThanOrEqual(2);
    expect(r.players[0]!.custody!.daysLeft).toBeGreaterThanOrEqual(2);
    expect(r.players[0]!.rentBlockedTurns).toBeGreaterThanOrEqual(2);
    expect(r.log.some((e) => e.text.includes('【违法事件】'))).toBe(true);
  });

  it('违法判定为只读派生随机：抽命运卡恰好消耗 1 抽', () => {
    // 波 8 起机会格改为抽命运卡池（公共池 33 张），抽签本身消耗 1 抽；
    // 违法判定用只读派生随机（只读不写回），故不额外消耗抽数。
    // 找一张「无额外随机」的命运卡样本（拆房/征地/绑架等会再抽一次）验证恰好 1 抽。
    let found: GameState | null = null;
    for (let seed = 1; seed <= 3000 && !found; seed++) {
      const s = landOn(newGame(seed), 3, 3);
      const before = s.rngState;
      const landed = applyAction(s, { type: 'ROLL_DICE' });
      expect(landed.players[0]!.position).toBe(3);
      if (landed.rngState === nextRandom(before).nextState) found = landed;
    }
    expect(found).not.toBeNull();
    expect(found!.log.some((e) => e.text.includes('【命运】'))).toBe(true);
  });

  it('判定不成立时不坐牢', () => {
    // 找一个机会格不触发违法事件的种子（命运卡本身也可能致住院/出国，故同时看 skipTurns）
    let quiet: GameState | null = null;
    for (let seed = 1; seed <= 3000 && !quiet; seed++) {
      const r = applyAction(landOn(newGame(seed), 3, 3), { type: 'ROLL_DICE' });
      if (r.players[0]!.custody === null && r.players[0]!.skipTurns === 0) quiet = r;
    }
    expect(quiet).not.toBeNull();
    expect(quiet!.log.some((e) => e.text.includes('【违法事件】'))).toBe(false);
  });
});

describe('EVT-05 / EVT-06 游戏厅四选一（TILE-17）', () => {
  it('四种小游戏均可随机到', () => {
    for (const kind of ['shells', 'memory', 'balloon', 'penguin'] as const) {
      const r = landOnGame(kind);
      expect(r.players[0]!.position).toBe(17);
      expect(r.phase).toBe('awaiting_pick');
      expect(r.minigame?.kind).toBe(kind);
    }
  });

  it('EVT-05 七彩气球：连续 3 轮避开炸弹获奖 ¥1500', () => {
    let g = landOnGame('balloon');
    for (let i = 0; i < 3; i++) {
      g.rngState = seedForNextInRange(0, 1 / 3); // 炸弹固定在 0 号气球
      g = applyAction(g, { type: 'MINIGAME_PICK', hole: 1 });
    }
    expect(g.minigame).toBeNull();
    expect(g.players[0]!.cash).toBe(15000 + 1500);
  });

  it('EVT-05 七彩气球：踩中炸弹提前结束并支付门票 ¥300', () => {
    const g = landOnGame('balloon');
    g.rngState = seedForNextInRange(0, 1 / 3); // 炸弹固定在 0 号气球
    const r = applyAction(g, { type: 'MINIGAME_PICK', hole: 0 });
    expect(r.minigame).toBeNull();
    expect(r.players[0]!.cash).toBe(15000 - 300);
    expect(r.log.some((e) => e.text.includes('踩到炸弹'))).toBe(true);
  });

  it('EVT-06 企鹅挖宝：3 轮全中获奖 ¥2000', () => {
    let g = landOnGame('penguin');
    for (let i = 0; i < 3; i++) {
      g.rngState = seedForNextInRange(0, 1 / 3); // 宝物固定在 0 号冰窟
      g = applyAction(g, { type: 'MINIGAME_PICK', hole: 0 });
    }
    expect(g.minigame).toBeNull();
    expect(g.players[0]!.cash).toBe(15000 + 2000);
  });

  it('EVT-06 企鹅挖宝：一无所获支付门票 ¥200', () => {
    let g = landOnGame('penguin');
    for (let i = 0; i < 3; i++) {
      g.rngState = seedForNextInRange(1 / 3, 1); // 宝物在 1/2 号冰窟，猜 0 号必空
      g = applyAction(g, { type: 'MINIGAME_PICK', hole: 0 });
    }
    expect(g.minigame).toBeNull();
    expect(g.players[0]!.cash).toBe(15000 - 200);
  });
});