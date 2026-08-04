#!/usr/bin/env python3
"""Compose logo.png into a macOS app icon, then build the .icns.

Run this after replacing logo.png:

    python3 radar/scripts/make-icon.py

The outputs (icons/app-icon.png and icons/veritas-radar.icns) are committed, so
install-app.sh just copies the .icns and needs neither Python nor Pillow. That
also sidesteps a trap that cost an afternoon once: icons/icon128.png is a JPEG
wearing a .png name, and sips preserves the source format, so a naive resize
chain hands iconutil a JPEG and it refuses the whole iconset without saying why.

Two things this does that a plain resize does not:

1. Trims the flat backdrop. logo.png is artwork filling 45% of a solid grey
   canvas. Shipped as-is it is a grey tile in the Dock with a small mark in the
   middle, not a logo.
2. Re-insets the artwork to the macOS safe area (~82% of the tile) on a
   transparent background, which is the proportion every system icon uses.
"""

import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageChops

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "logo.png"
FLAT = ROOT / "icons" / "app-icon.png"
ICNS = ROOT / "icons" / "veritas-radar.icns"

CANVAS = 1024
# Apple's icon grid: artwork occupies ~82% of the tile, the rest is breathing
# room. Filling the tile edge-to-edge reads as oversized next to system icons.
SAFE_AREA = 0.82
SIZES = [16, 32, 128, 256, 512]


def drop_backdrop(image):
    """Turn a flat studio backdrop into transparency.

    Cropping alone is not enough: the artwork's anti-aliased edge is a blend of
    logo colour and backdrop, so a hard crop leaves a grey halo ringing the
    rounded corners. Alpha is recovered from how far each pixel sits from the
    backdrop, then the backdrop's contribution is divided back out of the
    colour, which is what makes the edge fade to nothing instead of to grey.

    Left alone when the source already carries alpha, or when the corner colour
    is not actually a backdrop (a photo or full-bleed art), since guessing
    transparency out of those would eat the image."""
    if image.getchannel("A").getextrema()[0] < 255:
        return image

    flat = image.convert("RGB")
    backdrop = flat.getpixel((0, 0))
    distance = ImageChops.difference(flat, Image.new("RGB", flat.size, backdrop)).convert("L")

    histogram = distance.histogram()
    backdrop_share = sum(histogram[:13]) / (flat.width * flat.height)
    if backdrop_share < 0.15:
        return image  # no flat surround to remove

    # Scale so solid artwork lands at fully opaque and only the blend ramp is
    # partial. The 2% brightest distance is "solid", robust to stray specks.
    solid = next((value for value in range(255, 0, -1)
                  if sum(histogram[value:]) > 0.02 * flat.width * flat.height), 255)
    alpha = distance.point(lambda p: min(255, round(p * 255 / max(solid, 1))))

    # Crop to the artwork before un-matting: the loop below is per-pixel Python
    # and the backdrop is most of a 2000px canvas.
    box = alpha.getbbox()
    if box:
        flat = flat.crop(box)
        alpha = alpha.crop(box)

    unmatted = []
    for channel, base in zip(flat.split(), backdrop):
        # observed = a*fg + (1-a)*bg  ->  fg = (observed - (1-a)*bg) / a
        source = channel.load()
        mask = alpha.load()
        out = Image.new("L", flat.size)
        target = out.load()
        for y in range(flat.height):
            for x in range(flat.width):
                a = mask[x, y]
                if a == 0:
                    target[x, y] = base
                else:
                    value = (source[x, y] * 255 - base * (255 - a)) / a
                    target[x, y] = max(0, min(255, round(value)))
        unmatted.append(out)
    return Image.merge("RGBA", (*unmatted, alpha))


def compose():
    if not SOURCE.exists():
        sys.exit(f"no logo at {SOURCE} — drop a square PNG there and re-run")

    logo = drop_backdrop(Image.open(SOURCE).convert("RGBA"))
    box = logo.getchannel("A").getbbox()
    if box:
        logo = logo.crop(box)

    target = int(CANVAS * SAFE_AREA)
    # Fit inside the safe square without distorting a non-square logo.
    scale = min(target / logo.width, target / logo.height)
    logo = logo.resize((max(1, round(logo.width * scale)), max(1, round(logo.height * scale))), Image.LANCZOS)

    canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    canvas.paste(logo, ((CANVAS - logo.width) // 2, (CANVAS - logo.height) // 2), logo)
    FLAT.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(FLAT)
    return canvas


def build_icns(canvas):
    if not shutil.which("iconutil"):
        print("iconutil not found — wrote the PNG only", file=sys.stderr)
        return False
    with tempfile.TemporaryDirectory() as tmp:
        iconset = Path(tmp) / "icon.iconset"
        iconset.mkdir()
        for size in SIZES:
            # @1x and @2x both required: iconutil rejects an incomplete set.
            canvas.resize((size, size), Image.LANCZOS).save(iconset / f"icon_{size}x{size}.png")
            canvas.resize((size * 2, size * 2), Image.LANCZOS).save(iconset / f"icon_{size}x{size}@2x.png")
        subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(ICNS)], check=True)
    return True


if __name__ == "__main__":
    composed = compose()
    print(f"wrote {FLAT.relative_to(ROOT)}")
    if build_icns(composed):
        print(f"wrote {ICNS.relative_to(ROOT)}")
        print("re-run radar/scripts/install-app.sh to put it on the app")
