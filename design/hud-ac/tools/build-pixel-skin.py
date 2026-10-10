#!/usr/bin/env python
"""生成 client 的「像素字口味」皮肤：`client/public/ac-hud/ac-pixel.css`。

## 为什么需要生成，而不是手写

皮肤里的字号是**为矢量圆体设计的细腻字阶**：9 / 10 / 11 / 12 / 13 / 14 / 15 / 16 / 18 / 20 …
而像素字只有在**设计字号的整数倍**下才是清晰点阵（12 / 24 / 36，或 16 / 32）。
13px 的缝合像素 = 12px 点阵被缩放 1.0833 倍 → 直接糊掉。

所以像素字模式必须把字号吸附到网格上。手写覆盖有两个问题：
1. **会漏** —— 三份 CSS 合计数百条 `font-size`，漏掉一条就是一块糊的字；
2. **会漂** —— 上游 `ac.css` 一改，手写的覆盖就悄悄失配。

所以从上游 CSS **机械地派生**：凡是 `font-size` 落在 [9, 16] px 的声明，
在像素模式下重写成网格字号。>16px 的一律不动 —— 那些几乎全是 emoji 图标
（`.ac-icon` 26px、`.ac-card__art` 48px、`.ac-nav__tab .i` 20px），emoji 不在中文字体里，
跟着缩放只会把布局撑坏。

## 输出

`client/public/ac-hud/ac-pixel.css`，一个文件覆盖两种口味：

    html.ac-font-pix12   → 'Fusion Pixel 12px'，吸附到 12px
    html.ac-font-qiuye   → 'QiuYe Round 16'，   吸附到 16px

开关挂在 `<html>` 上而不是 `#ac-hud-root`：ac.css 的令牌定义在 `:root`，
而且弹层 / 横幅这些 React 部件是 `#ac-hud-root` 的兄弟节点，挂在 html 上才盖得住。

## 用法

    python design/hud-ac/tools/build-pixel-skin.py
"""
from __future__ import annotations

import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
HUD = REPO / 'client' / 'public' / 'ac-hud'
OUT = HUD / 'ac-pixel.css'

# 参与派生的样式表。顺序无关，输出按源文件顺序。
SOURCES = [
    HUD / 'ac.css',                                # ac 组件库
    HUD / 'hud.css',                               # 对局壳
    REPO / 'client' / 'src' / 'ui' / 'acHudClient.css',  # 弹层 / 横幅 / 大厅
    REPO / 'client' / 'src' / 'styles.css',        # 既有多数 React 面板（弹层内容）
]

# 只吸附这个区间里的字号。下界 9 是界面上最小的文字（角标），上界 16 是最大正文。
SNAP_MIN, SNAP_MAX = 9, 16

MODES = [
    ('ac-font-pix12', 'Fusion Pixel 12px', 12, '缝合像素 12px · 12 / 24 网格'),
    ('ac-font-qiuye', 'QiuYe Round 16', 16, '秋叶圆体 16 · 16 / 32 网格'),
]

FONT_SIZE_RE = re.compile(r'font-size\s*:\s*([0-9]*\.?[0-9]+)px\s*(?=;|$)')


def strip_comments(css: str) -> str:
    return re.sub(r'/\*.*?\*/', '', css, flags=re.S)


def walk(css: str):
    """极简 CSS 块遍历：产出 (选择器, 声明块)，@media / @supports 递归进去。

    不追求完整 CSS 解析 —— 输入是我们自己的样式表，规则都是扁平的
    `选择器 { 声明 }`，嵌套只出现在 `@media` / `@supports` 里。
    遇到其它 at-rule（@keyframes / @font-face）直接跳过整块。
    """
    i, n = 0, len(css)
    while i < n:
        j = css.find('{', i)
        if j < 0:
            return
        prelude = css[i:j].strip()
        # 找配对的 }
        depth, k = 1, j + 1
        while k < n and depth:
            if css[k] == '{':
                depth += 1
            elif css[k] == '}':
                depth -= 1
            k += 1
        body = css[j + 1:k - 1]
        if prelude.startswith('@'):
            at = prelude.split('(', 1)[0].strip().lower()
            if at in ('@media', '@supports'):
                for sel, decls in walk(body):
                    yield f'{prelude}||{sel}', decls
            # @keyframes / @font-face / @charset 等：不参与字号吸附
        else:
            yield prelude, body
        i = k


def snap_rules(src: Path, mode_cls: str, px: int) -> tuple[list[str], int]:
    css = strip_comments(src.read_text(encoding='utf-8'))
    out: list[str] = []
    hits = 0

    for sel, body in walk(css):
        prelude, real = sel.split('||', 1) if '||' in sel else ('', sel)
        s = real.strip()
        if not s:
            continue
        # `:root` 是令牌定义处，`html` 开头的选择器本身已是根级 —— 都不能加前缀
        if ':root' in s or re.match(r'^html\b', s, re.I):
            continue
        # 选择器列表要**逐个**加前缀：`html.cls A, B` 只会约束到 A，B 会漏出去
        parts = [p.strip() for p in s.split(',') if p.strip()]
        if not parts or any(p.startswith('@') or p == '*' for p in parts):
            continue
        scoped = ', '.join(f'html.{mode_cls} {p}' for p in parts)

        found = FONT_SIZE_RE.findall(body)
        if not found:
            continue
        # 一条规则里可能有多个 font-size（不同状态），取最后一个 —— 与 CSS 层叠一致
        val = float(found[-1])
        if SNAP_MIN <= val <= SNAP_MAX and val != px:
            rule = f'{scoped} {{ font-size: {px}px; }}'
            out.append(f'{prelude} {{ {rule} }}' if prelude else rule)
            hits += 1
    return out, hits


def main() -> int:
    blocks: list[str] = [
        '/* 本文件由 design/hud-ac/tools/build-pixel-skin.py 生成，不要手改。',
        ' *',
        ' * 「像素字口味」皮肤：把 ac 皮肤的字体栈换成像素中文字体，并把字号吸附到像素网格。',
        ' * 像素字只有在设计字号的整数倍下才清晰 —— 13px 的缝合像素是 12px 点阵被缩放 1.0833 倍，',
        ' * 直接糊。所以下面用生成的方式，把上游 CSS 里 [9, 16]px 的 font-size 全部重写。',
        ' * > 16px 的不动：那些基本都是 emoji 图标，不在中文字体里，跟着缩放只会撑坏布局。',
        ' *',
        ' * 由 acHudLayer 通过 <html> 上的 class 开关：',
        ' *   html.ac-font-pix12  缝合像素 12px —— 与 ac 的小字阶（11~13px）天然贴合',
        ' *   html.ac-font-qiuye  秋叶圆体 16px —— 会把小字整体撑大约 33~45%，属「放大版」观感',
        ' *',
        ' * ⚠️ 两种口味都关掉抗锯齿并归零字距，这是像素字的硬要求。',
        ' * 同时字重被压到 400：像素字只有一档字重，让浏览器合成粗体（faux bold）',
        ' * 会在 12px 上糊出 1px 毛边，比不加粗更难看。',
        ' */',
        '',
    ]

    for cls, family, px, note in MODES:
        rules: list[str] = []
        total = 0
        for src in SOURCES:
            if not src.exists():
                continue
            r, h = snap_rules(src, cls, px)
            if h:
                rules.append(f'  /* ---- {src.relative_to(REPO)} · {h} 条 ---- */')
                rules.extend('  ' + x for x in r)
                total += h
        blocks += [
            f'/* ============================================================ {note} */',
            '',
            f'html.{cls} {{',
            f"  --ac-disp: '{family}', system-ui, sans-serif;",
            f"  --ac-ui:   '{family}', system-ui, sans-serif;",
            f"  --ac-num:  '{family}', system-ui, sans-serif;",
            '}',
            '',
            f'/* 像素字的硬要求：关抗锯齿、归零字距、字重单档。',
            f' * 注意 -webkit-font-smoothing 在 Windows / Linux 上是 **no-op**（只对 macOS 有效），',
            f' * 所以锐利度完全取决于字体轮廓有没有落在像素网格上 —— 这正是上面要做字号吸附的原因。',
            f' * 缝合像素 12px 的轮廓是按 12px 网格描的，吸附后是硬边；秋叶圆体走矢量轮廓，',
            f' * 横笔画常落半像素，所以 16px 下会带一圈灰边（见 w98-pixel/README.md 的像素裁决）。',
            f' */',
            f'html.{cls} body,',
            f'html.{cls} .ac-hud-root {{',
            '  -webkit-font-smoothing: none;   /* macOS 生效；Windows 上无效，见上 */',
            '  -moz-osx-font-smoothing: unset; /* Firefox(macOS) 关灰度平滑 */',
            '  font-smooth: never;',
            '}',
            f'html.{cls} *,',
            f'html.{cls} *::before,',
            f'html.{cls} *::after {{',
            '  letter-spacing: 0 !important;   /* 像素字字距已算进点阵，撑开就出半像素缝 */',
            '  font-variant-ligatures: none;',
            '  font-weight: 400 !important;    /* 只有一个字重，别让浏览器合成粗体 */',
            '}',
            '',
            f'/* 字号吸附：{SNAP_MIN}~{SNAP_MAX}px → {px}px，共 {total} 条 */',
            *rules,
            '',
            '  /* ---- 排版补偿（手写，不从上游派生） ----',
            '   * 字号吸附是把 [9,16]px 统一到一档，信息密度高的行会因此放不下而换行，',
            '   * 且换行点常常很难看（实测岛民面板的资产行断出孤零零的「· 🧰6」）。',
            '   * text-wrap: balance 让两行均分，看起来是有意的两行而不是溢出。实测：',
            '   *   缝合像素 12px  资产行自然宽 277px / 可用 238px → 平衡后两行各 ~139px，放得下',
            '   *   秋叶圆体 16px  资产行自然宽 332px / 可用 218px → 平衡后两行各 ~166px，放得下',
            '   */',
            f'  html.{cls} .ac-list__tx small,',
            f'  html.{cls} .hud-foot,',
            f'  html.{cls} .ac-list__tx b {{ text-wrap: balance; }}',
            '',
        ]

    # ---- 内容适配（手写，不从上游派生） ----
    #
    # 字号吸附解决「糊」，这一节解决「放不下」。每一条都对应 font-mode-audit.mjs 实测的
    # 一条溢出，改前改后都要跑一遍对账 —— 不量就改，等于闭着眼调。
    blocks += [
        '/* ============================================================ 内容适配（手写，不从上游派生）',
        ' * 只写秋叶圆体：它是定下来的像素口味，设计字号 16px 比 ac 皮肤原有小字阶（10~13px）',
        ' * 大 23%~60%，凡是按小字排的紧凑容器都要给去处。缝合像素 12px 与原字阶几乎重合，不需要。',
        ' *',
        ' * 审计口径：design/hud-ac/tools/font-mode-audit.mjs 逐元素量 scrollWidth/clientWidth，',
        ' * 只看 overflow 为 visible 的（auto/scroll 的滚动容器是设计如此）。',
        ' */',
        '',
        '/* 1. 顶栏：16px 下整行实测 1717px / 可用 1420px，最宽的是名字旁那行日期。',
        ' *    而那行日期几乎全是冗余 —— 紧跟在下面的状态条就给了 M/D 周X · 岛历 N 天 · 月末 N 天，',
        ' *    例假日还有专门的 🏖️ chip。所以 hud.js 把日期段拆成 .hud-when，这里只在秋叶模式藏掉，',
        ' *    保留「第 N 回合 · 第 N 圈」（状态条没有这个）。藏掉后整行 ~1.3k px，一行放得下。 */',
        'html.ac-font-qiuye .hud-top .ac-hud__who .hud-when { display: none; }',
        '',
        '/* 2. 顶栏按钮：字从 12.5/13px 涨到 16px，内边距按 16px 字号重排，',
        ' *    省下的宽度还给文字，整行不再靠挤压谁。 */',
        'html.ac-font-qiuye .hud-topbtns .ac-btn { padding: 6px 10px 7px; }',
        'html.ac-font-qiuye .hud-top .ac-btn--sm { padding: 7px 12px 8px; }',
        '',
        '/* 3. 状态条行情带：6 支股票 chip 在 16px 下超出行宽 86px。它本来就是可横滚的',
        ' *    （带渐隐遮罩 + 隐藏滚动条），不算坏 —— 但把 chip 内边距、行情带内距与',
        ' *    容器间距各收紧一档，能整条塞进默认视野，不用横向滚才能看到「金融」。',
        ' *    实测 86px → 22px → 0。 */',
        'html.ac-font-qiuye .hud-status { gap: 6px; padding: 5px 8px; }',
        'html.ac-font-qiuye .hud-status .hud-chip { padding: 2px 6px; gap: 3px; }',
        'html.ac-font-qiuye .hud-status__mkt { gap: 4px; }',
        '',
        '/* 4. 面板底注：原 10px → 16px 后被省略号截断（实测丢掉「物价 ×1.000」）。',
        ' *    这行是唯一的回合/阶段/物价摘要，截断比折行糟，允许它折成两行。 */',
        'html.ac-font-qiuye .hud-panelfoot { white-space: normal; line-height: 1.5; }',
        '',
        '/* 5. 左下地块信息条：标题行在 16px 下会把类型名（small）从词中间断开，让它整段下移 */',
        'html.ac-font-qiuye .hud-tile__hd { flex-wrap: wrap; row-gap: 2px; }',
        '',
        '/* 6. 侧栏按字号等比加宽：26vw（374px@1440）是按 10.5px 表格字排的，账本 9 列在 16px 下',
        ' *    溢出 96px，把最重要的「Σ总」列裁掉了。字大 45%，栏也该宽一档 ——',
        ' *    提到 31vw（446px@1440，上限 470px），账本 + 表格内距收紧后刚好放得下。',
        ' *    代价是棋盘少 72px，可接受；棋盘是 minmax(0,1fr) 弹性列，不会破版。 */',
        'html.ac-font-qiuye .hud-shell { grid-template-columns: minmax(0, 1fr) clamp(360px, 31vw, 470px); }',
        'html.ac-font-qiuye .hud-side .ac-table thead th,',
        'html.ac-font-qiuye .hud-side .ac-table tbody td { padding: 4px 1px; }',
        '',
        '/* 7. 面板标题：emoji 的行框比汉字高，16px 下底部被裁 13px，放宽行框 */',
        'html.ac-font-qiuye .hud-side .ac-panel__hd { line-height: 1.45; }',
        '',
    ]

    OUT.write_text('\n'.join(blocks), encoding='utf-8')
    size = OUT.stat().st_size
    print(f'写出 {OUT.relative_to(REPO)}  {size / 1024:.1f} KB')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
