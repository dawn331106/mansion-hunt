"""
Build the ghost as a rigged, animated 3D model, with the supplied face on it.

The old ghost was a lathe "egg" wearing the face artwork, over a flat panel
carrying a photograph of a body. Head-on it read; from anywhere else it was a
cut-out. This builds the whole figure as geometry instead, in Blender, and
exports one GLB the game loads:

  * a gaunt sculpted head: sunk eye sockets, hollow cheeks, a long jaw and a
    concave mouth, placed so they sit under the matching features of the art;
  * the face art (`public/assets/ghot.webp`) projected onto the front of that
    head. The art is tilted about 16 degrees in its frame, so the projection
    is rotated to level the eyes, and it is blended into painted skin around
    the edges rather than stopping at a seam;
  * a hood, a tattered floor-length shroud and long bell sleeves, with folds
    and a ragged hem;
  * bony hands with long clawed fingers;
  * a skeleton, with every vertex weighted by distance to the bones;
  * three animations: Idle (float and sway), Chase (lean in, arms reaching,
    shroud trailing) and Lunge (arms flung wide, then the grab), which the
    jumpscare scrubs through.

Colour is baked to textures with Cycles, ambient occlusion is multiplied in
so the folds and the inside of the hood read in the dark, and the baked result
is what ships, so the game needs nothing beyond a standard material.

The script is deterministic; re-run it after changing anything here or after
replacing the face artwork.

    E:/Blender/blender.exe --background --factory-startup \\
        --python tools/build-ghost.py -- [out.glb] [preview_dir]
"""

import math
import os
import random
import sys

import bpy
import numpy as np
from mathutils import Euler, Matrix, Quaternion, Vector

ARGS = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = ARGS[0] if ARGS else os.path.join(ROOT, "public", "assets", "ghost.glb")
PREVIEW = ARGS[1] if len(ARGS) > 1 else None
FACE = os.path.join(ROOT, "public", "assets", "ghot.webp")

random.seed(7)
TAU = math.tau


def clamp(x, lo, hi):
    return lo if x < lo else hi if x > hi else x


def smoothstep(e0, e1, x):
    t = clamp((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def lerp(a, b, t):
    return a + (b - a) * t


# ---------------------------------------------------------------------------
# Mesh building
# ---------------------------------------------------------------------------

class Builder:
    """Collects vertices, faces and per-vertex float attributes for one mesh."""

    def __init__(self):
        self.verts = []
        self.faces = []
        self.attrs = {}

    def add(self, co, **attrs):
        i = len(self.verts)
        self.verts.append(tuple(co))
        for k, v in attrs.items():
            self.attrs.setdefault(k, {})[i] = v
        return i

    def grid(self, rows, closed=True):
        """Quads between consecutive rings of vertex indices."""
        for a, b in zip(rows, rows[1:]):
            n = len(a)
            for j in range(n if closed else n - 1):
                k = (j + 1) % n
                self.faces.append((a[j], a[k], b[k], b[j]))

    def fan(self, ring, centre, flip=False):
        n = len(ring)
        for j in range(n):
            k = (j + 1) % n
            self.faces.append((ring[k], ring[j], centre) if flip else (ring[j], ring[k], centre))

    def build(self, name):
        me = bpy.data.meshes.new(name)
        me.from_pydata(self.verts, [], self.faces)
        me.validate()
        n = len(me.vertices)
        for k, vals in self.attrs.items():
            arr = np.zeros(n, dtype=np.float32)
            for i, v in vals.items():
                arr[i] = v
            me.attributes.new(k, "FLOAT", "POINT").data.foreach_set("value", arr)
        ob = bpy.data.objects.new(name, me)
        bpy.context.scene.collection.objects.link(ob)
        return ob


def fix_normals(ob, outward_from=None):
    """Make face normals consistent, and outward if an interior point is given."""
    import bmesh
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    if outward_from is not None:
        score = 0.0
        for f in bm.faces:
            c = f.calc_center_median()
            p = outward_from(c)
            score += f.normal.dot(c - p) * f.calc_area()
        if score < 0:
            bmesh.ops.reverse_faces(bm, faces=bm.faces)
    bm.to_mesh(ob.data)
    bm.free()
    for p in ob.data.polygons:
        p.use_smooth = True


def tube(b, pts, radii, sides, ref, attrs_fn=None, ellipse=(1.0, 1.0), cap_end=False, twist=0.0):
    """
    A tube along a polyline, with rings framed by parallel transport.

    `ref` is the initial "side" direction; `ellipse` squashes the cross-section
    along (side, normal). Returns the list of rings.
    """
    pts = [Vector(p) for p in pts]
    tangents = []
    for i in range(len(pts)):
        a = pts[max(i - 1, 0)]
        c = pts[min(i + 1, len(pts) - 1)]
        tangents.append((c - a).normalized())
    side = Vector(ref)
    side = (side - tangents[0] * side.dot(tangents[0])).normalized()
    rings = []
    prev_t = tangents[0]
    for i, (p, t) in enumerate(zip(pts, tangents)):
        rot = prev_t.rotation_difference(t)
        side = (rot @ side)
        side = (side - t * side.dot(t)).normalized()
        prev_t = t
        nrm = t.cross(side).normalized()
        ring = []
        for j in range(sides):
            a = TAU * j / sides + twist * i
            off = side * (math.cos(a) * radii[i] * ellipse[0]) + nrm * (math.sin(a) * radii[i] * ellipse[1])
            co = p + off
            extra = attrs_fn(i, j, co) if attrs_fn else {}
            if "offset" in extra:
                co = co + extra.pop("offset")
            ring.append(b.add(co, **extra))
        rings.append(ring)
    b.grid(rings)
    if cap_end:
        c = b.add(pts[-1] + tangents[-1] * radii[-1] * 0.6, **(attrs_fn(len(pts) - 1, 0, pts[-1]) if attrs_fn else {}))
        b.fan(rings[-1], c)
    return rings


# ---------------------------------------------------------------------------
# The head
# ---------------------------------------------------------------------------

HEAD_C = Vector((0.0, -0.01, 2.00))   # head centre, world (Blender Z up, facing -Y)
EYE_Z = 0.045                          # eye line, head-local
EYE_X = 0.058
FACE_S = 0.275                         # metres per unit of the art's width
# The art's own frame: the midpoint between the eyes, the direction along the
# eye line (it slopes down to the right) and the direction down the face.
ART_C = (0.39, 0.23)
ART_A = (0.96, 0.27)
ART_D = (-0.27, 0.96)


def gauss(x, z, cx, cz, sx, sz):
    return math.exp(-(((x - cx) ** 2) / (2 * sx * sx) + ((z - cz) ** 2) / (2 * sz * sz)))


def head_point(n):
    """Sculpt: a unit direction on the sphere to a point on the skull."""
    nx, ny, nz = n
    x, y, z = 0.098 * nx, 0.118 * ny, 0.145 * nz
    if ny > 0:
        y *= 1.08                                    # the back of the skull
    jaw = smoothstep(0.0, -0.9, nz) * smoothstep(0.35, -0.5, ny)
    z -= 0.065 * jaw                                 # long, hanging jaw
    x *= 1 - 0.28 * smoothstep(-0.2, -1.0, nz)       # narrow at the chin
    x *= 1 - 0.06 * smoothstep(0.1, 0.9, nz)         # and at the crown

    front = smoothstep(0.0, -0.5, ny)
    ax = abs(x)
    dy = 0.0
    dy += 0.020 * (gauss(x, z, EYE_X, EYE_Z, 0.020, 0.016) + gauss(x, z, -EYE_X, EYE_Z, 0.020, 0.016))
    dy -= 0.009 * math.exp(-((z - 0.078) ** 2) / (2 * 0.012 ** 2)) * smoothstep(0.095, 0.05, ax)
    dy -= 0.006 * (gauss(x, z, 0.072, 0.0, 0.018, 0.014) + gauss(x, z, -0.072, 0.0, 0.018, 0.014))
    dy += 0.016 * (gauss(x, z, 0.066, -0.065, 0.022, 0.030) + gauss(x, z, -0.066, -0.065, 0.022, 0.030))
    dy -= 0.014 * gauss(x, z, 0.0, -0.010, 0.011, 0.028)
    dy -= 0.006 * gauss(x, z, 0.0, 0.040, 0.009, 0.020)
    dy += 0.022 * gauss(x, z, 0.0, -0.120, 0.050, 0.035)
    y += dy * front
    return Vector((x, y, z))


def art_uv(x, z):
    """Head-local (x, z) to the art's (u, v_down), levelling its tilt."""
    X = x / FACE_S
    D = (EYE_Z - z) / FACE_S
    u = ART_C[0] + X * ART_A[0] + D * ART_D[0]
    vd = ART_C[1] + X * ART_A[1] + D * ART_D[1]
    return u, vd


def art_mask(u, vd):
    """How much of the art to show at a point in its frame: the face, softly."""
    cu, cv = 0.38, 0.47
    pu, pv = u - cu, vd - cv
    s1 = (pu * ART_A[0] + pv * ART_A[1]) / 0.46
    s2 = (pu * ART_D[0] + pv * ART_D[1]) / 0.56
    m = 1 - smoothstep(0.72, 1.0, math.hypot(s1, s2))
    m *= smoothstep(0.0, 0.05, u) * smoothstep(1.0, 0.95, u)
    m *= smoothstep(0.0, 0.05, vd) * smoothstep(1.0, 0.95, vd)
    return m


def build_head():
    b = Builder()
    RINGS, SEGS = 44, 64
    uvs = {}

    def vert(n):
        p = head_point(n)
        u, vd = art_uv(p.x, p.z)
        facing = smoothstep(0.12, 0.55, -n[1])
        shade = lerp(0.55, 1.0, smoothstep(0.7, -0.6, n[1])) * lerp(0.7, 1.0, smoothstep(-0.9, 0.2, n[2]))
        eye = max(gauss(p.x, p.z, EYE_X, EYE_Z, 0.009, 0.007), gauss(p.x, p.z, -EYE_X, EYE_Z, 0.009, 0.007)) * facing
        i = b.add(HEAD_C + p, facemask=art_mask(u, vd) * facing, eyeglow=eye, shade=shade)
        uvs[i] = (u, 1.0 - vd)
        return i

    top = vert((0, 0, 1))
    rows = []
    for r in range(1, RINGS):
        phi = math.pi * r / RINGS
        row = []
        for s in range(SEGS):
            lam = TAU * s / SEGS
            row.append(vert((math.sin(phi) * math.cos(lam), math.sin(phi) * math.sin(lam), math.cos(phi))))
        rows.append(row)
    bot = vert((0, 0, -1))
    b.fan(rows[0], top, flip=True)
    b.grid(rows)
    b.fan(rows[-1], bot)
    ob = b.build("Head")
    fix_normals(ob, lambda c: HEAD_C)

    me = ob.data
    uv = me.uv_layers.new(name="FaceProj")
    for loop in me.loops:
        uv.data[loop.index].uv = uvs[loop.vertex_index]
    return ob


# ---------------------------------------------------------------------------
# The shroud: robe, hood and sleeves
# ---------------------------------------------------------------------------

PROFILE = [(1.97, 0.120), (1.86, 0.118), (1.78, 0.125), (1.75, 0.155), (1.72, 0.200),
           (1.66, 0.215), (1.50, 0.200), (1.30, 0.185), (1.10, 0.210), (0.80, 0.270),
           (0.50, 0.330), (0.20, 0.400), (0.00, 0.440), (-0.30, 0.460)]


def profile_r(z):
    for (z0, r0), (z1, r1) in zip(PROFILE, PROFILE[1:]):
        if z1 <= z <= z0:
            return lerp(r1, r0, (z - z1) / (z0 - z1))
    return PROFILE[0][1] if z > PROFILE[0][0] else PROFILE[-1][1]


# Arm joints, left side (+X is the character's left; it faces -Y).
SHOULDER = Vector((0.20, 0.00, 1.70))
ELBOW = Vector((0.29, -0.05, 1.36))
WRIST = Vector((0.34, -0.10, 1.03))
HAND_END = Vector((0.36, -0.13, 0.84))


def mirror(v):
    return Vector((-v.x, v.y, v.z))


def build_robe(b):
    SEGS, ROWS = 72, 52
    phase = [random.uniform(0, TAU) for _ in range(4)]
    rows = []
    for r in range(ROWS):
        t = (r / (ROWS - 1)) ** 1.25
        row = []
        for s in range(SEGS):
            th = TAU * s / SEGS
            cx, sy = math.cos(th), math.sin(th)
            back = (1 + sy) / 2                              # +Y is the back
            z_top = 1.75 + 0.22 * back ** 1.6                # low at the throat, high behind the hood
            rag = 0.24 * max(0.0, math.sin(9 * th + 0.7 * math.sin(3 * th) + phase[0])) ** 4
            rag += 0.13 * max(0.0, math.sin(17 * th + phase[1])) ** 6
            z_hem = 0.26 + 0.05 * math.sin(5 * th + phase[2]) - rag
            z = lerp(z_top, z_hem, t)
            rad = profile_r(z)
            upper = smoothstep(1.0, 1.6, z)
            fold = (0.018 * math.sin(7 * th + 1.3) + 0.010 * math.sin(13 * th + 0.4)
                    + 0.006 * math.sin(23 * th + phase[3])) * smoothstep(1.35, 0.3, z)
            rx = (rad + fold) * (1 + 0.18 * upper)
            ry = (rad + fold) * (1 - 0.30 * upper)
            row.append(b.add((cx * rx, sy * ry, z), part=0.0, hem=smoothstep(0.7, 0.05, z)))
        rows.append(row)
    b.grid(rows)


HOOD_C = Vector((0.0, 0.012, 2.02))


def build_hood(b):
    """
    A cowl, parameterised around the point at the back of the crown.

    Cutting a face hole out of a sphere left a stair-stepped edge wherever the
    grid crossed the cut. Here every ring is a fixed fraction of the way from
    that back pole to the hood's edge, so the edge is itself the last ring and
    is as smooth as the ring count allows. How far the hood reaches in each
    direction (`reach`) shapes the opening: short at the brow, so the face
    shows, long down the sides and back, so it drapes onto the shoulders.
    """
    pole = Vector((0.0, 0.45, 0.89)).normalized()
    ea = Vector((1.0, 0.0, 0.0))
    eb = pole.cross(ea).normalized()             # toward the back of the neck
    RINGS, SEGS = 30, 80
    jag = [random.uniform(0, 1) for _ in range(SEGS)]
    top = b.add(HOOD_C + Vector((0.138 * pole.x, 0.158 * pole.y, 0.19 * pole.z)), part=1.0, hem=0.0)
    rows = []
    for r in range(1, RINGS + 1):
        t = r / RINGS
        row = []
        for s in range(SEGS):
            phi = TAU * s / SEGS
            front = max(0.0, math.cos(phi - 1.5 * math.pi))     # 1 at the brow
            reach = math.radians(116 - 36 * front ** 1.2)
            th = reach * t
            d = pole * math.cos(th) + (ea * math.cos(phi) + eb * math.sin(phi)) * math.sin(th)
            co = HOOD_C + Vector((0.138 * d.x, 0.158 * d.y, 0.19 * d.z))
            # Drape: flare the lower hood out over the collar.
            drape = smoothstep(1.97, 1.84, co.z)
            co.x *= 1 + 0.35 * drape
            co.y = HOOD_C.y + (co.y - HOOD_C.y) * (1 + 0.25 * drape)
            # A heavy brow on the hood, pulled forward and down over the face.
            brow = front ** 3 * smoothstep(0.6, 1.0, t)
            co += Vector((0, -0.035, -0.02)) * brow
            # Roll the edge outward, and fray the part that lies on the shoulders.
            if t > 0.92:
                out = (co - HOOD_C)
                out.z = 0
                co += out.normalized() * 0.008 * smoothstep(0.92, 1.0, t) if out.length > 1e-6 else Vector()
            if r == RINGS:
                co.z -= 0.035 * jag[s] ** 2 * (1 - front)
            row.append(b.add(co, part=1.0, hem=0.25 * drape))
        rows.append(row)
    b.fan(rows[0], top, flip=True)
    b.grid(rows)


def build_mantle(b):
    """A short ragged cape over the shoulders, so the silhouette is not one cone."""
    SEGS, ROWS = 72, 18
    ph = [random.uniform(0, TAU) for _ in range(3)]
    rows = []
    for r in range(ROWS):
        t = r / (ROWS - 1)
        row = []
        for s in range(SEGS):
            th = TAU * s / SEGS
            cx, sy = math.cos(th), math.sin(th)
            back = (1 + sy) / 2
            z_top = 1.77 + 0.14 * back ** 1.6
            rag = 0.22 * max(0.0, math.sin(7 * th + ph[0])) ** 3 + 0.10 * max(0.0, math.sin(15 * th + ph[1])) ** 5
            z_hem = 1.42 + 0.06 * math.sin(4 * th + ph[2]) - rag - 0.10 * back
            z = lerp(z_top, z_hem, t ** 1.1)
            rad = profile_r(z) + 0.022 + 0.035 * smoothstep(1.76, 1.62, z)
            upper = smoothstep(1.0, 1.6, z)
            fold = 0.012 * math.sin(9 * th + 0.5) * smoothstep(1.7, 1.4, z)
            rx = (rad + fold) * (1 + 0.24 * upper)
            ry = (rad + fold) * (1 - 0.22 * upper)
            row.append(b.add((cx * rx, sy * ry, z), part=6.0, hem=0.35 * t))
        rows.append(row)
    b.grid(rows)


def build_sleeve(b, side):
    m = (lambda v: v) if side > 0 else mirror
    start = m(Vector((0.13, 0.0, 1.70)))
    fore = (WRIST - ELBOW).normalized()
    path = [start, m(SHOULDER), m(ELBOW), m(WRIST), m(WRIST + fore * 0.05)]
    pts, radii = [], []
    rs = [0.062, 0.066, 0.072, 0.090, 0.100]
    for i in range(len(path) - 1):
        n = 2 if i == 0 else 7
        for k in range(n):
            t = k / n
            pts.append(path[i].lerp(path[i + 1], t))
            radii.append(lerp(rs[i], rs[i + 1], t))
    pts.append(path[-1])
    radii.append(rs[-1])
    last = len(pts) - 1
    tip_dir = (path[-1] - path[-2]).normalized()
    jag = [random.uniform(0, 1) ** 2 for _ in range(16)]

    def attrs(i, j, co):
        d = {"part": 2.0 if side > 0 else 3.0, "hem": 0.3 if i >= last - 1 else 0.0}
        if i >= last - 1:
            k = 1.0 if i == last else 0.35
            d["offset"] = tip_dir * (0.07 * jag[j] + 0.02 * math.sin(j * 2.3)) * k
        return d

    tube(b, pts, radii, 16, (0, -1, 0), attrs)


def build_shroud():
    b = Builder()
    build_robe(b)
    build_hood(b)
    build_mantle(b)
    build_sleeve(b, +1)
    build_sleeve(b, -1)
    ob = b.build("Shroud")
    fix_normals(ob)
    # Orient each part outward from its own axis.
    import bmesh
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    part = bm.verts.layers.float.get("part")
    flip = []
    for f in bm.faces:
        c = f.calc_center_median()
        pid = f.verts[0][part]
        if pid in (0, 6):
            axis = Vector((0, 0, c.z))
        elif pid == 1:
            axis = HOOD_C
        else:
            s = 1 if pid == 2 else -1
            a, e = (SHOULDER, WRIST) if s > 0 else (mirror(SHOULDER), mirror(WRIST))
            t = clamp((c - a).dot(e - a) / (e - a).length_squared, 0, 1)
            axis = a.lerp(e, t)
        if f.normal.dot(c - axis) < 0:
            flip.append(f)
    bmesh.ops.reverse_faces(bm, faces=flip)
    bm.to_mesh(ob.data)
    bm.free()
    for p in ob.data.polygons:
        p.use_smooth = True

    # Cloth thickness, so the hood has an inside that can fall into shadow.
    mod = ob.modifiers.new("Solidify", "SOLIDIFY")
    mod.thickness = 0.008
    mod.offset = -1.0
    apply_modifiers(ob)
    return ob


def apply_modifiers(ob):
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg), preserve_all_data_layers=True, depsgraph=dg)
    old = ob.data
    ob.modifiers.clear()
    ob.data = me
    bpy.data.meshes.remove(old)


# ---------------------------------------------------------------------------
# Hands
# ---------------------------------------------------------------------------

def build_hand(b, side):
    m = (lambda v: v) if side > 0 else mirror
    w, h = m(WRIST), m(HAND_END)
    f = (h - w).normalized()
    fwd = Vector((0, -1, 0))
    s = (fwd - f * fwd.dot(f)).normalized()          # across the knuckles, index side forward
    n = f.cross(s).normalized()                      # palm normal
    if side < 0:
        n = -n
    part = 4.0 if side > 0 else 5.0
    start = w + f * 0.035                            # inside the sleeve

    def skin(i, j, co):
        return {"part": part, "claw": 0.0}

    palm_len = 0.10
    tube(b, [start - f * 0.03, start + f * 0.02, start + f * palm_len * 0.7, start + f * palm_len],
         [0.034, 0.042, 0.045, 0.040], 10, s, skin, ellipse=(1.0, 0.38), cap_end=True)

    knuckle = start + f * palm_len
    lengths = [0.160, 0.180, 0.170, 0.135]
    for k, off in enumerate([0.031, 0.0105, -0.0105, -0.031]):
        base = knuckle - f * 0.008 + s * off
        splay = (off / 0.031) * 0.12
        d = (f + s * splay).normalized()
        pts, radii = [base], []
        seg = lengths[k] / 3
        p = base
        curl = 0.28 + 0.06 * k
        for joint in range(3):
            d = (d + n * math.sin(curl)).normalized()
            for q in range(1, 3):
                pts.append(p + d * seg * q / 2)
            p = pts[-1]
        radii = [lerp(0.0105, 0.0055, (i / (len(pts) - 1))) for i in range(len(pts))]
        radii[-1] = 0.0012
        radii[-2] *= 0.8
        count = len(pts)
        tube(b, pts, radii, 6, n,
             lambda i, j, co, c=count: {"part": part, "claw": smoothstep(c - 3.2, c - 1.2, i)})

    # Thumb, from the base of the palm on the index side, angled across it.
    tb = start + f * 0.02 + s * 0.036
    d = (f * 0.6 + s * 0.5 + n * 0.5).normalized()
    pts = [tb]
    for q in range(1, 5):
        d = (d + n * 0.12).normalized()
        pts.append(pts[-1] + d * 0.026)
    radii = [0.012, 0.011, 0.0085, 0.005, 0.0012]
    tube(b, pts, radii, 6, n, lambda i, j, co: {"part": part, "claw": smoothstep(2.2, 3.8, i)})


def build_hands():
    b = Builder()
    build_hand(b, +1)
    build_hand(b, -1)
    ob = b.build("Hands")
    fix_normals(ob)
    return ob


# ---------------------------------------------------------------------------
# Skeleton and weights
# ---------------------------------------------------------------------------

SKIRT = {"F": (0.0, -0.8), "B": (0.0, 0.8), "L": (1.0, 0.0), "R": (-1.0, 0.0)}


def bone_table():
    t = [
        ("root", (0, 0, 0), (0, 0, 0.25), None),
        ("spine0", (0, 0, 1.00), (0, 0, 1.32), "root"),
        ("spine1", (0, 0, 1.32), (0, 0, 1.56), "spine0"),
        ("chest", (0, 0, 1.56), (0, 0, 1.74), "spine1"),
        ("neck", (0, 0, 1.74), (0, -0.01, 1.88), "chest"),
        ("head", (0, -0.01, 1.88), (0, -0.01, 2.16), "neck"),
    ]
    for sfx, m in (("L", lambda v: v), ("R", mirror)):
        t += [
            (f"shoulder.{sfx}", m(Vector((0.04, 0, 1.70))), m(SHOULDER), "chest"),
            (f"upperarm.{sfx}", m(SHOULDER), m(ELBOW), f"shoulder.{sfx}"),
            (f"forearm.{sfx}", m(ELBOW), m(WRIST), f"upperarm.{sfx}"),
            (f"hand.{sfx}", m(WRIST), m(HAND_END), f"forearm.{sfx}"),
        ]
    for k, (dx, dy) in SKIRT.items():
        a = Vector((dx * 0.08, dy * 0.08, 1.05))
        mid = Vector((dx * 0.21, dy * 0.21, 0.60))
        end = Vector((dx * 0.34, dy * 0.34, 0.10))
        t += [(f"skirt.{k}.1", a, mid, "spine0"), (f"skirt.{k}.2", mid, end, f"skirt.{k}.1")]
    return t


def build_armature():
    arm_data = bpy.data.armatures.new("GhostRig")
    arm = bpy.data.objects.new("GhostRig", arm_data)
    bpy.context.scene.collection.objects.link(arm)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="EDIT")
    for name, h, t, parent in bone_table():
        eb = arm_data.edit_bones.new(name)
        eb.head, eb.tail, eb.roll = Vector(h), Vector(t), 0.0
        if parent:
            eb.parent = arm_data.edit_bones[parent]
            eb.use_connect = False
    bpy.ops.object.mode_set(mode="OBJECT")
    return arm


def seg_dist(p, a, b):
    ab = b - a
    t = clamp((p - a).dot(ab) / ab.length_squared, 0.0, 1.0)
    return (p - (a + ab * t)).length


def weight_mesh(ob, arm, rule):
    """Weight each vertex to its candidate bones by inverse distance to the bone."""
    bones = {b.name: (b.head_local.copy(), b.tail_local.copy()) for b in arm.data.bones}
    groups = {name: ob.vertex_groups.new(name=name) for name in bones}
    me = ob.data
    part = me.attributes.get("part")
    for v in me.vertices:
        pid = part.data[v.index].value if part else -1
        cands = rule(pid, v.co)
        if len(cands) == 1 and isinstance(cands[0], str):
            groups[cands[0]].add([v.index], 1.0, "REPLACE")
            continue
        ws = []
        for c in cands:
            c, bias = c if isinstance(c, tuple) else (c, 1.0)
            d = seg_dist(v.co, *bones[c])
            ws.append((c, bias / (d * d + 1e-4) ** 2))
        ws.sort(key=lambda x: -x[1])
        ws = ws[:4]
        tot = sum(w for _, w in ws)
        for c, w in ws:
            if w / tot > 0.01:
                groups[c].add([v.index], w / tot, "REPLACE")
    mod = ob.modifiers.new("Armature", "ARMATURE")
    mod.object = arm
    ob.parent = arm


def shroud_rule(pid, co):
    if pid == 1:
        return ["head"]
    if pid == 6:
        # The arms barely pull on the mantle: it rests on the shoulders, and
        # letting the upper arms own it tore it apart whenever they lifted.
        return ["spine1", "chest", "neck", "shoulder.L", "shoulder.R",
                ("upperarm.L", 0.06), ("upperarm.R", 0.06)]
    if pid in (2, 3):
        s = "L" if pid == 2 else "R"
        return [f"shoulder.{s}", f"upperarm.{s}", f"forearm.{s}", f"hand.{s}"]
    return (["spine0", "spine1", "chest", "neck", "shoulder.L", "shoulder.R"]
            + [f"skirt.{k}.{i}" for k in SKIRT for i in (1, 2)])


def hands_rule(pid, co):
    s = "L" if pid == 4 else "R"
    return [f"forearm.{s}", f"hand.{s}"]


# ---------------------------------------------------------------------------
# Animation
# ---------------------------------------------------------------------------

def Q(rx=0.0, ry=0.0, rz=0.0):
    return Euler((rx, ry, rz), "XYZ").to_quaternion()


def sway(wx, wy):
    """Deflect a downward-hanging chain toward (wx, wy); the magnitude is the angle."""
    a = math.hypot(wx, wy)
    if a < 1e-6:
        return Quaternion()
    return Quaternion(Vector((wy, -wx, 0)).normalized(), a)


def skirt_poses(pose, wind):
    """`wind(key, link)` -> (wx, wy) for each skirt bone."""
    for k in SKIRT:
        for i in (1, 2):
            pose[f"skirt.{k}.{i}"] = sway(*wind(k, i))


def pose_idle(f):
    p = TAU * f / 120
    tw = sum(math.exp(-(((f - 80 + 120 * c) / 2.5) ** 2)) for c in (-1, 0, 1))
    pose = {
        "root": (Quaternion(), Vector((0, 0, 0.04 * math.sin(p)))),
        "spine0": Q(0.03 * math.sin(p + 1), 0.035 * math.sin(p)),
        "spine1": Q(0.02 * math.sin(p + 1.6)),
        "chest": Q(0.03 + 0.02 * math.sin(2 * p + 0.5)),
        "neck": Q(0.08 + 0.02 * math.sin(p + 2)),
        "head": Q(-0.04 + 0.04 * math.sin(2 * p), 0.10 * math.sin(p + 0.3) + 0.2 * tw, 0.12 * math.sin(p + 1.1)),
        "upperarm.L": Q(-0.12 + 0.10 * math.sin(p + 0.8), -0.06 + 0.04 * math.sin(p + 2.0)),
        "upperarm.R": Q(-0.12 + 0.10 * math.sin(p + 2.4), 0.06 - 0.04 * math.sin(p + 3.0)),
        "forearm.L": Q(-0.25 + 0.08 * math.sin(p + 1.5)),
        "forearm.R": Q(-0.25 + 0.08 * math.sin(p + 3.1)),
        "hand.L": Q(-0.15 + 0.10 * math.sin(p + 2.2)),
        "hand.R": Q(-0.15 + 0.10 * math.sin(p + 3.8)),
    }
    ph = {"F": 0.0, "L": 1.6, "B": 3.1, "R": 4.7}

    def wind(k, i):
        q = p - 0.7 * (i - 1) + ph[k]
        dx, dy = SKIRT[k]
        flare = 0.03 + 0.03 * math.sin(2 * p + ph[k])
        amp = 0.06 * (1 + 0.6 * (i - 1))
        return (amp * math.cos(q) + dx * flare, amp * math.sin(q) + dy * flare)

    skirt_poses(pose, wind)
    return pose


def pose_chase(f):
    p = TAU * f / 48
    pose = {
        "root": (Quaternion(), Vector((0, 0, 0.03 * math.sin(2 * p)))),
        "spine0": Q(0.30 + 0.03 * math.sin(2 * p)),
        "spine1": Q(0.10),
        "chest": Q(0.08 + 0.02 * math.sin(2 * p + 1)),
        "neck": Q(-0.14),
        "head": Q(-0.22 + 0.04 * math.sin(2 * p + 0.5), 0.05 * math.sin(p)),
        "upperarm.L": Q(-1.45 + 0.18 * math.sin(p), -0.25),
        "upperarm.R": Q(-1.45 + 0.18 * math.sin(p + math.pi), 0.25),
        "forearm.L": Q(-0.22 + 0.08 * math.sin(p + 0.8)),
        "forearm.R": Q(-0.22 + 0.08 * math.sin(p + 0.8 + math.pi)),
        "hand.L": Q(0.20 + 0.10 * math.sin(p + 1)),
        "hand.R": Q(0.20 + 0.10 * math.sin(p + 1 + math.pi)),
    }

    def wind(k, i):
        flut = 0.10 * math.sin(3 * p + (1.3 if k in "LR" else 0) + 0.8 * i)
        dx, dy = SKIRT[k]
        return (0.08 * dx + flut * 0.5, 0.40 * (1 + 0.3 * (i - 1)) + flut)

    skirt_poses(pose, wind)
    return pose


LUNGE_KEYS = {
    7: dict(spine0=0.12, spine1=0.0, chest=-0.10, neck=0.0, head=-0.30, arm_x=-0.55, arm_y=1.25,
            fore=-0.30, hand=0.40, lift=0.08, surge=0.0, trail=0.45, flare=0.30),
    14: dict(spine0=0.45, spine1=0.12, chest=0.10, neck=-0.10, head=-0.35, arm_x=-1.50, arm_y=0.55,
             fore=-0.55, hand=0.50, lift=0.12, surge=-0.25, trail=0.70, flare=0.15),
    24: dict(spine0=0.48, spine1=0.14, chest=0.12, neck=-0.12, head=-0.38, arm_x=-1.55, arm_y=0.42,
             fore=-0.75, hand=0.60, lift=0.12, surge=-0.28, trail=0.72, flare=0.12),
}


def pose_lunge(f):
    if f == 0:
        return pose_chase(0)
    k = LUNGE_KEYS[f]
    pose = {
        "root": (Quaternion(), Vector((0, k["surge"], k["lift"]))),
        "spine0": Q(k["spine0"]), "spine1": Q(k["spine1"]), "chest": Q(k["chest"]),
        "neck": Q(k["neck"]), "head": Q(k["head"]),
        "upperarm.L": Q(k["arm_x"], -k["arm_y"]), "upperarm.R": Q(k["arm_x"], k["arm_y"]),
        "forearm.L": Q(k["fore"]), "forearm.R": Q(k["fore"]),
        "hand.L": Q(k["hand"]), "hand.R": Q(k["hand"]),
    }

    def wind(key, i):
        dx, dy = SKIRT[key]
        return (dx * k["flare"], k["trail"] * (1 + 0.3 * (i - 1)) + dy * k["flare"])

    skirt_poses(pose, wind)
    return pose


def to_local(pb, q, loc):
    R = pb.bone.matrix_local.to_3x3()
    Ri = R.inverted()
    ql = (Ri @ q.to_matrix() @ R).to_quaternion()
    ll = Ri @ loc
    return ql, ll


def bake_action(arm, name, frames, pose_fn):
    act = bpy.data.actions.new(name)
    act.use_fake_user = True
    ad = arm.animation_data or arm.animation_data_create()
    ad.action = act
    for pb in arm.pose.bones:
        pb.rotation_mode = "QUATERNION"
    for f in frames:
        pose = pose_fn(f)
        for pb in arm.pose.bones:
            v = pose.get(pb.name, Quaternion())
            q, loc = v if isinstance(v, tuple) else (v, Vector())
            ql, ll = to_local(pb, q, loc)
            pb.rotation_quaternion = ql
            pb.location = ll
            pb.keyframe_insert("rotation_quaternion", frame=f, group=pb.name)
            pb.keyframe_insert("location", frame=f, group=pb.name)
    ad.action = None
    return act


def use_action(arm, act, frame):
    ad = arm.animation_data
    ad.action = act
    if hasattr(ad, "action_slot") and len(act.slots):
        ad.action_slot = act.slots[0]
    bpy.context.scene.frame_set(frame)


# ---------------------------------------------------------------------------
# Materials and baking
# ---------------------------------------------------------------------------

def node_mat(name):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    return mat, nt, out


def attr(nt, name):
    n = nt.nodes.new("ShaderNodeAttribute")
    n.attribute_type = "GEOMETRY"
    n.attribute_name = name
    return n.outputs["Fac"]


def mix(nt, fac, a, b, blend="MIX"):
    n = nt.nodes.new("ShaderNodeMix")
    n.data_type = "RGBA"
    n.blend_type = blend
    nt.links.new(fac, n.inputs["Factor"]) if not isinstance(fac, float) else None
    if isinstance(fac, float):
        n.inputs["Factor"].default_value = fac
    for sock, v in ((n.inputs["A"], a), (n.inputs["B"], b)):
        if isinstance(v, tuple):
            sock.default_value = v
        else:
            nt.links.new(v, sock)
    return n.outputs["Result"]


def noise(nt, scale, stretch=(1, 1, 1), detail=4.0):
    tc = nt.nodes.new("ShaderNodeTexCoord")
    mp = nt.nodes.new("ShaderNodeMapping")
    mp.inputs["Scale"].default_value = stretch
    nt.links.new(tc.outputs["Object"], mp.inputs["Vector"])
    nz = nt.nodes.new("ShaderNodeTexNoise")
    nz.inputs["Scale"].default_value = scale
    nz.inputs["Detail"].default_value = detail
    nt.links.new(mp.outputs["Vector"], nz.inputs["Vector"])
    return nz.outputs["Fac"]


def emit(nt, out, color):
    em = nt.nodes.new("ShaderNodeEmission")
    nt.links.new(color, em.inputs["Color"])
    nt.links.new(em.outputs["Emission"], out.inputs["Surface"])


def ramp(nt, fac, a, b):
    """Map a 0..1 factor onto a colour range."""
    return mix(nt, fac, a, b)


def head_albedo_mat(face_img):
    mat, nt, out = node_mat("HeadBake")
    uvn = nt.nodes.new("ShaderNodeUVMap")
    uvn.uv_map = "FaceProj"
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = face_img
    tex.extension = "EXTEND"
    nt.links.new(uvn.outputs["UV"], tex.inputs["Vector"])
    skin = ramp(nt, noise(nt, 38.0), (0.105, 0.102, 0.125, 1), (0.20, 0.195, 0.23, 1))
    skin = mix(nt, attr(nt, "shade"), (0, 0, 0, 1), skin)
    emit(nt, out, mix(nt, attr(nt, "facemask"), skin, tex.outputs["Color"]))
    return mat


def head_glow_mat():
    mat, nt, out = node_mat("HeadGlowBake")
    emit(nt, out, mix(nt, attr(nt, "eyeglow"), (0, 0, 0, 1), (0.42, 0.025, 0.015, 1)))
    return mat


def shroud_mat():
    mat, nt, out = node_mat("ShroudBake")
    streak = noise(nt, 5.0, (7, 7, 1.1), 6.0)
    cloth = ramp(nt, streak, (0.075, 0.078, 0.076, 1), (0.23, 0.232, 0.22, 1))
    stain = ramp(nt, noise(nt, 3.0, (2, 2, 1), 3.0), (0.6, 0.58, 0.52, 1), (1, 1, 1, 1))
    cloth = mix(nt, 1.0, cloth, stain, blend="MULTIPLY")
    grime = ramp(nt, noise(nt, 14.0), (0.025, 0.024, 0.022, 1), (0.07, 0.065, 0.058, 1))
    emit(nt, out, mix(nt, attr(nt, "hem"), cloth, grime))
    return mat


def hands_mat():
    mat, nt, out = node_mat("HandsBake")
    skin = ramp(nt, noise(nt, 60.0), (0.11, 0.108, 0.13, 1), (0.19, 0.185, 0.22, 1))
    emit(nt, out, mix(nt, attr(nt, "claw"), skin, (0.035, 0.03, 0.025, 1)))
    return mat


def smart_uv(ob):
    bpy.ops.object.select_all(action="DESELECT")
    ob.select_set(True)
    bpy.context.view_layer.objects.active = ob
    me = ob.data
    if "UVMap" not in me.uv_layers:
        me.uv_layers.new(name="UVMap")
    me.uv_layers.active = me.uv_layers["UVMap"]
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=0.006)
    bpy.ops.object.mode_set(mode="OBJECT")


def bake(ob, mat, size, kind, samples=1, noncolor=False):
    img = bpy.data.images.new(f"{ob.name}_{kind}_{mat.name}", size, size, alpha=False)
    if noncolor:
        img.colorspace_settings.name = "Non-Color"
    t = mat.node_tree.nodes.new("ShaderNodeTexImage")
    t.image = img
    mat.node_tree.nodes.active = t
    uvn = mat.node_tree.nodes.new("ShaderNodeUVMap")
    uvn.uv_map = "UVMap"
    mat.node_tree.links.new(uvn.outputs["UV"], t.inputs["Vector"])
    ob.data.materials.clear()
    ob.data.materials.append(mat)
    ob.data.uv_layers.active = ob.data.uv_layers["UVMap"]
    bpy.ops.object.select_all(action="DESELECT")
    ob.select_set(True)
    bpy.context.view_layer.objects.active = ob
    bpy.context.scene.cycles.samples = samples
    bpy.ops.object.bake(type=kind, margin=12, use_clear=True)
    return img


def pixels(img):
    a = np.empty(img.size[0] * img.size[1] * 4, dtype=np.float32)
    img.pixels.foreach_get(a)
    return a.reshape(-1, 4)


def bake_textures(ob, albedo, size, ao_strength, glow=None):
    col = bake(ob, albedo, size, "EMIT")
    ao = bake(ob, albedo, size, "AO", samples=48, noncolor=True)
    c, o = pixels(col), pixels(ao)
    c[:, :3] *= (1 - ao_strength) + ao_strength * o[:, :1]
    col.pixels.foreach_set(c.ravel())
    col.update()
    glow_img = bake(ob, glow, size // 2, "EMIT") if glow else None
    return col, glow_img


def final_mat(name, col, glow=None, rough=0.85):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    t = nt.nodes.new("ShaderNodeTexImage")
    t.image = col
    nt.links.new(t.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = rough
    if glow:
        g = nt.nodes.new("ShaderNodeTexImage")
        g.image = glow
        nt.links.new(g.outputs["Color"], bsdf.inputs["Emission Color"])
        bsdf.inputs["Emission Strength"].default_value = 1.0
    return mat


# ---------------------------------------------------------------------------
# Preview renders
# ---------------------------------------------------------------------------

def setup_preview_scene():
    sc = bpy.context.scene
    sc.render.engine = "BLENDER_EEVEE"
    sc.render.resolution_x, sc.render.resolution_y = 512, 768
    sc.render.film_transparent = False
    world = bpy.data.worlds.new("W")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.012, 0.013, 0.018, 1)
    sc.world = world

    def light(name, kind, loc, energy, color, size=1.0, target=(0, 0, 1.5)):
        ld = bpy.data.lights.new(name, kind)
        ld.energy, ld.color = energy, color
        if kind == "AREA":
            ld.size = size
        lo = bpy.data.objects.new(name, ld)
        lo.location = loc
        d = Vector(target) - Vector(loc)
        lo.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
        sc.collection.objects.link(lo)

    light("Key", "AREA", (-1.6, -2.2, 3.2), 420, (1.0, 0.96, 0.92), 1.2)
    light("Rim", "AREA", (1.4, 2.6, 2.8), 520, (0.55, 0.65, 1.0), 1.5)
    light("Fill", "AREA", (1.8, -2.0, 0.6), 60, (0.8, 0.3, 0.3), 2.0)
    cd = bpy.data.cameras.new("Cam")
    cam = bpy.data.objects.new("Cam", cd)
    sc.collection.objects.link(cam)
    sc.camera = cam
    return cam


def shoot(cam, path, az, elev, dist, target_z, lens):
    a = math.radians(az)
    e = math.radians(elev)
    tgt = Vector((0, 0, target_z))
    cam.location = tgt + Vector((math.sin(a) * math.cos(e), -math.cos(a) * math.cos(e), math.sin(e))) * dist
    cam.rotation_euler = (tgt - cam.location).to_track_quat("-Z", "Y").to_euler()
    cam.data.lens = lens
    bpy.context.scene.render.filepath = path
    bpy.ops.render.render(write_still=True)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.render.fps = 30
    sc.render.engine = "CYCLES"
    sc.cycles.device = "CPU"

    face_img = bpy.data.images.load(FACE)
    head = build_head()
    shroud = build_shroud()
    hands = build_hands()
    for ob in (head, shroud, hands):
        smart_uv(ob)

    head_col, head_glow = bake_textures(head, head_albedo_mat(face_img), 1024, 0.35, glow=head_glow_mat())
    shroud_col, _ = bake_textures(shroud, shroud_mat(), 1024, 0.85)
    hands_col, _ = bake_textures(hands, hands_mat(), 512, 0.6)

    for ob, mat in ((head, final_mat("GhostHead", head_col, head_glow, 0.55)),
                    (shroud, final_mat("GhostShroud", shroud_col, rough=0.95)),
                    (hands, final_mat("GhostHands", hands_col, rough=0.6))):
        ob.data.materials.clear()
        ob.data.materials.append(mat)
        me = ob.data
        if "FaceProj" in me.uv_layers:
            me.uv_layers.remove(me.uv_layers["FaceProj"])

    arm = build_armature()
    weight_mesh(head, arm, lambda pid, co: ["head"])
    weight_mesh(shroud, arm, shroud_rule)
    weight_mesh(hands, arm, hands_rule)
    for ob in (head, shroud, hands):
        for a in [a.name for a in ob.data.attributes if a.name in ("part", "hem", "claw", "facemask", "eyeglow", "shade")]:
            ob.data.attributes.remove(ob.data.attributes[a])

    # A marker at the face, so the game can aim the jumpscare camera at it.
    anchor = bpy.data.objects.new("FaceAnchor", None)
    sc.collection.objects.link(anchor)
    anchor.parent = arm
    anchor.parent_type = "BONE"
    anchor.parent_bone = "head"
    bpy.context.view_layer.update()
    anchor.matrix_world = Matrix.Translation(HEAD_C + Vector((0, -0.11, EYE_Z)))

    idle = bake_action(arm, "Idle", range(0, 121, 3), pose_idle)
    chase = bake_action(arm, "Chase", range(0, 49, 2), pose_chase)
    lunge = bake_action(arm, "Lunge", [0, 7, 14, 24], pose_lunge)

    for ob in (head, shroud, hands):
        print("MESH", ob.name, len(ob.data.vertices), "verts", len(ob.data.polygons), "faces")

    if PREVIEW:
        os.makedirs(PREVIEW, exist_ok=True)
        cam = setup_preview_scene()
        shots = [
            ("01-front", None, 0, 0, 5, 3.9, 1.12, 50),
            ("02-three-quarter", None, 0, 38, 6, 3.9, 1.12, 50),
            ("03-side", None, 0, 90, 5, 3.9, 1.12, 50),
            ("04-back", None, 0, 180, 5, 3.9, 1.12, 50),
            ("05-face", None, 0, 12, 3, 0.95, 1.99, 60),
            ("06-face-side", None, 0, 55, 3, 0.95, 1.99, 60),
            ("07-idle", idle, 80, 25, 5, 3.9, 1.12, 50),
            ("08-chase", chase, 12, 50, 5, 4.2, 1.12, 50),
            ("09-lunge", lunge, 14, 15, 2, 3.4, 1.35, 42),
        ]
        for name, act, frame, az, el, dist, tz, lens in shots:
            if act:
                use_action(arm, act, frame)
            else:
                if arm.animation_data:
                    arm.animation_data.action = None
                for pb in arm.pose.bones:
                    pb.rotation_quaternion = Quaternion()
                    pb.location = Vector()
                bpy.context.view_layer.update()
            shoot(cam, os.path.join(PREVIEW, name + ".png"), az, el, dist, tz, lens)

        for o in [o for o in sc.objects if o.type in ("CAMERA", "LIGHT")]:
            bpy.data.objects.remove(o)

    if arm.animation_data:
        arm.animation_data.action = None
    for pb in arm.pose.bones:
        pb.rotation_quaternion = Quaternion()
        pb.location = Vector()
    for act in (idle, chase, lunge):
        tr = arm.animation_data.nla_tracks.new()
        tr.name = act.name
        tr.strips.new(act.name, 0, act)
        tr.mute = True

    bpy.ops.export_scene.gltf(
        filepath=OUT,
        export_format="GLB",
        export_animations=True,
        export_animation_mode="ACTIONS",
        export_skins=True,
        export_yup=True,
        export_image_format="JPEG",
        export_jpeg_quality=88,
        export_cameras=False,
        export_lights=False,
    )
    print("EXPORTED", OUT, os.path.getsize(OUT))


main()
