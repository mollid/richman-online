#!/usr/bin/env python3
"""map.mkf 地图 0~3 → shared/src/maps/*.json。

## 已逆向出的格式（地图 0~3；4~7 的节点表不在 map.mkf 里）

块头：
  0x00 u32 节点数 N        0x04 u32 节点记录步长（= 40）
  0x08 u32 住宅地块数       0x0c u32 表偏移   （sid 2xxx，52 字节/行）
  0x10 u32 商业用地段数     0x14 u32 表偏移   （sid 4xxx，56 字节/行；**一段占两个节点**）
  0x18 u32 企业数           0x1c u32 表偏移   （sid 6xxx，52 字节/行：原版自己的公司，带面值）
  0x20 u32 景观数           0x24 u32 表偏移   （sid 8xxx，28 字节/行，多数是不在环上的装饰精灵）
  四张子表都是 **计数 + 1 行**，第 0 行是空槽，行号 = sid − 家族基数（1-based）

子表行的字段（u16 下标）：
  住宅：[0]x [1]y [2..9]名 [13]标志 [14]地价 [15..21]七档租金
  商业：[0]x [1]y [2..9]名 [13]标志 [17]地价 [18..23]六档
  企业：[0]x [1]y [2..9]名 [12]标志 [13]面值 [14..19]未定参数

节点记录 40 字节 = 20 个 u16：
  [0] x  [1] y  [2..9] 名（BIG5，最多 8 字）  [10][11] 恒 0
  [12..15] 邻居节点号，**1-based，0 = 无** ⇒ 最多 4 个邻居，支线与岔口本来就在数据里
  [16] sid：格型家族 + 子表行号（行号 = sid − 家族基数，1-based）
  [17] = [18] 格型枚举 0..17（见 TYPES）
  [19] 标志位（语义未确认，原样透传）

坐标与 SVG 拓扑图的关系：SVG 圆点的文档顺序 == 节点表顺序，
且 `svg = raw × 0.5024 − 90.88`（x）/ `raw × 0.5025 − 30.09`（y），103 点最大残差 0.06px。

## 原版图的三条规则（决定引擎怎么读这份数据）

1. **没有起点格**：0..17 的格型枚举里没有它 ⇒ `PASS_START_SALARY` 在原版图上永不触发，
   **原版图没有薪水**，收入只有租金 / 股票 / 点券小游戏。
2. **主闭环 + 分支**：节点 `[12..15]` 最多 4 个邻居就是分支的凭据；**岔路口随机拐**，
   不弹决策（方向在掷骰内部抽，回放按种子复现）。
3. **玩家随机出生**：引擎的 SP-01 `spawnCells` 已经是这套，不需要出生格。

## 用法
  python tools/decode_map_mkf.py            # 出 0~3 四份 json + 与 SVG 的核对报告
"""
import json
import re
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BLOCK_DIR = ROOT / 'docs/extraction/raw/map_blocks'
SVG_DIR = ROOT / 'docs/assets/board-svg'
OUT_DIR = ROOT / 'shared/src/maps'

# 头里的四张子表：(家族基数, 住宅/商业/企业/景观)
FAMILIES = [(2000, 'residential'), (4000, 'commercial'), (6000, 'company'), (8000, 'scenery')]

# 格型枚举 → 我们的 BoardCell.type。原版没有神庙与缴税，别拿空白格冒充。
TYPES = {
    0: None,          # 由 sid 家族决定：住宅 / 商业 / 企业
    1: 'blank',       # 公園：引擎里没有 park 格型、原版行为无依据 ⇒ 按空白格落，kind=1 留在数据里
    2: 'news',        # 新聞
    3: 'chance',      # 命運
    4: 'jail',        # 監獄
    5: 'hospital',    # 醫院
    6: 'game',        # 企鵝挖寶
    7: 'game',        # 喜從天降
    8: 'game',        # 七彩氣球
    9: 'lottery',     # 樂透
    10: 'points',     # 得５０點
    11: 'points',     # 得３０點
    12: 'points',     # 得１０點
    13: 'free-card',  # 卡片
    14: 'bank',       # 銀行
    15: 'shop',       # 百貨公司
    16: 'magic',      # 魔法屋
    17: 'blank',      # 空白 / 区域名（四國·九州·北海道那类）
}
POINTS_BY_TYPE = {10: 50, 11: 30, 12: 10}
MINIGAME_BY_TYPE = {6: 'penguin', 7: 'windfall', 8: 'balloon'}
MAP_NAMES = ['潮汕', '中國', '日本', '美國']


def big5(b: bytes) -> str:
    end = b.find(b'\x00\x00')
    if end >= 0:
        b = b[:end & ~1]
    try:
        return b.decode('big5').rstrip('\x00')
    except UnicodeDecodeError:
        return ''


# 机构名以 EXE 股票表为准（用户 2026-10-12 拍的）。
# 这不是解码 bug，是原盘两处自己打架：中國图 sid 6004 在 mkf 里的字节是
#   a5 c9 | a4 ab | a9 b2 | a6 ca | b3 66  →  玉 井 府 百 貨
# 而「王府井百貨」的 BIG5 是
#   a4 fd | a9 b2 | a4 ab | a6 ca | b3 66  →  王 府 井 百 貨
# 後两字相同，前三字是同字重组外加 王→玉；错位一字节解出来是「氻咿畢妘f」这种乱码，
# 所以顺序与对齐都对，两处数据就是不一致。同一张图上的「上海銀行」两边逐字相同，
# 可见这套名字本来就同源，只这一处偏了。
NAME_FIXES = {'玉井府百貨': '王府井百貨'}


def fix_name(s: str) -> str:
    return NAME_FIXES.get(s, s)


# ---------------------------------------------------------------- 繁 → 简
# 界面字体（站酷快乐体）是纯简体字库，不含繁体专用字形，而 mkf 里的名字是原版繁体。
# 所以**上屏简体、解码全程繁体**：转换只发生在写 JSON 前的最后一道，
# 这样 fix_name（键是繁体串）、`name == ''` 的空白格判据、与 SVG 的拓扑对拍
# 全都跑在原字上，一个都不受影响。
#
# 字表 tools/t2s-map.json 由 opencc 的 t2s 单字映射导出，只收「转换后仍是单字」的条目，
# 避开 一↔壹 这类要按词才判得对的歧义。
# 原文没有丢：map.mkf 与 docs/assets/board-svg/*.svg 仍是繁体，重跑本脚本即可回到原字。
_T2S: dict[str, str] = {}


def load_t2s() -> dict[str, str]:
    global _T2S
    if not _T2S:
        _T2S = json.loads((ROOT / 'tools' / 't2s-map.json').read_text(encoding='utf-8'))
    return _T2S


def to_simplified(s: str) -> str:
    m = load_t2s()
    return ''.join(m.get(c, c) for c in s)


def simplify_names(out: dict) -> dict:
    """就地转掉所有会进界面的 name 字段。

    股票表那边（`shared/src/maps/stocks.json`，手维护、没有生成脚本）用同一张表转，
    两边必须一致 —— `maps/index.ts` 是按 `s.name ===` 把棋盘公司与股票 join 起来的，
    只转一边会让 `companiesFromMap` 直接抛。
    """
    out['name'] = to_simplified(out['name'])
    for c in out['cells']:
        c['name'] = to_simplified(c['name'])
        if 'sidName' in c:
            c['sidName'] = to_simplified(c['sidName'])
    for g in out['companies']:
        g['name'] = to_simplified(g['name'])
    return out


def svg_graph(map_no: int):
    txt = (SVG_DIR / f'map{map_no}.svg').read_text(encoding='utf-8')
    circles = [(float(m[0]), float(m[1])) for m in re.findall(r'<circle cx="([\d.]+)" cy="([\d.]+)"', txt)]
    key = {(round(x * 10), round(y * 10)): i for i, (x, y) in enumerate(circles)}
    edges = set()
    for m in re.findall(r'<line x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)"', txt):
        a = key.get((round(float(m[0]) * 10), round(float(m[1]) * 10)))
        b = key.get((round(float(m[2]) * 10), round(float(m[3]) * 10)))
        if a is not None and b is not None:
            edges.add((min(a, b), max(a, b)))
    return circles, edges


def read_subtable(data: bytes, off: int, stride: int, count: int):
    return [struct.unpack_from(f'<{stride // 2}H', data, off + stride * k) for k in range(1, count + 1)]


def decode(map_no: int, blk: int):
    data = (BLOCK_DIR / f'block{blk}.bin').read_bytes()
    n, stride = struct.unpack_from('<2I', data, 0)
    hdr = struct.unpack_from('<8I', data, 8)
    tables = {}
    for k, (base, fam) in enumerate(FAMILIES):
        cnt, off = hdr[2 * k], hdr[2 * k + 1]
        # 子表都是「计数 + 1」行：第 0 行是空槽，行号 = sid − 家族基数（1-based）
        nxt = hdr[2 * k + 3] if k < 3 else len(data)
        row = (nxt - off) // (cnt + 1) if cnt else 0
        tables[fam] = (base, cnt, off, row, read_subtable(data, off, row, cnt) if row else [])

    cells = []
    for i in range(n):
        rec = data[0x50 + stride * i: 0x50 + stride * (i + 1)]
        u = struct.unpack_from('<20H', rec, 0)
        name = big5(rec[4:20])
        sid, t = u[16], u[17]
        fam = next((f for b, f in FAMILIES if b <= sid < b + 1000), 'function')
        cell = {'id': i, 'name': name, 'x': u[0], 'y': u[1],
                'neighbors': [v - 1 for v in u[12:16] if v], 'sid': sid, 'kind': t, 'flags': u[19]}
        if fam == 'residential':
            row = tables['residential'][4][sid - 2001]
            cell['type'] = 'property'
            cell['group'] = big5(struct.pack('<8H', *row[2:10]))
            cell['flag'] = row[13]
            cell['price'] = row[14]
            cell['rents'] = list(row[15:22])
        elif fam == 'commercial':
            row = tables['commercial'][4][sid - 4001]
            cell['type'] = 'commercial'
            cell['sidName'] = big5(struct.pack('<8H', *row[2:10]))
            cell['flag'] = row[13]
            cell['price'] = row[17]
            cell['rents'] = list(row[18:24])
        elif fam == 'company':
            row = tables['company'][4][sid - 6001]
            raw = list(row[14:20])
            cell['sidName'] = big5(struct.pack('<8H', *row[2:10]))
            cell['flag'] = row[12]
            # 企业子表这一行的字段（19 条记录逐列对拍出来的，判据钉在 shared/test/maps.test.ts）：
            #   row[13] 低字节 = 原版企业种类枚举（1 航空 / 3 电脑 / 4 保险 / 5 汽车 / 6 石油 /
            #                    7 银行 / 10 百货 / 11 建设），高字节是另一条内部分组，不是钱；
            #   raw[3] = 企业子表的一列钱，**不是面值**：面值在 EXE 的股票表里（见
            #            shared/src/maps/stocks.json 的 _note —— 拿 par 去除下面那个资本额得到 8000
            #            这类像总股本的数，拿这列去除只得到 48~790）。它的分布是「上得了市的公司非 0、
            #            銀行与百货公司恒 0」，所以只当「走不走公司格」的旗标；
            #   raw[2] = 建筑图块号；raw[4] | raw[5]<<16 = 资本额（一律整千）。
            cell['companyId'] = row[13] & 0xFF
            cell['companyPrice'] = raw[3]
            cell['buildingId'] = raw[2]
            cell['capital'] = raw[4] | (raw[5] << 16)
            cell['sidName'] = fix_name(cell['sidName'])
            # 节点自带的 kind 决定它是哪一种：0 = 上得了市的公司（占相邻两格），
            # 14 / 15 = 銀行 / 百货公司 —— 走功能格，不进公司表；但它们在 EXE 的股票表里
            # 照样有行（富士銀行、三越百貨…），所以「不发股」只是这一列为 0，不是没上市。
            cell['type'] = 'company' if t == 0 else (TYPES[t] or 'shop')
        else:
            cell['type'] = TYPES.get(t, 'blank') if t != 17 or name == '' else 'blank'
            if fam == 'scenery':
                cell['scenery'] = True
        if t in POINTS_BY_TYPE:
            cell['pointsGain'] = POINTS_BY_TYPE[t]
        if t in MINIGAME_BY_TYPE:
            cell['minigame'] = MINIGAME_BY_TYPE[t]
        cells.append(cell)
    return n, tables, cells


def check(map_no: int, cells):
    """与 SVG 拓扑图逐节点核对：节点数、坐标仿射残差、邻接集合是否完全一致"""
    circles, edges = svg_graph(map_no)
    rep = {'svgNodes': len(circles), 'mkfNodes': len(cells), 'svgEdges': len(edges)}
    if len(circles) != len(cells):
        rep['fatal'] = '节点数不一致'
        return rep
    xs = [c['x'] for c in cells]
    ys = [c['y'] for c in cells]
    sx = (max(c[0] for c in circles) - min(c[0] for c in circles)) / (max(xs) - min(xs))
    ox = min(c[0] for c in circles) - min(xs) * sx
    sy = (max(c[1] for c in circles) - min(c[1] for c in circles)) / (max(ys) - min(ys))
    oy = min(c[1] for c in circles) - min(ys) * sy
    rep['residualPx'] = round(max(max(cells[i]['x'] * sx + ox - circles[i][0],
                                      circles[i][0] - cells[i]['x'] * sx - ox)
                                  for i in range(len(cells)))
                              , 3)
    mine = set()
    for c in cells:
        for j in c['neighbors']:
            mine.add((min(c['id'], j), max(c['id'], j)))
    rep['mkfEdges'] = len(mine)
    rep['onlyInSvg'] = sorted(edges - mine)
    rep['onlyInMkf'] = sorted(mine - edges)
    return rep


def main() -> None:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for map_no, blk in enumerate([1, 3, 5, 7]):
        n, tables, cells = decode(map_no, blk)
        rep = check(map_no, cells)
        deg = {}
        for c in cells:
            deg[len(c['neighbors'])] = deg.get(len(c['neighbors']), 0) + 1
        types = {}
        for c in cells:
            types[c['type']] = types.get(c['type'], 0) + 1
        start = 0
        by_sid: dict[int, dict] = {}
        for c in cells:
            if 6000 <= c['sid'] < 7000 and c['kind'] == 0:
                g = by_sid.setdefault(c['sid'], {'sid': c['sid'], 'name': c['sidName'],
                                                 'companyId': c['companyId'], 'sharePrice': c['companyPrice'],
                                                 'buildingId': c['buildingId'], 'capital': c['capital'],
                                                 'cells': []})
                g['cells'].append(c['id'])
        out = {
            'mapId': map_no, 'name': MAP_NAMES[map_no], 'source': f'map.mkf 块 #{blk}',
            'nodeCount': n, 'startCellId': start,
            'subTables': {k: {'count': v[1], 'offset': v[2], 'rowBytes': v[3]} for k, v in tables.items()},
            'companies': [by_sid[s] for s in sorted(by_sid)],
            'cells': cells,
        }
        p = OUT_DIR / f'map{map_no}.json'
        p.write_text(json.dumps(simplify_names(out), ensure_ascii=False, indent=1), encoding='utf-8')
        print(f'地图 {map_no} {MAP_NAMES[map_no]}：{n} 格 → {p.name}')
        print(f'  格型分布 {types}')
        print(f'  邻居度数分布 {deg}（3+ = 岔口，1 = 死端）')
        print(f"  公司 {[(g['name'], g['sharePrice'], g['cells']) for g in out['companies']]}")
        print(f'  核对 SVG：{rep}')


if __name__ == '__main__':
    main()
