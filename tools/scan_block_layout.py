#!/usr/bin/env python3
"""map.mkf 地图块分区侦察：头部 u32 表 + 节点记录表 + 记录表之后的所有子表。

用法：python tools/scan_block_layout.py 1
"""
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def big5(b: bytes) -> str:
    for cut in range(len(b), 1, -2):
        try:
            s = b[:cut].decode('big5')
        except UnicodeDecodeError:
            continue
        if s.strip('\x00'):
            return s.rstrip('\x00')
    return ''


def name_of(rec: bytes, off: int = 4, size: int = 36) -> str:
    raw = rec[off:off + size]
    end = raw.find(b'\x00\x00')
    if end >= 0:
        raw = raw[:end & ~1]
    return big5(raw)


def main() -> None:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    blk = int(sys.argv[1])
    data = (ROOT / f'docs/extraction/raw/map_blocks/block{blk}.bin').read_bytes()
    n = struct.unpack_from('<I', data, 0)[0]
    print(f'== 块 #{blk}  {len(data):,} 字节 ==')
    print('头部 u32：')
    for i in range(0, 0x50, 4):
        v = struct.unpack_from('<I', data, i)[0]
        print(f'  0x{i:02x}  {v}')

    # 节点记录表：步长由头部第 2 个 u32 给出
    stride = struct.unpack_from('<I', data, 4)[0]
    for start in (0x10, 0x14, 0x50, 0x54, 0x58):
        recs = [data[start + stride * i: start + stride * (i + 1)] for i in range(n)]
        named = sum(1 for r in recs if name_of(r))
        ok = all(start + stride * n <= len(data) for _ in [0])
        print(f'\n候选表起点 0x{start:02x}：有名记录 {named}/{n}  越界={not ok}')
    start = 0x50
    recs = [data[start + stride * i: start + stride * (i + 1)] for i in range(n)]
    print('\n前 8 条记录（u16 全展开 + 名字）：')
    for i, r in enumerate(recs[:8]):
        u = struct.unpack(f'<{len(r) // 2}H', r)
        print(f'  #{i:<3} ' + ' '.join(f'{v}' for v in u) + f'   |{name_of(r)}|')
    tail_start = start + stride * n
    print(f'\n== 记录表之后：0x{tail_start:x} .. 0x{len(data):x}  共 {len(data) - tail_start:,} 字节 ==')
    body = data[tail_start:]
    for i in range(0, min(len(body), 0x180), 20):
        row = body[i:i + 20]
        u = struct.unpack(f'<{len(row) // 2}H', row[:len(row) // 2 * 2])
        print(f'  0x{tail_start + i:05x} ' + ' '.join(f'{v:>6}' for v in u) + '   ' + repr(name_of(row, 0, 20)))


if __name__ == '__main__':
    main()
