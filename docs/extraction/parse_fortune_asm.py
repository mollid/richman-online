# -*- coding: utf-8 -*-
"""命運池提取工具(2026-09-27)。用法:
   python parse_fortune_asm.py > fate_pool_数据表.txt
解析 .scratch/rich4/asm/rich4_fortune.asm 的 .data 节(db/db+dd 小端混合,BIG5)
还原 49 条命运文本;按效果表 ref_00475ef0 顺序输出各效果函数的调用面。
待续:逐函数精读随机范围(mov e??,0x?? + idiv / 立即数)→ FATE_POOL 填表。
"""
import re, io, sys
ASM = r".scratch/rich4/asm/rich4_fortune.asm"
lines = io.open(ASM, encoding="utf-8", errors="replace").read().splitlines()
data_start = next(i for i,l in enumerate(lines) if l.strip()=="section .data")
mem={}; addr=None
re_label=re.compile(r"^(ref_[0-9a-f]+|fcn_[0-9a-f]+):")
for l in lines[data_start+1:]:
    s=l.strip()
    if not s: continue
    m=re_label.match(s)
    if m:
        try: addr=int(m.group(1)[4:],16)
        except: addr=None
        continue
    if addr is None: continue
    m=re.match(r"^d([bw])\s+(.+)$",s)
    if m:
        w = 1 if m.group(1)=="b" else 2
        for item in m.group(2).split(","):
            item=item.strip()
            if item.startswith("0x"):
                v=int(item,16)
                for k in range(w): mem[addr]=(v>>(8*k))&0xFF; addr+=1
            else: addr+=w
        continue
    m=re.match(r"^dd\s+(.+)$",s)
    if m:
        for item in m.group(1).split(","):
            item=item.strip()
            if item.startswith("0x"):
                v=int(item,16)
                for k in range(4): mem[addr]=(v>>(8*k))&0xFF; addr+=1
            else: addr+=4
        continue
    addr+=1
addrs=sorted(mem); start=addrs[0]; end=addrs[-1]
blob=bytes(mem[a] for a in range(start,end+1))
off=0
for seg in blob.split(b"\x00"):
    if len(seg)>=4:
        try: print(f"0x{start+off:06x}: {seg.decode('big5', errors='replace')}")
        except: pass
    off+=len(seg)+1
