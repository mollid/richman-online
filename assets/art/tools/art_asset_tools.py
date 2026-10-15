"""《大富翁 Online》B4 批后处理工具（依据 raw↔batch6 像素实测校准）。

链路：品红相对阈值键控（r-g>60 且 b-g>60 → alpha=0，二值透明）
     → 紧裁切（留白 0）→ 等比缩放到目标尺寸 → 透明 pad 成方 → 校验 → 接触表。

用法：
  python art_asset_tools.py keyout <src> <dst> --size 256   # 品红底原图：键控 + 紧裁 + 缩放 + 补方
  python art_asset_tools.py pack   <src> <dst> --size 256   # 已抠好透明底：只紧裁 + 缩放 + 补方（不键控）
  python art_asset_tools.py check <dir>
  python art_asset_tools.py sheet <dir> <out.png>
"""
import argparse
from pathlib import Path

from PIL import Image, ImageDraw

# 清单规格：棋子/建筑/卡片图标 256×256，通用图标 128×128（batch6 旧 22 张未缩放，属流程缺口）
B4_EXPECT = {
    "char_god_": 256,
    "icon_card_": 256,
    "icon_coin@": 128,
    "icon_dice@": 128,
    "icon_stock@": 128,
    "icon_shield@": 128,
}


def expect_size(name: str):
    for k, v in B4_EXPECT.items():
        if k in name:
            return v
    return None


def _fit(im: Image.Image, size: int) -> Image.Image:
    """紧裁切（留白 0）→ 等比按最长边缩放到 size → 透明补方，主体居中。"""
    w, h = im.size
    s = size / max(w, h)
    if s < 1:
        im = im.resize((max(1, round(w * s)), max(1, round(h * s))), Image.LANCZOS)
    w, h = im.size
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.paste(im, ((size - w) // 2, (size - h) // 2))
    return canvas


def keyout(src: str, dst: str, size: int) -> Image.Image:
    im = Image.open(src).convert("RGBA")
    px = im.load()
    W, H = im.size
    minx, miny, maxx, maxy = W, H, -1, -1
    for y in range(H):
        for x in range(W):
            r, g, b, _ = px[x, y]
            if r - g > 60 and b - g > 60:
                px[x, y] = (r, g, b, 0)
            else:
                minx = min(minx, x)
                maxx = max(maxx, x)
                miny = min(miny, y)
                maxy = max(maxy, y)
    im = im.crop((minx, miny, maxx + 1, maxy + 1))
    canvas = _fit(im, size)
    canvas.save(dst)
    print(f"[keyout] {Path(src).name} -> {Path(dst).name} ({size}x{size})")
    return canvas


def pack(src: str, dst: str, size: int) -> Image.Image:
    """已抠好透明底的图 → 只做紧裁切 + 缩放 + 补方，**不跑键控**。

    为什么要有这条：`keyout` 的键控判据（r−g>60 且 b−g>60）会把撞键色（如藕紫、
    玫红系服装）连衣服一起打穿，而外部工具抠好的图本来就没有品红底，走 keyout
    纯属自伤。撞键色是否安全请单独量，别指望 keyout 顺手帮你查。
    """
    im = Image.open(src).convert("RGBA")
    box = im.getbbox()
    if not box:
        raise SystemExit(f"[pack] {src} 全透明，没有可裁切的内容")
    canvas = _fit(im.crop(box), size)
    canvas.save(dst)
    print(f"[pack] {Path(src).name} -> {Path(dst).name} ({size}x{size})")
    return canvas


def check(directory: str) -> int:
    bad = 0
    for p in sorted(Path(directory).glob("*.png")):
        if "_src" in p.name or "_deprecated" in p.name:
            continue
        im = Image.open(p)
        exp = expect_size(p.name)
        msgs = []
        if im.mode != "RGBA":
            msgs.append(f"mode={im.mode}!=RGBA")
        im = im.convert("RGBA")
        rgba = im.tobytes()
        alpha_bad = any(rgba[i + 3] not in (0, 255) for i in range(0, len(rgba), 4))
        if alpha_bad:
            msgs.append("alpha not binary")
        px = im.load()
        W, H = im.size
        residual = 0
        for y in range(H):
            for x in range(W):
                r, g, b, a = px[x, y]
                if a == 255 and r - g > 60 and b - g > 60:
                    residual += 1
        if residual:
            msgs.append(f"residual magenta px={residual}")
        if exp is not None and im.size != (exp, exp):
            msgs.append(f"size={im.size}!={(exp, exp)}")
        if msgs:
            bad += 1
            print(f"[FAIL] {p.name}: {'; '.join(msgs)}")
        else:
            tag = f"{exp}x{exp}" if exp else f"{im.size[0]}x{im.size[1]} (no spec)"
            print(f"[ OK ] {p.name} {tag}")
    print(f"check done: {bad} failed")
    return bad


def sheet(directory: str, out: str, cols: int = 5, cell: int = 180) -> None:
    files = [
        p
        for p in sorted(Path(directory).glob("*.png"))
        if "_src" not in p.name and "_deprecated" not in p.name
    ]
    if not files:
        print("no images")
        return
    rows = (len(files) + cols - 1) // cols
    label_h = 22
    W, H = cols * cell, rows * (cell + label_h)
    board = Image.new("RGB", (W, H), (46, 159, 216))  # v6 海蓝棋盘底
    dr = ImageDraw.Draw(board)
    for i, p in enumerate(files):
        cx, cy = (i % cols) * cell, (i // cols) * (cell + label_h)
        tile = Image.new("RGB", (cell, cell), (245, 227, 192))  # v6 米黄 UI 底
        tile.paste(Image.new("RGB", (cell // 2, cell // 2), (238, 216, 178)), (cell // 2, 0))
        tile.paste(Image.new("RGB", (cell // 2, cell // 2), (238, 216, 178)), (0, cell // 2))
        im = Image.open(p).convert("RGBA")
        im.thumbnail((cell - 16, cell - 16), Image.LANCZOS)
        tile.paste(im, ((cell - im.width) // 2, (cell - im.height) // 2), im)
        board.paste(tile, (cx, cy))
        dr.text((cx + 6, cy + cell + 4), p.name, fill=(26, 38, 32))
    board.save(out)
    print(f"[sheet] {out} ({len(files)} images, {cols} cols)")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    k = sub.add_parser("keyout")
    k.add_argument("src")
    k.add_argument("dst")
    k.add_argument("--size", type=int, default=256)
    pk = sub.add_parser("pack")
    pk.add_argument("src")
    pk.add_argument("dst")
    pk.add_argument("--size", type=int, default=256)
    c = sub.add_parser("check")
    c.add_argument("directory")
    s = sub.add_parser("sheet")
    s.add_argument("directory")
    s.add_argument("out")
    s.add_argument("--cols", type=int, default=5)
    a = ap.parse_args()
    if a.cmd == "keyout":
        keyout(a.src, a.dst, a.size)
    elif a.cmd == "pack":
        pack(a.src, a.dst, a.size)
    elif a.cmd == "check":
        sys_code = check(a.directory)
        raise SystemExit(1 if sys_code else 0)
    else:
        sheet(a.directory, a.out, a.cols)
