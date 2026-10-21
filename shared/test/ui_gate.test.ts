import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const HUD = read('../../client/src/ui/AcHudLayer.tsx');
const CONTROL = read('../../client/src/ui/ControlPanel.tsx');
const APP = read('../../client/src/App.tsx');

/**
 * FE-25 回归守卫：终局（game_over）必须有出口。
 *
 * 缺陷复盘：`game_over` 走 `forced` 强制弹层，而 forced 弹层的遮罩点击被禁、
 * Esc 被吞、右上角关闭键被条件渲染掉，结算面板里又没有任何按钮 ——
 * 打完一局只能刷新页面。引擎的 725 条测试抓不到它，因为它是「状态可见但出口缺失」，
 * 只存在于 UI 层。client 还没有测试框架，先用源码字符串断言守住这几处。
 *
 * 每条断言都对准一个「回退动作」：如果有人把 closable 改回 `!forced`、
 * 把出口按钮从结算面板里删掉、或把「再来一局」的配置记忆去掉，这里会红。
 */
describe('FE-25 终局出口（组件级回归 · 源码守卫）', () => {
  it('终局弹层必须可关闭：closable 覆盖 forced，且三处关法都认它', () => {
    expect(HUD, 'closable 必须对终局放行').toMatch(/const closable = !forced \|\| gameOver;/);
    expect(HUD, 'gameOver 必须来自 game_over 相位').toMatch(/const gameOver = game\.phase === 'game_over';/);
    // 三种关法：Esc / 遮罩点击 / 右上角关闭键 —— 少一个都算锁死
    expect(HUD, 'Esc 必须认 closable').toMatch(/if \(closable\) setPanel\(null\);/);
    expect(HUD, '遮罩点击必须认 closable').toMatch(/onClick=\{closable \? \(\) => setPanel\(null\) : undefined\}/);
    expect(HUD.match(/closable && \(/g)?.length ?? 0, '两套壳（mp / ac）的关闭键都要认 closable').toBeGreaterThanOrEqual(2);
  });

  it('结算面板必须长出三个出口：看回放 / 再来一局 / 回大厅', () => {
    expect(CONTROL).toContain('settlement-exit');
    expect(CONTROL, '看回放').toContain('看回放');
    expect(CONTROL, '再来一局').toContain('再来一局');
    expect(CONTROL, '回大厅').toContain('回大厅');
    // 出口排在名次表（settlement-final）之后、结算块（settlement）之内
    const finalAt = CONTROL.indexOf('settlement-final');
    const exitAt = CONTROL.indexOf('settlement-exit');
    expect(finalAt, '名次表存在').toBeGreaterThan(-1);
    expect(exitAt, '出口排必须存在').toBeGreaterThan(-1);
    expect(exitAt, '出口排必须长在名次表之后（同一结算块内）').toBeGreaterThan(finalAt);
  });

  it('「再来一局」要能真开起来：App 必须记住上次的开局配置', () => {
    expect(APP, 'startLocal 必须把配置存进 lastLocalOptsRef').toMatch(
      /lastLocalOptsRef\.current = opts;/,
    );
    expect(APP, 'restartLocal 必须从 lastLocalOptsRef 取配置').toMatch(
      /const opts = lastLocalOptsRef\.current;/,
    );
    // 「看回放」取的是本地回放列表的最新一条 —— 那是刚打完的这局
    expect(APP).toMatch(/listLocalReplays\(user\.username\)\[0\]/);
  });

  it('关掉结算后仍有等价的信息出口', () => {
    const MPHUD = read('../../client/src/ui/hud/MpHud.tsx');
    /* 终局弹层可关（上面那条），关掉之后玩家不丢信息：
       资产排名走侧栏「岛民」（MpHud 已有），回大厅走 onExit，回放走大厅「我的回放」。
       不为「再开一次结算面板」单独加 UI —— 更多菜单（moreOpen）本身就没有触发点，是死代码区。 */
    expect(MPHUD, '岛民侧栏存在（资产排名的等价出口）').toContain("'islanders'");
    expect(APP, '回大厅通道存在').toMatch(/onExit=\{exit\}/);
  });

  it('联机对局不得出现「再来一局」（重开要走服务端，不是前端能定的）', () => {
    // GameScreen 按会话类型放行：isRemote 时两个回调置 null，按钮随之隐藏
    expect(APP).toMatch(/onRestart=\{isRemote \? null : onRestart\}/);
    expect(APP).toMatch(/onWatchReplay=\{isRemote \? null : onWatchReplay\}/);
  });
});
