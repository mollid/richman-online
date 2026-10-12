#!/usr/bin/env python3
"""节点记录字段逆向：拿 SVG 的邻接当已知量，反查 40 字节记录里哪几个 u16 是前后指针、哪个是格型。

前提假设（本脚本会先验证它）：SVG 画圆点的文档顺序 == mkf 节点表顺序。

用法：python tools/decode_map_nodes.py 0
"""
import re
import struct
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SVG_DIR = ROOT / 'docs/assets/board-svg'
BLK = [1, 3, 5, 7, 9, 11, 13, 15]


def svg_graph(map_no: int):
    txt = (SVG_DIR / f'map{map_no}.svg').read_text(encoding='utf-8')
    circles = [(float(m[0]), float(m[1]))
               for m in re.findall(r'<circle cx="([\d.]+)" cy="([\d.]+)"', txt)]
    key = {(round(x * 10), round(y * 10)): i for i, (x, y) in enumerate(circles)}
    edges = []
    for m in re.findall(r'<line x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)"', txt):
        a = key.get((round(float(m[0]) * 10), round(float(m[1]) * 10)))
        b = key.get((round(float(m[2]) * 10), round(float(m[3]) * 10)))
        if a is not None and b is not None:
            edges.append((a, b))
    nbr = {i: set() for i in range(len(circles))}
    for a, b in edges:
        nbr[a].add(b)
        nbr[b].add(a)
    return circles, edges, nbr


def name_of(rec: bytes) -> str:
    raw = rec[4:20]
    end = raw.find(b'\x00\x00')
    if end >= 0:
        raw = raw[:end & ~1]
    try:
        return raw.decode('big5').rstrip('\x00')
    except UnicodeDecodeError:
        return ''


def main() -> None:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    map_no = int(sys.argv[1])
    data = (ROOT / f'docs/extraction/raw/map_blocks/block{BLK[map_no]}.bin').read_bytes()
    n, stride = struct.unpack_from('<2I', data, 0)
    recs = [data[0x50 + stride * i: 0x50 + stride * (i + 1)] for i in range(n)]
    circles, edges, nbr = svg_graph(map_no)
    print(f'地图 {map_no}（块 #{BLK[map_no]}）：mkf 节点 {n} · SVG 圆点 {len(circles)} · 连线 {len(edges)}')

    # 1) 验证「顺序一致」：raw→svg 应当是同一个仿射（各轴独立的 scale/offset），残差应接近 0
    rx = [struct.unpack_from('<H', r, 0)[0] for r in recs]
    ry = [struct.unpack_from('<H', r, 2)[0] for r in recs]
    sx = (max(c[0] for c in circles) - min(c[0] for c in circles)) / (max(rx) - min(rx))
    ox = min(c[0] for c in circles) - min(rx) * sx
    sy = (max(c[1] for c in circles) - min(c[1] for c in circles)) / (max(ry) - min(ry))
    oy = min(c[1] for c in circles) - min(ry) * sy
    res = max(max(abs(rx[i] * sx + ox - circles[i][0]), abs(ry[i] * sy + oy - circles[i][1]))
              for i in range(n))
    print(f'  顺序一致假设：x 缩放 {sx:.4f} 偏移 {ox:.2f} · y 缩放 {sy:.4f} 偏移 {oy:.2f} · 最大残差 {res:.2f}px')

    # 2) 每个字段槽命中「SVG 邻居编号」的比例
    print('\n字段槽 → 是否等于本节点的 SVG 邻居编号：')
    for slot in range(2, 20):
        hit = sum(1 for i in range(n) if struct.unpack_from('<H', recs[i], slot * 2)[0] in nbr[i])
        if hit:
            print(f'  u16[{slot:>2}] 命中 {hit:>3}/{n}')

    # 3) 逐格型看字段分布（名字前 2 字归类）
    print('\n按名字归类的字段分布（u16[10..19]）：')
    by: dict[str, list] = {}
    for i, r in enumerate(recs):
        nm = name_of(r) or '(空白)'
        by.setdefault(nm, []).append((i, struct.unpack_from('<10H', r, 20)))
    for nm, rows in sorted(by.items(), key=lambda kv: -len(kv[1])):
        cols = list(zip(*[v for _, v in rows]))
        uniq = [sorted(set(c))[:6] for c in cols]
        print(f'  {nm:<10} ×{len(rows):<3} ' + ' | '.join(
            f'{v}' if len(v) > 1 else str(v[0]) for v in uniq))

    # 4) 明细：前 12 条 + 所有岔口/死端
    print('\n明细（idx / 名 / u16 全 20 / SVG 邻居）：')
    hubs = [i for i in range(n) if len(nbr[i]) != 2]
    for i in list(range(12)) + hubs:
        u = struct.unpack_from('<20H', recs[i], 0)
        print(f'  #{i:<3} {name_of(recs[i]) or "(空白)":<8} deg={len(nbr[i])} '
              f'nbr={sorted(nbr[i])}  {list(u)}')


if __name__ == '__main__':
    main()
