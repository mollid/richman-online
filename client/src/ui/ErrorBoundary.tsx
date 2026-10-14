import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * 崩溃兜底：把「整屏黑掉」换成「一张写着原因的错误卡片」。
 *
 * 为什么必须有：HUD 本体 `client/public/ac-hud/hud.js` 是不经打包器、不参与 typecheck 的静态脚本，
 * 它读的是 `availableActions()` / `GameState` 的形状。引擎一改字段，那边只会在运行时拿到 undefined，
 * 而 React 在没有错误边界的情况下会把整棵树卸载 —— 深色底上什么也不留，现场只剩控制台一行红字。
 * 2026-10-14 那次魔法屋黑屏就是这个形状（改完 typecheck 三包全绿，照样崩）。
 *
 * 两条刻意的取舍：
 * - **不静默重载**。重载会连内存里的热座那一局一起丢掉，把"看得见、能截图的问题"换成
 *   "复现不了的事故"。要刷新也得玩家自己按。
 * - **不用主题的 class**。样式全部内联：真崩的时候最不该依赖的，就是同一份可能已经改坏的 CSS。
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 控制台仍要留一份完整栈：卡片上只放栈顶，方便截图；排查要看全。
    console.error('[客户端崩溃]', error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    // 栈顶那一帧通常就是抛错的文件与行号 —— 这正是黑屏时唯一缺的信息
    const topFrame = (error.stack ?? '')
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.startsWith('at ')) ?? '';

    return (
      <div style={{ padding: 24, color: '#f4f1ea', background: '#1c1a17', minHeight: '100vh', boxSizing: 'border-box' }}>
        <div style={{ maxWidth: 720, margin: '0 auto', padding: 20, border: '2px solid #c0492f', borderRadius: 14, background: '#26231f' }}>
          <div style={{ fontSize: 20, fontWeight: 700, color: '#ff8a80' }}>界面渲染崩了，不是规则算错</div>
          <p style={{ fontSize: 14, lineHeight: 1.7, marginTop: 10 }}>
            棋盘状态还在内存里，只是这一帧画不出来。下面这行原因请整条复制给开发者 ——
            没有它，现场就只剩「黑屏」两个字。
          </p>
          <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: 13, lineHeight: 1.6, padding: 12, borderRadius: 8, background: '#141210', color: '#ffd8a8' }}>
            {error.name}: {error.message}
            {topFrame ? `\n${topFrame}` : ''}
          </pre>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 14 }}>
            <button
              type="button"
              onClick={() => this.setState({ error: null })}
              style={{ padding: '8px 14px', fontSize: 14, borderRadius: 10, border: '2px solid #6b6459', background: '#3a352e', color: '#f4f1ea', cursor: 'pointer' }}
            >
              再画一次
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{ padding: '8px 14px', fontSize: 14, borderRadius: 10, border: '2px solid #6b6459', background: '#3a352e', color: '#f4f1ea', cursor: 'pointer' }}
            >
              刷新页面（会丢掉这一局）
            </button>
          </div>
        </div>
      </div>
    );
  }
}
