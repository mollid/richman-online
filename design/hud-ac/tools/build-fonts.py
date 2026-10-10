#!/usr/bin/env python
"""把设计稿要的字体落到 `client/public/fonts/`：下载 → 子集化 → 按 unicode-range 分片 → 生成 @font-face。

## 为什么不用 Google Fonts 的 <link>

1. `fonts.gstatic.com` 在国内基本连不通 —— 实测每次加载产生 50+ 条 `ERR_CONNECTION_CLOSED`，
   还会拖住 `document.fonts.ready`；
2. **更要命的是中文根本没生效**：`ac.css` 的字体栈是 `'M PLUS Rounded 1c', system-ui, sans-serif`，
   而 M PLUS Rounded 1c 是**日文字体**（8201 个码位）。实测界面用到的 1531 个中文字里它只覆盖
   1040 个（67.9%），其余逐字回退到 system-ui —— 同一个词里一半圆体一半系统字。

## 解法

中文交给**狮尾圆体 Swei Spring**（42858 码位，本项目用字 100% 覆盖），
拉丁与数字仍用设计稿指定的 M PLUS Rounded 1c / Nunito。

中文全量是 17MB/字重，不可能直接上网页；所以按 `unicode-range` 切三片，
浏览器**只下载实际用到的那片**：

| 片 | 内容 | 什么时候下载 |
| --- | --- | --- |
| hot | 项目源码里真实出现的字 | 立刻（界面文字全在这一片） |
| common | GB2312 一级字库（3755 常用字）里的其余 | 玩家昵称里出现了未见于源码的常用字时 |
| rare | GB2312 二级字库（生僻字）里的其余 | 极少数生僻昵称 |

## 用法

    python design/hud-ac/tools/build-fonts.py            # 缓存命中就跳过下载
    python design/hud-ac/tools/build-fonts.py --clean    # 重新下载

下载源缓存在仓库根的 `.font-cache/`（已 gitignore），不往仓库里塞 17MB 的源文件。
"""
from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
OUT = REPO / 'client' / 'public' / 'fonts'
CACHE = REPO / '.font-cache'

# 参与热片统计的源码范围。
#
# 这里必须**覆盖所有会产出界面可见文字的目录**，漏一个就会有一个字掉进 common 片，
# 让首屏白白多下 388KB。踩过的坑：最初只扫了 client/src/{ui,game} + shared/src，
# 于是「阿福」（热座默认玩家名，定义在 client/src/net/session.ts 与 server/src/rooms/GameRoom.ts）
# 不在热片里 —— 一个「阿」字把整整一片 common 拽了下来（实测 388KB）。
#
# 宁可多扫：多扫进来的字只让热片大几 KB，漏扫却是几百 KB 的代价。
CORPUS_DIRS = [
    REPO / 'client' / 'public',      # ac-hud 原型 HUD 本体 + 静态页
    REPO / 'client' / 'src',         # 含 net / ui / game / styles.css
    REPO / 'shared' / 'src',         # 规则与文案（卡牌、新闻、棋盘格子名）
    REPO / 'server' / 'src',         # 机器人名、服务端错误文案（会透传到界面）
]
SCAN_SUFFIX = {'.js', '.jsx', '.ts', '.tsx', '.mjs', '.mts', '.css', '.html', '.json'}

# ---------------------------------------------------------------- 字体来源
# 许可全部为 SIL Open Font License 1.1，可商用、可自托管、可子集化。
# OFL 要求分发字体时随附授权原文，故每个源都带 license_url，由 write_licenses() 落地。
SOURCES: dict[str, dict] = {
    'swei-bold': {
        'url': 'https://cdn.jsdelivr.net/gh/max32002/swei-spring@master/CJK%20SC/SweiSpringCJKsc-Bold.ttf',
        'file': 'SweiSpringCJKsc-Bold.ttf',
        'license': 'SIL Open Font License 1.1',
        'license_url': 'https://cdn.jsdelivr.net/gh/max32002/swei-spring@master/SIL_Open_Font_License_1.1.txt',
        'home': 'https://github.com/max32002/swei-spring',
        'note': '狮尾圆体 简中 Bold —— 中文主力（圆体，和 ac 皮肤的圆角风格一致）',
    },
    'swei-black': {
        'url': 'https://cdn.jsdelivr.net/gh/max32002/swei-spring@master/CJK%20SC/SweiSpringCJKsc-Black.ttf',
        'file': 'SweiSpringCJKsc-Black.ttf',
        'license': 'SIL Open Font License 1.1',
        'license_url': 'https://cdn.jsdelivr.net/gh/max32002/swei-spring@master/SIL_Open_Font_License_1.1.txt',
        'home': 'https://github.com/max32002/swei-spring',
        'note': '狮尾圆体 简中 Black —— 接 800/900 两档字重',
    },
    'mplus-bold': {
        'url': 'https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/mplusrounded1c/MPLUSRounded1c-Bold.ttf',
        'file': 'MPLUSRounded1c-Bold.ttf',
        'license': 'SIL Open Font License 1.1',
        'license_url': 'https://cdn.jsdelivr.net/gh/coz-m/mplus_fonts@master/OFL.txt',
        'home': 'https://github.com/coz-m/mplus_fonts',
        'note': 'M PLUS Rounded 1c Bold —— 只取拉丁与数字（设计稿指定的拉丁字形）',
    },
    'mplus-extrabold': {
        'url': 'https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/mplusrounded1c/MPLUSRounded1c-ExtraBold.ttf',
        'file': 'MPLUSRounded1c-ExtraBold.ttf',
        'license': 'SIL Open Font License 1.1',
        'license_url': 'https://cdn.jsdelivr.net/gh/coz-m/mplus_fonts@master/OFL.txt',
        'home': 'https://github.com/coz-m/mplus_fonts',
        'note': 'M PLUS Rounded 1c ExtraBold —— 只取拉丁与数字',
    },
    'nunito': {
        'url': 'https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/nunito/Nunito%5Bwght%5D.ttf',
        'file': 'Nunito-wght.ttf',
        'license': 'SIL Open Font License 1.1',
        'license_url': 'https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/nunito/OFL.txt',
        'home': 'https://github.com/googlefonts/nunito',
        'note': 'Nunito 可变字体 —— 金额与数值专用（设计稿 --ac-num）',
    },
    # 像素字体：官方已按语言切好，zh_hans 同时覆盖简繁，直接整包自托管
    'fusion-pixel': {
        'url': 'https://github.com/TakWolf/fusion-pixel-font/releases/download/2026.09.25/fusion-pixel-font-12px-proportional-otf.woff2-v2026.09.25.zip',
        'file': 'fusion-pixel-12px.zip',
        'license': 'SIL Open Font License 1.1',
        'license_url': None,        # 授权原文在 zip 里（OFL.txt），单独取
        'home': 'https://github.com/TakWolf/fusion-pixel-font',
        'note': '缝合像素字体 12px 比例版 —— 方舟像素缺「骰窗券即」，缝合版补齐了',
    },
    # 16px 点阵圆体。原文件 4.1MB / 13646 码位，且带内嵌 1-bit 位图（bloc/bdat），
    # 所以必须子集化；子集后位图仍会被保留。版本钉死在 v1.0.0，理由见 README。
    #
    # `local` 是这个字体的特例：作者只发 GitHub Release，而用户已经手动下了一份放在
    # assets/ 里，构建时**优先用它** —— 离线可跑，以后换字体只要替换文件重跑，不必改脚本。
    # 经比对，用户的这份与官方 v1.0.0 逐字节相同（sha256 0b3f941ba1224f26…）。
    'qiuye-round': {
        'url': 'https://github.com/yzdnn/QiuYeYuanTi-16/releases/download/v1.0.0/QiuYeYuanTi-16.ttf',
        'file': 'QiuYeYuanTi-16.ttf',
        'local': REPO / 'assets' / 'QiuYeYuanTi-16.ttf',
        'license': 'SIL Open Font License 1.1',
        'license_url': 'https://cdn.jsdelivr.net/gh/yzdnn/qiuyeyuanti-16@master/OFL.txt',
        'home': 'https://github.com/yzdnn/qiuyeyuanti-16',
        'note': '秋叶圆体 16 —— 16px 点阵圆体（基于日本 KHドット秋葉原16 增补简繁汉字）',
    },
}
PIXEL_ZIP_MEMBER = 'fusion-pixel-12px-proportional-zh_hans.otf.woff2'


def log(msg: str) -> None:
    print(msg, flush=True)


def fetch(key: str, clean: bool) -> Path:
    src = SOURCES[key]
    CACHE.mkdir(parents=True, exist_ok=True)
    dest = CACHE / src['file']

    # 本地优先：仓库里已有一份源文件（比如用户手动下的字体）时，不联网。
    # 这样构建可以离线跑，也方便换字体 —— 替换文件重跑即可，不必改脚本或 URL。
    local = src.get('local')
    if local is not None and local.exists():
        shutil.copyfile(local, dest)
        log(f'  本地 {local.relative_to(REPO)}  →  {dest.name}  ({dest.stat().st_size / 1048576:.2f}MB)')
        return dest

    if dest.exists() and not clean:
        log(f'  缓存命中 {dest.name}  ({dest.stat().st_size / 1048576:.1f}MB)')
        return dest
    log(f'  下载 {src["note"]}')
    log(f'       {src["url"]}')
    req = urllib.request.Request(src['url'], headers={'User-Agent': 'richman-online-font-build'})
    with urllib.request.urlopen(req, timeout=600) as r, dest.open('wb') as f:
        shutil.copyfileobj(r, f)
    log(f'      → {dest.name}  {dest.stat().st_size / 1048576:.2f}MB')
    return dest


def subset(src: Path, dest: Path, *, text_file: Path | None = None, unicodes: str | None = None,
           flavor: str = 'woff2') -> int:
    """跑 pyftsubset。`text_file` 与 `unicodes` 二选一（字体内部两者互斥）。"""
    cmd = [
        sys.executable, '-m', 'fontTools.subset', str(src),
        f'--flavor={flavor}',
        f'--output-file={dest}',
        '--layout-features=*',      # 保留全部排版特性，CJK 的竖排/全角标点靠它
        '--name-IDs=*',
        '--drop-tables+=DSIG',
        '--no-hinting',             # 网页场景用不到，去掉显著减小体积
        '--desubroutinize',
    ]
    if text_file is not None:
        cmd.append(f'--text-file={text_file}')
    if unicodes is not None:
        cmd.append(f'--unicodes={unicodes}')
    subprocess.run(cmd, check=True, capture_output=True)
    return dest.stat().st_size


# ---------------------------------------------------------------- 字符集
def gb2312_chars() -> tuple[set[str], set[str]]:
    """返回 (一级字库, 二级字库)。GB2312 一级=常用字 3755 个，二级=生僻字 3008 个。"""
    level1: set[str] = set()
    level2: set[str] = set()
    for hi in range(0xB0, 0xF8):
        for lo in range(0xA1, 0xFF):
            try:
                ch = bytes([hi, lo]).decode('gb2312')
            except UnicodeDecodeError:
                continue
            (level1 if hi < 0xD8 else level2).add(ch)
    return level1, level2


# 值得进字体的中文区间。界面里的 emoji（🔍 🗺 📈 …）落在 CJK 之外，
# 中文字体根本没有这些字形；若不剔掉，它们会被写进 unicode-range 白白撑大 CSS。
CJK_RANGES = (
    (0x3000, 0x303F),   # CJK 标点
    (0x3400, 0x4DBF),   # 扩展 A
    (0x4E00, 0x9FFF),   # 基本区
    (0xF900, 0xFAFF),   # 兼容表意
    (0xFF00, 0xFFEF),   # 全角形式
)


def is_cjk(ch: str) -> bool:
    cp = ord(ch)
    return any(lo <= cp <= hi for lo, hi in CJK_RANGES)


def corpus_chars() -> set[str]:
    """扫源码收集真实出现的汉字与中文标点。ASCII 交给拉丁字体，不在这里。"""
    chars: set[str] = set()
    for d in CORPUS_DIRS:
        if not d.exists():
            continue
        for p in d.rglob('*'):
            if p.suffix not in SCAN_SUFFIX or not p.is_file():
                continue
            try:
                text = p.read_text(encoding='utf-8', errors='ignore')
            except OSError:
                continue
            chars.update(ch for ch in text if is_cjk(ch))
    return chars


# 拉丁 + 数字 + 常用符号（M+/Nunito 的取字范围）
LATIN_UPLUS = (
    'U+0020-007E,U+00A0-00FF,U+0100-017F,'   # 基本拉丁 / 拉丁补充 / 拉丁扩展A
    'U+2000-206F,U+20A0-20BF,'               # 通用标点 / 货币符号
    'U+2190-21FF,U+2200-22FF,U+25A0-25FF,U+2600-26FF,'  # 箭头 / 数学 / 几何 / 杂项（界面图标常用）
    'U+3000-303F,U+FF00-FFEF'                # CJK 标点 / 全角形式
)


def cmap_of(path: Path) -> set[int]:
    """读字体的 cmap 码位集合，用来判断「想收的字它到底有没有」。"""
    from fontTools.ttLib import TTFont

    f = TTFont(path, lazy=True)
    cps: set[int] = set()
    for t in f['cmap'].tables:
        cps |= set(t.cmap.keys())
    return cps


def pixel_chars() -> set[str]:
    """像素字体要收的字。

    这里和中文圆体的「三片 + 按需下载」策略不同：像素字体是**整包**给的 —— 它既要显示界面
    文案，也要显示玩家自由输入的昵称，而昵称无法预测。所以除了项目语料，还把 GB2312
    一/二级整包（6763 个汉字）连 ASCII 与全角符号一起收进来，一次把常见中文输入封顶。
    """
    chars = corpus_chars()
    lvl1, lvl2 = gb2312_chars()
    chars |= lvl1 | lvl2
    chars |= {chr(c) for c in range(0x20, 0x7F)}                   # ASCII
    chars |= {chr(0xFF00 + c - 0xA0) for c in range(0xA1, 0xFE)}   # 全角形式
    chars |= set('　·—…“”‘’、。〈〉《》「」『』【】〔〕')
    return chars


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--clean', action='store_true', help='忽略缓存，重新下载')
    args = ap.parse_args()

    # 先清干净上一次的产物。踩过的坑：改了分片策略后，旧文件（比如不再生成的
    # fusion-pixel-12px-latin.woff2）会一直留在 public/ 里被一起打进镜像，白占 650KB。
    if OUT.exists():
        stale = sorted(p.name for p in OUT.rglob('*') if p.is_file())
        shutil.rmtree(OUT)
        if stale:
            log(f'清理上一次产物 {len(stale)} 个文件')
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / 'pixel').mkdir(exist_ok=True)
    CACHE.mkdir(parents=True, exist_ok=True)

    log('=== 1/4 准备源文件 ===')
    swei_bold = fetch('swei-bold', args.clean)
    swei_black = fetch('swei-black', args.clean)
    mplus_bold = fetch('mplus-bold', args.clean)
    mplus_eb = fetch('mplus-extrabold', args.clean)
    nunito = fetch('nunito', args.clean)
    pixel_zip = fetch('fusion-pixel', args.clean)
    qiuye = fetch('qiuye-round', args.clean)

    log('=== 2/4 切分中文字符集 ===')
    hot = corpus_chars()
    lvl1, lvl2 = gb2312_chars()
    common = lvl1 - hot
    rare = lvl2 - hot
    for name, s in (('hot', hot), ('common', common), ('rare', rare)):
        (CACHE / f'chars-{name}.txt').write_text(''.join(sorted(s)), encoding='utf-8')
        log(f'  {name:7} {len(s):5} 字')

    log('=== 3/4 子集化中文（狮尾圆体，按 unicode-range 分片）===')
    swei_out = []
    for weight, src in ((700, swei_bold), (900, swei_black)):
        for slice_name in ('hot', 'common', 'rare'):
            dest = OUT / f'swei-round-{weight}-{slice_name}.woff2'
            size = subset(src, dest, text_file=CACHE / f'chars-{slice_name}.txt')
            swei_out.append((weight, slice_name, size))
            log(f'  {dest.name:32} {size / 1024:8.1f} KB')

    log('=== 4/4 子集化拉丁（M+ / Nunito，只留拉丁数字与符号）===')
    mplus_out = []
    for weight, src in ((700, mplus_bold), (800, mplus_eb)):
        dest = OUT / f'mplus-rounded-{weight}.woff2'
        size = subset(src, dest, unicodes=LATIN_UPLUS)
        mplus_out.append((weight, size))
        log(f'  {dest.name:32} {size / 1024:8.1f} KB')
    nunito_dest = OUT / 'nunito-var.woff2'
    nunito_size = subset(nunito, nunito_dest, unicodes=LATIN_UPLUS)
    log(f'  {nunito_dest.name:32} {nunito_size / 1024:8.1f} KB')

    # 像素字体：官方虽按语言切了包，但实测各语言构建**体积几乎一致**
    # （latin 651.7KB / zh_hans 650.6KB / zh_tw 659.2KB），说明并没有真的做语言裁剪，
    # zh_hans 本身已含拉丁。同时发两份只是白扔 650KB，故只留 zh_hans。
    log('=== 落地像素字体 ===')
    import zipfile
    with zipfile.ZipFile(pixel_zip) as z:
        for member, out_name in ((PIXEL_ZIP_MEMBER, 'fusion-pixel-12px-zh_hans.woff2'),
                                 ('OFL.txt', 'OFL.txt')):
            data = z.read(member)
            (OUT / 'pixel' / out_name).write_bytes(data)
            log(f'  {out_name:40} {len(data) / 1024:8.1f} KB')

    # 秋叶圆体要子集化：原文件 4.1MB / 13646 码位，其中一半以上（如日文假名、IBM 扩张文字）
    # 本项目用不到。注意它带内嵌 1-bit 位图（bloc/bdat）——实测能扛过子集化与 woff2 转换，
    # 所以子集里位图仍在（Linux/Firefox 那类会读内嵌位图的实现能拿到真点阵）。
    qiuye_ok = cmap_of(qiuye)
    px = pixel_chars()
    px_fit = {c for c in px if ord(c) in qiuye_ok}
    px_txt = CACHE / 'chars-pixel.txt'
    px_txt.write_text(''.join(sorted(px_fit)), encoding='utf-8')
    dropped = len(px) - len(px_fit)
    log(f'  想收 {len(px)} 字 → 原字体有 {len(px_fit)} 字'
        + (f'（缺 {dropped} 个，已自动剔除）' if dropped else ''))
    qiuye_dest = OUT / 'pixel' / 'qiuye-round-16.woff2'
    qiuye_size = subset(qiuye, qiuye_dest, text_file=px_txt, flavor='woff2')
    log(f'  {qiuye_dest.name:40} {qiuye_size / 1024:8.1f} KB')

    log('=== 生成 @font-face ===')
    verify_disjoint(hot, common, rare)
    write_css(hot, common, rare, swei_out, mplus_out, nunito_size)
    write_licenses()

    log('\n=== 首屏字体预算（界面文字全在 hot 片）===')
    first_paint = sum(sz for w, s, sz in swei_out if s == 'hot') + sum(sz for _, sz in mplus_out) + nunito_size
    log(f'  hot ×2 字重 + 拉丁 + 数字 = {first_paint / 1024:.0f} KB')
    log(f'  仅在被触发时才下的：common {sum(sz for w, s, sz in swei_out if s == "common") / 1024:.0f} KB'
        f' · rare {sum(sz for w, s, sz in swei_out if s == "rare") / 1024:.0f} KB')
    log(f'  像素字体（也只在真的用到时才下）：缝合像素 12px 650 KB · 秋叶圆体 16px {qiuye_size / 1024:.0f} KB')
    log(f'\n完成。产物在 {OUT.relative_to(REPO)}')
    return 0


def to_unicode_range(chars: set[str]) -> str:
    """把字符集压成 unicode-range：连续码位合并成区间，不连续就各占一段。

    ⚠️ 不要"为了省 CSS 字节"去合并相邻区间（把 gap ≤ N 的码位并进同一段）。
    试过一次，翻车了：合并会让 hot / common / rare 三片的区间**互相重叠**，
    而同一个字命中多个分片时浏览器取最后声明的那个 —— 结果是界面每渲染一个字，
    三片都被认为可能用到，于是 6 个 CJK 分片（2.4MB）全下载，整个分片策略白做。
    收益（CSS 90KB → 33KB）远小于代价（首屏 430KB → 2.8MB）。

    精确区间的另一个好处是可证不相交：hot/common/rare 按定义就是划分，
    所以任何一个字只可能命中一片，只可能触发一次下载。
    """
    cps = sorted(ord(c) for c in chars)
    ranges: list[list[int]] = []
    for cp in cps:
        if ranges and cp == ranges[-1][1] + 1:
            ranges[-1][1] = cp
        else:
            ranges.append([cp, cp])
    return ','.join(f'U+{a:X}' if a == b else f'U+{a:X}-{b:X}' for a, b in ranges)


def verify_disjoint(hot, common, rare) -> None:
    """自检：三片的 unicode-range 必须两两不相交。

    这是分片策略能成立的前提，但它是**静默失效**的 —— 区间一旦重叠，浏览器会对同一个字
    命中多片（取最后声明的那个），表现只是"三片都下载"，界面上完全看不出来。所以在这里显式拦一道。
    """
    covers = {name: {cp for lo, hi in _ranges(s) for cp in range(lo, hi + 1)}
              for name, s in (('hot', hot), ('common', common), ('rare', rare))}
    for a, b in (('hot', 'common'), ('hot', 'rare'), ('common', 'rare')):
        inter = covers[a] & covers[b]
        if inter:
            sample = ''.join(chr(c) for c in sorted(inter)[:12])
            raise SystemExit(f'✗ {a} 与 {b} 的 unicode-range 重叠 {len(inter)} 个码位：{sample} …')
    log('  自检通过：三片 unicode-range 两两不相交')


def _ranges(chars: set[str]) -> list[tuple[int, int]]:
    cps = sorted(ord(c) for c in chars)
    out: list[list[int]] = []
    for cp in cps:
        if out and cp == out[-1][1] + 1:
            out[-1][1] = cp
        else:
            out.append([cp, cp])
    return [(a, b) for a, b in out]


def write_css(hot, common, rare, swei_out, mplus_out, nunito_size) -> None:
    hot_r, common_r, rare_r = (to_unicode_range(s) for s in (hot, common, rare))
    swei_files = {(w, s): sz for w, s, sz in swei_out}
    parts: list[str] = [
        '/* 本文件由 design/hud-ac/tools/build-fonts.py 生成，不要手改。',
        ' * 全部字体为 SIL Open Font License 1.1，可商用可自托管。授权原文见同目录 LICENSE-*.txt。',
        ' *',
        ' * 中文 = 狮尾圆体（圆体，匹配 ac 皮肤的圆角风格），按 unicode-range 切三片：',
        ' *   hot    项目源码里真实出现的字 —— 界面文字全在这一片，首屏就下它',
        ' *   common GB2312 一级常用字里 hot 之外的 —— 只在玩家昵称出现新字时才拉',
        ' *   rare   GB2312 二级生僻字 —— 同上，极少数情况',
        ' * 拉丁与数字 = M PLUS Rounded 1c（设计稿指定）+ Nunito（金额）。',
        ' */',
        '',
        '/* ---------- 中文：狮尾圆体 Swei Spring ---------- */',
    ]
    for weight in (700, 900):
        for slice_name, rng in (('hot', hot_r), ('common', common_r), ('rare', rare_r)):
            key = (weight, slice_name)
            if key not in swei_files:
                continue
            parts += [
                '@font-face {',
                "  font-family: 'Swei Spring CJKsc';",
                '  font-style: normal;',
                f'  font-weight: {weight};',
                '  font-display: swap;',
                f'  src: url(./swei-round-{weight}-{slice_name}.woff2) format("woff2");',
                f'  unicode-range: {rng};',
                '}',
                '',
            ]

    parts.append('/* ---------- 拉丁与数字 ---------- */')
    for weight, size in mplus_out:
        parts += [
            '@font-face {',
            "  font-family: 'M PLUS Rounded 1c';",
            '  font-style: normal;',
            f'  font-weight: {weight};',
            '  font-display: swap;',
            f'  src: url(./mplus-rounded-{weight}.woff2) format("woff2");',
            f'  unicode-range: {LATIN_UPLUS};',
            '}',
            '',
        ]
    parts += [
        '@font-face {',
        '  font-family: \'Nunito\';',
        '  font-style: normal;',
        '  font-weight: 200 1000;',
        '  font-display: swap;',
        '  src: url(./nunito-var.woff2) format("woff2");',
        f'  unicode-range: {LATIN_UPLUS};',
        '}',
        '',
    ]
    (OUT / 'fonts.css').write_text('\n'.join(parts), encoding='utf-8')

    # 像素字体单独一份，给 design/w98-pixel 用
    pixel_css = [
        '/* 本文件由 design/hud-ac/tools/build-fonts.py 生成，不要手改。',
        ' * 两款像素字体，均为 SIL Open Font License 1.1，可商用可自托管：',
        ' *   Fusion Pixel 12px  缝合像素 12px 比例版 —— 主力，笔画纯黑实心',
        ' *   QiuYe Round 16     秋叶圆体 16        —— 备选，圆润、笔画带 1px 灰边',
        ' *',
        ' * 像素字体的使用前提（否则会糊）：',
        ' *   1. font-size 必须是设计字号的**整数倍**（缝合 12/24/36px；秋叶 16/32px），不要用 13px 这种；',
        ' *   2. 关抗锯齿：-webkit-font-smoothing: none; font-smooth: never;',
        ' *   3. line-height 也取整数像素；',
        ' *   4. 如果用 canvas 绘制，贴图要 scaleMode: NEAREST / image-rendering: pixelated。',
        ' *',
        ' * 为什么主力选缝合版而不是方舟：方舟像素 12px 简中缺「骰窗券即筑毁旋姿旅斜」——',
        ' * 对一个《大富翁》来说缺「骰」是致命的。缝合版补上了这些，还顺带带繁体。',
        ' *',
        ' * 秋叶圆体为什么只是备选：它 16px 是设计字号，但字体虽带内嵌 16px 1-bit 位图',
        ' * （bloc/bdat 表），实测 **Chrome on Windows 并不使用内嵌位图、走矢量轮廓** ——',
        ' * 1:1 截图的像素裁决是「笔画中间 1 像素 + 两侧灰边」，比缝合像素的实心纯黑要虚。',
        ' * 它的优势是字形更圆润、覆盖到 GB2312 全集 + 常用繁体，适合当「圆体像素」口味。',
        ' */',
        '',
        '@font-face {',
        "  font-family: 'Fusion Pixel 12px';",
        '  font-style: normal;',
        '  font-weight: 400;',
        '  font-display: swap;',
        '  src: url(./fusion-pixel-12px-zh_hans.woff2) format("woff2");',
        '  /* zh_hans 构建同时覆盖简繁与拉丁，不必再切分片 */',
        '}',
        '',
        '@font-face {',
        "  font-family: 'QiuYe Round 16';",
        '  font-style: normal;',
        '  font-weight: 400;',
        '  font-display: block;',
        '  src: url(./qiuye-round-16.woff2) format("woff2");',
        '  /* 16px 是唯一原生字号，32px 是整数倍放大；其余字号点阵会被重采样糊掉。',
        '   * 它带内嵌 16px 1-bit 位图，但 Chrome/Windows 不读（见文件头注释），故 16px 下边缘发虚。 */',
        '}',
        '',
        '/* 授权：Fusion Pixel 12px —— SIL OFL 1.1，原文见同目录 OFL.txt。',
        ' * 上游整合了三个开源像素字体的字形，各自授权见 fusion-pixel-font 仓库 LICENSES/：',
        ' *   ark-pixel (方舟像素) · cubic-11 · galmuri  —— 均为 OFL 1.1。',
        ' * 授权：QiuYe Round 16 —— SIL OFL 1.1，原文见 ../licenses/OFL-qiuye-round.txt。',
        ' * 上游 github.com/yzdnn/qiuyeyuanti-16，血统是日本 KHドット秋葉原16 (Sharp X68000)。',
        ' */',
        '',
    ]
    (OUT / 'pixel' / 'fonts.css').write_text('\n'.join(pixel_css), encoding='utf-8')


def write_licenses() -> None:
    """OFL 要求随字体分发授权原文。抓一份放 `fonts/licenses/`，并生成 NOTICE 交代来源。"""
    lic_dir = OUT / 'licenses'
    lic_dir.mkdir(exist_ok=True)
    rows: list[str] = [
        '# 字体来源与授权',
        '',
        '本目录下的字体文件均由 `design/hud-ac/tools/build-fonts.py` 从上游下载、子集化后生成。',
        '全部为 **SIL Open Font License 1.1**，允许商用、自托管、子集化与再分发。',
        'OFL 要求分发时随附授权原文，各字体的授权文件见本目录同名 `.txt`。',
        '',
        '| 字体 | 用途 | 上游 | 授权 |',
        '| --- | --- | --- | --- |',
    ]
    seen: dict[str, str] = {}
    for key, src in SOURCES.items():
        lic_url = src.get('license_url')
        if lic_url and lic_url not in seen:
            name = f'OFL-{key}.txt'
            try:
                req = urllib.request.Request(lic_url, headers={'User-Agent': 'richman-online-font-build'})
                with urllib.request.urlopen(req, timeout=120) as r:
                    (lic_dir / name).write_bytes(r.read())
                seen[lic_url] = name
            except Exception as e:      # noqa: BLE001 — 抓不到不影响字体本身
                log(f'  ! 授权原文抓取失败 {key}: {e}')
                name = '（未抓到，见上游仓库）'
        else:
            name = seen.get(lic_url, '见上游仓库') if lic_url else '见 pixel/OFL.txt'
        rows.append(f'| {key} | {src["note"]} | {src["home"]} | {name} |')
    (lic_dir / 'NOTICE.md').write_text('\n'.join(rows) + '\n', encoding='utf-8')
    log(f'  授权原文 {len(seen)} 份 → fonts/licenses/')


if __name__ == '__main__':
    raise SystemExit(main())