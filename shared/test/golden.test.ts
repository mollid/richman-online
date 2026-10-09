import { describe, expect, it } from 'vitest';
import { GOLDEN_PLAYERS, runGoldenMatch } from './helpers/golden_run.js';

/**
 * Golden 回归基线：确定性 bot 对跑的逐帧状态散列序列。
 *
 * 这是本轮技术债重构期间**唯一能证明「行为不变」**的手段 —— 420 个单测各自只断言
 * 局部规则，重构时可能全绿却已经改变整局演化；本测试把整局的状态轨迹压成散列序列，
 * 任何一处规则、抽数顺序或金额取整的差异都会在这里暴露。
 *
 * 使用纪律：
 * - 纯重构波（拆 handler、switch 改注册表、效果逻辑搬回各系统模块）⇒ 散列必须逐位不变。
 * - 功能波（神明上棋盘、结束条件、角色特技）会**合法地**改变散列 ⇒ 更新本文件基线，
 *   并在 commit message 里写明改动原因。
 *
 * 基线参数：seed=20260105、startDate=2026-01-05（周一）、`maxTurns=141`。
 *
 * `maxTurns` 取 141 而非更大的值，是因为 turn=142 会触发一个**已记录的拍卖会死锁**
 * （见任务「拍卖会死锁」）：`nextBidAmount` 只加价 1 元，bot 又无条件加价，两个现金充裕
 * 的竞买人会无限循环。那属于规则缺陷，将在「门控与拍卖修正」波处理；在此之前，
 * 基线窗口必须停在它前面，否则 golden 会退化成一个死锁的重复散列而非整局轨迹。
 */

/** 四人局：turn=141 收束，218 个动作 */
const FOUR_PLAYER_HASHES = [
  '#10@8:483fccb7',
  '#20@16:3e87c70a',
  '#30@24:a87432f0',
  '#40@32:e2b5f550',
  '#50@38:0805b447',
  '#60@44:9c70e902',
  '#70@52:b4123b84',
  '#80@58:95bb56de',
  '#90@64:f0ea1492',
  '#100@69:0b490678',
  '#110@75:98ac6c81',
  '#120@82:8569b799',
  '#130@89:fa8a537e',
  '#140@91:af95bf7b',
  '#150@97:9fb077f1',
  '#160@102:2b287c50',
  '#170@106:4898f6b5',
  '#180@115:b5c7b378',
  '#190@123:4bf09bc3',
  '#200@130:9edce132',
  '#210@138:9f60ed42',
];

/** 两人局：turn=105 收束，209 个动作（与四人局走完全不同的落格与结算序列） */
const TWO_PLAYER_HASHES = [
  '#10@8:9c884d9d',
  '#20@14:1c330167',
  '#30@20:4900e121',
  '#40@26:e7749d65',
  '#50@32:2d3e5a31',
  '#60@39:de059814',
  '#70@42:e8b2b557',
  '#80@49:13619a47',
  '#90@54:ffb764bc',
  '#100@59:3222515c',
  '#110@60:bea7abcf',
  '#120@67:fa7ebc9e',
  '#130@74:d65aab52',
  '#140@80:20e6960c',
  '#150@84:5af75e6e',
  '#160@85:b09a1fef',
  '#170@91:7b9327a4',
  '#180@99:2dccbebf',
  '#190@103:395c5395',
  '#200@108:6fa38207',
];

const MAX_TURNS = 141;
const SAMPLE_EVERY = 10;

/**
 * 当前基线记录在案的 7 个「决策被引擎拒绝」错误，全部是门控与引擎校验不同源：
 * - `BUY_LAND → 衰神附身，买地流拍` ×3 与 `UPGRADE_LAND → 衰神附身，投资失败` ×1：
 *   `canBuy` / `canUpgrade` 未反映衰神禁止投资（`engine.ts:3259`、`engine.ts:3292` 会抛错）；
 * - `BUY_STOCK → 存款不足…现金不能用于炒股` ×3：bot 按现金判断买得起
 *   （`bot.ts:107` 的 `me.cash >= 8000`），而引擎要求用存款买入（`engine.ts:4595`）。
 *
 * 这些在「门控与拍卖修正」波被修掉后，本数字应降为 0 —— 所以把它写成断言而不是注释，
 * 让"修好了"变成可验证的事实，而不是口头声明。
 */
const RECORDED_GATE_ERRORS = 7;

describe('golden 逐帧基线（重构期间行为不变的唯一证明）', () => {
  it('四人局整局状态轨迹与基线逐位一致', () => {
    const run = runGoldenMatch({ maxTurns: MAX_TURNS, sampleEvery: SAMPLE_EVERY });
    expect(run.hashes).toEqual(FOUR_PLAYER_HASHES);
    expect(run.steps).toBe(218);
    expect(run.stalls).toBe(0);
  });

  it('两人局整局状态轨迹与基线逐位一致', () => {
    const run = runGoldenMatch({
      maxTurns: MAX_TURNS,
      sampleEvery: SAMPLE_EVERY,
      players: GOLDEN_PLAYERS.slice(0, 2),
    });
    expect(run.hashes).toEqual(TWO_PLAYER_HASHES);
    expect(run.steps).toBe(209);
    expect(run.stalls).toBe(0);
  });

  it('门控与引擎不同源造成的被吞错误数当前为 7（修正波应降为 0）', () => {
    const run = runGoldenMatch({ maxTurns: MAX_TURNS, sampleEvery: SAMPLE_EVERY });
    expect(run.errors).toBe(RECORDED_GATE_ERRORS);
  });
});
