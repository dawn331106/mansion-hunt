"""
Generate a stand-in ghost face texture.

This exists because the reference artwork arrived as an image in conversation
rather than as a file, and the game needs bytes on disk to texture the ghost's
head with. It paints a face in the same register as the reference: a gaunt,
corpse-pale skull lit hard from above, eyes sunk deep enough to be in shadow
with a red light behind them, and a lipless jaw of uneven teeth.

The whole thing is built from signed distance fields and a lighting model
rather than from drawn shapes. That matters: outlined ellipses and polygons
give you a cartoon, because real faces are made of curved surfaces catching
light at different angles, and it is the shading that carries the anatomy.

It is a placeholder with intent, not a copy. Drop the real artwork over
`public/assets/ghost.png` whenever it exists as a file; nothing else changes,
because `GHOST_TEXTURE_URL` already points there.

    python tools/make-ghost.py
"""

import math
import random
import struct
import zlib

SIZE = 512
random.seed(11)


def clamp(x, lo=0.0, hi=1.0):
    return lo if x < lo else hi if x > hi else x


def smoothstep(a, b, x):
    t = clamp((x - a) / (b - a))
    return t * t * (3 - 2 * t)


def mix(a, b, t):
    t = clamp(t)
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(3))


# Cold grey-green flesh, as in the reference — never white.
FLESH = (0.80, 0.815, 0.78)
FLESH_SHADOW = (0.34, 0.37, 0.37)
FLESH_DEEP = (0.10, 0.115, 0.12)
BLOOD = (0.62, 0.13, 0.12)
BLOOD_HOT = (1.0, 0.42, 0.32)
TOOTH = (0.80, 0.78, 0.71)
GUM = (0.20, 0.10, 0.11)


def ellipse_sd(px, py, cx, cy, rx, ry):
    """Signed distance-ish field for an ellipse: <1 inside, >1 outside."""
    dx = (px - cx) / rx
    dy = (py - cy) / ry
    return math.hypot(dx, dy)


def skull_halfwidth(v):
    """Half-width of the head at height v (0 = crown, 1 = chin)."""
    if v < 0.10:
        # A dome, not a flat top: the width follows a circular arc so the
        # crown reads as a skull rather than a slab with corners.
        return 0.54 * math.sqrt(max(0.0, 1.0 - ((0.10 - v) / 0.115) ** 2))
    if v < 0.32:
        return 0.54 + 0.045 * smoothstep(0.10, 0.32, v)
    if v < 0.52:
        return 0.585 - 0.020 * smoothstep(0.32, 0.52, v)
    if v < 0.74:
        return 0.565 - 0.145 * smoothstep(0.52, 0.74, v)
    if v < 0.92:
        return 0.42 - 0.155 * smoothstep(0.74, 0.92, v)
    return 0.265 * (1.0 - smoothstep(0.92, 1.0, v) * 0.80)


def surface_height(u, v):
    """
    A crude depth map of the face: how far each point bulges toward the viewer.

    This is what the lighting is computed from, so every feature — brow, cheek
    hollow, nose, jaw — is modelled here as a bump or a dent rather than drawn
    as a shape later.
    """
    half = skull_halfwidth(v)
    if half <= 1e-6:
        return None
    dx = u / half
    if abs(dx) >= 1.0:
        return None

    # Base: an egg, rounded across and along.
    h = math.sqrt(max(0.0, 1.0 - dx * dx)) * (0.85 + 0.15 * math.sin(v * math.pi))

    # Brow ridge — the strongest feature on a skull like this.
    brow = math.exp(-(((v - 0.375) / 0.052) ** 2)) * math.exp(-((dx / 0.78) ** 4))
    h += brow * 0.30

    # Eye sockets, scooped out under the brow.
    for side in (-1, 1):
        d = ellipse_sd(dx, v, side * 0.44, 0.452, 0.34, 0.085)
        h -= math.exp(-(d ** 2) * 2.3) * 0.40

    # Temples, hollow either side of the brow.
    for side in (-1, 1):
        d = ellipse_sd(dx, v, side * 0.88, 0.335, 0.30, 0.13)
        h -= math.exp(-(d ** 2) * 2.6) * 0.16

    # Cheekbones: a hard ridge, with the starved hollow directly beneath.
    for side in (-1, 1):
        d = ellipse_sd(dx, v, side * 0.62, 0.565, 0.30, 0.070)
        h += math.exp(-(d ** 2) * 2.4) * 0.17
        d = ellipse_sd(dx, v, side * 0.58, 0.675, 0.27, 0.085)
        h -= math.exp(-(d ** 2) * 2.2) * 0.26

    # Nose: a narrow ridge running down to the aperture.
    nose = math.exp(-((dx / 0.16) ** 2)) * smoothstep(0.40, 0.50, v) * (1 - smoothstep(0.60, 0.665, v))
    h += nose * 0.26

    # Jaw and chin.
    jaw = math.exp(-(((v - 0.905) / 0.075) ** 2)) * math.exp(-((dx / 0.62) ** 2))
    h += jaw * 0.13

    return h


def build():
    w = h_px = SIZE
    buf = bytearray(w * h_px * 4)

    # Light from above and slightly front-left, as in the reference.
    lx, ly, lz = -0.33, -0.86, 0.39
    ln = math.sqrt(lx * lx + ly * ly + lz * lz)
    lx, ly, lz = lx / ln, ly / ln, lz / ln

    eps = 1.0 / SIZE

    for py in range(h_px):
        v = py / h_px
        for px_i in range(w):
            u = (px_i / w - 0.5) * 2.0   # -1..1 across the face
            i = (py * w + px_i) * 4

            z = surface_height(u, v)
            if z is None:
                continue

            # --- Normal by finite difference, so shading follows the form. ---
            zx1 = surface_height(u + eps * 2, v)
            zx0 = surface_height(u - eps * 2, v)
            zy1 = surface_height(u, v + eps * 2)
            zy0 = surface_height(u, v - eps * 2)
            if None in (zx1, zx0, zy1, zy0):
                nx, ny = 0.0, 0.0
            else:
                nx = (zx0 - zx1) / (4 * eps) * 0.42
                ny = (zy0 - zy1) / (4 * eps) * 0.42
            nz = 1.0
            nl = math.sqrt(nx * nx + ny * ny + nz * nz)
            nx, ny, nz = nx / nl, ny / nl, nz / nl

            diffuse = clamp(nx * -lx + ny * -ly + nz * lz)
            # Wrap the light a little, or the underside goes pure black.
            diffuse = clamp(diffuse * 0.62 + 0.38)

            # Ambient occlusion: creases and sockets stay dark whatever the light.
            ao = clamp(0.55 + z * 0.50)

            lit = diffuse * ao
            if lit < 0.34:
                col = mix(FLESH_DEEP, FLESH_SHADOW, lit / 0.34)
            else:
                col = mix(FLESH_SHADOW, FLESH, (lit - 0.34) / 0.66)

            # A cold rim along the silhouette, separating it from the dark.
            half = skull_halfwidth(v)
            edge = 1.0 - abs(u / half)
            col = mix(col, (0.52, 0.60, 0.62), smoothstep(0.16, 0.0, edge) * 0.45)

            # --- The eyes: a red light burning at the back of each socket. ---
            for side in (-1, 1):
                ex, ey = side * 0.44 * half, 0.452
                d = math.hypot((u - ex) / (0.105 * half * 2), (v - ey) / 0.052)
                if d < 2.6:
                    glow = math.exp(-(d ** 2) * 1.5)
                    col = mix(col, BLOOD, clamp(glow * 1.25))
                    core = math.exp(-(d ** 4) * 22.0)
                    col = mix(col, BLOOD_HOT, clamp(core * 0.95))

            # --- Nostrils: two dark slits, angled. ---
            for side in (-1, 1):
                d = math.hypot((u - side * 0.055) / 0.030, (v - 0.617) / 0.022)
                if d < 1.6:
                    col = mix(col, (0.02, 0.02, 0.025), smoothstep(1.6, 0.5, d))

            # --- The mouth, as a field rather than a polygon. ---
            mouth_c, mouth_h = 0.775, 0.092
            mouth_w = 0.50 * half * 2
            mu = u / mouth_w
            mv = (v - mouth_c) / mouth_h
            # A wide lens shape, wider in the middle, tapering at the corners.
            lip = (mu * mu) ** 1.6 + (mv * mv)
            if lip < 1.0:
                inside = smoothstep(1.0, 0.72, lip)
                col = mix(col, (0.035, 0.022, 0.025), inside)

                # --- Teeth. ---
                # A uniform comb of identical triangles reads as a zip, not a
                # mouth. Real fangs in art like this are irregular: different
                # widths, different lengths, some missing, and the corner ones
                # much smaller than the front ones. Each tooth here gets its
                # own deterministic jitter, and some are simply absent.
                def tooth_row(count, seed, base_len, up):
                    ti = (mu + 1.0) * 0.5 * count
                    idx = int(ti)
                    if idx < 0 or idx >= count:
                        return None
                    r1 = (math.sin((idx + seed) * 12.9898) * 43758.5453) % 1.0
                    r2 = (math.sin((idx + seed) * 78.233) * 12345.6789) % 1.0
                    # A few gaps where a tooth has gone.
                    if r2 < 0.13:
                        return None
                    # Width varies; corners are narrower than the centre.
                    centre_bias = 1.0 - abs(mu) * 0.45
                    wide = (0.34 + 0.42 * r1) * centre_bias
                    frac = ti - idx
                    spike = 1.0 - abs(frac - 0.5) * 2.0 / max(wide, 1e-6)
                    if spike <= 0.0:
                        return None
                    length = base_len * (0.55 + 0.75 * r1) * centre_bias
                    reach = (mv if up else -mv)
                    if reach < 0 or reach > length * spike:
                        return None
                    return 1.0 - reach / max(length * spike, 1e-6)

                t = tooth_row(11, 0.0, 0.92, up=False)
                if t is not None:
                    col = mix(col, TOOTH, clamp(0.45 + 0.55 * t) * inside)
                t = tooth_row(9, 5.5, 0.78, up=True)
                if t is not None:
                    col = mix(col, mix(TOOTH, GUM, 0.30), clamp(0.40 + 0.50 * t) * inside)

            # Grain, so the skin is not plastic.
            g = (random.random() - 0.5) * 0.045
            col = (col[0] + g, col[1] + g, col[2] + g)

            # --- Alpha: solid inside, dissolving at the very edge and the hem. ---
            a = 1.0
            a *= smoothstep(0.0, 0.045, edge)
            a *= smoothstep(0.0, 0.035, v)
            a *= 1.0 - smoothstep(0.93, 1.0, v)

            buf[i + 0] = int(clamp(col[0]) * 255)
            buf[i + 1] = int(clamp(col[1]) * 255)
            buf[i + 2] = int(clamp(col[2]) * 255)
            buf[i + 3] = int(clamp(a) * 255)

    return w, h_px, bytes(buf)


def write_png(path, w, h, rgba):
    """Minimal PNG writer, so this script needs nothing installed."""
    raw = bytearray()
    stride = w * 4
    for y in range(h):
        raw.append(0)
        raw += rgba[y * stride:(y + 1) * stride]

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)


if __name__ == "__main__":
    out = "public/assets/ghost.png"
    w, h, rgba = build()
    write_png(out, w, h, rgba)
    print(f"wrote {out}  {w}x{h}")
