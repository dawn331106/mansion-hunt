"""
Turn the supplied ghost artwork into a texture the model can wear.

The source is a 240x240 RGB WebP with no alpha: a face lit hard from the upper
left, half of it falling away into deep shadow, cropped tight and sitting
off-centre in the frame.

The one thing to get right here is the alpha. The image is genuinely
high-contrast — a quarter of its pixels are pure black and the median
luminance is about 20 — so the shadowed side of the face is exactly as dark as
the background behind it. Keying on brightness therefore cannot separate them,
and a first attempt that tried produced a washed-out negative: it punched holes
through the shadowed cheek and the open mouth while leaving the lit skin
blown out.

So the colours are passed through completely untouched, and alpha comes from a
soft vignette instead. That keeps every pixel of the artwork as drawn, lets the
dark half stay dark, and relies on the fact that the ghost is rendered against
an almost black house — the background of the source simply disappears into
the scene rather than needing to be cut out.

    python tools/import-ghost.py [source] [dest]
"""

import math
import sys
from PIL import Image

SRC = sys.argv[1] if len(sys.argv) > 1 else "public/assets/ghot.webp"
DST = sys.argv[2] if len(sys.argv) > 2 else "public/assets/ghost.png"
OUT = 512


def main():
    src = Image.open(SRC).convert("RGB")

    # Upscale first, so the vignette is computed at output resolution and the
    # edge stays smooth rather than inheriting 240px stair-stepping.
    face = src.resize((OUT, OUT), Image.LANCZOS)
    out = face.convert("RGBA")
    px = out.load()

    for y in range(OUT):
        v = (y / OUT - 0.5) * 2.0          # -1 .. 1
        for x in range(OUT):
            u = (x / OUT - 0.5) * 2.0

            r, g, b, _ = px[x, y]

            # --- A soft oval vignette: fully opaque across the face, falling
            #     away at the edges so the texture has no visible border. ---
            d = math.hypot(u / 0.98, v / 1.02)
            if d <= 0.72:
                a = 1.0
            elif d >= 1.0:
                a = 0.0
            else:
                t = (d - 0.72) / 0.28
                a = 1.0 - t * t * (3 - 2 * t)   # smoothstep

            # --- The bottom fades further, so the jaw melts into the shroud
            #     instead of ending on a hard horizontal cut. ---
            vy = y / OUT
            if vy > 0.82:
                a *= max(0.0, 1.0 - (vy - 0.82) / 0.18)

            # --- Pixels that are essentially black carry no information and
            #     only dull the scene behind them, so let them drop out. This
            #     is a gentle ramp over a wide range, not a threshold: it
            #     thins the background without biting into the shadowed side
            #     of the face. ---
            lum = 0.299 * r + 0.587 * g + 0.114 * b
            if lum < 34:
                a *= lum / 34.0

            px[x, y] = (r, g, b, int(max(0.0, min(1.0, a)) * 255))

    out.save(DST)
    print(f"wrote {DST}  {OUT}x{OUT}")


if __name__ == "__main__":
    main()
