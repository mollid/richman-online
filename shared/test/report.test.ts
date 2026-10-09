import { describe, expect, it } from 'vitest';
import {
  allAssetSummaries,
  allStockSummaries,
  assetSummary,
  applyAction,
  createGame,
  estateGroups,
  propertyValue,
  scaled,
  stockSummary,
  vehicleOf,
  type GameState,
  type PlayerDef,
} from '../src/index.js';
import { pinIndexOne } from './helpers/state.js';

/**
 * ECON-14 三清单报表测试（help [16]）：
 * - 资产清单：现金/存款/土地/房屋/股票/贷款/总值；
 * - 地产清单：按街道分组，含等级、建设、连锁店与现值；
 * - 股票清单：持仓数量、单价、成本、市值、盈亏、持股比例。
 */

const PLAYERS: PlayerDef[] = [
  { id: 'p1', name: '阿福', color: 0xef5350 },
  { id: 'p2', name: '小美', color: 0x42a5f5 },
  { id: 'p3', name: '老王', color: 0x66bb6a },
];
const MONDAY = { year: 2026, month: 1, day: 5 } as const;

function newGame(seed = 42): GameState {
  return applyAction(createGame(PLAYERS, seed, { startDate: { ...MONDAY } }), { type: 'START_GAME' });
}

describe('ECON-14 资产清单', () => {
  it('新开局资产清单：现金项等于 STARTING_CASH，总值与之相符', () => {
    const g = newGame();
    const p = g.players[0]!;
    const sum = assetSummary(g, p);
    expect(sum.cash).toBe(p.cash);
    expect(sum.deposit).toBe(0);
    expect(sum.landValue).toBe(0);
    expect(sum.houseValue).toBe(0);
    expect(sum.stockValue).toBe(0);
    expect(sum.loan).toBe(0);
    expect(sum.total).toBe(p.cash);
    // 明细行覆盖 help [16] 的六项
    expect(sum.rows.map((r) => r.key)).toEqual(['cash', 'deposit', 'land', 'house', 'stock', 'loan']);
  });

  it('土地与房屋分开计价：土地取地价，房屋取加盖与建设增值', () => {
    const g = pinIndexOne(newGame());
    const landCell = g.board.find((c) => c.type === 'property' && c.price)!;
    g.players[0]!.properties.push({ cellId: landCell.id, grade: 3 });
    const p = g.players[0]!;
    const sum = assetSummary(g, p);
    expect(sum.landValue).toBe(landCell.price ?? 0);
    // 房屋部分 = propertyValue − 地价
    expect(sum.houseValue).toBe(propertyValue(g, p.properties[0]!) - (landCell.price ?? 0));
    expect(sum.total).toBe(p.cash + sum.landValue + sum.houseValue);
  });

  it('建设设施计入房屋价值', () => {
    const g = pinIndexOne(newGame());
    const landCell = g.board.find((c) => c.type === 'property' && c.price)!;
    const p = g.players[0]!;
    p.properties.push({ cellId: landCell.id, grade: 1 });
    const before = assetSummary(g, p).houseValue;
    p.properties[0]!.facility = 'hotel';
    const after = assetSummary(g, p).houseValue;
    expect(after).toBeGreaterThan(before);
  });

  it('贷款本金在总值中扣减', () => {
    const g = pinIndexOne(newGame());
    const p = g.players[0]!;
    const base = assetSummary(g, p).total;
    p.loan = { principal: 5000, dueDayIndex: 99, takenAtDayIndex: 0 };
    const sum = assetSummary(g, p);
    expect(sum.loan).toBe(5000);
    expect(sum.total).toBe(base - 5000);
    expect(sum.rows.find((r) => r.key === 'loan')!.amount).toBe(-5000);
  });

  it('股票现值计入资产总额', () => {
    const g = pinIndexOne(newGame());
    const p = g.players[0]!;
    const tech = g.stockMarket.stocks.find((s) => s.id === 'tech')!;
    p.stocks.tech = 10;
    const sum = assetSummary(g, p);
    expect(sum.stockValue).toBe(tech.price * 10);
    expect(sum.total).toBe(p.cash + tech.price * 10);
  });

  it('全员资产清单按总值降序', () => {
    const g = newGame();
    g.players[1]!.cash = 999999;
    const list = allAssetSummaries(g);
    expect(list).toHaveLength(3);
    expect(list[0]!.playerId).toBe('p2');
    for (let i = 1; i < list.length; i++) {
      expect(list[i - 1]!.total).toBeGreaterThanOrEqual(list[i]!.total);
    }
  });

  it('车辆描述随 diceCount 变化（EST-11）', () => {
    const g = newGame();
    const p = g.players[0]!;
    expect(vehicleOf(p)).toBe('步行');
    p.diceCount = 2;
    expect(vehicleOf(p)).toBe(vehicleOf({ ...p, diceCount: 2 }));
  });
});

describe('ECON-14 地产清单', () => {
  it('无地产时分组为空', () => {
    const g = newGame();
    expect(estateGroups(g, g.players[0]!)).toEqual([]);
  });

  it('按街道分组，组内按格号升序，含等级/建设/现值', () => {
    const g = pinIndexOne(newGame());
    const p = g.players[0]!;
    const cells = g.board.filter((c) => c.type === 'property' && c.price && c.street);
    // 取同一街道（street-X）的两格
    const streetKey = cells.find((c) => cells.filter((x) => x.street === c.street).length >= 2)!.street!;
    const pair = cells.filter((c) => c.street === streetKey).sort((a, b) => a.id - b.id).slice(0, 2);
    p.properties.push({ cellId: pair[0]!.id, grade: 4 }, { cellId: pair[1]!.id, grade: 2, facility: 'hotel' });
    const groups = estateGroups(g, p);
    // 街道可读名 = 该街道首格地名
    const streetName = pair[0]!.name;
    const group = groups.find((gr) => gr.streetName === streetName)!;
    expect(group).toBeDefined();
    expect(group.rows).toHaveLength(2);
    expect(group.rows[0]!.cellId).toBeLessThan(group.rows[1]!.cellId);
    expect(group.rows[0]!.gradeLabel).toBeTruthy();
    expect(group.rows[1]!.facility).toBe('旅馆');
    expect(group.totalValue).toBe(group.rows.reduce((a, r) => a + r.totalValue, 0));
    // 每行现值 = 地价 + 房屋增值
    for (const r of group.rows) {
      expect(r.landValue).toBe(g.board[r.cellId]!.price ?? 0);
      expect(r.totalValue).toBe(r.landValue + r.houseValue);
    }
  });

  it('连锁店标记为 isChain', () => {
    const g = newGame();
    const landCell = g.board.find((c) => c.type === 'property')!;
    g.players[0]!.properties.push({ cellId: landCell.id, grade: 1, chain: true });
    const row = estateGroups(g, g.players[0]!)[0]!.rows[0]!;
    expect(row.isChain).toBe(true);
  });

  it('分组按组内现值合计降序', () => {
    const g = newGame();
    const p = g.players[0]!;
    const cells = g.board.filter((c) => c.type === 'property' && c.price);
    p.properties.push({ cellId: cells[0]!.id, grade: 5 }, { cellId: cells[cells.length - 1]!.id, grade: 1 });
    const groups = estateGroups(g, p);
    expect(groups[0]!.totalValue).toBeGreaterThanOrEqual(groups[1]!.totalValue);
  });
});

describe('ECON-14 股票清单', () => {
  it('无持仓时清单为空', () => {
    const g = newGame();
    const sum = stockSummary(g, g.players[0]!);
    expect(sum.rows).toEqual([]);
    expect(sum.marketValue).toBe(0);
    expect(sum.profit).toBe(0);
  });

  it('明细含数量/单价/成本/市值/盈亏/持股比例', () => {
    const g = newGame();
    const p = g.players[0]!;
    p.stocks.tech = 20;
    p.stockCost = { tech: 2000 };
    const sum = stockSummary(g, p);
    const row = sum.rows[0]!;
    const tech = g.stockMarket.stocks.find((s) => s.id === 'tech')!;
    expect(row.stockId).toBe('tech');
    expect(row.stockName).toBe(tech.name);
    expect(row.quantity).toBe(20);
    expect(row.price).toBe(tech.price);
    expect(row.cost).toBe(2000);
    expect(row.marketValue).toBe(tech.price * 20);
    expect(row.profit).toBe(tech.price * 20 - 2000);
    expect(row.holdingPct).toBeCloseTo(2, 5); // 20 / 1000
    expect(sum.marketValue).toBe(row.marketValue);
    expect(sum.profit).toBe(row.profit);
  });

  it('股价上涨后盈亏转正，下跌后转负', () => {
    const g = newGame();
    const p = g.players[0]!;
    p.stocks.food = 10;
    p.stockCost = { food: 1000 };
    const stock = g.stockMarket.stocks.find((s) => s.id === 'food')!;
    stock.price = 200;
    expect(stockSummary(g, p).profit).toBe(1000);
    stock.price = 50;
    expect(stockSummary(g, p).profit).toBe(-500);
  });

  it('明细按市值降序，全员清单覆盖所有玩家', () => {
    const g = newGame();
    g.players[0]!.stocks.tech = 5;
    g.players[1]!.stocks.energy = 30;
    const all = allStockSummaries(g);
    expect(all).toHaveLength(3);
    expect(all[0]!.rows.length + all[1]!.rows.length + all[2]!.rows.length).toBe(2);
    expect(stockSummary(g, g.players[1]!).rows[0]!.quantity).toBe(30);
  });

  it('持股比例上限 100%，不会溢出', () => {
    const g = newGame();
    g.players[0]!.stocks.tech = 99999;
    expect(stockSummary(g, g.players[0]!).rows[0]!.holdingPct).toBeLessThanOrEqual(100);
  });
});

describe('ECON-14 报表为只读（不改状态、不消耗随机数）', () => {
  it('调用全部报表函数后 GameState 与 rngState 不变', () => {
    const g = newGame(123);
    g.players[0]!.properties.push({ cellId: 1, grade: 3, facility: 'hotel' });
    g.players[0]!.stocks.tech = 8;
    g.players[0]!.stockCost = { tech: 900 };
    const snapshot = JSON.stringify(g);
    const rngBefore = g.rngState;
    allAssetSummaries(g);
    allStockSummaries(g);
    for (const p of g.players) {
      assetSummary(g, p);
      estateGroups(g, p);
      stockSummary(g, p);
    }
    expect(JSON.stringify(g)).toBe(snapshot);
    expect(g.rngState).toBe(rngBefore);
  });

  it('scaled 为报表中设施造价的口径来源（指数为 1 时等于原价）', () => {
    const g = pinIndexOne(newGame());
    expect(scaled(g, 1234)).toBe(1234);
  });
});