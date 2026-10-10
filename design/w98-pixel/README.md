# W98-Pixel UI Kit — 组件规范

> B 套独立美术方向。基准：伪 Win9x 桌面壳 + 高清像素热带海岛棋盘。
> **与 `大富翁Online-美术风格提案.md`（v1–v6 那条线）并行，互不依赖，勿混用。**
> 状态：tokens + 组件已成型，未接入 `client/`。

## 文件

| 文件 | 职责 | 约束 |
|---|---|---|
| `tokens.css` | 只有 `:root` 变量：色、描边、bevel、圆角、间距、尺寸、字体、渐变、动效、层级 | 不得出现任何选择器、不得出现组件规则 |
| `fonts.css` | 只挂自托管像素中文字库的 `@font-face`（缝合像素 12px + 秋叶圆体 16） | 字体本体在 `client/public/fonts/pixel/`，本目录不放 1.2MB 副本 |
| `ui-kit.css` | 组件规则 | **取值只能来自 `--w98-*`**，不得写死色号/像素值 |
| `preview.html` | 全组件渲染预览 + 色板 + 状态矩阵 + 字体 A/B 对比 | 页面自身布局样式写在它内联 `<style>` 里，不进套件 |
| `specimen.html` | 像素中文字体库样张：使用规则 + 双字体切换 + 全字集浏览（GB2312 一/二级 + 拉丁）+ 逐字覆盖率自测 | 字符集在客户端用 `TextDecoder('gbk')` 从 GB2312 字节区间解出，不往仓库塞字符表 |
| `ab-qiuye.html` | 像素级 A/B：两款字各以设计字号绘进 canvas，再 3 倍最近邻放大，逐个方块就是真实像素 | 只用 canvas + `imageSmoothingEnabled=false`，不做矢量缩放（那会掩盖真实的点阵差异） |

预览：起个 HTTP 服务再打开（**不能 `file://` 双击，字体请求会被浏览器当作跨来源拦掉**）：

```bash
python -m http.server 8080     # 仓库根目录
# http://localhost:8080/design/w98-pixel/preview.html   组件与字体对比
# http://localhost:8080/design/w98-pixel/specimen.html  像素中文字库样张
# http://localhost:8080/design/w98-pixel/ab-qiuye.html  像素级 A/B（3 倍放大）
```

## 核心设计规则

1. **两层语言分离**——这是本风格的全部张力来源，不许合并：
   - 桌面壳（窗口/标题栏/工具栏/小地图/按钮）= Win9x 拟物，**直角**，`box-shadow` 画 bevel 立体边；
   - 棋盘与角色 = 高清像素，**硬投影** `--w98-shadow-sprite`，`image-rendering: pixelated`。
   - 羊皮纸面板是两者的过渡层：圆角 + 金框 + 硬投影，不带 bevel。
2. **描边统一** `--w98-ink #3B2A1A`。桌面壳用 1px（`--w98-line-thin`），像素物件用 2–3px（`--w98-line` / `--w98-stroke-heavy`）。同一元素不得混用两种。
3. **bevel 只有三档**：凸起 `--w98-bevel-out`、凹陷 `--w98-bevel-in`、细凸起 `--w98-bevel-out-thin`。按下态 = 把 out 换成 in 且 `translateY(1px)`。不得自造第四种。
4. **圆角三档**：chrome `0`、卡片 `14px`、chip `8px`、圆形 `999px`。工具栏按钮是唯一允许 8px 圆角的 chrome 元素。
5. **数字一律** `--w98-font-num` + `font-variant-numeric: tabular-nums` + 右对齐。金额变动用 `.is-positive` / `.is-negative`，不靠 ± 号以外的手段表意。
6. **标题字用 text-shadow 描边**（`--w98-text-outline`），不生成字体贴图。
7. **选中态**统一 `--w98-glow-select`（金环 + 外描边），hover 只改亮度不改形状。
8. **像素动画**用 `--w98-ease-step` 与整像素位移；PixiJS 侧贴图须 `scaleMode: NEAREST`。
9. 所有交互组件必须响应 `prefers-reduced-motion`（见 `ui-kit.css` 第 10 节）。

## 组件清单

| 类 | 用途 | 关键状态 |
|---|---|---|
| `.w98-app` | 最外层窗口，纵向 flex | — |
| `.w98-titlebar` `__icon` `__text` `__controls` | 蓝渐变标题栏 | — |
| `.w98-caption-btn` | 标题栏右侧窗控（_ □ ×） | `:active` 转 bevel-in |
| `.w98-toolbar` `__sep` | 顶部图标工具栏，高 76px | — |
| `.w98-toolbtn` | 图标 + 中文标签按钮 | `.is-active` / `:hover` / `:disabled` |
| `.w98-parchment` `__title` | 羊皮纸信息卡，标题压在卡上沿 | — |
| `.w98-tabs-v` / `.w98-tab-v` | 右缘竖排标签（资金/地產/股票/其他） | `.is-active` 外凸 4px |
| `.w98-stat` `__icon` `__label` `__value` | 图标+标签+右对齐数值行 | `.is-positive` `.is-negative` |
| `.w98-avatar` | 玩家头像框 92×92 | — |
| `.w98-actionbar` | 底部蓝渐变操作条，高 108px | — |
| `.w98-orb` `__glyph` `__label` | 玻璃质感圆形大按钮 84px | `--go` `--card` `--aid` / `:disabled` |
| `.w98-float` `__body` | 悬浮窗（小地图等），复用 titlebar | — |
| `.w98-news` `__body` `::before` | 绳圈 NEWS 徽章 + 对话尾巴 | — |
| `.w98-tile` | 棋盘地块 DOM 版（提示、图例用；真实棋盘走 PixiJS） | `--orange --purple --green --blue --gold` / `.is-selected` |
| `.w98-btn` `--primary` `--danger` | Win9x 方角按钮 | `:hover` `:active` `:disabled` |
| `.w98-field` | 输入框，凹陷 bevel | `:focus` 加选中环 |
| `.w98-heading` | 描边展示字 | — |
| `.w98-icon` | 像素贴图容器，硬投影 | — |
| `.w98-stage` | 棋盘舞台水面底 | — |

## 与现有 client 的对接（尚未执行）

现有 `client/src/styles.css`（2168 行）是墨绿深色 + `#e91e63` 粉主色，与本套件是两套语言。若要采用：

1. `main.tsx` 里在 `./styles.css` **之前** import `tokens.css` + `ui-kit.css`（`.w98-` 前缀不冲突）；
2. 按面板逐个迁移，映射表：

| 现有选择器 | 迁到 |
|---|---|
| `.panel` / `.panel-title` | `.w98-parchment` / `.w98-parchment__title` |
| `.sidebar` 顶栏 | `.w98-titlebar` |
| 侧栏 tab 切换 | `.w98-tabs-v` + `.w98-tab-v` |
| `button` / `button.primary` / `button.ghost` | `.w98-btn` / `--primary` / 去边框版 |
| `.player-card` 数值区 | `.w98-stat` 三列网格 |
| `.die` | `.w98-icon` + 像素骰子贴图 |
| 弹窗 / 面板浮层 | `.w98-float` |
| 中央事件提示 | `.w98-news` |

3. 迁移期两套并存会明显串味，**建议整屏一次切完再合**，不要逐面板混排。

## 已产出资产（`art/`，品红底）

| 文件 | 内容 | 实测结论 |
|---|---|---|
| `cards_face@w98.png` | 8 张卡面（4×2），金绳框 + 奶油内底 + 单个大图章，无文字 | ✅ 4 列宽 281/281/282/281，底边极差 1px，**可直接等距切片** |
| `env_resort_lv1-4@w98.png` | 同一地块 lv1 棚屋 → lv4 度假塔的升级链 | ⚠️ 底边对齐极好（815–817，极差 2px），但**底座占地 234/310/365/495，lv4 是 lv1 的 2.1 倍**，不共享等距地基，**不能原位替换** |
| `ui_news_badge_templates@w98.png` | 4 个公告框模板：圆环+尾巴 / 圆环+横幅 / 木牌跑马灯 / 六边形角标 | ⚠️ 仅模板 1 的中心底板经确认纯白可压字（rgb 251,251,251，σ=0.5）；其余三个因相邻元素包围盒越界，自动切格无法验证，需人工确认 |

**品红底纯度（影响色键）**：三张图的背景中心约 `rgb(248,6,240)`，四角偏暗到 `rgb(237,13,245)`–`rgb(251,14,243)`，通道暗角差 7–18，背景相对中心的最大偏离 79–82。**不是绝对平面品红**，用 `#FF00FF` 精确抠图会在边缘留脏边，需带容差抠像 + despill。

**建筑集修复方案**（择一）：
1. 逐级单独出图，固定画布与固定菱形地基尺寸，靠提示词锁死 `identical 256px-wide isometric base plate`；
2. 交代码统一缩放对齐底座——但像素风在非整数倍缩放会花，需 `NEAREST` + 手工补偿，不推荐；
3. 接受"逐级占地变大"作为设计特征，同时改棋盘逻辑允许升级改变碰撞格。

> 量测脚本：`.scratch/measure-png.mjs`（零依赖 PNG 解码，一次性工具，不入库）。

## 待定

- 图标：当前预览用 emoji 占位，正式版需像素图标图集（顶部 8 枚 + 金币 + 骰子 + 窗控）。
- 棋盘：`.w98-tile` 只是 DOM 表达，真实棋盘仍由 `BoardRenderer.ts` 画，色号应从 `tokens.css` 抽成 TS 常量共享，避免两处漂移。

## 已定：像素中文字体（原「待评估」项，已结）

问题原来是：`Press Start 2P` 只覆盖拉丁、中文要 `Zpix`，两个都没落地，于是「像素中文」实际是系统字。
现已选定 **缝合像素字体 Fusion Pixel 12px 比例版**为主力（`fonts.css` + `--w98-font-pix`），
**秋叶圆体 16** 为备选（`--w98-font-qy`）。体积与覆盖率实测如下。

| 候选 | 码位 | 体积(woff2) | 本项目界面用字覆盖 | 结论 |
|---|---|---|---|---|
| 缝合像素 Fusion Pixel 12px zh_hans | 36,999 | **0.64 MB** | **100%**（繁体亦 100%） | **主力** |
| 秋叶圆体 QiuYe Round 16（子集后） | 13,646 → 子集 7,255 | **0.51 MB** | GB2312 一/二级 6,763 字 **全含** | **备选** |
| 方舟像素 Ark Pixel 12px zh_hans | 24,869 | — | 95.4% | 弃 |
| Press Start 2P | 仅拉丁 | — | 0%（无中文） | 仅可作纯拉丁备选 |

弃方舟像素的**唯一但决定性**的理由：它缺「骰 窗 券 即 筑 毁 旋 姿 旅 斜」8 个字，
而《大富翁》的核心动词就是「骰」。覆盖率实测脚本：`design/hud-ac/tools/check-font-coverage.py`。

体积结论：**0.64 MB 可以接受**，理由是——
1. 它是**按需加载**的：只有页面真的渲染 `.w98-pix` 才会请求，游戏本体不需要就一个字节都不下；
2. 它是**单一文件**：官方各语言构建实测体积几乎一致（latin 651.7 / zh_hans 650.6 / zh_tw 659.2 KB），
   说明上游没做语言裁剪，zh_hans 已含拉丁，因此只需托管这一份，不必再切分片；
3. 走 nginx `location /fonts/` 的 30 天强缓存，只在字体重建时失效。

### 已评估：秋叶圆体 16（新增，用户提供）

用户从 `github.com/yzdnn/qiuyeyuanti-16` 下了一份，评估后**收作备选口味**。

**它是什么**：血统是日本 **KHドット秋葉原16** —— Sharp X68000 时代的 16 点阵商用位图字体，
作者 yzdnn 在此基础上增补了简繁汉字。原文件 4.1 MB / 13,646 码位 / 14,034 字形，
带内嵌 1-bit 位图（`bloc` 单一 strike **ppem 16**、`bdat` 430 KB ≈ 每字 32 字节）。
**OFL 1.1**，可商用可自托管可子集化。用户这份文件经比对与官方 **v1.0.0** 逐字节相同。

**接入方式**：用户在 `assets/QiuYeYuanTi-16.ttf` 留了一份，`build-fonts.py` 的 `fetch()` 
加了 `local` 字段，**优先用本地文件**而非联网 —— 离线可构建，换字体只要替换文件重跑，不必改脚本。

**子集化**：收项目语料 + GB2312 一/二级 + ASCII + 全角共 7,257 字，其中 7,255 字原字体有
（缺「〞」「—」，回退到系统字）。**4.1 MB → 0.51 MB**。

**关键的实测结论 —— 位图被忽略**：做了「剥掉 `bloc`/`bdat` 表」的对照字体，两张渲染
**逐像素完全相同**，即 **Chrome on Windows 不使用内嵌 EBDT/EBLC 位图，走的是矢量轮廓**。
所以它在 Windows 上 16px 会略带灰边（黑体类小字号字形横向笔画常落半像素）；
在会读内嵌位图的实现（部分 Linux / Firefox 环境）上才是硬点阵。

**像素裁决**（canvas 取字形位图的行值）：

| 渲染 | 笔画行像素 | 判定 |
| --- | --- | --- |
| 缝合像素 12px | `·####*` 纯黑实心，仅 1 个边缘过渡像素 | **最锐** |
| 秋叶圆体 16px | `·*#*·` 中间 1 像素 + 两侧灰边 | 发虚 |
| 秋叶圆体 32px（2 倍） | `·##·` 实心 2 像素 | 清晰 |
| 系统字（Microsoft YaHei 12px） | 多级灰阶 | 最糊 |

前进宽度均为整数（缝合 12/24，秋叶 16/32），网格对齐无问题。
**结论：主力仍是缝合像素，秋叶圆体作「圆体像素」口味的备选，字号只能用 16 / 32px。**

### 用像素字的硬约束

像素字不是「把字号调小就好看」，它只有在**各自设计字号的整数倍**下才是清晰点阵：

- 缝合像素设计字号 12px → `font-size` 取 `--w98-fs-pix-sm/md/lg`（**12 / 24 / 36px**）；
- 秋叶圆体设计字号 16px → `font-size` 取 `--w98-fs-qy-sm/md`（**16 / 32px**）；
- **两组不可混用** —— 24px 对秋叶圆体是 16 的非整数倍，一定糊（`specimen.html` 里做了这个反例）；
- 必须关抗锯齿（`.w98-pix` / `.w98-pix-qiuye` 已代劳：`-webkit-font-smoothing: none`）；
- `line-height` 取整数像素，`letter-spacing: 0`。

`preview.html` 第 4 节把 12px / 24px / 13px（故意写错）/ 秋叶 16 / 秋叶 32 / 秋叶 24（故意写错）/
系统字并排放了；`ab-qiuye.html` 再各按设计字号绘进 canvas 做 3 倍最近邻放大，肉眼可辨。

### 逐字覆盖率自测

`specimen.html` 把整个字符集铺成网格（可切换字体），并用 canvas 逐字比对「用该字体渲染」与
「故意指定一个不存在的字体逼出系统回退字形」两张位图 —— 位图一致就说明这个字本字库没有，标红。
在本机实测：

| 字符集 | 字数 | 缝合像素 12px 缺 | 秋叶圆体 16 缺 |
| --- | --- | --- | --- |
| GB2312 一级（常用） | 3,760 | **0** | **0** |
| GB2312 二级（次常用） | 3,008 | **0** | **0** |
| 拉丁 / 数字 / 全角符号 | 189 | **0** | **0** |

（一级解出 3,760 而非标准里的 3,755，是因为浏览器里 `gb2312` 这个编码标签按规范映射到 GBK 解码器，
比 GB2312 多认几个空位 —— 那几个字在 GBK 里有定义，不算错。
注：秋叶圆体上表 0 缺，是因为自测样本只覆盖 GB2312 与拉丁；实测它缺「〞」「—」两个符号字。）

### 预览方式

⚠️ 必须走 HTTP，不能 `file://` 双击 —— Chrome 视 `file://` 为不透明来源，会拦掉字体请求：

```bash
python -m http.server 8080     # 仓库根目录
# 打开 http://localhost:8080/design/w98-pixel/preview.html
```

### 授权

两者均为 SIL Open Font License 1.1，原文随字体落地在
`client/public/fonts/pixel/OFL.txt`（缝合像素）与 `client/public/fonts/licenses/OFL-qiuye-round.txt`（秋叶圆体），
来源清单见 `client/public/fonts/licenses/NOTICE.md`。
缝合像素上游整合了 ark-pixel / cubic-11 / galmuri 三家字形；秋叶圆体上游 `github.com/yzdnn/qiuyeyuanti-16`。

