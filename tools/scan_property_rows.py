#!/usr/bin/env python3
"""普通地块子表细看：找「两个普通地块连一起 = 商业用地」在数据里的判据。

用法：python tools/scan_property_rows.py 0
"""
import struct
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BLK = [1, 3, 5, 7, 9, 11, 13, 15]


def nm(b: bytes) -> str:
    e = b.find(b'\x00\x00')
    if e >= 0:
        b = b[:e & ~1]
    try:
        return b.decode('big5').rstrip('\x00')
    except UnicodeDecodeError:
        return ''


def main() -> None:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    no = int(sys.argv[1])
    d = (ROOT / f'docs/extraction/raw/map_blocks/block{BLK[no]}.bin').read_bytes()
    n, stride = struct.unpack_from('<2I', d, 0)
    counts = struct.unpack_from('<8I', d, 8)   # (数量,偏移) × 4 张子表
    print(f'地图 {no}: 节点 {n} 步长 {stride}  子表 (数量,偏移) = {list(zip(counts[0::2], counts[1::2]))}')

    prop_cnt, prop_off = counts[0], counts[1]
    rows = {}
    for k in range(1, prop_cnt + 2):
        off = prop_off + 52 * k
        if off + 52 > len(d):
            break
        r = d[off:off + 52]
        u = struct.unpack('<26H', r)
        rows[prop_off + 52 * k] = (k, nm(r[20:36]), u)

    # 节点表里的 type-0（普通地块），按 [16] 指到子表行
    nodes = []
    for i in range(n):
        rec = d[0x50 + stride * i: 0x50 + stride * (i + 1)]
        u = struct.unpack_from('<20H', rec, 0)
        nodes.append({'i': i, 'name': nm(rec[4:20]), 't': u[17], 'sid': u[16], 'u': u,
                      'nbr': [v - 1 for v in u[12:16] if v]})
    props = [x for x in nodes if x['t'] == 0]
    print(f'普通地块节点 {len(props)} 个，子表 {len(rows)} 行')

    print('\n按 [16] 顺序对齐子表行（sid / 名 / 行内非零字段）：')
    by_idx = {k: (rname, u) for k, (kk, rname, u) in rows.items()}
    for x in props[:56]:
        ent = by_idx.get(x['sid'] - 2000)
        if ent is None:
            print(f"  节点#{x['i']:>3} {x['name']:<6} sid={x['sid']} → 无对应行")
            continue
        rname, u = ent
        nz = ' '.join(f'[{j}]={v}' for j, v in enumerate(u) if v and j not in (0, 1))
        print(f"  节点#{x['i']:>3} {x['name']:<6} sid={x['sid']} 行名={rname:<6} {nz}")

    # 名字连续段长度分布：商业用地应当是「两格一段」
    seg = []
    cur = None
    for x in nodes:
        if x['t'] != 0:
            continue
        if cur and cur[0] == x['name'] and x['i'] - cur[1] == 1:
            cur = (x['name'], x['i'], cur[2] + 1)
        else:
            if cur:
                seg.append(cur)
            cur = (x['name'], x['i'], 1)
    if cur:
        seg.append(cur)
    print('\n普通地块连续同名段长度分布：', Counter(s[2] for s in seg))
    for s in seg:
        if s[2] != 4:
            print(f'  非 4 连段：{s[0]} 起点节点 {s[1] - s[2] + 1}..{s[1]} 长度 {s[2]}')


if __name__ == '__main__':
    main()
