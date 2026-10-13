# 大富翁 Online — 棋盘目标选取交互规格

> 状态：v1 定稿（2026-10-13），W1→W4 待实施
> 决策口径来源：本文 §7「已定案」；玩法对账背景见 `docs/玩法拆解_卡片对账决策表.md`（D-43 视野、D-19 改建、D-32 机器娃娃、D-39 传送机、D-45 工程车、D-46 乞丐）
> 关联表现层文档：`大富翁Online-相机系统规格.md`

---

## 1. 问题与目标

### 1.1 现状病灶（逐条核过代码）

| # | 事实 | 证据 |
|---|---|---|
| 1 | 目标选择全靠面板里一个**裸数字下拉框**，棋盘不参与任何选目标 | `client/src/ui/HandPanel.tsx:150-162` |
| 2 | 门控**从不校验目标**：`checkUseCard` / `checkUseItem` 只看持有、`auto`、`available`、时机、`guard`，不看 `cellId / targetPlayerId / stockId / diceValue / facility` | `shared/src/engine.ts:3608-3626`、`:3658-3667` |
| 3 | 目标合法性只存在于 `apply` 中途抛出的异常里 ⇒ 「按钮按下去才报错」 | `requireCellId` `engine.ts:3127`、`targetPlayer` `:3138-3143` |
| 4 | 项目不变式「门控与引擎校验同源」在目标维度**已知未守** | `shared/test/action_registry.test.ts:59-61` 的 `push(..., false)` |
| 5 | `anyCellId()` 缺省**静默取脚下** ⇒ 拍卖/天使/恶魔/拆除/怪兽等在下拉框没选值时打到脚下 | `engine.ts:3133`、`:3226` |
| 6 | 改建卡声明 `target:'land'` 却**整个忽略** `cellId` | `cards.ts:251` |
| 7 | `useItem` 不发 `targetPlayerId` ⇒ 定时炸弹「丢给对手」与传送机带人在界面上**不可达** | `HandPanel.tsx:66-75` vs `items.ts:142-145`、`:290-297` |
| 8 | `robot-worker` 漏在需要选格的硬编码集合之外；`effectiveTarget` 默认锁第一名可见对手 | `HandPanel.tsx:8`、`:25` |
| 9 | 路障 / 地雷 / 定时炸弹在画面上**完全不存在**；且 `roadblocks` / `mines` 只是格子号数组，**不知道是谁放的** | `client/public/ac-hud/world.js` 绘制清单；`shared/src/types.ts:648`、`:650` |
| 10 | `ItemDef.phase` 是死元数据（13 件全写 `'any'`，引擎硬要求掷骰前） | `items.ts:33`；`engine.ts:3658` |

### 1.2 目标

把「选目标」做成一等公民：**同一个谓词既用于枚举候选，也用于派单校验**；玩家在活棋盘上直接点选；非法目标在进入选态时就被标灰并给出理由，而不是按下之后才失败。

非目标：不做老存档兼容；不改回放用的 `BoardRenderer.ts`；不动已定案的射程与脚下类口径；载具独立速度模型另开会话。

---

## 2. 引擎侧模型（W1）

### 2.1 新增 `shared/src/targets.ts`

```ts
/** USE_CARD / USE_ITEM 的派单参数里与目标有关的字段 */
export interface TargetFields {
  cellId?: number;
  targetPlayerId?: string;
  stockId?: string;
  diceValue?: number;
  facility?: FacilityType;
}

/**
 * 目标合法性的唯一来源：null = 放行，字符串 = 拒绝理由。
 * 不带目标字段 ⇒ 只回答「这张卡/道具此刻是否存在任何合法目标」（门控列表用）；
 * 带目标字段 ⇒ 逐条校验（派单用）。纯计算，**不得消耗 state.rngState**（golden 决定性）。
 */
export type TargetCheck = (state: GameState, actor: Player, want: TargetFields) => string | null;

export interface TargetSet {
  cells: number[];                                  // 合法格
  rejectedCells: { id: number; reason: string }[];  // reason 原样来自 TargetCheck
  players: string[];
  rejectedPlayers: { id: string; reason: string }[];
  stocks: string[];
  facilities: FacilityType[];
  diceValues: number[];
}

export function actionTargets(state: GameState, actor: Player, want: { cardId: string }): TargetSet;
export function actionTargets(state: GameState, actor: Player, want: { itemId: string }): TargetSet;
```

实现方式 = 沿用既有的「逐候选问谓词」写法（对照 `engine.ts:2025-2034` 的 `estateBuildCells`），谓词本体挂在 def 上：

- `CardDef` / `ItemDef` 各加 `checkTarget?: TargetCheck`。
- `apply` 内的 `requireCellId` / `targetPlayer` / `anyCellId` 改为**调用同一个 `checkTarget`** 并抛出同一句话 ⇒ 「拒绝理由」与「异常文本」不可能分叉。
- `checkUseCard` / `checkUseItem` 末尾追加 `return def.checkTarget?.(state, p, action) ?? null`。
- 删除 `anyCellId()` 的「缺省取脚下」。落地时**没有**引入 `footDefault` 这个新字段：需要"任选一格"的卡（拍卖/天使/恶魔/涨价/查封）本来就把脚下当作候选之一，`cells: 'land'` / `cells: 'any'` 的候选池里就含它，不必再声明一次。真正被消灭的是"没传 `cellId` 就默认打脚下"这条静默改目标的行为 —— 现在没传就是 `'请选择目标格'`。
- `CardDef.guard`（现仅 `invite-god` 用到，`cards.ts:57`）并入 `checkTarget` 的无目标分支后删除该字段。

### 2.2 复用的现成件（不新造）

`viewportCells`(`tiles.ts:149`，= 后 7 + 当前 + 前 8 = 16 格近景窗)、`playersInViewport`(`:159`)、`streetCells`/`routeSegment`、`cellOwner`、`activePlayers`、`builtProperties`、`unownedLandCells`、`pathAhead`、`nearestGodFor`、`godSummonRefusal`、`FACILITY_ORDER`、`RESEARCH_ORDER`。

### 2.3 数据形状变更

`roadblocks: number[]` / `mines: number[]` → `obstacles: { cellId: number; ownerId: string }[]`（`types.ts:648`、`:650`）。
理由：拆除卡与机器娃娃要区分放置者，HUD tooltip 要写「谁埋的」。**不做兼容层**，测试 fixture 与 golden 基线一并重生成。
`bombs` / `npcs` / `boardGods` 现有字段够用，不动。

---

## 3. 目标口径总表（本规格的正文）

### 3.1 卡片（30 张，`shared/src/cards.ts`）

| 卡 | 候选目标 | 谓词要点 |
|---|---|---|
| 均富 / 冬眠 | 无目标 | 需存在其他存活玩家（`:461`） |
| 复仇 / 嫁祸 / 免费 / 免罪 | 无目标（auto） | 不可主动使用，由反制栈消费 |
| 均贫 / 转向 / 梦游 / 陷害 / 查税 / 乌龟 | **视野内他人**（16 格） | `playersInViewport` + 存活 |
| 抢夺 | 视野内他人 | 另需受害者有可拿物、且自己手牌/道具未满（`:408`、`:411`、`:416`） |
| 停留 | 自己 **或** 视野内他人 | 对自己免视野（`:440`） |
| 购地 | **仅脚下格** | `cellId` 必须等于 `actor.position`，否则拒绝；他人有主地；现金足（`:145-155`） |
| 改建 | **仅脚下格** | 维持 D-19「脚下有建筑」口径；`checkTarget` 里显式写明，不再靠忽略 `cellId` |
| 换地 / 换屋 | 视野内他人同类地 | 且脚下须自有地、≠脚下、同格型（`:177-187`、`:206-215`） |
| 拍卖 / 天使 / 恶魔 / 涨价 / 查封 | **任意格（显式选择）** | 涨价/查封保留 `type === 'property'` 硬门（`:90`）；天使需路段内有可加盖（`:313-320`）；恶魔需路段内有建筑（`:342-350`） |
| 怪兽 | 建筑格 | `grade ≥ 2`（`:365`） |
| 拆除 | 建筑格 **或** 地雷格 **或** 路障格 | 三源并集在同一个谓词里（`:384`、`:387`） |
| 送神 | 无目标 | 身上有附身神或定时炸弹（`:558`、`:564`） |
| 请神 | 无目标 | `godSummonRefusal`（棋盘上无神可请即拒） |
| 红卡 / 黑卡 | 股票 | `stocks` 由 TargetSet 给出（行情池现值） |
| 同盟 | 视野内他人 | 现口径见 D-18 |

### 3.2 道具（13 件，`shared/src/items.ts`）

| 道具 | 候选目标 | 谓词要点 |
|---|---|---|
| 路障 / 地雷 | **视野内路面格**（本次新增限制）+ 该格无他人停留 | 与 D-43 同口径；记 `ownerId` |
| 定时炸弹 | 无（自装）**或**视野内他人 | 目标已带炸弹则拒（`:151`） |
| 机器工人 | 自己已建成且可加盖的土地格 | 自有地 + 设施/连锁/上限判定（`:244-251`） |
| 飞弹 / 核弹 | **任意格**（射程全局，不套视野） | 3×3 / 7×7 见 D-36、D-37 |
| 传送机 | **任意格** + 可选一名视野内对手 | 目标格无玩家停留（`:293`） |
| 机器娃娃 | 无目标 | 前方 9 步内无可清物则拒（D-32 收窄后口径） |
| 机车 / 汽车 | 无目标 | 同种载具重复使用拒绝；换装归还旧槽（D-33） |
| 工程车 | 无目标 | 已在开则拒（`:323`）；18 步/7 天双限（D-45） |
| 时光机 | 无目标 | 无 `lastRoundSnapshot` 则拒 |
| 遥控骰子 | 骰点 1~6 | `diceValues` 由 TargetSet 给出 |

### 3.3 触发语义（选目标时必须讲清楚）

| 实体 | 生效条件 | 代码 |
|---|---|---|
| 路障 | **经过即截停**（消耗掉） | `engine.ts:2259-2264` |
| 地雷 | **经过即踩中**，住院 3 天 | `:2265-2270`、`:2321-2327` |
| 驻留神明 | **经过即附身**，排在三类截停型之后 | `:2277-2280`、`:2369-2378` |
| 定时炸弹 | 挂身后按步计数 38 步 | `:2309-2319` |
| 恶犬 / 宝箱 / 乞丐 | **只认踩中那一格**，路过不算 | `:2331-2341`、`:2354-2359`、`:2291-2300` |
| 四大恶人 | 日切行动，与落脚无关 | `:1386-1460` |

---

## 4. 客户端交互

### 4.1 选目标状态机

```
idle ──点「使用」(需目标)──▶ picking(kind,id,TargetSet) ──点合法格──▶ 组装完整 action ──▶ dispatch ──▶ idle
 │                                │
 │                                ├─ 点非法格 ─▶ toast(reason)，留在 picking
 │                                ├─ Esc / 再点「使用」─▶ 取消，setPickTargets(null) ─▶ idle
 └─ 点「使用」(候选集为空) ─▶ 直接 toast 门控理由，不进入 picking
```

要点：

1. 需要目标的卡/道具，点「使用」**不派单**，先把 TargetSet 推给 HUD（`AC_HUD.setPickTargets(ts)`）。候选集为空 ⇒ 当场给出拒绝理由，不进选态 —— 这条同时修掉病灶 #3/#8。
2. 合法格高亮复用现成的 ring 实例池（`world.js:913-930`），非法格不加特效，hover 时把 `rejectedCells.reason` 走现成 tooltip（`hud.js:387-396`）。
3. 拾取链路**已经存在**，只缺回传：`pick()`(`world.js:1072-1078`) → `hooks.onSelect`(`:1129-1138`)。新增 host 回调 `onPickCell(cellId)`（`AcHostApi`，`AcHudLayer.tsx:27-37`，配套 `setHost` 推送点 `:312-321`）。
4. 相机与视野**解耦**：合法性永远来自引擎那 16 格近景窗，与 `iso` / `top` 相机模式无关；`top` 全盘俯视时视窗外格子淡 30% 并禁点，避免玩家以为俯视就能全局点。
5. 纯棋盘点选（已定案）：删除面板 `<select>` 与 `CARD_REQUIRES_CELL` / `ITEM_REQUIRES_CELL` 硬编码集合；键盘通路用 `world.js` 已有的方向键换格（在 `locked` 闸门 `:1108-1110` 之内），不保留列表兜底。
6. 目标类型覆盖：格（地块/路面/障碍格）、棋子（玩家 token，用于丢炸弹、传送带人）、股票与骰点走面板内小选择器（不在棋盘上）。

### 4.2 快照协议要补的字段

`client/src/game/acSnapshot.ts` 的 `AcSnapshot.view`（接口 `:28-72`，构造 `:107-131`）现只带 owners / gods / treasure / layout / actions，须补：障碍（含 `ownerId`）、`bombs`、`npcs`（位置 + kind + ownerId）、每玩家 `properties` / `cards` / `items` 摘要。服务端继续只推 `game + availableActions`（`server/src/rooms/GameRoom.ts:304`、`:128`），候选集由**客户端本地用同一个 `actionTargets` 算**（同源，不新增协议字段）。

### 4.3 文案模板

- 放置确认条：`在「{格名}」{放置物}：{生效说明}`，生效说明取自 §3.3 三类之一（经过截停 / 踩中生效 / 停在才算）。
- 非法理由直接用引擎原句，不另编一套 UI 措辞（同源的另一半）。
- 视野类拒绝统一为「{对象} 不在视野内」，与 D-43 落地时已有的引擎文案保持一致。

---

## 5. 波次与验收

| 波 | 内容 | 主要文件 | 验收 |
|---|---|---|---|
| W1 引擎 | `targets.ts` + 逐卡逐道具 `checkTarget` 下沉 + gate 级目标校验 + 删 `anyCellId` 脚下缺省（改 `footDefault` 显式）+ 障碍带 `ownerId` + 路障/地雷上视野 | `shared/src/{targets,cards,items,engine,types,cell_handlers}.ts` | 新属性测试：**TargetSet 成员派单必被放行，非成员必被拒且给出理由**；`action_registry.test.ts:59-61` 的 `executable` 升级为 true；`pnpm test`（现 608 项）全绿；golden 按 `golden.test.ts` 「重录历史」体例重录并写明原因 |
| W2 桥接 | `AcHostApi` +`onPickCell`/`setPickTargets`、`pendingTarget` 状态机、快照补实体、`HandPanel` 重构 | `client/src/ui/{AcHudLayer,HandPanel}.tsx`、`client/src/game/acSnapshot.ts`、`client/public/ac-hud/hud.js` | Docker 全栈 + 逐卡通清单：每张需目标的卡都能棋盘点选、Esc 取消不消耗、非法格出理由、定时炸弹/传送机带人恢复可达 |
| W3 HUD 视觉 | 高亮池、非法格淡出、hover 理由、触发图例（截停=手掌 / 踩中=脚印 / 停在=图钉）、玩家 token 可点 | `client/public/ac-hud/{world.js,hud.js,ac.css}` | 浏览器实测 `iso` 与 `top` 各一遍；表现层按项目惯例用截图或 40ms 采样取证，不接受"看起来对" |
| W4 收尾 | 删 `CardDef.target` / `ItemDef.target` / `ItemDef.phase` / `CardDef.guard`；决策表补 D-47 | `shared/src/{cards,items,types}.ts`、`docs/玩法拆解_卡片对账决策表.md` | 全量 vitest + `pnpm -r typecheck` |

### 验证纪律

1. `pnpm -r typecheck` 三包干净；`pnpm test` 全绿。
2. `pnpm docker:up` 起全套（db/redis/server/client）后在浏览器实测 —— 宿主 dev 会跑旧规则，不作数。
3. 逐 id 手动清单（30 卡 + 13 道具）：候选集正确 / 点非法格给理由且不退出选态 / Esc 取消不消耗 / 脚下类卡不再被静默改目标。
4. 反向不变式：绕开 UI 直接 dispatch 一个非法 target 的动作，引擎应返回**拒绝消息**，而不是半途生效或抛未捕获异常。

### 5.1 W1 落地记录（2026-10-13）

`pnpm -r typecheck` 三包干净，`pnpm test` **615 项全绿（28 个文件）**。

| 项 | 实际落地 |
|---|---|
| 同源谓词 | `shared/src/targets.ts`：`TargetFields` / `TargetCheck` / `TargetSpec` / `TargetSet` / `actionTargets`，积木件 `needPlayer` / `needCell` / `footOnly` / `ownerOfCell` / `streetOf` / `viewCells` / `standBeforeCell` |
| 卡片 | 30 张全部挂上 `targetSpec`；`apply` 里的目标校验全部搬出（`checkBuyLand` / `checkSwap` / `checkRebuild` / `checkStreet` / `checkAuction` / `checkStreetLand` / `checkMonster` / `checkDemolish` / `checkSnatch` / `checkStock` / `checkHold` / `checkSendGod` / `needsOtherPlayers`） |
| 道具 | 13 件全部挂上 `targetSpec`（`obstacleCheck` / `checkRobotDoll` / `vehicleCheck` / `checkTimeBomb` / `checkTeleporter` / `checkRobotWorker` / `checkBulldozer` / `checkTimeMachine` / `checkRemoteDice`） |
| 门控 | `checkUseCard` / `checkUseItem` 末尾跑 `targetSpec.check` ⇒ 非法目标在**派单前**就被拒并带理由，`assertLegal` 与 `targetCell()` / `targetPlayer()` 共用同一句话 |
| `guard` 字段 | 删除：`invite-god` 的棋盘前提并入 `targetSpec.check`（`CardDef.guard` 字段已不存在） |
| 障碍数据 | `roadblocks` / `mines` → `Obstacle[] = { cellId, ownerId }[]`；移动循环、拆除卡、机器娃娃、路障/地雷放置、HUD 候选列表与测试 fixture 全部改到新形状 |
| 路障 / 地雷视野 | 按定案实现（`cells: 'view'` = 近景窗 16 格），拒绝理由单列为「『某格』不在视野内」，供 UI 灰显 |
| 新增测试 | `shared/test/targets.test.ts`：30 卡 + 13 道具逐个核对「候选必放行、被拒必同句理由」，另钉住「必须显式给目标」「脚下类拒远程」「拆除卡并集障碍格」「窗外对手进 `rejectedPlayers` 而不是凭空消失」 |
| 门控测试升级 | `action_registry.test.ts` 的 `push(..., false)` 两条改为从 `actionTargets` 取真实候选凑参数 ⇒ `executable` 第一次是真的，`applyAction` 真的被执行 |

三条与原计划不同的实测结论（如实记着）：

1. **golden 基线没有变**。原以为"目标拒绝时机前移"会重录，实际两条轨迹逐位一致 —— 因为 `bot.ts` 从不使用带目标的卡/道具（只用 `send-god`，`bot.ts:110`），而 `send-god` 没有目标参数。这条同时说明：**门控收紧目前不会影响 bot 对跑**，但 W1 之后 `usableCards` 变严了（没有合法目标的卡不再被列进可用手牌），bot 一旦学会用带目标的卡就必须走 `actionTargets` 取候选，否则会重演历史上"被吞错误刷活整局"那类活锁。
2. **候选枚举要刻意比裁决宽一档**：`probePlayers` 枚举所有存活玩家（裁决仍由 `needPlayer` 管视野），否则窗外对手根本不会出现在结果里，UI 只知道"没这个人"而拿不到「不在视野内」这句灰显文案。
3. 中途我曾以"埋雷不该受近景限制 + 用例会变脆"为理由把路障/地雷改回全局可选 —— 那与你的定案和 help [88][95] 都相反，已改回；用例变脆的问题用测试辅助 `cellAheadOfActor`（`test/helpers/state.ts`）解决，规则迁就用例是反的。

---

### 5.2 W2 落地记录（2026-10-13，Docker 全栈 + 浏览器实测）

`pnpm -r typecheck` 三包干净、`pnpm test` 615 项全绿；界面侧走 `docker compose up -d --build` 后在浏览器里逐步验过。

| 项 | 实际落地 |
|---|---|
| 快照补实体 | `acSnapshot.view.entities`（新类型 `AcEntities`）：障碍（带 `ownerId` + 放置者名）、挂身炸弹（携带者位置 + 剩余步）、特殊单位（`NPC_NAMES` 新出在 `shared/src/npc.ts`，与四大恶人同表补上恶犬）、乞丐（`bankrupt && !beggarGone`）。口径只有一份，`hud.js` 不必再自己扒 `GameState` |
| 选格通路 | `AcHostApi` 新增 `onPickCell`、`AC_HUD.setPickTargets()`；`hud.js` 在选格态把 `hooks.onSelect` 改走回传（不再动 `selCell` 详情卡）；舞台切 `.d25-stage--pick` 手型 |
| 状态机 | `AcHudLayer` 持 `pick` + `pickHint`：发起时收起弹层（弹层带遮罩，不收起就"看得见点不到"）、点非法格**留在选态**并把引擎原句挂在横幅上、Esc / 取消按钮退出、回合或换人自动作废 |
| 面板 | `HandPanel` 重写：候选全部来自 `actionTargets`，裸数字 `<select>` 与 `CARD/ITEM_REQUIRES_CELL` 硬编码集合删除；格改成棋盘点选（按钮文案「使用 · 选格」），对手改成行内胶囊（视野外的灰着并带引擎理由），股票 / 设施 / 骰点仍走小选择器 |

**浏览器里抓到两个真问题，都已修**（这两条单测看不见，只有真点才知道）：

1. **门控被当成派单问，dock 把路障 / 地雷一律标成「此刻不可用」**。`availableActions` 问的是「这张卡此刻有没有得用」（不带目标），而 W1 的谓词把"没带目标"直接判成 `请选择目标格`。修法不是给 dock 开后门，而是把契约写清：`targets.ts:targetRefusal()` 分两种问法 —— 没带目标 = 问**有没有得选**（拿候选枚举答，空集才不可用，并给出「此刻没有可选的目标格」这类列表专用措辞），带了目标 = 逐条校验。修好后 dock 变「路障，此刻可用」，而机器娃娃仍正确显示不可用（前方 9 步确实没东西）。
2. **可选目标被必填的预选吃掉**。定时炸弹的语义是「自装 or 丢给视野内对手」，而"唯一候选就预选"让它只剩后者：点「使用」直接把炸弹塞给了对手。现在按引擎的回答分岔 —— 不带目标也合法的动作（定时炸弹 / 传送机）默认空着并摆出「自己」这颗胶囊，必填的那几张（均贫 / 陷害…）才允许唯一候选预选。

**实测过的路径**（选格态截图：`docs/extraction/w2_board_pick.png`）：

- 路障：dock 开面板 →「使用 · 选格」→ 横幅出现、舞台进选态 → 点视野外的 26 号「监狱」→ 横幅追加引擎原句「「监狱」不在视野内」且**仍在选态** → Esc 取消、道具没被消耗 → 再进选态点视野内一格 → 放置成功、道具消耗、退出选态 ✅
- 地雷：同一条路再走一遍 ✅
- 定时炸弹：胶囊 `[自己●, 小美]`，点「使用」→ 自装、不进选态、正常消耗 ✅
- 遥控骰子：骰点下拉 1~6 ✅；机器工人：无自有地 → dock「此刻不可用」✅
- `availableActions` 多走一遍候选枚举的代价：**≈0.13 ms/次**（四人局、手上 3 件道具），按快照节奏完全吃得下

**W2 明确没做、留给 W3**：合法格高亮 / 非法格淡出（`setPickTargets` 已把 `cells` 送到 HUD，只差消费）、悬停出理由的 tooltip、障碍 / 炸弹 / 乞丐的**实体上屏**（现在棋盘上看不见自己埋的东西）、玩家 token 作为可点目标（丢炸弹与传送带人目前仍只能在面板胶囊里选）、`?board=flat` 方环模式没有拾取通路（该模式本是 WebGL 不可用时的兜底）。

### 5.3 W3 落地记录（2026-10-13，Docker 全栈 + 浏览器实测）

三包 typecheck 干净、`shared` 615 项全绿（W3 没动规则层，只在表现层与 `HandPanel` 补了一次全图问询）。

| 项 | 实际落地 |
|---|---|
| W3-a 高亮 / 淡出 | `world.js:setPickHighlight()` —— 合法格套一圈 `InstancedMesh` 绿环（一次 draw call，64 个 mesh 的教训本文件已记过），其余格面**连同格面贴花**一起压暗到 0.55；还原一律走绝对赋值（`userData.baseHex` / `setScalar(1)`），不做"暗色上再乘一次" |
| W3-b 悬停依据 | `hud.js:showTip()` 在选态追加一句：可选 → `✅ 可选为目标`；不可选 → **引擎原句**。为此 `HandPanel` 进选态时补一次 `cellRefusals()`（全图 64 格纯校验，不消耗随机数） |
| W3-c 实体上屏 | `world.js:syncEntities()`：障碍 / 挂身炸弹 / 恶人 / 乞丐画成朝相机的圆盘 sprite，纹理按 `图标+副标+主人色` 缓存；圆盘描边 = 放置者 / 携带者色，与地皮台座同一套语言；同格多实体走固定偏移散开。`hud.js` 图例补三条触发口径（🚧 经过截停 / 💥 踩中才炸 / 💣 挂身倒数 / 🥣 站上才施舍） |
| W3-d 点棋子选人 | `world.js:setPickPlayers()` 给候选玩家脚下套同款绿环（环挂在 token 组上，棋子移动自然跟随）+ `pickPlayer()` 优先按棋子命中；`hooks.onPickPlayer` → `AcHudLayer` 拿同一个 `actionRefusal` 判定并派单；`HandPanel` 在玩家目标行加「🎯 点棋子」，**与芯片读同一份 `actionTargets`**，不是第二套候选 |

**实测到的量（全部走 `gl.readPixels` 回读棋盘 canvas，不靠看截图）**

- 淡出：16 个合法格亮度比 **1.06 ~ 1.42**（>1 是绿环本身落在采样环上），31 个可见非法格 **0.76 ~ 0.77**，两组**无交叠（间隙 0.32）**。加贴花之前非法格是 `0.76~1.00` 的双峰 —— 奶油色描字与价签是不吃光照的 basic 材质，只压格身时它们照旧亮着，"淡出"在视觉上等于没做；这条是量出来的，不是猜的。
- 不累积：连续进 / 出选态 3 轮后关高亮，两帧像素 **逐字节相同（changedPixels=0, maxDelta=0）**。
- 绿环取色：合法格采样点 RGB ≈ `121~141, 211, 123~135`，对得上 `0x7fe07a`；非法格同位置无绿（G < R）。
- 悬停：视野内 24 号 → `…每级租金 🔔165 ✅ 可选为目标`；视野外 11 号 → `…「机会」不在视野内`、30 号 → `…「陆家嘴」不在视野内`（改前只有「不可选」）。路障请求实测 `cells=16, rejected=48`。
- 实体：开局 `entityAnchors()=0` → 棋盘点一格放路障后 `[{cellId:24,emoji:'🚧'}]` → 再放地雷后 `[24🚧, 16💥]`，且岛况面板芯片同步 `🚧 路障 1 个 / 💥 地雷 1 个`。合成注入 5 个实体（含同格三件）出 5 个圆盘、偏移与高度各不相同（地面 0.87 / 恶人 1.20 / 挂身炸弹 2.70），**狱中恶人按 `jailed` 正确不上屏**。
- 选人：四人局里 阿福@6、小美@10（视野内）、大宝 / 金宝在窗外。绿像素只出现在小美脚下（16 个采样点里 4 个命中环色），其余三人 0 —— 环集 = 候选集，没有多画。点小美的棋子 → 派单成功、炸弹上屏 `💣 剩38 @格10`、选态自动退出、`pickState().rings=0`。

**顺手抓到的两个隐患**

1. `buildWorld()` 重置了 `tileMeshes / decalByCell / tokenGroups / focusRing / treasureMesh`，却**没重置 `pickOverlay`**：换局重挂载后绿环会被加进上一个已经被丢弃的 scene，表现为「进了选格态却什么都看不见」。现与选人环、`pickIds` 一起归零。
2. `PickRequest.rejected` 原本直接取 `set.rejectedCells`，而候选池 `view` 只搜视野 16 格 —— 窗外的格**从没被问过**，于是 HUD 只能说「不可选」。改为进选态那一刻逐格问一次引擎，措辞仍出自同一个谓词。

**验证方法的坑（下次别再踩）**：自动化页面处于后台 → `document.visibilityState='hidden'` → rAF 被冻结 → 相机入场补间永远走不到 settle → `world.js` 的 `if (locked) return` 把所有棋盘指针吞掉，同时 `take_screenshot` 直接报 `NATIVE_BROWSER_VIEWPORT_UNAVAILABLE`。解法是页内调 `D25World.renderOnce(dt)`（这个入口本来就是为后台标签页准备的）手动把补间推完再量；所有 W3 证据因此走像素回读与场景图访问器（`pickState` / `entityAnchors` / `tokenAnchors`），比肉眼看图更硬。

**W3 没做、留给 W4 或后续**：`CardDef.target` / `ItemDef.target` / `ItemDef.phase` / `CardDef.guard` 四组死字段删除 + 决策表补 D-47；键盘方向键在候选间循环（现只有鼠标通路）；`?board=flat` 方环兜底无拾取通路；bot 仍不消费 `actionTargets`。

### 5.4 W4 落地记录（2026-10-13，声明收口）

删掉的是**同一件事的第二份声明**，不是规则本身。清点结果（每条都 grep 过读方，证据在下面）：

| 字段 | 读方 | 处置 |
|---|---|---|
| `CardDef.target`（`CardTarget`） | **无**（`e.target` 那些全是 DOM） | 删字段 + 删类型 |
| `ItemDef.target`（`ItemTarget`） | **无** | 删字段 + 删类型 |
| `ItemDef.phase` | **无** —— 道具时机实际由 `engine.ts:3672` 那句硬判断给（`state.phase !== 'awaiting_roll'`），字段写 `'any'` / `'pre_roll'` 都不影响行为 | 删字段 + 去掉 `items.ts` 对 `CardPhase` 的 import |
| `CardDef.needsStock` | **无**（红卡 / 黑卡实际由 `targetSpec.stocks` 驱动候选与派单） | 删字段 |
| `ItemDef.needsDiceValue` | **无**（遥控骰子实际走 `targetSpec.dice`） | 删字段 |
| `CardDef.phase`（`CardPhase`） | **有**：`engine.ts:3628-3629` 用它分掷骰前 / 掷骰后，`targets.test.ts:47` 用它摆相位 | **保留**；取值从三档收成 `'any' \| 'post_roll'`（`pre_roll` 与 `any` 在 R4 之后走同一分支，留两个名字只会让人以为有区别） |
| `CardDef.guard` | 已在 W1 并入 `targetSpec` | 无字段可删，只在 `cards.ts` 留了一句"为什么这里没有 guard"的注释 |

规则没丢：道具「一律掷骰前」与卡片两档时机现在各只有一处判断（`checkUseItem` / `checkUseCard`），并补了两条回归用例钉住 ——
13 件道具在 `awaiting_action` 里都被同一句「道具只能在掷骰前使用」挡下；每一张手动卡在其错位相位上必被引擎点名（`该卡片只能在掷骰前/后使用`），且 `phase` 的取值只能是那两档。

验证：shared **617 项全绿**（615 + 2 条新用例），`shared` / `client` / `server` 三包 typecheck 干净；**golden 基线未动** ⇒ 这一波确实是纯声明收口，没有夹带行为变化。决策表补 **D-47**（`docs/玩法拆解_卡片对账决策表.md` §十）。

顺手把「为什么这一行灰着」也收进同一句原话：`HandPanel` 原先在 `!listed` 时把 tooltip 退回成卡片描述（玩家看得见"是什么"却不知道"为什么现在不能用"）。现在按 `!listed → 引擎那句 / !interactive → 还没轮到你 / needBoard → 点「使用」后在棋盘上点一格` 分岔。掷骰后在浏览器里实测 6 件道具的 tooltip 全部变成 **「道具只能在掷骰前使用」** —— 字段删了，规则在界面上反而更看得见。

顺带把决策表里那条批次1.5 遗留（「`HandPanel` 使用道具没有传 `targetPlayerId` 的入口」）改成已关闭 —— W2 的玩家胶囊 + W3-d 的棋子点选已经把这条路接通。

## 6. 已定案（决策人 2026-10-13）

| 项 | 结论 |
|---|---|
| 交付范围 | W1→W4 全做 |
| 路障 / 地雷 | 上「视野内 16 格」限制（与 D-43 一致；help [88][95] 亦明写「視窗範圍內」） |
| 面板列表选择器 | **删除**，纯棋盘点选（键盘走方向键换格） |
| `ItemDef.phase` | **删除字段**，维持「道具一律掷骰前用」这一条硬规则 |
| 飞弹 / 核弹 / 传送机 | 保持全局射程，不套视野 |
| 改建卡 | 维持脚下格 + 脚下有建筑（D-19） |

## 7. 风险与留待后续

- **golden 基线会重录**：目标拒绝时机从 `apply` 中途前移到 `assertLegal`，属行为修正而非重构；W1 的纯搬迁部分应逐帧一致，不一致即说明混进了真规则变化，要拆开查。
- **Bot 行为**：`shared/src/bot.ts` 目前只用送神卡（`:110`），不受目标校验影响；但 W1 之后 bot 若学会用玩家目标卡，必须走同一个 `actionTargets` 取候选，否则会被新门控拒成被吞错误（历史上这类被吞错误造成过整局活锁，见 `golden.test.ts` W2/W3 条）。
- **无障碍**：纯棋盘点选砍掉列表后，键盘通路依赖 `world.js` 的方向键换格实现程度；若实测不顺，W3 需补一个"候选序列 Tab 切换"的最小通路。
- **载具速度**：`diceCount` 同时兼任"骰子数/载具身份"，工程车「速度 1」与步行同值表达不出来 —— 另开会话，不在本规格内。
