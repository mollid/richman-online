# 《大富翁 Online》角色立绘出图提示词（10 人 · v6 高清像素热带海岛风）

> 版本 v2 ｜ 日期 2026-10-15 ｜ 对象：`shared/src/characters.ts` 的 10 名角色（波 3 已进引擎）
> 风格依据：`大富翁Online-美术风格提案.md` §v6.1 风格锚点（已冻结方向）+ 已定稿的 `char_player_a~d@v6` 四张基准棋子的实测语法
> v2 = 首批回图（§11）之后按实测改的：朝向尾句、撞键色改写、头身硬顶、锚点段压回平涂
> 状态：**提示词可直接粘贴出图**；首批 3 张朝左需重出、2 张撞键需重出或永久走外部抠图，其余 5 张可用

---

## 0. 一分钟结论

| 项 | 值 |
|---|---|
| 画风 | v6 高清像素热带海岛 Q 版（不是 v3 纯平涂纸片、不是 ac- 动物森友会皮肤、不是 w98-pixel 桌面壳） |
| 每人 | 一张全身棋子像，1024×1024 出图 → 抠图缩到 256×256 透明底，棋盘显示高 ≈32px |
| 同族底线 | 只有 5 条是硬的：全身完整可见 + 底部居中不画阴影、**面向观众右侧**（接近正面可以，朝左作废）、2~3 头身且不超过 3、纯品红底单人、标志物落在画面右半部。朝向另有一条 §3.2 尾句钉在提示词最末尾 |
| 刻意放开 | 服装件数与款式、体型胖瘦宽窄、姿态动作幅度、表情、配饰数量、标志物的大小与**拿法**（握/扛/抱/挎/挂/夹/顶/含都可以）、配色深浅 |
| 个体区分 | **主色 + 头饰/发型 + 标志物**三样，其中标志物不再要求「右手平举」——10 个人做同一个动作反而最像复制粘贴 |
| 张数/额度 | 10 张，一次过 ≈ 50–100 生成额度（按提案 49 张 ≈ 250–500 折算）；同一提示词重试上限 3 次 |
| 首批回图 | 10 张身份全对、无文字泄漏、体量达标；**但 3 张整身朝左（小美/白小鹿/冷秋萍）、胡三思紫袍 8.44% 与苏媒婆玫红衫 2.60% 的像素满足项目抠图规则会被打穿** → §11 有逐项数字 |
| 已知坑 | 引擎色 `#AB47BC`（胡三思）与 `#EC407A`（苏媒婆）与品红底同族。**只压暗没用**（回图实测压暗后仍命中），必须抬绿色分量 → 见 §6 |

---

## 1. 风格来源与已定稿家族语法

现有 4 张已定稿棋子（`assets/art/final/char_player_{a,b,c,d}@v6.png`）实测出的语法。**注意：实测到的一致 ≠ 要写进提示词当规矩**——下表右侧标出本档把哪些留成硬约束、哪些明确放开，避免把「凑巧都长这样」锁成模板。

| 观察项 | 实测结果 | 本档处置 |
|---|---|---|
| 质感 | 高清像素颗粒 + 色阶抖动过渡，哑光，无渐变无光晕 | **留硬**（这是画风本体，松了就换风格了） |
| 描边 | 统一深棕中粗描边，色块分界与外轮廓同一语言 | **留硬** |
| 朝向 | 正面 3/4、身体与脸朝右 | **留硬，但放宽到「朝右或接近正面」**——只禁朝左，因为左向靠 `scale.x=-1` 镜像得到 |
| 头身比 | 约 2.5 头身，头占整体高约 45%，大眼简化五官、脸颊腮红 | **放宽到 2~3 头身自选**，少年更小更 Q、长者稍修长 |
| 手持物 | 右手向前平举一枚**放大的金币**，左手叉腰 | **只留「有一件轮廓可辨的标志物」**，姿势与位置全交给模型 |
| 服装 | 白衬衫 + 主色马甲/上衣 + 深棕长裤 + 深棕鞋 | **不写进提示词**，只当参考气质；10 人各按身份穿，允许不穿衬衫 |
| 构图高度 | 主体高约占画布 80% | **删掉**——`keyout` 本来就会紧裁切再居中补方，写死反而逼模型把所有人都画成一个体量。但放开姿势有个可量化的代价：`keyout` 按**最长边**缩到 256，所以横向摊得越开、补方后人就越矮，而棋盘按固定高度缩放贴图（`BoardRenderer.ts:359` `heightPx / tex.height`）。判据见 §7 第 3 条 |

**为什么把「金币」换成各自的标志物**：金币已有独立资产 `icon_coin@v6_src.png`，10 个人人手一枚金币在棋盘上等于 10 个相同剪影，个体识别度归零。所以「举一枚放大物件」这个**可读性思路**保留，但物件换成角色身份物、怎么拿完全放开。

---

## 2. 共用风格锚点段（每次生成整段复制，禁止凭记忆重写）

### 2.1 中文版锚点（给即梦等中文模型，一律用这版）

```
高清像素艺术风格的热带海岛Q版游戏角色，细腻密集的像素颗粒与色阶抖动过渡，不是低分辨率粗像素；造型卡通Q版、圆润柔和；色块之间一律硬边过渡，每个色相最多两阶（一个亮面、一个暗面），不做柔光、不做高光反射、不做材质渐变；装饰细节克制，纽扣与花纹点到为止，不堆珠宝蕾丝刺绣；整体平光，无方向投影；统一深棕色中粗描边，描边干净、承担轮廓与色块分界；哑光像素贴图，无光晕、无外发光、无噪点纹理；Q版纸片人式比例，头大、五官简化、脸颊腮红；明亮饱和但色数收敛的热带岛屿配色；不写实解剖、不厚涂；纯品红色背景，只作色键用，背景上不得有其他元素、渐变、投影或杂色；主体完整可见、居中、四周留白约10%；脚下不画阴影；无文字、无字母、无数字、无标点、无水印、无签名、无商标；边缘干净无半透明像素。
```

### 2.2 英文版锚点

```
Hi-res pixel art tropical-island chibi game character, fine dense pixel grain with dithered step transitions (not chunky low-resolution pixels); cute rounded cartoon silhouette; every color boundary is a hard edge, at most two values per hue (one lit, one shadow) - no soft lighting, no specular highlights, no material gradients; restrained ornamentation, buttons and patterns kept minimal, no piled-up jewelry, lace or embroidery; flat lighting, no directional cast shadow; uniform medium-thick dark-brown outline on every contour and color-block boundary, clean; matte pixel texture, no glow, no bloom, no noise texture; chibi paper-doll proportions with an oversized head, simplified features and blushing cheeks; bright saturated tropical island palette with a restrained color count; no realistic anatomy, no painterly rendering; pure magenta background used only as a chroma key, nothing else on it, no gradient, no shadow, no speckles; whole subject visible, centered, about 10% margin around it; no shadow baked under the feet; no text, no letters, no digits, no punctuation, no watermark, no signature, no logo; clean edges with no semi-transparent pixels.
```

> **与提案 §v6.1 锚点的两处有意差异**：① 提示词正文里**不写字面色码**（`#4A3222`、`#FF00FF` 这类）——踩过一次，模型会把色码当成要渲染的文本抄进画面，精确色值只放在给人看的 §4/§6 表里，出图靠色名。② 锚点里**去掉了「正面 3/4 朝右」「约 2.5 头身」「主体高占画布 80%」三项**，它们属于构图与体量锁，改由 §3 的底线负责（朝向只禁朝左、头身给 2~3 区间、高度不锁）。画风本体（像素颗粒、两阶明暗、深棕描边、哑光、热带配色、品红底）一项没松。

---

## 3. 同族底线（只有这 5 条是硬的）+ 刻意放开的部分

```
同族底线（其余全部由你自由发挥）：
1. 全身完整可见，站姿稳定、重心落在两脚之间，主体底部居中，脚下不画阴影——棋盘要把棋子对齐到格心并做上下浮动；
2. 朝向是这批最容易翻车的一条：整位角色面向观众视角的右侧，鼻尖、肩线、脚尖都指向画面右边，画面左半边留给背影与飘起的衣摆；接近正面也可以，但绝不能朝左——游戏靠水平镜像得到左向，朝左版镜像后道具会换到另一只手、与其他角色不对称，直接作废；
3. 头身比在2到3头身之间自选，不超过3头身，头大、五官简化、脸颊有腮红；少年可以更小更Q，长者靠皱纹与体态显老、不靠拉长身体，不必与其他人等高；
4. 画面里只有这一位角色，纯品红底，不要场景、不要地台、不要第二个人；
5. 他身上有一件「一眼认出他是谁」的标志物，握在手里、扛在肩上、抱在怀中、挎在臂弯、挂在腰间、顶在头上、夹在腋下、含在嘴里都可以，但**它必须落在画面右半部**（由靠近观众的这只手托住），不要举到身体另一侧去；缩得很小之后那件东西的轮廓还要认得出来。
放开：服装件数与款式（不必穿衬衫、不必穿长裤，制服、长衫、围裙、套裙、背心、披肩、罩衫都可以）、体型胖瘦宽窄、动作幅度与表情、配饰多寡、标志物的大小与拿法、配色深浅（只保留「一个主色加深棕描边」这一条）。
原创角色，不得模仿《大富翁》系列任何原版角色、建筑或界面形象，不得模仿其他现有游戏的美术。
```

### 3.1 英文版同族底线（英文出图时与 §2.2 锚点段拼在一起）

```
Family floor (only these are hard; everything else is yours to decide):
1. whole body visible, stable standing pose with weight between both feet, subject bottom centered, no shadow baked under the feet - the board aligns tokens to tile centers and floats them;
2. orientation is where this batch failed last time: the whole character faces the viewer's right - nose tip, shoulder line and toes all point to the right side of the frame, leaving the left half for the back of the body and trailing cloth; nearly frontal is fine, facing left is not - the leftward view is produced in-engine by a horizontal flip, and a left-facing source would flip the prop onto the wrong hand;
3. pick any proportion between 2 and 3 heads tall, never above 3, oversized head, simplified features, blushing cheeks; a teenager may be smaller and chubbier, an elder reads old through wrinkles and posture rather than a longer body - they do not have to be the same height;
4. this character alone on a pure magenta field, no scenery, no floor plate, no second person;
5. he or she carries one signature object that says who it is - held, shouldered, hugged, hooked over an arm, hanging at the waist, balanced on the head, tucked under an arm or in the mouth - but it must sit in the right half of the frame, supported by the hand nearer the viewer, and its outline must still read when shrunk very small.
Wide open: garment count and type, body width and weight, gesture and expression, jewelry, the size and grip of the signature object, color depth (keep only "one signature color plus a dark-brown outline").
Original character: must not imitate any character, building or interface from the Richman board-game series, and must not imitate the art of any existing game.
```

### 3.2 朝向尾句（**每条提示词的最后再抄一遍这个**）

第 2 条写在中间被无视了——上一批 10 张里 3 张整身朝左。这条单独放到最末尾，利用尾位权重，别合并进主体段。

```
最后确认朝向：这位角色面向观众视角的右侧，鼻尖、肩线、脚尖全部指向画面右边，标志物在画面右半部，画面左侧是身体背面。不得朝左。
```

EN: `Final orientation check: the character faces the viewer's right - nose tip, shoulder line and toes all point to the right edge of the frame, the signature object sits in the right half, the left side of the frame shows the back of the body. Never facing left.`

---

## 4. 十人对照表（给人看，含引擎色值）

`引擎色` = `shared/src/characters.ts` 的 `color` 字段，用于名牌与棋子光晕 tint，**不一定要等于服装色**（差异见 §6）。表中「头饰/发型」「主服装」「标志物」是**人设参考**，不是硬要求——模型把马褂换成短褂、把团扇换成药秤，只要还认得出这位是谁、且主色与标志物对得上，就不算偏离。`剪影特征`那一列才是 32px 下真正干活的东西。

| # | id | 姓名 | 性别 | 年龄 | 引擎色 | 色名 | 头饰/发型 | 主服装 | 标志物（怎么拿交给模型） | 剪影特征 |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `afu` | 阿福 | 男 | 17 | `#EF5350` | 珊瑚红 | 黑短发翘一撮 + 红头巾 | 珊瑚红无袖短打工装背心 | 鼓鼓的红色平安符布袋 | 头巾飘结 + 咧嘴虎牙 |
| 2 | `xiaomei` | 小美 | 女 | 24 | `#42A5F5` | 天蓝 | 深棕低马尾 + 天蓝贝雷帽 | 天蓝收腰背心裙 + 小领结 | 放大优惠券票券（半圆缺口边） | 贝雷帽斜 + 裙摆 |
| 3 | `tiexiong` | 铁雄 | 男 | 29 | `#66BB6A` | 草绿 | 黑平头 + 草绿大檐帽（金盾徽） | 草绿保安制服（金肩章、宽腰带） | 放大金色哨子（带挂绳） | 帽檐宽 + 体格最宽 |
| 4 | `baixiaolu` | 白小鹿 | 女 | 19 | `#D4E157` | 柠黄绿 | 浅棕双马尾 + 反戴棒球帽 | 柠黄绿多口袋快递马甲 | 小纸箱包裹（十字胶带） | 双马尾外甩 + 背后大包 |
| 5 | `husansi` | 胡三思 | 男 | 41 | `#AB47BC` | 藕紫（引擎紫撞键，见 §6） | 黑瓜皮小帽 + 八字胡短须 | 藕紫绸缎对襟马褂 + 米白长衫 | 放大木算盘（三档金珠） | 小帽圆 + 算盘方 |
| 6 | `huadasao` | 花大嫂 | 女 | 37 | `#FFA726` | 暖橙 | 黑发低髻 + 橙绢花金簪 + 金环耳饰 | 暖橙对襟碎花上衣 + 深棕围裙 | 鼓鼓的橙色布钱袋 | 发髻大 + 体态丰腴 |
| 7 | `jiabanxian` | 贾半仙 | 男 | 53 | `#26C6DA` | 松石青 | 混元道帽 + 齐腰灰白长须 | 松石青宽袖长道袍（斜襟、波纹摆） | 八角八卦镜（阴阳鱼，纯图形） | 长须垂地 + 宽袖 |
| 8 | `sumopo` | 苏媒婆 | 女 | 48 | `#EC407A` | 豆沙砖玫（引擎玫红撞键，见 §6） | 高发髻 + 金步摇红花 + 卷刘海 | 豆沙砖玫交领窄袖衫 + 灰紫披肩 | 打开的大团扇（红花图案） | 高髻 + 扇面圆盘 |
| 9 | `guanlaoji` | 关老吉 | 男 | 68 | `#8D6E63` | 牛奶棕 | 秃顶 + 两侧白发 + 圆框金眼镜 | 牛奶棕针织马甲 + 深棕小领带 | 一大串钥匙（三把 + 圆环） | 微驼 + 钥匙串散开 |
| 10 | `lengqiuping` | 冷秋萍 | 女 | 74 | `#78909C` | 蓝灰 | 银发一丝不苟低髻 + 细方框银眼镜 | 蓝灰修身西装上衣 + 及膝西裙 | 大木拍卖槌（带敲击台） | 笔直肩背 + 槌头 |

---

## 5. 逐角色提示词（10 段主体描述）

拼装规则：**中文 = §2.1 锚点段 + §3 同族底线 + 该角色主体段 + §3.2 朝向尾句**；**英文 = §2.2 + §3.1 + 该角色 body 段 + §3.2 英文尾句**。四段直接首尾相接、不加自己的说明文字（说明会被模型画进画面）。

朝向尾句必须留在**最末尾**、不要合并进主体段：上一批 10 张里 3 张整身朝左，而当时「朝右」只写在共 5 条的底线第 2 条里——中段指令被无视了，尾位才压得住。

主体段只写三件事：**人是谁（年龄性别气质）+ 穿什么色系 + 标志物是什么**。标志物「怎么拿」一律写成「都可以」，把姿势留给模型；每段末尾的自由发挥句不是废话，是在明确告诉模型不要退回「站立举物」的安全解。

实测字符数（脚本量过，不是目测）：中文整条 **1178–1305 字**（锚点 340 + 底线 585 + 主体 190–317 + 尾句 63），仍在即梦 2000 字上限内；**英文整条 3762–4264 字，约为中文 3.2 倍，超上限**。给即梦一律交中文版，只有目标模型明确支持长英文时才用英文，且需压缩 §3.1。

### 1 阿福 `char_afu@v6`

**中文（主体段）**
```
主体：一位原创的17岁少年庙口跑腿小弟。圆脸带雀斑、咧嘴自信笑、露出一颗小虎牙、眼神发亮；黑色短发翘起一撮，额上绑一条珊瑚红布头巾，结在左侧飘起。穿珊瑚红无袖短打工装、腰束深棕布带，深棕长裤与棕色圆头布鞋。他的标志物是一枚鼓鼓的珊瑚红平安符布袋（袋口扎绳、绳上一只小金铃）——系在腰带上、拎起来给人看、托在掌心抛着玩都可以，姿势你定；站姿松、重心歪在一条腿上，一副混不吝的机灵劲。
```

**English（body paragraph）**
```
Subject: an original 17-year-old temple errand boy. Round freckled face, cocky open-mouth grin with one small fang, bright eyes; short black hair with a flipped tuft, coral-red cloth headband knotted at the left side with floating ends. Coral-red sleeveless short work outfit, dark-brown waist belt, dark-brown trousers, round-toe brown cloth shoes. His signature object is a plump coral-red paper amulet pouch (drawstring mouth, one small gold bell) - worn at the belt, dangled up to show off or tossed in the palm, your call; loose stance with weight on one leg, cheeky and carefree.
```

### 2 小美 `char_xiaomei@v6`

**中文**
```
主体：一位原创的24岁百货公司专柜女店员。圆脸大眼、睫毛明显、脸颊腮红、笑容职业又精明；深棕长发扎成低马尾、鬓角两缕微卷，头戴一顶小巧的天蓝贝雷帽。穿天蓝收腰背心裙（裙摆在膝上）、领口系小领结、腰前挂一只账夹包，黑色圆头小皮鞋。她的标志物是一张放大的空白优惠券票券（长方形、四边一圈半圆缺口、中间一条斜色带，纯图形不得有任何文字或数字）——举到脸侧翻看着比价、贴在胸前或甩在指间转圈都可以，但票券必须在画面右半部、由靠近观众的这只手拿着；另一臂在画面左侧挎一只天蓝小购物袋。
```

**English**
```
Subject: an original 24-year-old department-store counter clerk. Round face, big lashed eyes, blushing cheeks, a professional-but-sharp smile; long dark-brown hair in a low ponytail with two curled side locks, small sky-blue beret. Waisted sky-blue pinafore dress (hem above the knee), neck bow, a small bill-folder pouch at the waist, black round-toe pumps. Her signature object is an oversized blank coupon ticket (rectangle with a row of semicircular notches along all edges and one diagonal color band, purely graphic, absolutely no text or digits) - raised beside the face as if comparing prices, pressed to the chest or spun on a finger, but it must sit in the right half of the frame held by the near hand; a small sky-blue shopping bag on the other arm at the left side.
```

### 3 铁雄 `char_tiexiong@v6`

**中文**
```
主体：一位原创的29岁魁梧保安队长。方脸浓眉、下巴方正、嘴角紧抿、眼神正直带凶；黑色平头短发，头戴草绿大檐保安帽（深棕帽檐、帽前一枚金色盾形帽徽，纯图形）。穿草绿短袖保安制服（双肩金色肩章、胸前两个方形口袋、腰束深棕宽腰带）、深棕长裤、黑色厚底皮鞋，体格比同族明显宽一圈、手臂粗壮。他的标志物是一只放大的金色哨子（配深棕挂绳）——挂在颈上垂在胸前、抬手含在嘴里吹、两指夹着举到眉边都可以；右手抬起掌心向外做拦阻手势，或抱臂瞪人，由你定。
```

**English**
```
Subject: an original 29-year-old burly head of security. Square jaw, thick brows, tight mouth, blunt honest-glaring eyes; black buzz cut under a grass-green peaked security cap (dark-brown visor, one gold shield badge, purely graphic). Grass-green short-sleeve security tunic with two gold epaulettes, two square chest pockets and a wide dark-brown belt, dark-brown trousers, black chunky shoes; frame one clear size wider than the rest of the set, thick arms. His signature object is an oversized gold whistle on a dark-brown lanyard - hanging at the chest, raised to his mouth to blow, or pinched up at brow height, your call; either a palm-out blocking hand or folded arms glaring, as you prefer.
```

### 4 白小鹿 `char_baixiaolu@v6`

**中文**
```
主体：一位原创的19岁快递女骑手。圆脸大眼、鼻尖一点雀斑、张嘴元气笑；浅棕双马尾从帽后甩出、飘向画面左侧，头戴一顶反着戴的柠黄绿棒球帽（帽檐朝后）。穿柠黄绿多口袋快递马甲（方形小口袋与一条浅色反光横条，纯色块）、内里浅色短袖、深棕七分裤、柠黄绿白底运动鞋，背后斜挎一只鼓鼓的棕色大快递包。她的标志物是一只棕色小纸箱包裹（十字封箱胶带是纯色条、不得有文字或标签）——扛在右肩、抱在怀里或单手托在画面右侧都可以；身体略前倾、迈步方向朝画面右，手臂带跑步摆臂的动势，像随时要跑向右边的下一格。
```

**English**
```
Subject: an original 19-year-old girl courier. Round face, big eyes, one freckle on the nose tip, open energetic grin; light-brown twin tails flicking out behind the cap toward the left of the frame, lime-yellow baseball cap worn backwards (visor to the rear). Lime-yellow multi-pocket courier vest (square pockets and one pale reflective stripe as flat blocks) over a light short-sleeve top, dark-brown cropped trousers, lime-and-white sneakers, a plump brown delivery backpack slung behind. Her signature object is a small brown cardboard parcel (cross tape as plain color strips, no text or labels) - on the right shoulder, hugged, or held one-handed in the right half of the frame; body leaning forward, stride heading to the right, running-arm momentum, ready to bolt toward the next tile on the right.
```

### 5 胡三思 `char_husansi@v6`

**中文**
```
主体：一位原创的41岁精明当铺掌柜。微胖圆脸、细眯眼、眉毛高挑、上唇两撇黑八字胡、下巴一小撮短须、皮笑肉不笑；头戴黑色瓜皮小帽（帽顶一枚深色结珠）。穿藕紫色绸缎对襟马褂——这是洗旧脱色的紫布，紫里掺明显的灰与一点褐，接近灰紫、旧缎紫，绝不是发亮的品红紫、酒红紫或紫罗兰；领口与前襟一圈浅金滚边加三枚圆形布扣，内里米白长衫，腰上挂一枚方形玉佩，黑色布鞋。他的标志物是一把放大的木算盘（深棕外框、三档浅金算珠，纯图形）——抱在左臂弯、单手拎着晃、或一手托着另一手在梁上拨珠都可以，算盘落在画面右半部；脖子略缩、肩膀微耸，一副随时准备压你价的架势。
```

**English**
```
Subject: an original 41-year-old pawnshop boss. Plump round face, narrow squinting eyes, raised brows, black handlebar mustache and a short chin tuft, a smile that never reaches the eyes; black skullcap with one dark knot bead. Fade-dusty lilac-grey silk front-opening jacket - washed-out purple cloth, grey and a touch of brown mixed into the purple, close to muted heather violet, NOT glossy magenta-purple, NOT wine-purple, NOT violet; pale-gold piping at collar and placket with three round cloth buttons, off-white long inner robe, a square jade pendant at the waist, black cloth shoes. His signature object is an oversized abacus (dark-brown frame, three rows of pale-gold beads, purely graphic) - cradled on the arm, dangled from one hand, or held flat while the other flicks the beads, but it sits in the right half of the frame; neck shrunk, shoulders hunched, forever ready to haggle you down.
```

### 6 花大嫂 `char_huadasao@v6`

**中文**
```
主体：一位原创的37岁富态里长太太。宽圆脸、笑眼眯成缝、两颊鼓鼓的腮红、嘴角上翘、耳垂厚大戴一对金圆环耳环；黑发在脑后盘成饱满的低发髻，髻上一朵橙色绢花（可以画大一点）与一支金簪。穿暖橙对襟上衣，衣身只点三五个浅色小圆点当碎花（不得密集花纹），领口与袖口米白滚边，腰间系深棕围裙、围裙一个大口袋鼓起来，深棕长裙、黑色布鞋，体态丰腴、双手肉感。她的标志物是一只鼓鼓的橙色布钱袋（袋口扎绳、袋身一枚金圆扣）——双手拢在怀里、拎在指间晃、或塞进围裙口袋只露一半都行；另一只手腕上搭一块米白手帕。
```

**English**
```
Subject: an original 37-year-old well-off village-head's wife. Broad round face, eyes squeezed into laughing slits, puffy blushing cheeks, upturned mouth, thick earlobes with gold hoop earrings; black hair in a full low bun wearing one oversized orange silk flower and a gold hairpin. Warm-orange front-tie jacket with only three or five pale dots as flowers (never a dense pattern), off-white piping at collar and cuffs, a dark-brown apron whose big pocket bulges, dark-brown long skirt, black cloth shoes; plump build with soft hands. Her signature object is a bulging orange cloth money pouch (drawstring mouth, one gold button) - cradled in both arms, dangled from the fingers, or half-sunk in the apron pocket, your call; an off-white handkerchief over the other wrist.
```

### 7 贾半仙 `char_jiabanxian@v6`

**中文**
```
主体：一位原创的53岁庙口神算先生。瘦长脸、三角眼、花白眉毛上挑、神情高深又带一点狡黠；头戴松石青混元道帽（帽前一枚黑白阴阳鱼小徽，纯图形），鬓角斑白，颌下一把齐腰的灰白长须、须尖收成一个尖。穿松石青宽袖长道袍（一条深棕斜襟、三枚圆形布扣、下摆一道米白波纹边，纯图形），内里米白中衣，腰束深棕布带，黑色布鞋，袖子可以画得夸张一点。他的标志物是一面放大的八角八卦镜（深棕木框、米白镜面、中央一个黑白阴阳鱼，全部是图形符号，不得有任何文字、符文或刻度）——托在掌心、举到额前、斜搭在小臂上或藏在袖里只露一角都可以；另一只手捋着长须。
```

**English**
```
Subject: an original 53-year-old temple-mouth fortune teller. Gaunt long face, triangular eyes, grizzled upturned brows, uncanny sly composure; turquoise Taoist cap with one small black-and-white yin-yang emblem (purely graphic), salt-and-pepper sideburns, a waist-length grey-white beard tapering to a point. Wide-sleeved long turquoise Taoist robe with one dark-brown diagonal placket, three round cloth buttons and a pale wave border at the hem (purely graphic), off-white inner robe, dark-brown cloth sash, black cloth shoes; sleeves may be exaggerated. His signature object is an oversized octagonal bagua mirror (dark-brown wooden frame, off-white face, one black-and-white yin-yang at the center, graphic symbols only, absolutely no characters, runes or tick marks) - palm-balanced, raised to brow height, laid across the forearm or half-hidden in a sleeve, your call; the other hand stroking the beard.
```

### 8 苏媒婆 `char_sumopo@v6`

**中文**
```
主体：一位原创的48岁能说会道的媒婆。长圆脸、眯笑眼、嘴唇丰厚涂艳红、左嘴角下方一颗大黑痣、两团浓腮红；黑发梳成高耸发髻，髻上一支金步摇与一朵红花，额前一缕卷贴的刘海。穿豆沙砖玫色交领窄袖衫——是在砖红、铁锈红里掺进一点粉的褪色玫色，掺棕不掺蓝，绝不是荧光玫红、桃红或品红（这类颜色后期会被当作背景一起抠掉）；衣襟与袖口米白滚边加三颗圆形盘扣，外罩一条灰紫色披肩搭在肩后（同样是掺灰的旧紫，不要亮紫），腰系深棕宽带并挂一只小荷包，深棕长裙、黑色绣花鞋。她的标志物是一把打开的大团扇（米白扇面、深棕竹柄、扇面中央一朵红色图形花卉，不得有文字）——半掩在脸前、摇在画面右侧或搭在右臂弯都可以；另一只手在嘴前虚握，做说悄悄话、攀关系的手势。
```

**English**
```
Subject: an original 48-year-old talkative matchmaker. Long round face, squinting smiling eyes, full red-painted lips, one big dark mole below the left corner of the mouth, two strong blush patches; black hair in a tall bun with a gold dangling hairpin and one red flower, a curled lock pasted on the forehead. Faded brick-rose cross-collar slim-sleeve blouse - a dusty rose leaning to brick and rust with a touch of pink, brown mixed in rather than blue, NOT neon magenta-pink, NOT hot pink, NOT fuchsia (those get keyed out with the background); off-white piping and three round knot buttons, a smoky grey-violet shawl draped behind the shoulders (also a greyed-out old purple, not a bright one), dark-brown sash with a small pouch, dark-brown long skirt, black embroidered shoes. Her signature object is an open round fan (off-white face, dark-brown bamboo handle, one red graphic flower at the center, no text) - half covering the face, waving in the right half of the frame or resting on the right elbow; the other hand cupped near the mouth in a whispering, pulling-a-deal gesture.
```

### 9 关老吉 `char_guanlaoji@v6`

**中文**
```
主体：一位原创的68岁老房东。宽脸慈祥、满脸笑纹、花白眉毛下垂、耳朵厚大、戴一副圆框金边眼镜；头顶大半秃、两侧与后脑一圈白发。穿牛奶棕（浅咖色）针织马甲（一排小圆扣、左胸口袋露出半截账本角），内里米白长袖衬衫、领口系一条深棕小领带，深棕长裤、棕色旧皮鞋，略微驼背、肚子微凸。他的标志物是一大串钥匙（一个深棕圆环上挂着三把大小不一的金色钥匙与一枚方形小钥匙牌，纯图形不得有字）——挂在食指上垂着晃、托在掌心摊开、或揣进马甲口袋只露出圆环都可以；另一只手背在身后。
```

**English**
```
Subject: an original 68-year-old veteran landlord. Broad kindly face, deep smile wrinkles, drooping grey-white brows, big thick ears, round gold-rimmed spectacles; mostly bald crown with a ring of white hair at sides and back. Milk-brown (light coffee) knit vest with a row of small round buttons and a chest pocket showing half a ledger corner, off-white long-sleeve shirt with a small dark-brown necktie, dark-brown trousers, worn brown shoes; slightly stooped with a small belly. His signature object is a big bunch of keys (three gold keys of different sizes plus one square key tag on a dark-brown ring, purely graphic, no lettering) - hung from a finger and swinging, fanned out in the palm, or tucked in the pocket with only the ring showing, your call; the other hand behind the back.
```

### 10 冷秋萍 `char_lengqiuping@v6`

**中文**
```
主体：一位原创的74岁退休银行女行长。瘦削端庄、颧骨明显、细眉、嘴角一丝了然的笑、戴一副细方框银边眼镜；银发梳成一丝不苟的低发髻、鬓角整齐，颈上一串珍珠。穿蓝灰修身西装上衣（翻领、两枚金扣、左胸一枚圆形金质徽章，纯图形），内里米白立领衬衫，下身同色及膝西装裙，黑色低跟皮鞋，体态笔直、肩背打开。她的标志物是一只大木拍卖槌（深棕槌头带两道金环、浅棕槌柄，配一块方形小木敲击台，纯图形不得有编号或文字）——由靠近观众的这只右手托在画面右侧、垂在身侧或举起来像正要朝右落槌都可以；另一只手在画面左侧轻握一只小皮面账夹。脚尖与视线指向画面右。
```

**English**
```
Subject: an original 74-year-old retired female bank president. Lean and dignified, prominent cheekbones, thin brows, a knowing half-smile, slim silver rectangular spectacles; silver hair in a flawless low bun, neat temples, a pearl necklace. Slate-blue tailored suit jacket (notched lapels, two gold buttons, one round gold badge on the left chest, purely graphic) over an off-white stand-collar blouse, matching knee-length skirt, black low-heel shoes; ramrod-straight with open shoulders. Her signature object is an oversized wooden auction gavel (dark-brown head with two gold bands, light-brown handle, one small square striking block, purely graphic, no numerals or text) - palm-balanced in the right half of the frame by the near hand, held down at the side, or raised as if about to strike toward the right; the other hand holds a small leather folder at the left. Toes and gaze point to the right.
```

---

## 6. 色键冲突实测（**出图前必须先定，否则整片衣服会被抠穿**）

现有抠图规则在 `assets/art/tools/art_asset_tools.py:42`：`r−g > 60 且 b−g > 60` 的像素一律置为透明（品红相对阈值键控）。按这条规则实测 10 个引擎色：

| 角色 | 引擎色 | r−g | b−g | 判定 |
|---|---|---|---|---|
| 胡三思 | `#AB47BC` | 100 | 117 | ❌ **两个条件同时命中 → 整件马褂会被抠成透明** |
| 苏媒婆 | `#EC407A` | 172 | 58 | ⚠️ 安全但只差 2 个通道值，模型画得偏亮一点就穿 |
| 阿福 | `#EF5350` | 156 | −3 | ✅ |
| 小美 | `#42A5F5` | −99 | 80 | ✅ |
| 铁雄 | `#66BB6A` | −85 | −81 | ✅ |
| 白小鹿 | `#D4E157` | −13 | −138 | ✅ |
| 花大嫂 | `#FFA726` | 88 | −129 | ✅ |
| 贾半仙 | `#26C6DA` | −160 | 20 | ✅ |
| 关老吉 | `#8D6E63` | 31 | −11 | ✅ |
| 冷秋萍 | `#78909C` | −24 | 12 | ✅ |

**第一版解法实测失败**：文档原来只写「压暗」（深茄紫 `#5E3562`、深玫瑰红 `#B5486F`），回图里模型确实压暗了，但暗成了 `#5D145A`（r−g=73、b−g=70）与 `#BF2D6A`（146、61）——**只降明度不抬绿，两个条件照样全中**。实测这两张图里满足键控规则的像素：胡三思紫袍 8.44%、苏媒婆玫红衫 2.60%（其余 8 张均 ≤0.01%）。

**修正后的规则：往色相里掺灰或掺棕，把绿色分量抬起来，而不是把颜色压暗。** 判据是 `r−g` 与 `b−g` 至少有一项 ≤60，靠抬 `g` 同时压低两项最稳。

| 角色 | 建议服装色 | r−g | b−g | 提示词里的写法 |
|---|---|---|---|---|
| 胡三思 | `#7A5C82` 藕紫 / 旧缎紫 | 30 | 38 | 「洗旧脱色的紫布，紫里掺明显的灰与一点褐，绝不是发亮的品红紫、酒红紫或紫罗兰」 |
| （备选） | `#5C5A8A` 靛紫 | 2 | 48 | 往蓝里走也可以，只要别往品红里走 |
| 苏媒婆 | `#A85560` 豆沙砖玫 | 83 | 11 | 「砖红、铁锈红里掺一点粉的褪色玫色，掺棕不掺蓝，绝不是荧光玫红、桃红或品红」 |
| （备选） | `#9C5247` 铁锈玫 | 74 | −11 | 更偏棕，键控余量最大，但「玫」的身份感会弱 |

**引擎色仍然不动**（`color` 只喂 PixiJS 做名牌与光晕 tint）。若要让名牌色与衣服色一致，改 `characters.ts` 是另一件事，别混进这一波。

**备选解法（§8 D-04）**：a) 引擎色一起改（名牌与贴图统一，代价是紫红两色在色板上退让）；b) 这两个角色换底色生成（绿幕），代价是抠图链路要分两批；c) 把抠图阈值改成三通道判据 —— 会波及已定稿的 22 张 @v6 资产，不建议。

---

## 7. 后处理与验收判据

```bash
# 1. 品红底原图存 assets/art/raw/char_<id>@v6_src.png
# 2. 抠图 + 紧裁切 + 缩放 + 透明补方（一条命令全做，工具里没有单独的 trim 步骤）
python assets/art/tools/art_asset_tools.py keyout assets/art/raw/char_afu@v6_src.png assets/art/batch7/char_afu@v6.png --size 256
# 3. 规格校验 + 10 人接触表（同族比对唯一可靠手段）
python assets/art/tools/art_asset_tools.py check assets/art/batch7
python assets/art/tools/art_asset_tools.py sheet assets/art/batch7 assets/art/batch7/_contact_sheet.png --cols 5
```

**淘汰判据（任一不过即重出，同一条提示词不超过 3 次）**：

1. 接触表缩到 32px 高，**只看剪影**能认出是哪位（头饰 + 标志物承担识别，不靠颜色）；
2. 转灰度后深棕描边分界线清晰可数，主体与背景不糊成一片；
3. **体量一致（放开姿势后唯一需要补的量）**：量每张不透明像素的包围盒，`高 ÷ 宽 ≥ 1.05` 才算以竖向人体为主。因为 `keyout` 按最长边缩到 256 再补方，横向摊开（大摆袖、斜伸的包裹、张开的团扇）会把人挤小，棋盘上就比别人矮一截。并排看接触表，头顶高度差超过 8% 判同族性不足；
4. 透明底边缘无半透明品红残留（`keyout` 是二值 alpha，出现粉边即说明原图边缘有品红混色，需按保色 chroma key 流程处理，不得直接放宽阈值）；
5. 画面内无任何文字、数字、符文、标签（票券/账本/钥匙牌/八卦镜四处最容易漏）；
6. 脚下无烘焙阴影（阴影由 `fx_shadow_oval` 代码叠加，烘进贴图会导致浮动时穿帮）；
7. 朝右或接近正面均可，**朝左直接判不合格**（左向靠代码镜像得到）；标志物必须完整可辨、且落在画面右半部，被身体挡掉一半或跑到画面左边即不合格；
8. **键控余量**：回图先量「满足 `r−g>60 且 b−g>60` 的不透明像素占比」，>0.5% 即判撞键（首批胡三思 8.44%、苏媒婆 2.60% 就是这么抓出来的，其余 8 张 ≤0.01%）。

```bash
# 第 3 条的包围盒实测 + 第 8 条的键控余量（对 batch7 全量跑一遍）
python -c "
from PIL import Image; from pathlib import Path
for p in sorted(Path('assets/art/batch7').glob('*.png')):
    im=Image.open(p).convert('RGBA'); b=im.getbbox(); im=im.crop(b); W,H=im.size; px=im.load()
    opq=kill=0
    for y in range(H):
        for x in range(W):
            r,g,bl,al=px[x,y]
            if al>200:
                opq+=1
                if r-g>60 and bl-g>60: kill+=1
    w,h=b[2]-b[0],b[3]-b[1]
    print(f'{p.name:24s} 高/宽={h/w:4.2f} 高占画布={h/256:4.0%} 撞键像素={kill/opq:6.2%}  {\"OK\" if (h/w>=1.05 and kill/opq<0.005) else \"返工\"}')
"
```

---

## 8. 分歧待决表

| # | 分歧 | 选项 | 我的倾向 | 决定 |
|---|---|---|---|---|
| D-01 | 现有 `char_player_a~d@v6` 四张通用棋子的去留 | a) 保留作 bot/未选角占位 b) 全部废弃，10 张具名顶上 | a（改动最小，且 4 张已定稿） | |
| D-02 | 标志物是否统一为金币 | a) 各自身份物（本档已按此写） b) 全员金币（同族最强、个体最差） c) 各自身份物 + 腰上再挂一枚小金币 | a | |
| D-03 | 是否加「肩头一只动物」呼应 `avatar` emoji（🐵🐬…） | a) 不加 b) 加（10 只动物 = 10 处额外细节，32px 下不可读且增加穿帮） | a | |
| D-04 | 色键冲突解法 | a) 只压服装色（本档已按此写） b) 引擎色一起改 c) 两角色换绿幕底 | a | |
| D-05 | 神仙三人（财神/穷神/土地公，清单 #6，仍未开始）是否同批出 | a) 同批（语法直接复用，省一轮风格漂移） b) 下一批 | a | |
| D-06 | HUD 头像（现在是 emoji）怎么换 | a) 用全身像裁头，不额外生成 b) 每人再出一张胸像（+10 张额度） c) 继续用 emoji | a | |
| D-07 | 出图批次 | a) 10 张一次出（同族一致性最好比对） b) 先出 2 张基准（阿福 + 冷秋萍，一少一老）确认后再出 8 张 | b（省额度，基准歪了只损失 2 张） | |

---

## 9. 落地清单（图回来后要做的事，本档不含改动）

| 项 | 位置 | 要做 |
|---|---|---|
| 资产命名 | `assets/art/batch7/char_<id>@v6.png` | 10 张，`<id>` 取 `characters.ts` 的 `id`（`afu`/`xiaomei`/…），别再用 `char_player_a` |
| 棋盘贴图映射 | `client/src/game/BoardRenderer.ts:58-61` | 现在按座位取 `char0..char3`，要改成按 `player.characterId` 取图（4 张变 10 张，座位序不再等于图序） |
| HUD 头像 | `client/public/ac-hud/hud.js`、`client/src/App.tsx:106` | 现在两处都渲染 `c.avatar`（emoji），若走 D-06a 则改成同一张图的裁切版 |
| 录像 | `shared/src/replay.ts` | 已知缺口：录像只记 `id/name/color`、不记 `characterId`（决策表 §十一 已记）。按 [[no-legacy-data-compat]] 不为老录像保底 |

---

## 10. 额度与批次

| 方案 | 张数 | 估算额度 | 说明 |
|---|---|---|---|
| 基准先行（D-07b） | 2 → 8 | 10–20 → 40–80 | 基准歪了只损失 2 张 |
| 一次全出（D-07a） | 10 | 50–100 | 同族比对最快，风险是整批返工 |
| 加神仙三人（D-05a） | +3 | +15–30 | 语法复用，边际成本低 |

> 折算依据：提案 §v6.6「全部重出 + 新增 ≈ 49 张，约 250–500 生成额度」⇒ 每张 5–10 额度。重试按上限 3 次计最坏 ×3。

---

## 11. 首批回图验收记录（2026-10-15，`assets/role/image0~9.png`，2048×2048 已抠透明底）

身份映射（回图文件名是 `image0~9`，落到 `batch7` 时按此改名）：

| 文件 | 角色 | 建议改名 | h/w（门槛≥1.05） | 满足键控规则的像素 | 肤色重心偏移（基准 +0.09~+0.11 = 朝右） | 判定 |
|---|---|---|---|---|---|---|
| image0 | 阿福 | `char_afu@v6` | 1.83 | 0.00% | +0.111 | 通过 |
| image1 | 小美 | `char_xiaomei@v6` | 1.96 | 0.00% | +0.033 | **整身朝左，重出** |
| image2 | 铁雄 | `char_tiexiong@v6` | 1.90 | 0.00% | −0.112 | 正面，可用（哨子在 32px 丢失） |
| image3 | 白小鹿 | `char_baixiaolu@v6` | 1.70 | 0.00% | −0.078 | **整身朝左，重出** |
| image4 | 胡三思 | `char_husansi@v6` | 1.57 | **8.44%** | −0.008 | 正面可用，但**紫袍走项目抠图会被打穿** |
| image5 | 花大嫂 | `char_huadasao@v6` | 2.05 | 0.00% | −0.017 | 通过 |
| image6 | 贾半仙 | `char_jiabanxian@v6` | 1.70 | 0.00% | −0.085 | 正面，可用 |
| image7 | 苏媒婆 | `char_sumopo@v6` | 2.14 | **2.60%** | −0.055 | 正面可用，**玫红衫同上** |
| image8 | 关老吉 | `char_guanlaoji@v6` | 2.41 | 0.00% | −0.021 | 通过（钥匙串在 32px 完全丢失，本批最弱） |
| image9 | 冷秋萍 | `char_lengqiuping@v6` | 1.99 | 0.00% | +0.146 | **整身朝左，重出** |

**过关项**：10 人身份与标志物全部对得上角色表；无文字/数字/符文泄漏；无烘焙落地投影；h/w 全部 ≥1.05，`keyout` 按最长边缩 256 后 10 张等高，棋盘上不会有人被挤小。

**未过关与已改进提示词的部分**：① 朝向 3 张作废 → §3 第 2 条改写 + 新增 §3.2 尾句；② 紫/玫红撞键 → §6 改成「抬绿色分量」并把两个角色的色名换成藕紫、豆沙砖玫；③ 头身比实测 2.25~3.56，4 张超出 2~3 带宽 → §3 第 3 条加「不超过 3 头身」硬顶；④ 回图整体比老 4 张更「贵」（柔光渐变、细节堆叠、更亮更饱和）→ §2 锚点段加「硬边过渡、每色相最多两阶、装饰克制、色数收敛」。

**两条如实说明的偏差**：① 我设计了「同色连续游程长度」来证明新图不是真像素风，实测**该判据无效**——老 4 张也只有 1.02~1.11，它们本身就不是格点对齐的像素画，不能拿它打新图；② 内部封闭透明空洞（image0 0.67%、image3 1.66%、image9 0.74%）经查主要是手臂与身体之间的合理负空间，不是抠穿，别当缺陷处理。

**仍未定**：这批与已定稿 `char_player_a~d@v6` 不同族（并排见 `.scratch/role_old_vs_new.png`），走 D-01 的哪条决定后续要不要统一重出。
