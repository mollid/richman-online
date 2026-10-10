# 大富翁 Online · 相机系统集成实施报告

把 `design/hud-ac` 预览（正交等距近景 + 相机跟随 + 输入锁定 + 小地图）逐步集成进真实业务流程。
日期：2026-10-10。

---

## 0. 总体决策：不引入 three，语义移植到 Pixi

预览是 three.js（透视俯视 + 正交等距双相机）；真实客户端是 **Pixi v8 伪等距 2D**
（`client/src/game/BoardRenderer.ts`，棋盘本身已投影成 2:1 菱形）。
引第二套渲染层意味着双份棋盘数据、双份所有权同步、双倍包体 —— 不符合「与现有流程逻辑和数据结构一致」。

因此**移植的是相机的语义与参数，落点是 Pixi 的 `world.scale/position`**：

| 预览概念（three） | 客户端等价物（Pixi） |
| --- | --- |
| `OrthographicCamera` 竖直覆盖 `view`（世界单位） | 竖直方向覆盖的世界像素 = `renderer.height / world.scale` |
| `aimY` 抬注视点 | 注视点 y 上移 `ISO_AIM_Y=14px` 后居中 |
| 正交「只裁横向」 | 2D 只有均匀缩放 → 横向封顶折算成 effective view（`isoScaleNow` 取两约束中更近者） |
| 透视距离 ↔ 正交视野等效换算 | top 的「覆盖像素」原样作为 iso 起点视野，换相机那一帧不跳 |
| `renderer.info.render.calls` | Pixi v8 无公开 draw-call 计数 → 读数**不给假数**（报 0 并注明） |

---

## 1. 逐环节实现

| # | 预览环节 | 客户端落点 | 说明 |
| --- | --- | --- | --- |
| 1 | 相机状态机 idle/intro/follow | `BoardRenderer` 私有字段 + `stepCamera()` | `introMs=1150`、`followHalfLife=0.16`、`easeInOutCubic` 补间；演出结束（且仅此出口）解锁 |
| 2 | 「轮到谁就聚焦谁」 | `App.tsx` GameScreen 的 `[game]` effect | diff `currentPlayerIndex` 对应的玩家 id，变了就 `focusPlayer(pid)`。**服务端没有独立的「轮到 XX」事件**（Colyseus 整局广播快照），沿用现有「比对快照」模式，没有新增消息协议 |
| 3 | 输入锁定 | `interactive = isMyTurn && phase!=='game_over' && !camLocked`；热键 `armed` 同步加条件 | 纯 UI 门控：不改 `availableActions`、不发新 action、服务端照常推进。锁定期间 Enter 热键也被 `armed` 拦住 |
| 4 | 正交等距近景取景 | `NEAR_VIEW_CELLS=7.2`、`ISO_AIM_Y=14`、`ISO_MAX_ASPECT=1.5`、`applyCamera()` | 预览 `ISO.view=9.6`（4.8 格进深）在客户端稀疏环上实测只露 3 格，**按「人物居中、周围 5~7 格」实测校准为 7.2 → 5 格** |
| 5 | 模式互切（top ↔ iso） | `setCamMode()` + `topMemory` | 等效换算防首帧跳变；`topMemory` 只在不在补间中时记录（预览同款三坑全数规避） |
| 6 | 小地图 | 新文件 `client/src/game/BoardCameraOverlay.ts` | 64 格环 + 所有权描边 + 四玩家圆点 + 橙色取景框；~15fps 自轮询（**不进 React 状态树**）；`pointer-events:none` 不抢交互 |
| 7 | 读数条 | 同上 `board-cam-chip` | `🔍 近景 · 可视 5 格 · 跟随 阿福`，phase 实时反映 idle/intro/follow |
| 8 | 工具条 | `board-cam-strip`（近景/全盘切换 + 巡演） | 位置沿用原「全图」按钮的右下角语义；原 `resetView()` 语义扩展为「退出近景 + 释放跟随 + 恢复手选机位」 |
| 9 | 镜头巡演 | `camTour()` | 按环序聚焦下一位玩家，只动镜头不改回合 |
| 10 | 防指针劫持 | 结构上不存在 | 渲染器的拖拽只挂 Pixi canvas，工具条是 canvas 上方的独立 DOM —— 预览第三轮的 `setPointerCapture` 教训在这里没有土壤（预览是按钮长在 stage 容器里） |

## 2. 数据结构对齐（未改任何 shared 类型）

- **玩家**：`Player.id/name/color`（`color` 是 `0xRRGGBB` 数字）—— 小地图用 `cssColor()` 转 CSS；名牌/跟随目标用 `id`。
- **位置**：`Player.position`（格索引）→ `BoardRenderer.tokens` 的 `targetIndex` → 行走插值 `displayIndex`；跟随注视点认插值位置（关动画时认 `targetIndex`，因为棋子已冻结）。
- **回合**：`GameState.currentPlayerIndex`（索引而非 id）；`phase` 判 `lobby/game_over` 不聚焦。
- **`TurnStage` 没有读** —— shared 注释明确它只作表现用、禁做规则判定；相机门控只依赖 `phase` + `currentPlayerIndex`。
- **所有权**：小地图描边直接读 `player.properties[].cellId`，与 `drawOwnershipOverlay` 同源。

## 3. 验证结果

| 检查 | 结果 |
| --- | --- |
| `tsc --noEmit`（client 全量） | 0 错误 |
| `vite build` | 通过（10.1s，体积警告为既有问题） |
| shared 回归 | **23 文件 / 514 测试全过** |
| 真浏览器冒烟（`client/tools/camera-smoke.mjs`，热座 + 真鼠标） | **13/13，连跑 3 遍全绿** |
| 冒烟覆盖 | 开局锁定→解锁；近景小地图/读数；真鼠标拖拽+滚轮；巡演锁定→解锁；回全盘小地图隐藏；**掷骰 → 结束回合 → 换回合自动聚焦**（业务流接缝）；控制台无 error |
| 近景可视格数（1440×900） | **5 格**（人物居中、跟随中） |

---

## 4. 兼容性与边界问题（集成过程中实际撞上的加预判的）

### 4.1 实测撞上并已修的

1. **`isoView` 被 top 方向补间污染**。`stepCamera` 原本对任何补间都回写 `isoView`，导致「回全盘」的 900ms 补间把近景视野一路推到全盘值 —— 之后每次换回合聚焦都退成假近景（实测可视格数 5 → 27）。修法：只在 `camMode==='iso'` 的补间里回写。**这是本次集成最大的坑：状态量复用（一个 tween 服务两个方向）必须想清楚哪些回写。**
2. **iso 下滚轮方向反了**。UI-07 的 `viewZoom` 是倍率（wheel 下 → 变小 → 拉远），`isoView` 是覆盖像素（变小 = 拉近）。直接套原公式方向相反。已按「wheel 向下 = 拉远」对齐。
3. **预览的 4.8 格进深在客户端只露 3 格**。客户端 64 格摊在 17×17 外圈，格中心距相对格面比预览稀疏。取景参数不能照抄数值，要按目标观感实测校准（4.8 → 7.2）。
4. **挂载时序竞态**：`focusPlayer` 在挂载 effect 里同步调用，但 Pixi `init()` 是异步（预载 22 张贴图）、tokens 更晚才就绪 —— 直接调会静默丢失。加了 `pendingFocus`/`flushFocus` 队列，`setState`（tokens 就绪）后落地。**任何「挂载即调渲染器」的 API 都要考虑这个时序。**
5. **冒烟测试自身的竞态**：读数条 15fps 节流，解锁瞬间还写着上一帧「聚焦中」；贴图加载期锁定起点不固定。测试改成轮询断言，不赌固定延时。

### 4.2 预判并处理的

6. **「关闭动画」设置（UI-10）会让相机永久锁死**。ticker 停转 → `update()` 不跑 → 补间不推进、锁定不解除。处理：`focusPlayer` 在动画关闭时直接落跟随态（不演出不锁定）；`setState` 里手动推一格相机。**预览没有这个开关，这是移植时新发现的边界。**
7. **`animationSpeed()`（UI-09）不能作用到相机演出**。演出时长 = 锁定时长是硬承诺，低速档（0.5x）会把 1.15s 拉成 2.3s。两个 dt 分离：棋子动画吃速度倍率（原语义不变），相机吃墙钟（上限 0.25s/帧防后台跳帧）。
8. **React StrictMode 双挂载**（`main.tsx` 开着）：effect 跑两遍，第二遍拿到新建的 renderer —— 钩子重挂、overlay 重建、聚焦重发。`destroy()` 拆干净全部监听。
9. **自愈出口**：锁定超过 `introMs + 4s` 强制解锁。任何异常（ticker 冻结、补间丢失）都不能「点哪儿都没反应」—— 这是预览第三轮用户报障的直接教训。
10. **ReplayScreen 也实例化 BoardRenderer**（`src/ui/ReplayScreen.tsx:26`）但 不设钩子 → 走默认 top/idle，行为与旧版完全一致。向后兼容靠「钩子全可选」保证。
11. **热座 vs 联机**：`myPlayerId == null`（热座）时 `isMyTurn` 恒真，锁定对全场生效（一台机器轮流操作，正确）；联机下锁定只影响当前行动者的客户端，他人本来就被 `isMyTurn` 挡住。相机断线重连无需特殊处理：快照恢复后跟随目标以 `player.position` 为准。
12. **`player.direction === -1`（转向卡）**：棋子动画走环形最短方向，跟随注视点用指数平滑自然跟住，无需特判。
13. **文字发虚**：近景把 world 放大 ~9 倍，Text 默认 1x 光栅化。已做低成本缓解（格名/地价 Text `resolution: 2`）；彻底方案是进 iso 时按缩放重排文字分辨率，或改 SDF/图集字 —— 见「遗留」。
14. **`/favicon.ico` 404**：`public/` 下没有 favicon，浏览器自动请求导致，**先于本次集成就存在**。冒烟测试对该 URL 豁免（console error 的 text 不带 URL，要用 `location().url` 判断——这个坑也记下了）。

### 4.3 明确不做的（与预览的差异，非遗漏）

15. **视角预设（正俯视/斜 45°/低角度）没有移植**：这些是三维机位，2D 投影没有方位角/俯角可调，硬造只会是「不同缩放倍率」。iso 下置灰的同款逻辑因此也不需要。
16. **小地图取景框不旋转**：预览按方位角转框；这里投影固定，框是屏幕对齐矩形，直接按实际缩放反推（`appliedScale`），保证框和画面永远一致。
17. **横向封顶的实现差异**：正交相机「只裁横向」；2D 均匀缩放做不到，等价实现是超宽容器下整体推近（横向恒 ≤ 1.5 倍竖直，竖向看到格数相应变少）。观感目标一致，机制不同。

## 5. 遗留与后续工作

1. **文字清晰度彻底方案**：进 iso 时按当前缩放重排 Text `resolution`（切换瞬间有重排开销），或改位图字集。
2. **格子点击 / hit-test**：预览有「点击格子看明细」，现有 `BoardRenderer` 零事件出口。要加的话在 `world` 上做逆变换 + 菱形命中，注意近景下命中区域放大 9 倍后的 tolerance。
3. **名牌 / 飘字 / toast**：预览有（Pixi overlay 层 + DOM），客户端目前只有 `wait-banner`。建议 DOM 层做（复用小地图的取数路径）。
4. **镜头分级**：`followClamp` 的代价是「注视点 ≠ 棋子位置」（本次验收图里人物偏下正是它），要「贴身跟随」得先做全局/半区/单格三级镜头（与预览相同的结论）。
5. **性能**：近景下 Pixi 裁剪以容器为单位，格Layer 整体仍参与渲染；64 格规模无感，若日后棋盘扩到几百格再考虑按视口剔除。
6. **移动端**：交互走 pointer 事件与 UI-07 同路径，未实测触控；`board-cam-strip`/小地图在窄容器下的布局未专门调。

## 6. 跑法

```bash
# 冒烟（需先起 dev server）
pnpm --filter @richman/client dev &
node client/tools/camera-smoke.mjs        # 13 断言，退出码即结果
```
