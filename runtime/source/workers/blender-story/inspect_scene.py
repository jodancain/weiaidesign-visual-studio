"""
Inspect a downloaded .blend before adapting it as a Story Mode scene.

    blender --background <file.blend> --python inspect_scene.py -- --out D:\story-assets\inspect\<name> [--preview]

Prints one JSON line (event INSPECT) with collections, cameras, lights, object count, world
bounds and a ground-level estimate, and with --preview renders a 270x480 EEVEE frame from
every existing camera into <out>/cam-<name>.png so the scene can be judged without a GUI.
"""

import argparse
import json
import os
import sys

import bpy
from mathutils import Vector


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--out", required=True)
    p.add_argument("--preview", action="store_true")
    p.add_argument("--size", type=int, default=25, help="resolution percentage for previews")
    return p.parse_args(argv)


def world_bounds(objs):
    lo = Vector((1e9, 1e9, 1e9))
    hi = Vector((-1e9, -1e9, -1e9))
    n = 0
    for o in objs:
        if o.type != "MESH" or o.hide_render:
            continue
        for c in o.bound_box:
            w = o.matrix_world @ Vector(c)
            lo = Vector(map(min, lo, w))
            hi = Vector(map(max, hi, w))
        n += 1
    return (list(lo), list(hi)) if n else None


def main():
    args = parse_args()
    os.makedirs(args.out, exist_ok=True)
    scene = bpy.context.scene
    objs = list(scene.objects)
    cams = [o for o in objs if o.type == "CAMERA"]
    lights = [o for o in objs if o.type == "LIGHT"]
    big = sorted(
        [o for o in objs if o.type == "MESH" and not o.hide_render],
        key=lambda o: -(o.dimensions.x * o.dimensions.y * o.dimensions.z),
    )[:15]
    info = {
        "event": "INSPECT",
        "file": bpy.data.filepath,
        "engine": scene.render.engine,
        "resolution": [scene.render.resolution_x, scene.render.resolution_y],
        "frame": scene.frame_current,
        "collections": [c.name for c in bpy.data.collections][:40],
        "object_count": len(objs),
        "mesh_count": sum(1 for o in objs if o.type == "MESH"),
        "cameras": [
            {"name": c.name, "location": [round(v, 2) for v in c.matrix_world.translation], "lens": c.data.lens,
             "rotation_deg": [round(v * 57.2958, 1) for v in c.matrix_world.to_euler()]}
            for c in cams
        ],
        "active_camera": scene.camera.name if scene.camera else None,
        "lights": [{"name": l.name, "type": l.data.type, "energy": l.data.energy} for l in lights][:20],
        "bounds": world_bounds(objs),
        "largest_meshes": [
            {"name": o.name, "dims": [round(v, 2) for v in o.dimensions], "z_min": round(min((o.matrix_world @ Vector(c)).z for c in o.bound_box), 2)}
            for o in big
        ],
        "armatures": [o.name for o in objs if o.type == "ARMATURE"],
        "world": scene.world.name if scene.world else None,
    }
    print(json.dumps(info, ensure_ascii=False))

    if args.preview and cams:
        scene.render.engine = "BLENDER_EEVEE"
        scene.render.resolution_percentage = args.size
        scene.render.image_settings.file_format = "PNG"
        scene.render.image_settings.color_mode = "RGB"
        scene.eevee.taa_render_samples = 8
        for cam in cams:
            scene.camera = cam
            scene.render.filepath = os.path.join(args.out, f"cam-{cam.name}.png")
            bpy.ops.render.render(write_still=True)
            print(json.dumps({"event": "PREVIEW", "camera": cam.name, "path": scene.render.filepath}))


if __name__ == "__main__":
    main()
