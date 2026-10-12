#!/usr/bin/env python3
"""map.mkf 抽取与逆向侦察。

用途（一次性逆向工具，产物进 shared/src/maps/）：
  1. inventory：列出容器所有块（偏移 / 原始大小 / 压缩后大小 / RAW 或 CMP）
  2. dump：把指定块导出成 .bin（CMP 走 mkfdec.exe 的私有霍夫曼解压）
  3. probe：拿 docs/assets/board-svg/mapN.svg 里的繁体地名当 oracle，在块内搜 BIG5 字节，
     按命中偏移的排布反推名字表步长 —— 这是逆出节点记录布局的入口

容器格式见 docs/extraction/help.mkf_拆解报告.md 与
.scratch/mkf-parser/mkf-resource-parser/references/mkf_format.md（同源）。

用法：
  python tools/extract_map_mkf.py                       # 默认 docs/extraction/raw/map.mkf
  python tools/extract_map_mkf.py --dump 1,3,5,7,9,11,13,15
  python tools/extract_map_mkf.py --probe 1
"""
import argparse
import re
import struct
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_MKF = ROOT / 'docs/extraction/raw/map.mkf'
SVG_DIR = ROOT / 'docs/assets/board-svg'
OUT_DIR = ROOT / 'docs/extraction/raw/map_blocks'
# 原版 8 张地图所在的块号（见每张 SVG 标题「map.mkf 块 #N」）
MAP_BLOCKS = [1, 3, 5, 7, 9, 11, 13, 15]
MKFDEC_CANDIDATES = [
    ROOT / '.scratch/mkf-parser/mkf-resource-parser/scripts/mkfdec.exe',
    ROOT / 'tools/mkf/mkfdec.exe',
]


def find_mkfdec() -> Path | None:
    for p in MKFDEC_CANDIDATES:
        if p.exists():
            return p
    return None


def read_index(mkf: Path) -> tuple[list[dict], bytes]:
    raw = mkf.read_bytes()
    table_off = struct.unpack_from('<I', raw, 0)[0]
    n = (len(raw) - table_off) // 4
    offs = struct.unpack_from(f'<{n}I', raw, table_off)
    chunks = []
    for i, off in enumerate(offs):
        end = offs[i + 1] if i + 1 < n else len(raw)
        uncomp, comp, f2, f3 = struct.unpack_from('<4I', raw, off)
        chunks.append({
            'idx': i, 'off': off, 'disk': end - off, 'uncomp': uncomp, 'comp': comp,
            'f2': f2, 'f3': f3, 'kind': 'RAW' if uncomp == comp else 'CMP',
        })
    return chunks, raw


def body(mkf: Path, chunks: list[dict], raw: bytes, idx: int, mkfdec: Path | None) -> bytes:
    c = chunks[idx]
    start = c['off'] + 16
    if c['kind'] == 'RAW':
        return raw[start:start + c['uncomp']]
    if mkfdec is None:
        sys.exit(f'块 #{idx} 是 CMP（{c["comp"]}→{c["uncomp"]} 字节），但找不到 mkfdec.exe。'
                 f'先编译 .scratch/mkf-parser/mkf-resource-parser/scripts/mkfdec.c')
    out = OUT_DIR / f'chunk{idx}.decompressed.bin'
    subprocess.run([str(mkfdec), str(mkf), str(idx), str(out)], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return out.read_bytes()


def svg_labels(map_no: int) -> list[str]:
    svg = (SVG_DIR / f'map{map_no}.svg').read_text(encoding='utf-8')
    return sorted(set(re.findall(r'>([^<>]+)</text>', svg)))


def probe(data: bytes, labels: list[str]) -> None:
    """BIG5 搜地名：命中偏移的等差排布就是名字表，公差即记录步长"""
    hits = []
    for name in labels:
        try:
            needle = name.encode('big5')
        except UnicodeEncodeError:
            continue
        pos = data.find(needle)
        if pos >= 0:
            hits.append((pos, name, data.count(needle)))
    hits.sort()
    print(f'  命中 {len(hits)} / {len(labels)} 个地名')
    for pos, name, cnt in hits[:40]:
        print(f'    0x{pos:06x}  {name}  (块内出现 {cnt} 次)')
    if len(hits) >= 3:
        strides: dict[int, int] = {}
        for a, b in zip(hits, hits[1:]):
            d = b[0] - a[0]
            if 0 < d < 4096:
                strides[d] = strides.get(d, 0) + 1
        top = sorted(strides.items(), key=lambda kv: -kv[1])[:6]
        print(f'  相邻命中偏移差（候选记录步长）：{top}')


class Tee:
    """报告同时进控制台和文件：本机控制台代码页不可靠，文件才是准的"""

    def __init__(self, stream, path: Path):
        self.stream = stream
        self.fh = path.open('w', encoding='utf-8')

    def write(self, s):
        self.stream.write(s)
        self.fh.write(s)
        return len(s)

    def flush(self):
        self.stream.flush()
        self.fh.flush()

    def __getattr__(self, name):
        return getattr(self.stream, name)


def main() -> None:
    # 本机控制台不是 UTF-8 代码页，中文报告直接 print 会成乱码 —— 见 mkf-resource-parser SKILL 的同一坑
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    ap = argparse.ArgumentParser()
    ap.add_argument('--mkf', default=str(DEFAULT_MKF))
    ap.add_argument('--dump', help='逗号分隔的块号，导出到 %s' % OUT_DIR)
    ap.add_argument('--probe', type=int, help='对某个块跑地名 BIG5 搜索')
    ap.add_argument('--out', help='同时把报告写进这个文件（控制台不可读时用）')
    args = ap.parse_args()
    if args.out:
        p = Path(args.out)
        p.parent.mkdir(parents=True, exist_ok=True)
        sys.stdout = Tee(sys.stdout, p)

    mkf = Path(args.mkf)
    if not mkf.exists():
        sys.exit(f'找不到 {mkf}\n把原版 map.mkf 拷到 docs/extraction/raw/ 下（该目录已 gitignore，'
                 f'原版资源不入库）')
    chunks, raw = read_index(mkf)
    print(f'{mkf.name}: {len(raw):,} 字节 · {len(chunks)} 块 · '
          f'RAW {sum(1 for c in chunks if c["kind"] == "RAW")} / '
          f'CMP {sum(1 for c in chunks if c["kind"] == "CMP")}')
    print('  idx      off     disk      uncomp    comp      kind  sig')
    for c in chunks:
        sig = raw[c['off'] + 16:c['off'] + 20]
        sig_s = sig.decode('latin-1').strip('\x00') if all(32 <= b < 127 or b == 0 for b in sig) else ''
        mark = ' <-- 地图' if c['idx'] in MAP_BLOCKS else ''
        print(f"  #{c['idx']:<3} {c['off']:>9} {c['disk']:>9} {c['uncomp']:>9} {c['comp']:>9}  "
              f"{c['kind']:<4} {repr(sig)} {sig_s!r}{mark}")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    mkfdec = find_mkfdec()
    todo = [int(x) for x in args.dump.split(',')] if args.dump else MAP_BLOCKS
    for idx in todo:
        data = body(mkf, chunks, raw, idx, mkfdec)
        out = OUT_DIR / f'block{idx}.bin'
        out.write_bytes(data)
        print(f'块 #{idx} → {out.name}  {len(data):,} 字节  首 4 字节 {data[:4]!r}')

    if args.probe is not None:
        data = body(mkf, chunks, raw, args.probe, mkfdec)
        map_no = MAP_BLOCKS.index(args.probe) if args.probe in MAP_BLOCKS else 0
        print(f'\n== probe 块 #{args.probe}（地图 {map_no}），oracle = map{map_no}.svg 的地名 ==')
        probe(data, svg_labels(map_no))


if __name__ == '__main__':
    main()
