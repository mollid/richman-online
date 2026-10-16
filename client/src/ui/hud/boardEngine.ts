/**
 * 两个 vanilla 引擎脚本（`public/ac-hud/world.js` / `overlay.js`）的类型面。
 *
 * 它们是用 `<script>` 直挂的 IIFE，不参与 typecheck，所以接口只能在这一侧声明。
 * 只声明**本壳真的会调**的那几项，并把可选性照实写出来 —— 旧壳到处 `globalThis.D25World?.foo?.()`
 * 就是因为没有类型，没人知道哪个函数其实可能不存在。指不到实现时是运行期 undefined，
 * 有这一份至少编译期能说清「这个口子是宿主契约的一部分」。
 */

export interface CamStateOut {
  state: 'idle' | 'intro' | 'follow';
  pid: string | null;
  locked: boolean;
  tx: number;
  tz: number;
  mode: 'top' | 'iso';
  az: number;
  el: number;
  /** 当前相机在地面上的可视宽度（世界单位） */
  view: number;
  /** 已夹过近景上限的实际宽高比 */
  aspect: number;
  prog: number | null;
}

export interface WorldApi {
  mount(el: HTMLElement, snap: unknown, hooks: WorldHooks): unknown;
  resize(): void;
  sync(snap: unknown): void;
  paintOwners(): void;
  redrawLabels?(): void;
  playMove(opts: { pid: string; from: number; steps: number; dir: number; cells: number[]; transfer: number | null; dice: number[] | null }): boolean;
  isHopping?(): boolean;
  project(x: number, y: number, z: number): { x: number; y: number; dist: number; vis: boolean };
  tokenAnchors(): Array<{ pid: string; x: number; y: number; z: number }>;
  tileAnchor(cellId: number): { x: number; y: number; z: number };
  lastPointer(): { x: number; y: number };
  setView?(preset: string): void;
  setCamMode(mode: 'top' | 'iso', pid?: string | null): void;
  camMode(): 'top' | 'iso';
  focusPlayer(pid: string, opts?: unknown): void;
  isCameraLocked(): boolean;
  visibleCells(): { count: number };
  cameraState(): CamStateOut;
  renderOnce(dt?: number): void;
  setPaused?(v: boolean): void;
  setPickHighlight?(ids: number[]): void;
  setPickPlayers?(ids: string[]): void;
  dispose(): void;
}

export interface WorldHooks {
  onFrame(): void;
  /** world 会把切换后的模式当参数传进来；本壳不接这个回调（下一次 onFrame 自然重报读数） */
  onCameraMode?(mode: 'top' | 'iso'): void;
  onHover(id: number | null): void;
  onSelect(id: number | null): void;
  onPickPlayer(pid: string): void;
  /** `kind` 只有 'walk'（沿圈走到）与 'transfer'（押送 / 传送落位）两种 */
  onLand(pid: string, cellId: number, kind: 'walk' | 'transfer'): void;
  onMoveSettled?(pid?: string, cellId?: number): void;
  onCameraLock(v: boolean): void;
  onCameraSettled(): void;
}

export interface OverlayApi {
  mount(el: HTMLElement, snap: unknown): void;
  setSnapshot?(snap: unknown): void;
  rebuild(): void;
  tick(): void;
  float(text: string, cellId: number, tone?: 'gold' | 'bad'): void;
  dispose(): void;
}

declare global {
  var D25World: WorldApi | undefined;
  var D25Overlay: OverlayApi | undefined;
}
