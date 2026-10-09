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
 * 重录历史（每次都写明原因，便于把「规则真的变了」和「只是基线过期」区分开）：
 * - R3-a：`GameState` 新增 `turnStage` 字段（回合内子阶段，CORE-02）。该字段不参与任何规则
 *   判定，重录前后 `steps` / `stalls` / `errors` 与每个采样点的 `#步数@回合` 序号完全一致，
 *   只有散列值变化 —— 纯形状变化、零行为漂移；由 `.scratch/diffcheck.sh` 的新旧引擎差分
 *   （24 局 12456 个动作，剔除新增键后逐帧全等）佐证。
 * - R3-d：bot 的炒股决策改用存款并向注册表确认数量（旧实现按现金推测，每回被引擎拒绝后
 *   落到兜底 END_TURN）。这是**决策变化而非规则变化**，因此前 10 个采样点逐字相同、
 *   自第 110 步起分叉；代价是被吞错误 6 → 0，两人局的轨迹也从 20 个采样点延长到 24 个。
 * - W1：取消自定的「商业地购地价 = 标价 ×1.5」，回到 help[22] 的公定地价。这是**规则变化**
 *   （买地金额与随后的资金流都不同），四人局从第 110 步、两人局从第 90 步起分叉；
 *   两人局的动作数由 249 变为 238。基线由 `.scratch/record-golden.sh` 重录。
 *
 * `maxTurns` 取 141：窗口再放大就会撞上两个**已知活锁**，基线将退化成同一散列的重复
 * 而不是真实演化。两个缺陷都还没修，各自记在下：
 * - 拍卖会：`nextBidAmount` 每次只加价 1 元，bot 只要现金够就无条件跟价。实测 seed=77 / 424242
 *   在 200 回合窗口内烧完 2400 步仍停在 `awaiting_auction`（任务「拍卖会死锁」，排 W3）。
 * - 记忆翻牌：bot 一律猜 0-2 号杯，而该小游戏是 8 张牌（下标 0-7），翻过的牌被引擎拒绝，
 *   兜底逻辑在 `awaiting_pick` 下无事可做。实测 seed=1007 一局产生 2216 个被吞错误
 *   （任务「记忆翻牌活锁」，排 W5）。
 */

/** 四人局：turn=141 收束，217 个动作 */
const FOUR_PLAYER_HASHES = [
  '#10@8:43d2b336',
  '#20@16:cd1f9d4f',
  '#30@24:fd4a4ba4',
  '#40@32:11852aa1',
  '#50@38:85186486',
  '#60@44:e4bcb827',
  '#70@52:f195385b',
  '#80@58:587489c5',
  '#90@64:bf988826',
  '#100@69:87450c71',
  '#110@75:6ec48bed',
  '#120@82:e18b2ea4',
  '#130@89:b1262c29',
  '#140@93:337ce32d',
  '#150@100:8e2c758d',
  '#160@102:ca655592',
  '#170@108:0d16852d',
  '#180@115:c9ba2b8f',
  '#190@122:80437b70',
  '#200@128:01314aa2',
  '#210@136:422a1f52',
];

/** 两人局：turn=141 收束，238 个动作（与四人局走完全不同的落格与结算序列） */
const TWO_PLAYER_HASHES = [
  '#10@8:a1838bc7',
  '#20@14:009677e6',
  '#30@20:7a7fd483',
  '#40@26:72bd8e0a',
  '#50@32:8806989b',
  '#60@39:82a21c9b',
  '#70@43:37a0c269',
  '#80@49:7c0c17e5',
  '#90@55:228e23cc',
  '#100@59:7bff8664',
  '#110@61:ca0e2242',
  '#120@68:e41ba0d8',
  '#130@74:df19042b',
  '#140@80:1879a468',
  '#150@88:03887a15',
  '#160@94:78cfd9a5',
  '#170@99:ed4bc36c',
  '#180@106:e403fcd7',
  '#190@112:a9de6ad1',
  '#200@117:b8b2f761',
  '#210@125:5dcd8b33',
  '#220@132:8048eb72',
  '#230@137:3217e050',
];

const MAX_TURNS = 141;
const SAMPLE_EVERY = 10;

/**
 * 「决策被引擎拒绝」的错误数，必须是 0。
 *
 * 这条断言是 R3 那一类 bug 的收敛证明：门控（`availableActions`，决定按钮可否点）与
 * 引擎校验（动作开头的 `if … throw`）此前是两套并行实现，一漂移就出现
 * 「按钮能点、点下去报错」。收敛过程：
 * - 重构前：7（衰神买地流拍 ×N、福神加倍投资现金不足、`BUY_STOCK` 把现金当存款…）
 * - R3-c：门控全部改由注册表的 `check` 派生 ⇒ 7 → 6，整局散列逐位不变；
 * - R3-d：bot 炒股改用存款并向注册表确认数量 ⇒ 6 → 0。
 *
 * 保持为 0 由 `action_registry.test.ts` 的属性测试兜住：门控列出的每一项，引擎都必须放行。
 */
const RECORDED_GATE_ERRORS = 0;

describe('golden 逐帧基线（重构期间行为不变的唯一证明）', () => {
  it('四人局整局状态轨迹与基线逐位一致', () => {
    const run = runGoldenMatch({ maxTurns: MAX_TURNS, sampleEvery: SAMPLE_EVERY });
    expect(run.hashes).toEqual(FOUR_PLAYER_HASHES);
    expect(run.steps).toBe(217);
    expect(run.stalls).toBe(0);
  });

  it('两人局整局状态轨迹与基线逐位一致', () => {
    const run = runGoldenMatch({
      maxTurns: MAX_TURNS,
      sampleEvery: SAMPLE_EVERY,
      players: GOLDEN_PLAYERS.slice(0, 2),
    });
    expect(run.hashes).toEqual(TWO_PLAYER_HASHES);
    expect(run.steps).toBe(238);
    expect(run.stalls).toBe(0);
  });

  it('门控与引擎校验完全同源：整局不再出现「门控放行、引擎报错」', () => {
    const run = runGoldenMatch({ maxTurns: MAX_TURNS, sampleEvery: SAMPLE_EVERY });
    expect(run.errors).toBe(RECORDED_GATE_ERRORS);
  });
});
