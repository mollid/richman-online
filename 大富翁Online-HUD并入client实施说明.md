# 大富翁 Online · ac-HUD 并入 client 实施说明

日期：2026-10-10　范围：`design/hud-ac/`（动物森林 HUD 原型）→ `client/`（真客户端）

---

## 0. 结论

**HUD 已进 client 并能真跑。** 对局界面整壳换成 three.js 2.5D 棋盘 + ac 皮肤 HUD（顶栏 / 状态条 / 侧栏 6 页签 / Dock / 行囊 / 弹层），
数据由真实 `GameState` 实时派生（不再用冻结快照），一键类动作走真实 `session.dispatch()`，
需要选目标 / 填金额的流程用 ac 弹层托管既有 React 面板。

`tsc --noEmit` 0 错误、`vite build` 通过；`docker compose up -d --build` 四服务全 Healthy，
真浏览器真鼠标在**容器里**（`http://localhost:8080`）冒烟全绿（见 §5）。

弹层做了尺寸分级与交互补全，并修掉三个真 bug（休市打不开股市、K 线不随容器变宽、回合数口径不一致），见 §6。

字体从 Google Fonts 改为自托管：中文原本有 1/3 的字在逐字回退到系统字（M PLUS Rounded 1c 是日文字体），
现换用狮尾圆体并实测 100% 覆盖，见 §7。另落地了一套像素中文字库，见 §8。

---

## 1. 改了什么（按文件）

| 文件 | 动作 | 说明 |
| --- | --- | --- |
| `client/public/ac-hud/{ac.css,hud.css,world.js,overlay.js,hud.js}` | 新增 | 原型资产副本。改副本、不动 `design/hud-ac/`，原型仍可独立打开 |
| `client/public/ac-hud/vendor/{three.umd.min.js,pixi.min.js}` | 新增 | 原型的 three / pixi 走 UMD 全局，与 client 的 `pixi.js@8`（ESM）互不干扰 |
| `client/src/game/acSnapshot.ts` | **新增** | 实时 view 适配层：`GameState` → `{state, view}`，口径逐条对齐 `dump-snapshot.mts` |
| `client/src/ui/AcHudLayer.tsx` | **新增** | React 挂载层：装样式、按序载脚本、注入数据与动作、托管弹层 / 大厅 / 横幅 |
| `client/src/ui/acHudClient.css` | **新增** | HUD 不负责的那几块：全屏遮罩、弹层壳、连接横幅 |
| `client/src/App.tsx` | 改动 | `GameScreen` 从「`board-area` + `sidebar`」换成 `<AcHudLayer/>`；摘掉 17 个面板 import 与 `SidebarTab` |
| `docker-compose.yml` | 改动 | 四服务加 `restart: unless-stopped`；`server` 加 `/healthz` healthcheck，`client` 等它 healthy；`db`/`redis` 用 `pg_isready`/`redis-cli ping` 探活 |
| `package.json` | 改动 | 加 `docker:up`（`docker compose up -d --build`）/ `docker:down` / `docker:logs` / `docker:ps`，以及 `fonts` / `fonts:clean` |
| `client/public/fonts/**` | **新增** | 自托管字体产物（狮尾圆体分片 + M+ + Nunito + 像素中文字库 + 授权原文），由脚本生成，**入库** |
| `design/hud-ac/tools/build-fonts.py` | **新增** | 下载 → 子集化 → 按 `unicode-range` 分片 → 生成 `@font-face` → 落地授权原文 |
| `design/hud-ac/tools/check-font-coverage.py` | **新增** | 实测某字体对本项目实际用字的覆盖率（回答「中文到底有没有生效」） |
| `client/nginx.conf` | 改动 | 补 `gzip on`（默认是 off）；新增 `location /fonts/` 给字体 30 天强缓存 |
| `design/w98-pixel/{fonts.css,tokens.css,ui-kit.css,preview.html,specimen.html,ab-qiuye.html,README.md}` | 改动 | 接入两款像素中文字库（`--w98-font-pix` / `--w98-font-qy`），加 `.w98-pix` / `.w98-pix-qiuye` 使用规范、双字体样张与 3 倍放大 A/B |

### `hud.js` 的三处最小手术（其余 1100+ 行原样保留）

1. **冻结快照 → 可变快照**：`const S = GAME_SNAPSHOT` 及 `st/view/A/cur/me/RING` 全改 `let`，加 `bindSnap()` 重绑；
   `RING`（64 格环坐标）从模块常量改为随 `state.board` 重建。
2. **伪动作 → 真 dispatch**：`actionSpec()` 每行加第 5 项「点下去干什么」（`{type:...}` 或 `{__open:...}`），
   新增 `fire()` 走 `hostApi.dispatch / openPanel`；未注入宿主时自动退回旧的 `cosmetic()` 演示行为。
3. **挂载口**：`document.getElementById('app')` → `#ac-hud-root`；导出 `window.AC_HUD = { update, setHost, destroy, toast }`。

另加两个接缝：顶栏 `[data-host-tools]`（宿主工具位：静音 / 帮助 / 设置 / 存档 / 读档 / 退出 + 联机/热座标）、
`hostApi.interactive === false` 时 dock 整体置灰（联机非我方回合）。世界层补了 `disposed` 复位与
`overlay.setSnapshot()`、`buildWorld()` 容器清空 —— 都是「dispose 后再 mount」会踩的坑。

---

## 2. 两个接缝的契约

**数据**（`acSnapshot.ts`，全部来自 `@richman/shared`，零规则改动）

```
gameDate / priceIndex / allAssetSummaries / allStockSummaries
estateGroups(state, player)  → view.estates[playerId]
availableActions(state)      → view.actions（门控位原样透出，HUD 只读）
owners: player.properties → cellId→playerId
gods: boardGods + GODS + godSummary
names: CARDS / ITEMS / FACILITIES / GODS 压成 id→展示字段
myPlayerId = myPlayerId ?? 当前行动者（热座无「我」，就是当前行动者）
```

**动作**（`AcHudLayer` → `AC_HUD.setHost`）

| 动作形态 | 出口 | 覆盖 |
| --- | --- | --- |
| 无参数一键 | `session.dispatch` 真发 | 掷骰 / 买地 / 加盖 / 建商业设施 / 认购原始股 / 保释 / 让人出院 / 结束回合 |
| 需选目标、填金额 | `openPanel(kind)` → ac 弹层托管既有面板 | 银行存取贷还、商店、股市、乐透、公布栏挂出、魔法屋/监狱、公司企业、手牌道具、拍卖、认输 |
| 阶段强制 | 由 `phase` 驱动自动弹 | `awaiting_auction`→拍卖、`awaiting_pick`/`awaiting_discard`/`game_over`→控制面板 |

---

## 3. 刻意做的取舍

- **两套 Pixi 并存**：原型 `overlay.js` 用的是 pixi v7 的 `beginFill/drawRoundedRect` 老 API，client 是 `pixi.js@8`（API 已重构）。
  直接把 overlay 迁到 v8 是重写级改动，本轮用原型自带的 UMD pixi，两套互不污染全局。
- **既有面板保持深色**：银行 / 商店 / 股市等面板是深色主题（自带 `#16211b` 底 + 浅字），
  弹层里**刻意不去改它** —— 保住可读性与全部流程。把它们重做成 ac 皮肤是下一轮的独立工作。
- **样式用 `:has` 提权**：client 的 `styles.css` 对 `html/body/#root` 有全局深色设定且注入顺序会变，
  `body:has(#ac-hud-root)` / `#root:has(#ac-hud-root)` 提权，保证 HUD 挂载期间 ac 皮肤稳定生效；
  卸载时 `destroy()` 并撤掉 `<link>`，开始界面/回放界面不受影响（实测 body 底色回到 `rgb(13,21,18)`）。

---

## 4. 按钮清理：只留玩法真正用得到的入口

原型是「验收用」的，带了一批一次性入口。这些在 `client/public/ac-hud/hud.js` 里已全部摘除：

| 摘掉的 | 原来在哪 | 为什么摘 |
| --- | --- | --- |
| 视角预设（复位 / 正俯视 / 斜 45° / 低角度） | `.d25-bar` 的 `[data-view]` 组 | 相机会自动跟着回合走，玩家不需要手调俯角；四个按钮纯占位 |
| 镜头巡演 | `.d25-bar` 的 `[data-cam-demo]` + `globalThis.__camTour` | 验收四位玩家用的演示装置，产品里没有对应玩法 |
| 「🚫 被挡住 n」弹层 | Dock 的 `blocked` 段 | 「为什么不能点」改挂按钮的悬浮 `title`，不再单开一个弹层 |
| 棋盘形态切换（2.5D ↔ 方环） | `.hud-bswitch` | 方环只是 WebGL 不可用时的兜底，不该做成玩家开关 |
| 相机读数里的 fps / draw call / 距离 / 俯角 | `.d25-cam` chip | 开发指标。现在只报两件事：**全盘还是近景**、**镜头跟着谁** |

相机读数从 `144 fps · 197 draw · 🗺 全盘 · 距离 70 · 俯 46° 🎯 跟随 local-0`
简化成 `🗺 全盘 · 跟随 阿福`（近景时 `🔍 近景等距 · 周围 9 格 · 跟随 小美`）。

配套收敛：`applyCamLockUI` 白名单只放行 `[data-cam-mode]`；`renderCamBar()` 删掉巡演与「切回 2.5D」按钮；
`.d25-bar` 的 `max-width` 从 `calc(100% - 126px)` 收回 `calc(100% - 16px)`（原本要给那排按钮让位）。

**留下的都是真开关**：`🔍 近景等距 ↔ 🗺 回到全盘`（玩法相关，且近景必配小地图找回方位感）、
`拖拽 / 方向键 / 滚轮` 相机操作提示条、Dock 里的主操作与 `⚙️ 更多动作`（次操作收在浮层里，`🚩 认输投降` 就在其中，不做常驻一键）。

顶栏宿主工具位保留 6 个：`🔊 静音 / ❓ 帮助 / ⚙️ 设置 / 💾 存档 / 📂 读档 / 退出`。
存档读档已在 `App.tsx:76-83` 接到 `saveHotseatGame / loadHotseatGame`（热座可用，联机时不出现）。

---

## 5. 实测 · vite dev（1440×900，真鼠标）

| 检查 | 结果 |
| --- | --- |
| HUD 挂载 | `.hud-shell` + 3 块 canvas（three / pixi overlay / 小地图）齐全 |
| 顶栏 / 状态条 | 真实玩家名、三币、例假日、物价 ×1.000、六支股现价、奖池 —— 全来自实时 `GameState` |
| 侧栏 6 页签 | 岛民 / 岛况 / 股市 / 账本 / 播报 / 公布栏；股市页 6 支股 + 6 条日 K 正常 |
| **掷骰（真动作）** | 主按钮点击 → 骰子 4=4、脚下格换到成都路、主按钮变「💰 买下『成都路』」 |
| 更多动作 popup | 打开 1 项；点「认输投降」→ 打开认输弹层（ControlPanel 已渲染） |
| **结束回合（真动作）** | 点击即锁定（`.hud-shell--locked`、`🔒 镜头聚焦中 · 操作已屏蔽`）→ 读数条目标切到小美（`🗺 全盘 · 聚焦中`）→ 3.5s 后解锁（`🗺 全盘 · 跟随 小美`）；热座表现层视角跟随当前行动者 |
| 近景等距切换 | 读数条 `🔍 近景等距 · 周围 9 格 · 跟随 小美`，按钮翻成 `🗺 回到全盘`，小地图出现，`D25World.camMode()==='iso'` |
| 退出对局 | 回开始界面，HUD 与样式全部撤净 |
| 控制台 | 无新增 error（仅既有的 favicon 404 与 three UMD 弃用 warning） |

### 5.1 Docker 环境复验（`http://localhost:8080`，容器内）

| 检查 | 结果 |
| --- | --- |
| 四服务 | `client` Up / `db` healthy / `redis` healthy / `server` healthy，端口 8080 / 5432 / 6379 / 2567 |
| 服务端健康 | `GET /healthz` → `{"ok":true,"service":"richman-online-server"}` |
| HUD 资产 | `ac-hud/{hud.js,world.js,overlay.js,hud.css,ac.css}` 与两个 vendor 全部 HTTP 200，字节数与源文件一致 |
| HUD 挂载 | `.hud-shell` + 3 块 canvas 齐全 |
| **清理项核对** | `d25-bar` 按钮只剩 `["🔍 近景等距"]`；`[data-view]` / `[data-cam-demo]` / `.hud-bswitch` 均为 `false`；正文不含「被挡住」 |
| 相机读数 | `🗺 全盘 · 跟随 阿福` → 掷骰后 `💰 买下「南京路」` → 结束回合 `🗺 全盘 · 聚焦中` → 落定 `🗺 全盘 · 跟随 小美` |
| 宿主工具位 | `["🔊","❓","⚙️","💾","📂","退出"]` |
| 近景等距 | `周围 9 格 · 跟随 小美`，小地图可见，`camMode==='iso'` |
| 退出对局 | `.hud-shell` / `#ac-hud-root` 均消失，`body` 底色回到 `rgb(13, 21, 18)`，回到开始界面 |
| 控制台 | 0 error，1 warning |

截图（Docker）：`design/hud-ac/preview/docker-1-board.png`（开局全盘）、`-2-roll`（掷骰后）、`-3-turn`（换成小美）、
`-4-iso`（近景等距 + 小地图）、`-5-exit`（退出回退）；清理后的 dev 全貌见 `client-ac-hud-6-clean.png`。

---

## 6. 弹层与交互修复（本轮）

起因：股市弹层**模态框太小**——K 线只有拇指大、五列表挤成两行，另有一批交互问题。

### 6.1 根因：类名撞车（不是「宽度没设够」）

宿主层的弹层原本也叫 `.ac-modal`，而原型的设计系统 `ac.css` 里**已经有一个 `.ac-modal`**（`width: min(380px, 92vw)`，给原型自己的小对话框用）。
`ac.css` 是以 `<link>` 后挂的，同权重后加载者胜 —— 于是不管怎么调 `width`，实际宽度都被按死在 380px，看起来像「改了不生效」。

修法不是提权，而是**改名**：宿主层换成 `.ac-sheet / __hd / __bd / --wide`。
两边本来就是完全不同的组件，共用一个类名是隐患（以后再改还会踩）。

改完顺便给弹层做了尺寸分级，按面板内容分配：

| 档位 | 宽度 | 用在 |
| --- | --- | --- |
| `sm` | 520px | 乐透选号 |
| `md` | 760px | 银行、商店、魔法屋、手牌、拍卖、挂出、公司、流程控制 |
| `wide` | 1120px | 股市（唯一的双表格 + 图表 + 长文案） |

窄屏一律回落 `94vw`，所以分级只是「有多宽就用多宽」。

实测：股市弹层 380px → **1120px**；内部滚动量 1412px → 976px；`stock-summary` 自动排成 5 列；
长段说明按可读行长收口到 516px（`76ch`）；弹层内滚轮加了 `overscroll-behavior: contain`，滚到底不会把页面带着走。

### 6.2 K 线图不随容器变宽

`StockChart` 原来是固定 `viewBox="0 0 336 130"` + `width="100%"`：
容器变宽时浏览器只会**等比居中留白**，图本身一点没变大 —— 所以光把弹层放宽，K 线还是原来那个小方块。

改成用 `ResizeObserver` 量容器实际宽度重算 `viewBox`：

- 天数按宽度自适应（约 22px/根），宽了自然多看几天；
- 价格区高度随宽度长高（92 → 200px 封顶），成交量区同比；
- 蜡烛很少时（刚开盘）不摊到屏幕两端，改成**居中一块画布**、间距封顶 90px。

实测：1440 宽下 `1044 × 230`（原 `336 × 130`）；5 根蜡烛时图形居中，不再挤在右边留一大片黑。

### 6.3 休市时股市面板打不开（真 bug）

入口的门控用的是 `A.canTradeStock`，而这个标志里含 `isMarketOpen` —— 例假日 / 全市场停牌时是 `false`，
于是**整个面板都打不开**。但面板里除了 6 支上市股还挂着**公司原始股**：一级市场按面值向公司申购，
引擎的 `checkBuyShares` 不受休市与停牌约束（面板自己的文案也写着「休市中：可认购，暂不能卖出」）。
结果就是「最该买原始股的休市日，那半张表直接消失」。

修法：`acSnapshot.view` 新增 `canOpenStock`（口径 = 引擎的 `canTradeStockNow`：自己回合 + 未破产），入口改用它，
市场状态只用来决定面板内「上市股」那几个按钮的可用性；门控文案也相应写成
「例假日休市：上市股不能动，原始股照常认购」。

实测：例假日打开面板成功，顶栏「周六例假日休市」，上市股 4 个按钮置灰、原始股 4 个按钮可用。

### 6.4 同一屏两个「回合」数

HUD 顶栏是 `第 ${turn} 回合 · 第 ${round} 圈`，而 `StockPanel` 把 `game.round` 也写成「回合」——
于是顶栏「第 15 回合」和面板「第 8 回合」同屏打架。面板改用 `game.turn`（其余面板本来就是对的）。

### 6.5 交互细节

| 补了什么 | 说明 |
| --- | --- |
| Esc 关闭 | 强制流程弹层（小游戏 / 拍卖 / 结算）没有可关的余地，Esc 一律吞掉不外传 |
| 锁背景滚动 | 打开时 `body{overflow:hidden}`，关闭还原。棋盘铺满整屏，滚轮本来是推拉相机 |
| 焦点管理 | 打开时焦点移进弹层，关闭后**归还触发按钮**（实测回到「开股市」） |
| HUD 让出键盘 | 新增 `hostApi.modalOpen`：弹层开着时 HUD 不抢键盘，否则点完「买 10 张」顺手一个回车会隔着遮罩把骰子掷了 |
| 无障碍 | `role="dialog"` / `aria-modal` / `aria-label`；关闭按钮上标 `Esc` 让键盘操作可发现 |
| 银行「全部」歧义 | 原来只有一个「全部」，取的是 `maxDeposit \|\| maxWithdraw` —— 你想「取光」时它可能填的却是存款上限。存款与取款是两个上限，拆成「存满 ¥x」「取光 ¥y」两个按钮，各带各的数 |

### 6.6 发现但**未**修（等你定）

1. **字体走 Google Fonts**：`ensureHudStyles()` 注入 `fonts.googleapis.com` 的 `M PLUS Rounded 1c` / `Nunito`。
   这个域名在国内基本连不通 —— 实测每次加载产生 **50+ 条 `ERR_CONNECTION_CLOSED`**，
   还会拖住 `document.fonts.ready`（自动化截图因此超时）。视觉上会静默退化成系统字体，
   而圆体字形是 ac 风格的一大半。建议自托管 woff2，我没动是因为要新增字体文件、想先跟你确认。
2. **既有面板仍是深色**（壳奶油、里深色），视觉是断的 —— 即 §7 里那条「逐个换皮」。

---

## 7. 字体：从 Google Fonts 换成自托管

### 7.1 原来的问题（不是「慢」，是「中文根本没生效」）

`ac.css` 的字体栈原本是 `'M PLUS Rounded 1c', system-ui, sans-serif`，靠一个 `<link>` 拉 Google Fonts。
跑起来容器里刷了 55 条 console error，全是 `fonts.gstatic.com` 的 `ERR_CONNECTION_CLOSED`。但那条只是表象，真正的问题是：

**M PLUS Rounded 1c 是日文字体，只有 8201 个码位。** 实测界面用到的 1794 个汉字，它只覆盖 1218 个（67.9%）。
其余 576 个字逐字回退到 `system-ui` —— 同一个词里一半圆体、一半系统黑体，而这种断裂在截图里几乎看不出来，
只有量出来才知道。

实测脚本：`design/hud-ac/tools/check-font-coverage.py`

| 字体 | 码位 | 本项目界面用字覆盖 |
| --- | --- | --- |
| M PLUS Rounded 1c（原方案） | 8,201 | 67.9% |
| 狮尾圆体 Swei Spring CJKsc（现方案） | 42,858 | **100%** |
| 缝合像素 Fusion Pixel 12px zh_hans | 36,999 | **100%**（含繁体） |
| 方舟像素 Ark Pixel 12px zh_hans | 24,869 | 95.4% |

### 7.2 现在的做法

全部自托管到 `client/public/fonts/`，由 `design/hud-ac/tools/build-fonts.py` 生成（下载 → 子集化 → 分片 → 写 `@font-face`）。

字体栈改为**拉丁在前、中文在后**，各取所需：

```css
--ac-disp:'M PLUS Rounded 1c','Swei Spring CJKsc',system-ui,sans-serif;
--ac-ui:  'M PLUS Rounded 1c','Swei Spring CJKsc',system-ui,sans-serif;
--ac-num: 'Nunito','M PLUS Rounded 1c','Swei Spring CJKsc',system-ui,sans-serif;
```

`AcHudLayer.tsx` 里那个 Google Fonts `<link>` 已删除，改成注入本地 `/fonts/fonts.css`。

**中文按 `unicode-range` 切三片**，浏览器只下实际用到的那片：

| 片 | 内容 | 何时下载 | 体积（700 / 900） |
| --- | --- | --- | --- |
| hot | 项目源码里真实出现的 1794 字 | 首屏必下（界面文字全在这） | 296 KB / 298 KB |
| common | GB2312 一级常用字的其余 2292 字 | 玩家昵称出现源码外常用字时 | 387 KB / 389 KB |
| rare | GB2312 二级生僻字 2990 字 | 极少数情况 | 534 KB / 535 KB |

**首屏字体预算 = 730 KB**：hot 两档字重（296+298）+ M+ 700/800（43+43）+ Nunito（50）—— 与容器内实测一致。
两档都要，是因为界面同屏既有 700 也有 800 字重的文字（`--ac-disp` 的按钮标题是 800）。
走 nginx `location /fonts/` 的 30 天强缓存，第二次进游戏为 0。

> 试过砍掉 900（只发 Bold 并声明 `font-weight: 700 900`，省 298KB → 首屏 430KB）。
> 做了 A/B 截图对比后放弃：那样 800 字重的中文只有 Bold，而同一行的拉丁是 M+ ExtraBold，
> 中文明显比数字轻，一行里两种重量。保留 Black 后两者才协调。

### 7.3 踩的两个坑（都会静默失效，界面上看不出来）

**坑一：语料目录漏了一个，一个「阿」字拖下 388KB。**
最初 `CORPUS_DIRS` 只扫 `client/src/{ui,game}` 与 `shared/src`。但热座默认玩家名「阿福」定义在
`client/src/net/session.ts` 与 `server/src/rooms/GameRoom.ts` —— 两处都不在扫描范围内。
结果「阿」不在 hot 片里，界面一渲染它就去拉 common 片（387KB）。现在 `CORPUS_DIRS` 覆盖
`client/public`、`client/src`、`shared/src`、`server/src` 全部，多扫只让热片大几 KB，漏扫就是几百 KB。
（探测方法：抓 `document.body.innerText`，与 `chars-hot.txt` 做差集，一眼看出是哪个字。）

**坑二：为省 CSS 字节去合并 unicode-range 区间，导致三片全下载（2.4MB）。**
`fonts.css` 原来 90KB 且渲染阻塞，于是我把「相距 ≤32 的码位并成一段」，压到 33KB。
但合并让 hot / common / rare 的区间**互相重叠**，同一个字命中多片时浏览器取最后声明的那个，
于是界面上每个字都让三片"看起来可能用到" —— 实测 6 个 CJK 分片全下载，2.4MB，分片策略彻底白做。
现在改回**精确区间**（90KB 原始 / 35KB gzip），并在 `build-fonts.py` 里加了 `verify_disjoint()`
自检：三片区间两两相交直接报错退出。精确区间的额外好处是可证不相交 —— 任何一个字只可能命中一片。
（顺带给 nginx 补了 `gzip on`，默认是 off，90KB 会原样下发。）

**坑三：`--ac-num` 里的中文掉到 Microsoft YaHei。**
Nunito 与 M+ 都没有 CJK，栈里必须显式补中文兜底，否则金额旁边那些用 `--ac-num` 的中文小字会和别处不是一个字体。

### 7.4 怎么验的（不用肉眼猜）

用 CDP 的 `CSS.getPlatformFontsForNode` 直接问浏览器「这段文字实际用了哪几个字体、各几个字形」：

```
#disp: Rounded Mplus 1c Bold x12 · Swei Spring CJK SC x10
#ui:   Rounded Mplus 1c Bold x12 · Swei Spring CJK SC x10
#num:  Nunito x12 · Swei Spring CJK SC x10
```

12/10 正好是「骰子擢出六點 存款 $12,580 回合 8」里拉丁数字与汉字的个数切分，说明两地字形各归其主。
（补过 `--ac-num` 之前，那一栏是 `Nunito ExtraLight x12 · Microsoft YaHei UI x10`。）

另外验证了 Nunito 子集后**变量轴仍在**（`fvar: wght 200–1000`）：同一串数字在 200/400/700/900/1000 五档下
宽度单调递增 204.77 → 212.84，说明字重真的被应用了，不是永远渲染默认实例。

---

## 8. 像素中文字体库

选型与结论写在 `design/w98-pixel/README.md` 的「已定：像素中文字体」一节，这里是接口层。

**两款像素字体**：

| | 缝合像素 12px（主力） | 秋叶圆体 16（备选） |
|---|---|---|
| 产物 | `fonts/pixel/fusion-pixel-12px-zh_hans.woff2` | `fonts/pixel/qiuye-round-16.woff2` |
| 体积 | 0.64 MB | **0.51 MB**（原文件 4.1 MB 子集化而来） |
| 码位 | 36,999 | 13,646（子集后 7,255） |
| 设计字号 | 12px → 取 12 / 24 / 36 | **16px → 取 16 / 32** |
| CSS 变量 | `--w98-font-pix` / `--w98-fs-pix-*` | `--w98-font-qy` / `--w98-fs-qy-*` |
| 用法类 | `.w98-pix` / `--md` / `--lg` | `.w98-pix-qiuye` / `--md` |
| 授权 | OFL 1.1 | OFL 1.1 |

- 两款都在 `design/w98-pixel/fonts.css` 挂 `@font-face`；
- 字号必须取**各自设计字号的整数倍**，两组不可混用（24px 对秋叶圆体是 16 的非整数倍，一定糊）。
  `preview.html` 第 4 节把 12 / 24 / 13（故意写错）/ 秋叶 16 / 秋叶 32 / 秋叶 24（故意写错）/ 系统字并排放了；
  `ab-qiuye.html` 再把两者各按设计字号绘进 canvas、做 3 倍最近邻放大，逐像素可辨；
- 没选方舟像素的唯一理由：它缺「骰 窗 券 即 筑 毁 旋 姿 旅 斜」8 个字，而《大富翁》的核心动词就是「骰」；
- 秋叶圆体只作备选的原因：它带 16px 内嵌 1-bit 位图，但实测 **Chrome on Windows 不读、走矢量轮廓**，
  16px 下笔画行是 `·*#*·`（中间 1 黑像素 + 两侧灰边），而缝合像素是 `·####*` 纯黑实心；
- 顺带修了 `.w98-orb__glyph`：原来字号写的是 22px（不是 12 的倍数），已改 24px。

**秋叶圆体的接入方式**：用户在 `assets/QiuYeYuanTi-16.ttf` 留了一份源文件，`build-fonts.py` 的
`fetch()` 新增了 `local` 字段 —— **有本地文件就不联网**，离线可构建，换字体只要替换文件重跑。
经比对，用户这份与官方 v1.0.0 逐字节相同。

### 关于像素字体的体积问题（回应 `design/w98-pixel/README.md` 原第 97 行「待评估」）

**0.64 MB 可以接受**，三个理由：
1. **按需加载** —— 只有页面真的渲染 `.w98-pix` 才会请求，当前游戏本体不用就一个字节都不下；
2. **只需一份** —— 官方按语言切了包，但实测各语言构建体积几乎一致（latin 651.7 / zh_hans 650.6 / zh_tw 659.2 KB），
   说明上游没做语言裁剪、zh_hans 已含拉丁与繁体，没必要再切分片；
3. **强缓存** —— 30 天，只在字体重建时失效。

### 怎么重建 / 怎么跑

```bash
pip install -r design/hud-ac/tools/requirements.txt   # fonttools[woff] + brotli
pnpm fonts                # = python design/hud-ac/tools/build-fonts.py（缓存命中则跳过下载）
pnpm fonts:clean          # 重新下载源文件
```

源文件缓存在 `.font-cache/`（已 gitignore，17MB/个不入库）；**产物 `client/public/fonts/` 入库**，
这样新克隆的仓库和 Docker 构建都不需要联网、不需要装 Python 依赖。

> 像素字体预览必须走 HTTP，`file://` 双击会被 Chrome 当作跨来源拦掉字体请求：
> `python -m http.server 8080` 后开 `http://localhost:8080/design/w98-pixel/preview.html`

授权：全部 SIL OFL 1.1（可商用、可自托管、可子集化），原文随字体落地在
`client/public/fonts/licenses/` 与 `client/public/fonts/pixel/OFL.txt`，来源清单见 `licenses/NOTICE.md`。

---

## 9. 遗留与下一轮

1. **既有面板未换皮**：银行 / 商店 / 股市 / 拍卖等仍是深色 React 面板，装在 ac 弹层里。建议逐个重做成 ac 皮肤（含金额步进器、目标选择器）。
2. **顶栏工具按钮是文字符号**：静音/帮助等在顶栏是 `ac-btn` 小按钮，非图标资产；图标家族可另出一套。
3. **小地图偏淡**：近景取景框与格环对比度可再提一档。
4. **软渲染帧率**：截图环境 2~5fps（原型已知问题），真机无此压力；自动化要留足等待。
5. **手机竖屏**：≤1120px 是堆叠降级布局，未在真机触控实测。
6. **死代码**：`styles.css` 里 `.game-screen/.board-area/.sidebar/.lobby-*` 等规则已无引用，可择机清理（`BoardRenderer.ts` 仍被 `ReplayScreen` 使用，不能删）。
7. **缝合像素 12px 未做自己的内容适配**：顶栏 / 行情带 / 账本表都靠下面 §10 的通用收口兜住了（三口味审计均 0 处真溢出），但它的 12px 网格与 16px 的秋叶不是一档，真要启用仍建议按秋叶那套逐条对账。
8. **961~1120px 这一段顶栏仍会裁掉最右按钮**（修顶栏时顺手复量出来的，与字体口味无关）：1120px 溢出 +26px、1000px +146px。此时 `.ac-hud__who` 已经被压到底（`.hud-when` 归零、只剩 `.hud-stamp`），多出来的是**不让宽的固定组**：钱包三枚 chip + 5 个页签 + 「热座」标 + 11 个宿主工具按钮，合计 ~904px，塞不进 1000px。堆叠降级布局要到 ≤960px 才生效，这段是空档。
   试过给 `.hud-hosttools` 加 `flex-wrap: wrap` —— **无效**：它 `flex:none`，容器宽度按 max-content 算，永远不会触发换行，已撤回。真要修得让堆布局提前生效，或把工具组收成一个 ⋯ 菜单。

> 原第 7、8 条（`.hud-rank em` 溢出 29px、顶栏溢出 63px）与「账本首列印出 `undefined`」已在 §10 末「顶栏 / 排名行收口」修掉。

---

## 10. 像素字口味开关（本轮新增）

在真实对局里把整套 HUD 换成像素中文，用来「看实际效果」。顶栏**第一个工具按钮**循环切换
`圆体 → 缝合像素 → 秋叶像素`，也可以用 URL 直接指定：`http://localhost:8080/?font=pix12` / `?font=qiuye`（优先于 localStorage 记忆）。

### 为什么不能只换 font-family

像素字只有在**设计字号的整数倍**下才是清晰点阵，而 ac 皮肤的字阶是 9~16px 的细腻梯队 ——
13px 的缝合像素等于 12px 点阵被缩放 1.0833 倍，必糊。所以另挂一份
**`client/public/ac-hud/ac-pixel.css`**，由 `design/hud-ac/tools/build-pixel-skin.py` 从四份上游 CSS
（ac.css / hud.css / acHudClient.css / styles.css）**机械派生**：把 `[9,16]px` 的 `font-size`
全部吸附到网格（缝合→12px、秋叶→16px），**>16px 一律不动** —— 那些基本是 emoji 图标
（`.ac-icon` 26px、`.ac-card__art` 48px），不在中文字体里，跟着缩放只会撑坏布局。

手写覆盖不行的两个原因：会漏（四份 CSS 共 385 条，漏一条就是一块糊字）、会漂（上游一改就失配）。
`pnpm pixel-skin` 重新生成。

### 实测结论（真实对局，1440×900，容器里）

**已定：像素口味采用秋叶圆体 16**（用户拍板），内容适配也只做它 —— 缝合像素 12px 与原字阶几乎重合、不需要适配，先放着。

| 口味 | 观感 | 适配后溢出（5 个侧栏页签合计） |
| --- | --- | --- |
| 圆体（默认） | 狮尾圆体 + M+ / Nunito | **0 处真溢出**（顶栏原 +63px 已修，见下文「顶栏 / 排名行收口」） |
| 缝合像素 12px | 硬边点阵，与原字阶几乎重合 | **0 处真溢出**（原 +85px 同上一并修掉） |
| **秋叶圆体 16px** | 字大 ~45%，圆润像素 | **0 处真溢出**（剩 2 条是设计内的纵向滚动容器） |

适配前的秋叶模式有 4 处真溢出：顶栏 +297px（工具按钮被裁掉）、行情带 +86px（「金融」看不到）、
面板底注截断（丢「物价 ×N.NNN」）、账本 9 列表 +96px（「Σ总」列被裁）。逐条适配后归零。

### 内容适配怎么做（秋叶圆体 16px）

全部写在生成器的「内容适配」一节，**每条对应审计工具实测的一条溢出**，改前改后都要跑对账：

| # | 溢出 | 适配 | 结果 |
| --- | --- | --- | --- |
| 1 | 顶栏 +297px | hud.js 把日期段拆成 `.hud-when`，秋叶模式下隐藏 —— 那行日期几乎全是冗余（状态条紧接着就给 M/D 周X · 岛历 N 天 · 月末 N 天，例假日还有专门 chip），保留「第 N 回合 · 第 N 圈」 | 一行放下 |
| 2 | 顶栏按钮被挤 | 内边距按 16px 字号重排（12.5/13px 时代的 7/13 → 6/10） | — |
| 3 | 行情带 +86px | chip 内边距 3/8 → 2/6、行情带 gap 6 → 4、容器 gap 8 → 6 | 86 → 22 → **0** |
| 4 | 面板底注截断 | 允许折行（原来是 nowrap + 省略号） | 信息完整 |
| 5 | 地块信息条标题断词 | 标题行 `flex-wrap: wrap` | — |
| 6 | 账本 9 列表 +96px（「Σ总」被裁） | **侧栏按字号等比加宽** 26vw → 31vw（374 → 446px@1440）+ 表格内距 6/3 → 4/1 | 96 → **0** |
| 7 | 面板标题底部裁 12px | `line-height: 1.45`；实测是 emoji 行框的幻影，视觉上没裁任何字 | — |

侧栏加宽是唯一动布局的适配，理由：字大 45%，栏还按 10.5px 表格字排就不成比例。
代价是棋盘少 72px（棋盘是 `minmax(0,1fr)` 弹性列，不会破版）。

审计口径：`design/hud-ac/tools/font-mode-audit.mjs` 逐元素量 `scrollWidth/clientWidth`，
只看 `overflow` 为 visible 的（auto/scroll 的滚动容器是设计如此），侧栏 5 个页签 + 股市弹层逐个过。

两条实测教训已写进生成器注释，第三条写进度量工具：
1. **`-webkit-font-smoothing: none` 只对 macOS 有效**，Windows/Linux 上是 no-op —— 像素字的锐利度完全取决于字体轮廓有没有落在像素网格上，这正是要做字号吸附的原因。
2. `Range.getClientRects()` 量换行文本的自然宽度时，**各行宽度要相加**（取 max 会漏掉换行部分，量出「差 -2 却报了 2 行」这种自相矛盾的结果）。
3. 但**同一行**里嵌套行内元素的矩形**不能相加**：整段矩形已经覆盖它们，一律相加会把 141px 量成 170px，凭空报出一条不存在的溢出（§9 原第 7 条即如此）。口径改成：按行归组、行内取左右并集、跨行才相加。

### 改了什么

| 文件 | 动作 |
| --- | --- |
| `design/hud-ac/tools/build-pixel-skin.py` | **新增**，生成 `ac-pixel.css`（30.5 KB：字号吸附 + 排版补偿 + 内容适配） |
| `client/public/ac-hud/ac-pixel.css` | **新增**（生成物，入库） |
| `client/public/ac-hud/hud.js` | 顶栏日期段拆出 `.hud-when`（供皮肤按口味隐藏，其余模式不受影响） |
| `client/src/ui/AcHudLayer.tsx` | 加载两份像素样式；`fontMode` state + 顶栏切换按钮 + `<html>` class + localStorage / `?font=` |
| `design/hud-ac/tools/font-mode-{shots,zoom,measure,audit}.mjs` | **新增**，三口味实机截图 / DPR=3 局部放大 / 宽度量测 / **全量溢出审计** |
| `package.json` | 加 `pixel-skin` 脚本 |

产物截图：`hud-font-{round,fusion,qiuye}.png`（整屏）、`hud-font-qiuye-tab-{岛民,股市,账本}.png`（秋叶各页签）、`hud-font-zoom-{round,fusion,qiuye}.png`（状态条 3 倍放大）。

### 顶栏 / 排名行收口（三口味共用，本轮补修）

§9 原第 7、8 条与「账本首列印 `undefined`」一起收口。前两条是像素口味那轮顺手带出来的，第三条在数据层。

| # | 现象 | 根因 | 改法 | 实测 |
| --- | --- | --- | --- | --- |
| 1 | 顶栏横向溢出：圆体 +63px、缝合像素 +85px，最右「退出」被裁一截 | `.ac-hud__who` 是 flex 子项、`min-width:auto`，把里面 nowrap 的日期当成不可压缩的最小内容宽（自然 540px / 盒只有 357px）。而 hud.css 上那条省略号**从来没生效** —— 省略号要求块容器，`small` 是 inline | `who` 给 `min-width:0`；`small` 改 `display:flex`：「回合/圈/岛历」包成 `.hud-stamp`（`flex:none`，永不裁），「M/D 周X」留在 `.hud-when`（可缩 + 省略号）。顺带删掉这行的「（例假日·股市休市）」—— 状态条的 🗓️ 与 🏖️ chip 已重述 | 三口味 `header.ac-hud` 均 **1420/1420**；末按钮右缘 1416 < 顶栏右缘 1430 |
| 2 | `.hud-rank em` 报「自然 170 / 可用 141，溢出 29px」 | **量测假象**：`Range.getClientRects()` 在同一行里会为整段文字与嵌套的 `<b>` 各出一个矩形，相加把 141 量成 141+29 | 修 `font-mode-measure.mjs`：矩形按行归组，行内取左右并集、跨行才相加。CSS 侧顺手补兜底 —— `__track` 由 `flex:1` 改 `flex:1 1 96px`，`em` 加 `min-width:0` + 省略号 | em 的 max-content = 141 = 盒宽，**本来就没溢出**；track 187/152/176 与改前一致，视觉不变。长地名 + 三位数百分比时改由省略号裁字，不再顶破卡片 |
| 3 | 账本 9 列表首列、股市持股分组标题印出「undefined」 | `AVA` 只挂了 `bot-1..bot-4`，热座玩家 id 是 `local-0..3`；这两处漏了别处都有的 `\|\| '🧑‍🌾'` 兜底，模板字符串直接把 `undefined` 当头像渲染出来 | 统一走 `avaOf(p)`：认识的 id 用固定动物，其余按座位序从调色板稳定取一只，兜底 🧑‍🌾。顶栏 / 岛民卡 / 股市分组 / 账本首列四处一起换 | 账本首列 🐵 🐰（`title` 里的名字一直是对的，只是可见的那格是头像）；热座四名玩家各自不同 |

复验：三口味全量审计（5 个侧栏页签 + 股市弹层）横向溢出 **0 处**，只剩设计内的纵向滚动容器 2 + 1 条，与秋叶既有基线同口径。
`pnpm pixel-skin` 重跑产物 md5 不变 —— 本轮没动任何字号，生成物无漂移。
顶栏另按 1280 / 1120 / 1000 / 860px 复量过：1280 与 860 干净，961~1120 那一段是另一回事，已登记 §9.8。

| 文件 | 动作 |
| --- | --- |
| `client/public/ac-hud/hud.js` | `avaOf()` 取代裸 `AVA[p.id]`；顶栏日期两段化 `.hud-stamp` / `.hud-when`，删冗余的「（例假日·股市休市）」 |
| `client/public/ac-hud/hud.css` | 顶栏 `who` / `small` 的收缩与省略号分工；`.hud-rank` 细条与文字的宽度分配 |
| `design/hud-ac/tools/font-mode-measure.mjs` | 自然宽矩形按行归组（修掉凭空报溢出的口径） |

---

## 11. 跑法

### 11.1 Docker（推荐，一条命令全栈）

```bash
pnpm docker:up      # = docker compose up -d --build   → http://localhost:8080
pnpm docker:ps      # 看四服务状态（db / redis / server 应显示 healthy）
pnpm docker:logs    # 跟踪日志
pnpm docker:down    # 停掉并移除容器
```

> 脚本名带 `docker:` 前缀是为了避开 `pnpm up` —— 那是 pnpm 内置的 `update` 别名，会被 pnpm 自己截走，
> 不会执行到这里的脚本。也可以直接 `docker compose up -d --build`。

改完代码重新 `pnpm docker:up` 即可（client 是多阶段构建：node:22-alpine 里 `vite build`，再用 nginx:1.27-alpine 提供静态站点）。
`server` 带 `/healthz` 健康检查，`client` 等 `server` healthy 才开始，所以首屏不会撞上「后端还没起来」。
`db` / `redis` 用 `pg_isready` 与 `redis-cli ping` 探活，四个服务都是 `restart: unless-stopped`。

### 11.2 本地开发

```bash
pnpm --filter @richman/client dev     # http://localhost:5173 → 本地热座 → 开始游戏
pnpm --filter @richman/client typecheck
pnpm --filter @richman/client build
```

> 原型 `design/hud-ac/index.html` 仍可独立打开，两条线互不影响：
> 那边读 `snapshot.js` 冻结快照、按钮只做表现；这边读实时 `GameState`、按钮真发动作。
