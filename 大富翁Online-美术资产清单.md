# 《大富翁 Online》美术资产清单

> 版本 v1 ｜ 日期 2026-10-08 ｜ 依据：M1–M4 已实现玩法（README 里程碑）+ `BoardRenderer.ts` 现有占位表现
> 命名规范：`<类别>_<对象>_<状态>@v<版本>.png`，类别前缀 `char / env / icon / ui / fx`
> 交付规格：PNG；出图 1024×1024（2 倍）→ 脚本裁切缩放至目标尺寸；纯品红底 `#FF00FF` 生成 → keyout 转透明底，**双版本保留**

## 一、规格基准

| 项 | 值 |
|---|---|
| 棋盘瓦片 | 64×32 菱形（2:1 等距），建筑落单格底座 |
| 棋子显示高 | ≈32px（出图按 256×256 交付） |
| 建筑交付 | 256×256 PNG 透明底 |
| 卡片图标 | 256×256 PNG 透明底 |
| UI 切图 | 九宫格优先，同形状变色交代码 |
| 图集分组 | 棋盘组（建筑+棋子）、UI 组、图标组，同屏同组 |

## 二、缺口清单

| # | 资产 | 类别 | 规格 | 用途 | 优先级 | 状态 | 阻塞什么 |
|---|---|---|---|---|---|---|---|
| 1 | char_player_a~d | 角色 | 256×256 透明 | 4 名玩家棋子 | **P0** | 全员 @v6 已定稿 | — |
| 2 | env_house_lv1~5 | 建筑 | 256×256 透明 | 住宅升级 5 级 | **P0** | 全员 @v6 已定稿 | — |
| 3 | env_mall / env_hotel / env_park / env_gas / env_lab | 建筑 | 256×256 透明 | 特殊地产 | **P0** | 全员 @v6 已定稿 | — |
| 4 | env_bank / env_shop / env_hospital / env_jail / env_start / env_tax / env_chance / env_news | 建筑 | 256×256 透明 | 功能地块 | **P0** | 全员 @v6 已定稿 | — |
| 5 | icon_card_×8 | 图标 | 256×256 透明 | 8 种卡片（现有卡池） | **P0** | 未开始 | 手牌/商店可视化 |
| 6 | char_god_cai / char_god_qiong / char_god_tudi | 角色 | 256×256 透明 | 财神/穷神/土地公 | P1 | 未开始 | 神仙系统表现 |
| 7 | icon_coin / icon_dice / icon_stock / icon_shield | 图标 | 128×128 透明 | 货币/回合/股票/保护 | P1 | 未开始 | 通用 UI 语义 |
| 8 | ui_panel / ui_btn_primary / ui_btn_secondary | UI | 九宫格 | 面板与按钮 | P1 | 未开始 | 界面精致化 |
| 9 | fx_dice_roll / fx_pay / fx_build / fx_win | 特效 | 256×256 | 掷骰/扣款/建造/胜利 | P2 | 未开始 | 反馈手感 |
| 10 | env_tileset_grass / road | 场景 | 瓦片 | 棋盘底纹（可选，纯色底已可用） | P2 | 未开始 | 棋盘氛围 |

> P0 = 缺了玩法验收明显降级；P1 = 体验提升；P2 = 锦上添花。

## 三、产出批次（按"一套锚点能覆盖"划分）

| 批次 | 内容 | 数量 | 前置条件 |
|---|---|---|---|
| **第 1 批（基准图）** | char_player_a + env_house_lv1 | 2 张 | 本提案确认 |
| 第 2 批 | 玩家 b/c/d 变体 + house_lv2~5 | 7 张 | 第 1 批定稿（锚点冻结 v1-final） |
| 第 3 批 | 特殊地产 + 功能地块建筑 | 13 张 | 第 2 批同族一致性通过 |
| 第 4 批 | 卡片图标 ×8 + 神仙 ×3 + 通用图标 ×4 | 15 张 | 第 3 批通过 |
| 第 5 批 | UI 切图 + 特效 | 7+ | 全部定稿后收尾 |

> 第 1 批定稿前后续规格可能变，不做提前量。每批交付：`@v1_src.png`（品红底原图）+ `@v1.png`（透明底）+ `check` 校验报告 + 需精修标注。

## 四、生成链路（每批固定）

```bash
# 1. 生成品红底原图 → assets/art/raw/
# 2. 抠图转透明底
python art_asset_tools.py keyout <raw>/<资产>@v1_src.png --color "#FF00FF" --out assets/art/<资产>@v1.png
# 3. 批量裁边 + 规格校验
python art_asset_tools.py trim assets/art/<批次目录>
python art_asset_tools.py check assets/art/<批次目录>
# 4. 接触表做缩略图测试 + 同族一致性比对
python art_asset_tools.py sheet assets/art/<批次目录>
```

AI 生成图需人工精修与合规确认后才作最终素材，每批交付时明确标注哪些需精修。
