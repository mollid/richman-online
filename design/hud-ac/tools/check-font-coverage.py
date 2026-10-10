"""实测某个字体文件对本项目实际用到的中文字符覆盖多少。

用法：
    python check-font-coverage.py <字体文件> [要扫的源码目录...]

为什么需要它：`ac.css` 把界面字体写成了 `'M PLUS Rounded 1c', system-ui, sans-serif`。
M PLUS Rounded 1c 是**日文字体**，如果它其实不含简体汉字，那么"圆体中文"根本就没生效 ——
浏览器会逐字回退到 system-ui，看起来"字体加载了"但中文一点没变。这个脚本把这件事量化。
"""
import sys
import unicodedata
from pathlib import Path

from fontTools.ttLib import TTFont

CJK_RANGES = ((0x4E00, 0x9FFF), (0x3400, 0x4DBF), (0xF900, 0xFAFF), (0x3000, 0x303F), (0xFF00, 0xFFEF))
SCAN_SUFFIX = {'.js', '.ts', '.tsx', '.css', '.html', '.mjs', '.mts'}


def is_cjk(ch: str) -> bool:
    return any(lo <= ord(ch) <= hi for lo, hi in CJK_RANGES)


def collect_corpus(paths):
    chars = {}
    files = []
    for p in paths:
        p = Path(p)
        files.extend(x for x in ([p] if p.is_file() else p.rglob('*')) if x.suffix in SCAN_SUFFIX)
    for f in files:
        try:
            text = f.read_text(encoding='utf-8', errors='ignore')
        except OSError:
            continue
        for ch in text:
            if is_cjk(ch):
                chars[ch] = chars.get(ch, 0) + 1
    return chars


def main():
    font_path = sys.argv[1]
    targets = sys.argv[2:] or ['.']
    font = TTFont(font_path, lazy=True)
    cmap = set()
    for table in font['cmap'].tables:
        cmap |= set(table.cmap.keys())
    name = font['name'].getDebugName(4) or Path(font_path).name

    corpus = collect_corpus(targets)
    if not corpus:
        print('没扫到任何中文字符，检查一下路径')
        return 1

    missing = {c: n for c, n in corpus.items() if ord(c) not in cmap}
    total_use = sum(corpus.values())
    missing_use = sum(missing.values())
    covered_chars = len(corpus) - len(missing)

    print(f'字体文件   : {font_path}')
    print(f'字体名     : {name}')
    print(f'字形总数   : {len(cmap)} 个码位')
    print()
    print(f'界面用到的不同中文字 : {len(corpus)} 个')
    print(f'其中字体里有         : {covered_chars} 个  ({covered_chars / len(corpus) * 100:.1f}%)')
    print(f'字体里没有（回退）   : {len(missing)} 个  ({len(missing) / len(corpus) * 100:.1f}%)')
    print(f'按出现次数加权覆盖   : {(1 - missing_use / total_use) * 100:.1f}%')
    print()
    worst = sorted(missing.items(), key=lambda kv: -kv[1])[:40]
    if worst:
        print('缺得最多的一批（按界面出现次数排序）：')
        print('  ' + ' '.join(f'{c}({n})' for c, n in worst))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
