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
 * 上一次重录（R3-a）：`GameState` 新增 `turnStage` 字段（回合内子阶段，CORE-02）。
 * 该字段不参与任何规则判定，重录前后 `steps` / `stalls` / `errors` 与每个采样点的
 * `#步数@回合` 序号完全一致，只有散列值变化 —— 即纯形状变化、零行为漂移；
 * 由 `.scratch/diffcheck.sh` 的新旧引擎差分（24 局 12456 个动作，剔除新增键后逐帧全等）佐证。
 *
 * `maxTurns` 取 141 而非更大的值，是因为 turn=142 会触发一个**已记录的拍卖会死锁**
 * （见任务「拍卖会死锁」）：`nextBidAmount` 只加价 1 元，bot 又无条件加价，两个现金充裕
 * 的竞买人会无限循环。那属于规则缺陷，将在「门控与拍卖修正」波处理；在此之前，
 * 基线窗口必须停在它前面，否则 golden 会退化成一个死锁的重复散列而非整局轨迹。
 */

/** 四人局：turn=141 收束，218 个动作 */
const FOUR_PLAYER_HASHES = [
  '#10@8:43d2b336',
  '#20@16:cd1f9d4f',
  '#30@24:fd4a4ba4',
  '#40@32:11852aa1',
  '#50@38:85186486',
  '#60@44:f9560622',
  '#70@52:ce0c5ed0',
  '#80@58:a8cd9eeb',
  '#90@64:5b839527',
  '#100@69:29867fbc',
  '#110@75:7e331fd4',
  '#120@82:ad3697bc',
  '#130@89:775f1e4b',
  '#140@91:63313642',
  '#150@97:ccdbb104',
  '#160@102:4d14f704',
  '#170@106:baf3a200',
  '#180@115:c7e67759',
  '#190@123:bad85ffa',
  '#200@130:ec07a507',
  '#210@138:2f98c6d7',
];

/** 两人局：turn=105 收束，209 个动作（与四人局走完全不同的落格与结算序列） */
const TWO_PLAYER_HASHES = [
  '#10@8:a1838bc7',
  '#20@14:009677e6',
  '#30@20:7a7fd483',
  '#40@26:78ce999f',
  '#50@32:abcc3744',
  '#60@39:7c969cbd',
  '#70@42:55f42b96',
  '#80@49:866a2a86',
  '#90@54:1363f7b8',
  '#100@59:54d17dd8',
  '#110@60:ff9ae3fe',
  '#120@67:ae9649ab',
  '#130@74:d7049be7',
  '#140@80:65e08ba5',
  '#150@84:5de673c6',
  '#160@85:80f95fde',
  '#170@91:4f0a200d',
  '#180@99:56bbcbae',
  '#190@103:2f16500f',
  '#200@108:109e4c55',
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
