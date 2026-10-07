# -*- coding: utf-8 -*-
"""Parse rich4_news.asm .data section: reconstruct bytes, extract BIG5 strings,
and map event functions (jump table) to string refs used in .text."""
import re, json, sys

ASM = r"D:\Work\rich man web\richman-online\docs\extraction\help-mkf-work\rich4_news.asm"

text = open(ASM, encoding="utf-8", errors="replace").read()
lines = text.splitlines()

# --- locate sections ---
data_start = next(i for i, l in enumerate(lines) if l.strip() == "section .data")
text_start = next(i for i, l in enumerate(lines) if l.strip() == "section .text")

# --- 1. reconstruct .data byte image ---
mem = {}   # addr -> byte
labels = {}  # label -> addr
addr = None
cur_label = None
re_label = re.compile(r"^(ref_[0-9a-f]+|fcn_[0-9a-f]+):")
for l in lines[data_start + 1:]:
    s = l.strip()
    if not s:
        continue
    m = re_label.match(s)
    if m:
        cur_label = m.group(1)
        try:
            addr = int(cur_label[4:], 16)  # ref_004653ec -> 0x4653ec
        except ValueError:
            addr = None
        labels[cur_label] = addr
        continue
    m = re.match(r"^dd\s+(.+)$", s)
    if m:
        for item in m.group(1).split(","):
            item = item.strip()
            if item.startswith("0x"):
                v = int(item, 16)
                for k in range(4):
                    mem[addr] = (v >> (8 * k)) & 0xFF
                    addr += 1
            elif re.match(r"^fcn_[0-9a-f]+$", item) or re.match(r"^ref_[0-9a-f]+$", item):
                # pointer: 4 bytes, value unknown here but we record label
                # store marker via labels map later
                addr += 4
            else:
                raise ValueError("unknown dd item: " + item)
        continue
    m = re.match(r"^db\s+(.+)$", s)
    if m:
        for item in m.group(1).split(","):
            item = item.strip()
            if item.startswith("0x"):
                mem[addr] = int(item, 16)
                addr += 1
            elif item.startswith("'"):
                mem[addr] = ord(item[1])
                addr += 1
            else:
                raise ValueError("unknown db item: " + item)
        continue
    # anything else (instructions etc.) -> stop at end of data blob tables
    break

lo, hi = min(mem), max(mem)
blob = bytes(mem.get(a, 0) for a in range(lo, hi + 1))
print("data image: 0x%X - 0x%X (%d bytes)" % (lo, hi, len(blob)))

# --- 2. extract NUL-terminated strings from 0x4653ec..0x465874 ---
strings = {}
a = 0x4653EC
end = 0x465874 + 0x20
buf = bytearray()
start = a
while a < end:
    b = mem.get(a, 0)
    if b == 0:
        if len(buf) >= 2:
            raw = bytes(buf)
            try:
                s = raw.decode("big5")
            except Exception:
                s = raw.decode("big5", errors="replace")
            strings[start] = s
        buf.clear()
        start = a + 1
    else:
        buf.append(b)
    a += 1

# --- 3. map event id -> function (jump table at 0x475e24) ---
# read the dd fcn_XXXX lines after ref_00475e24 label
jt = []
idx = next(i for i, l in enumerate(lines) if l.startswith("ref_00475e24:"))
for l in lines[idx + 1: idx + 60]:
    m = re.match(r"^dd\s+(fcn_[0-9a-f]+)", l.strip())
    if not m:
        break
    jt.append(m.group(1))

# --- 4. text-id table ref_00475eb4 (36 bytes) ---
idx = next(i for i, l in enumerate(lines) if l.startswith("ref_00475eb4:"))
tid_bytes = bytearray()
for l in lines[idx + 1: idx + 30]:
    m = re.match(r"^dd\s+0x([0-9a-f]+)", l.strip())
    if not m:
        break
    v = int(m.group(1), 16)
    tid_bytes += bytes([(v >> 8 * k) & 0xFF for k in range(4)])
tid_bytes = tid_bytes[:36]

# --- 5. headline pointer table ref_00475ed8 ---
idx = next(i for i, l in enumerate(lines) if l.startswith("ref_00475ed8:"))
head_ptrs = []
for l in lines[idx + 1: idx + 40]:
    m = re.match(r"^dd\s+(ref_[0-9a-f]+)", l.strip())
    if not m:
        break
    head_ptrs.append(m.group(1))

# --- 6. headline strings decode ---
head_lines = []
for p in head_ptrs:
    a0 = labels.get(p)
    buf = bytearray()
    aa = a0
    while True:
        b = mem.get(aa, 0)
        if b == 0:
            break
        buf.append(b)
        aa += 1
    head_lines.append((p, bytes(buf).decode("big5", errors="replace")))

# --- 7. scan .text: for each function range, collect push ref_004654xx ---
fn_addr = {}
for m in re.finditer(r"^fcn_([0-9a-f]+):", text, re.M):
    fn_addr["fcn_" + m.group(1)] = int(m.group(1), 16)
fn_sorted = sorted(fn_addr.items(), key=lambda kv: kv[1])

def enclosing_fn(a):
    cur = None
    for name, ad in fn_sorted:
        if ad <= a:
            cur = name
        else:
            break
    return cur

# find function bodies within .text region (up to .data)
fn_end = {}
entries = [(ad, name) for name, ad in fn_sorted]
for i, (ad, name) in enumerate(entries):
    fn_end[name] = entries[i + 1][0] if i + 1 < len(entries) else 0x475000

# parse .text lines for push ref_ / refs of data strings and string usage
text_lines = lines[text_start + 1: data_start]
fn_strings = {}
fn_floats = {}
cur_fn = None
for l in text_lines:
    m = re_label.match(l.strip())
    if m:
        cur_fn = m.group(1)
        continue
    if cur_fn is None:
        continue
    for rm in re.finditer(r"ref_(00465[0-9a-f]+)", l):
        a2 = int(rm.group(1), 16)
        if a2 in strings:
            fn_strings.setdefault(cur_fn, []).append((a2, strings[a2]))
    for rm in re.finditer(r"ref_(004654dc|004655a4|004655cc|004655f4|0046561c|00465734)", l):
        fn_floats.setdefault(cur_fn, []).append("0x" + rm.group(1)[5:].upper())

# --- output ---
out = []
out.append("=== jump table (event id -> function) ===")
for i, f in enumerate(jt):
    out.append("event %2d -> %s" % (i, f))
out.append("")
out.append("=== text-id table (event id -> headline idx) ===")
out.append(" ".join(str(b) for b in tid_bytes))
out.append("")
out.append("=== headline table ===")
for i, (p, s) in enumerate(head_lines):
    out.append("head %d: %s : %s" % (i, p, s))
out.append("")
out.append("=== strings in 0x4653ec..0x465894 (BIG5->GBK dump) ===")
for a2 in sorted(strings):
    out.append("0x%06X: %s" % (a2, strings[a2]))
out.append("")
out.append("=== per-function string refs ===")
for f in jt:
    out.append("--- %s ---" % f)
    for a2, s in fn_strings.get(f, []):
        out.append("  0x%06X: %s" % (a2, s))

open(r"D:\Work\rich man web\richman-online\docs\extraction\news_strings_map.txt", "w", encoding="utf-8").write("\n".join(out))
print("written news_strings_map.txt, events:", len(jt), "headline ptrs:", len(head_ptrs), "strings:", len(strings))
