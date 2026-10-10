"""
Render a 3x3 greybox ANIMATIC GRID for one Story Mode segment.

    blender --background <scene.blend> --python render_grid.py -- --spec grid.json --out grid.png

The spec holds a start shot and an end shot (same shape as render_shot.py's shot spec, same
scene). Nine panels are rendered by interpolating pose (per-bone quaternion slerp + location
lerp), character placement (anchor position / facing) and camera (position, orientation, lens)
from start to end, then tiled left-to-right, top-to-bottom with thin white gutters — the layout
Seedance-style video models are prompted to "follow in persisted order as one continuous shot".

{
  "start": {"camera": "cam_medium", "pose_id": "crouch_ready", "character_anchor": "anchor_center", "character_rotation": 0},
  "end":   {"camera": "cam_low",    "pose_id": "reach_forward", "character_anchor": "anchor_left",   "character_rotation": 15},
  "panels": 9,                     # 9 = 3x3 (only 3x3 is tiled; other counts render a strip)
  "panel_resolution": [486, 864],  # per panel; 3x3 -> 1466x2600 incl. 4px gutters (>= 3.69 MP)
  "ease": "smooth"                 # "linear" | "smooth" (smoothstep)
}
"""

import argparse
import json
import math
import os
import sys

import bpy
import numpy as np
from mathutils import Euler, Quaternion, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import render_shot as rs  # noqa: E402  (reuses pose/camera helpers)


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--spec", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--pose-lib", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets", "poses", "library.json"))
    p.add_argument("--engine", default="BLENDER_EEVEE")
    return p.parse_args(argv)


def pose_for(spec, lib):
    if spec.get("pose_action"):
        return None
    pose = lib["poses"].get(spec.get("pose_id", "idle_neutral"))
    if pose is None:
        raise SystemExit(f"pose_id not in library: {spec.get('pose_id')}")
    return pose


def snapshot_pose(rig, spec, lib):
    """Apply a spec's pose and record every control bone as (quaternion, location)."""
    rs.clear_pose(rig)
    if spec.get("pose_action"):
        rs.apply_action_pose(rig, spec["pose_action"], spec.get("pose_frame", 1))
    else:
        rs.apply_procedural_pose(rig, pose_for(spec, lib))
    snap = {}
    for pb in rig.pose.bones:
        q = pb.rotation_euler.to_quaternion() if pb.rotation_mode != "QUATERNION" else pb.rotation_quaternion.copy()
        snap[pb.name] = (q, pb.location.copy())
    return snap


def snapshot_placement(spec):
    anchor = bpy.data.objects.get(spec.get("character_anchor", "anchor_center"))
    if anchor is None:
        raise SystemExit(f"anchor not found: {spec.get('character_anchor')}")
    off = spec.get("character_offset", [0.0, 0.0])
    loc = anchor.location + Vector((float(off[0]), float(off[1]), 0.0))
    yaw = anchor.rotation_euler.z + math.radians(float(spec.get("character_rotation", 0)))
    return loc, yaw


def snapshot_camera(spec):
    cam = bpy.data.objects.get(spec["camera"])
    if cam is None or cam.type != "CAMERA":
        raise SystemExit(f"camera not found: {spec.get('camera')}")
    off = spec.get("camera_offset")
    loc = cam.location + (Vector([float(v) for v in off]) if off else Vector((0, 0, 0)))
    return loc.copy(), cam.rotation_euler.to_quaternion(), float(cam.data.lens)


def lerp(a, b, t):
    return a + (b - a) * t


def lerp_angle(a, b, t):
    d = (b - a + math.pi) % (2 * math.pi) - math.pi
    return a + d * t


def apply_blend(rig, p0, p1, t):
    for name, (q0, l0) in p0.items():
        pb = rig.pose.bones.get(name)
        if pb is None:
            continue
        q1, l1 = p1.get(name, (q0, l0))
        pb.rotation_mode = "QUATERNION"
        pb.rotation_quaternion = q0.slerp(q1, t)
        pb.location = l0.lerp(l1, t)
    bpy.context.view_layer.update()


def linear_to_srgb(x):
    return np.where(x <= 0.0031308, x * 12.92, 1.055 * np.power(np.clip(x, 0, None), 1 / 2.4) - 0.055)


def write_png(path, rgb):
    """Minimal 8-bit RGB PNG writer (no colour management involved)."""
    import struct
    import zlib

    h, w, _ = rgb.shape
    raw = b"".join(b"\x00" + rgb[y].tobytes() for y in range(h))

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    with open(path, "wb") as fh:
        fh.write(b"\x89PNG\r\n\x1a\n")
        fh.write(chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)))
        fh.write(chunk(b"IDAT", zlib.compress(raw, 6)))
        fh.write(chunk(b"IEND", b""))


def main():
    args = parse_args()
    spec = rs.load_json(args.spec)
    lib = rs.load_json(args.pose_lib)
    start, end = spec["start"], spec["end"]
    n = int(spec.get("panels", 9))
    pw, ph = spec.get("panel_resolution", [486, 864])
    ease = spec.get("ease", "smooth")

    rig = rs.get_rig()
    p0 = snapshot_pose(rig, start, lib)
    p1 = snapshot_pose(rig, end, lib)
    loc0, yaw0 = snapshot_placement(start)
    loc1, yaw1 = snapshot_placement(end)
    cloc0, cq0, lens0 = snapshot_camera(start)
    cloc1, cq1, lens1 = snapshot_camera(end)

    # one working camera so the scene's named cameras stay untouched
    cam_data = bpy.data.cameras.new("grid_cam")
    cam_data.sensor_fit = "VERTICAL"
    cam_data.clip_end = 5000
    cam = bpy.data.objects.new("grid_cam", cam_data)
    bpy.context.scene.collection.objects.link(cam)
    bpy.context.scene.camera = cam

    scene = bpy.context.scene
    rs.configure_render({"resolution": [pw, ph]}, args.out, args.engine)
    out_dir = os.path.dirname(os.path.abspath(args.out))
    os.makedirs(out_dir, exist_ok=True)
    panel_paths = []
    for i in range(n):
        t = i / max(1, n - 1)
        if ease == "smooth":
            t = t * t * (3 - 2 * t)
        apply_blend(rig, p0, p1, t)
        rig.location = loc0.lerp(loc1, t)
        rig.rotation_euler = (0, 0, lerp_angle(yaw0, yaw1, t))
        cam.location = cloc0.lerp(cloc1, t)
        cam.rotation_euler = cq0.slerp(cq1, t).to_euler()
        cam.data.lens = lerp(lens0, lens1, t)
        bpy.context.view_layer.update()
        path = os.path.join(out_dir, f"_panel_{i + 1:02d}.png")
        scene.render.filepath = path
        bpy.ops.render.render(write_still=True)
        panel_paths.append(path)

    # tile: 3x3 when n == 9, otherwise a vertical strip
    cols = 3 if n == 9 else 1
    rows = math.ceil(n / cols)
    gutter = 4
    W = cols * pw + (cols + 1) * gutter
    H = rows * ph + (rows + 1) * gutter
    # image.pixels yields scene-linear floats; encode to sRGB ourselves and write the PNG directly.
    # Round-tripping through bpy.data.images.new()+save() came out ~3x too dark.
    canvas = np.full((H, W, 3), 255, dtype=np.uint8)
    for i, path in enumerate(panel_paths):
        img = bpy.data.images.load(path)
        px = np.array(img.pixels[:], dtype=np.float32).reshape(img.size[1], img.size[0], 4)[::-1, :, :3]
        r, c = divmod(i, cols)
        y0 = gutter + r * (ph + gutter)
        x0 = gutter + c * (pw + gutter)
        canvas[y0 : y0 + ph, x0 : x0 + pw] = np.clip(linear_to_srgb(px) * 255.0 + 0.5, 0, 255).astype(np.uint8)
        bpy.data.images.remove(img)
    write_png(args.out, canvas)
    for path in panel_paths:
        try:
            os.remove(path)
        except OSError:
            pass
    print(json.dumps({
        "event": "RENDER_DONE",
        "kind": "grid",
        "out": args.out,
        "bytes": os.path.getsize(args.out),
        "panels": n,
        "grid": [cols, rows],
        "resolution": [W, H],
        "start": {k: start.get(k) for k in ("camera", "pose_id", "character_anchor", "character_rotation")},
        "end": {k: end.get(k) for k in ("camera", "pose_id", "character_anchor", "character_rotation")},
    }))


if __name__ == "__main__":
    main()
