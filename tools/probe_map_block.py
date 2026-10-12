#!/usr/bin/env python3
"""map.mkf 地图块的结构侦察：把块里所有可 BIG5 解码的字串连偏移/长度打出来，
再按偏移差找等差排布（= 定长记录槽），顺带扫 u16 序列找坐标候选。

用法：python tools/probe_map_block.py 1 [--tail 40]
"""
import argparse
import re
import struct
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BLOCK_DIR = ROOT / 'docs/extraction/raw/map_blocks'


def big5_runs(data: bytes, min_chars: int = 2):
    """极大化扫描：连续可 BIG5 解码且落在常用汉字/全角区的字节段"""
    runs = []
    i = 0
    n = len(data)
    while i < n:
        b = data[i]
        if 0x80 <= b <= 0xfe:  # BIG5 首字节
            j = i
            chars = []
            while j + 1 < n and 0x80 <= data[j] <= 0xfe:
                pair = data[j:j + 2]
                try:
                    ch = pair.decode('big5')
                except UnicodeDecodeError:
                    break
                if not re.match(r'[一-鿿　-〿＀-￯ -~]', ch):
                    break
                chars.append(ch)
                j += 2
            if len(chars) >= min_chars:
                runs.append((i, ''.join(chars)))
                i = j
                continue
        i += 1
    return runs


def main() -> None:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    ap = argparse.ArgumentParser()
    ap.add_argument('block', type=int)
    ap.add_argument('--min', type=int, default=2, help='最短字串长度')
    ap.add_argument('--tail', type=int, default=0, help='只打最后 N 条')
    ap.add_argument('--u16', action='store_true', help='额外打 u16 序列的周期性观察')
    args = ap.parse_args()

    data = (BLOCK_DIR / f'block{args.block}.bin').read_bytes()
    print(f'block{args.block}.bin  {len(data):,} 字节')
    print(f'头 4 字节 u32 = {struct.unpack_from("<I", data, 0)[0]}  '
          f'次 4 字节 u32 = {struct.unpack_from("<I", data, 4)[0]}')

    runs = big5_runs(data, args.min)
    if args.tail:
        runs = runs[-args.tail:]
    print(f'\n== BIG5 字串 {len(runs)} 段 ==')
    prev = None
    for off, s in runs:
        d = '' if prev is None else f'  Δ={off - prev}'
        print(f'  0x{off:05x}  {s!r}{d}')
        prev = off

    if args.u16:
        print('\n== u16 值序列（每 2 字节一档，前 0x200）==')
        vals = struct.unpack_from(f'<{0x200 // 2}H', data, 0)
        for i in range(0, len(vals), 16):
            row = vals[i:i + 16]
            print(f'  0x{i:04x}  ' + ' '.join(f'{v:>5}' for v in row))


if __name__ == '__main__':
    main()
