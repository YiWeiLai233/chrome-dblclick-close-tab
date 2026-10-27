"""生成扩展图标：深色圆角方块 + 白色「双击」符号（两个圆点 + 关闭叉）。

不依赖外部素材，直接用 Pillow 画，4x 超采样后缩到目标尺寸，边缘干净。
"""

from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "icons"
SIZES = (16, 32, 48, 128)

BG_TOP = (47, 107, 255)  # #2f6bff
BG_BOTTOM = (28, 66, 190)
INK = (255, 255, 255)


def rounded_mask(size: int, radius_ratio: float, ss: int) -> Image.Image:
    m = Image.new("L", (size * ss, size * ss), 0)
    d = ImageDraw.Draw(m)
    r = int(size * ss * radius_ratio)
    d.rounded_rectangle([0, 0, size * ss - 1, size * ss - 1], radius=r, fill=255)
    return m.resize((size, size), Image.LANCZOS)


def gradient(size: int, ss: int) -> Image.Image:
    big = size * ss
    g = Image.new("RGB", (1, big))
    for y in range(big):
        t = y / max(big - 1, 1)
        g.putpixel(
            (0, y),
            tuple(int(BG_TOP[i] + (BG_BOTTOM[i] - BG_TOP[i]) * t) for i in range(3)),
        )
    return g.resize((big, big), Image.NEAREST)


def draw_glyph(canvas: Image.Image, size: int, ss: int) -> None:
    d = ImageDraw.Draw(canvas)
    big = size * ss
    u = big / 100.0  # 以 100 单位坐标系做设计，便于等比缩放

    # 关闭的叉：右下角，笔画粗一点，小尺寸也认得出
    cx, cy = 66, 34
    arm = 15
    w = max(int(round(8.5 * u)), 2)
    for dx, dy in ((1, 1), (1, -1)):
        d.line(
            [
                (cx * u - arm * u * dx, cy * u - arm * u * dy),
                (cx * u + arm * u * dx, cy * u + arm * u * dy),
            ],
            fill=INK,
            width=w,
        )

    # 双击的两个圆点：左下角，一大一小表示「两下」
    r1 = 11 * u
    d.ellipse(
        [26 * u - r1, 62 * u - r1, 26 * u + r1, 62 * u + r1],
        fill=INK,
    )
    r2 = 6.5 * u
    d.ellipse(
        [46 * u - r2, 42 * u - r2, 46 * u + r2, 42 * u + r2],
        fill=INK,
    )


def build(size: int) -> Image.Image:
    ss = 8 if size <= 32 else 4  # 小图标超采样更多，保证笔画不糊
    big = size * ss

    glyph = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    draw_glyph(glyph, size, ss)

    base = gradient(size, ss).convert("RGBA")

    icon = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    icon.paste(base, (0, 0))
    icon.alpha_composite(glyph)

    mask = rounded_mask(size, 0.24, ss).resize((big, big), Image.LANCZOS)
    icon.putalpha(Image.composite(icon.split()[3], Image.new("L", (big, big), 0), mask))

    return icon.resize((size, size), Image.LANCZOS)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for s in SIZES:
        img = build(s)
        img.save(OUT / f"icon{s}.png")
        print(f"icons/icon{s}.png  {img.size}")


if __name__ == "__main__":
    main()
