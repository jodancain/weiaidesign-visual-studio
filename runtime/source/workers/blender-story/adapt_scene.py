r"""
Adapt a downloaded open-licence .blend into a Story Mode scene.

    blender --background <source.blend> --python adapt_scene.py -- \
        --config scene_configs/pagoda_mountain.json --character D:\story-assets\scenes\warehouse.blend \
        --out D:\story-assets\scenes\pagoda_mountain.blend

What it does, without modelling anything:
  1. optionally deletes collections / hides objects named in the config (e.g. the demo's own hero prop)
  2. appends the posable clay humanoid `char_main` (+ its body_* meshes) from warehouse.blend
  3. places the standard camera set (cam_wide/medium/close/low) and anchors
     (anchor_center/left/right/near_prop) in a local frame: `origin` + `yaw_deg`, so every scene
     shares the same camera/anchor semantics the storyboard LLM already knows
  4. snaps anchors and cameras to the real ground by ray-casting down (optionally only onto
     objects listed in `ground_objects`, so tree canopies etc. are ignored)
  5. adds a key + fill light around the character so the pose reads even in a back-lit scene
  6. sets a clay material override on the view layer -> the whole scene renders greybox
  7. sets 1080x1920 EEVEE and saves

Local frame: +Y is the camera look direction ("forward"), +X is frame-right, Z up, z=0 is ground
at the origin. `yaw_deg` rotates that frame about world Z (0 = world +Y forward, -90 = world +X).
"""

import argparse
import json
import math
import os
import sys

import bpy
from mathutils import Matrix, Vector

DEFAULT_CAMERAS = {
    # same numbers as build_scene_warehouse.py; subject line is local y=1
    "cam_wide": {"pos": [0.3, -9.5, 1.7], "target": [0.0, 1.0, 1.0], "lens": 32},
    "cam_medium": {"pos": [0.2, -6.5, 1.5], "target": [0.0, 1.0, 1.0], "lens": 40},
    "cam_close": {"pos": [0.1, -3.4, 1.5], "target": [0.0, 1.0, 1.35], "lens": 55},
    "cam_low": {"pos": [0.4, -7.0, 0.5], "target": [0.0, 1.0, 1.1], "lens": 35},
}
DEFAULT_ANCHORS = {
    "anchor_center": {"pos": [0.0, 1.0], "rot": 0},
    "anchor_left": {"pos": [-0.85, 1.2], "rot": 15},
    "anchor_right": {"pos": [0.85, 1.0], "rot": -15},
    "anchor_near_prop": {"pos": [1.0, 2.6], "rot": -35},
}


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--config", required=True, help="JSON file with origin/yaw/cameras/anchors overrides")
    p.add_argument("--character", required=True, help="warehouse.blend that holds char_main + body_*")
    p.add_argument("--out", required=True)
    return p.parse_args(argv)


def load_config(path):
    with open(path, "r", encoding="utf-8") as fh:
        cfg = json.load(fh)
    cams = dict(DEFAULT_CAMERAS)
    for k, v in (cfg.get("cameras") or {}).items():
        cams[k] = {**cams.get(k, {}), **v}
    anchors = dict(DEFAULT_ANCHORS)
    for k, v in (cfg.get("anchors") or {}).items():
        anchors[k] = {**anchors.get(k, {}), **v}
    cfg["cameras"], cfg["anchors"] = cams, anchors
    cfg.setdefault("origin", [0.0, 0.0])
    cfg.setdefault("yaw_deg", 0.0)
    cfg.setdefault("clay_override", True)
    cfg.setdefault("add_lights", True)
    return cfg


class Frame:
    def __init__(self, origin, yaw_deg, ground_z):
        self.rot = Matrix.Rotation(math.radians(yaw_deg), 3, "Z")
        self.origin = Vector((origin[0], origin[1], ground_z))
        self.yaw = math.radians(yaw_deg)

    def to_world(self, local):
        v = Vector((local[0], local[1], local[2] if len(local) > 2 else 0.0))
        return self.origin + self.rot @ v


def ground_at(x, y, allow, start_z=1000.0):
    """Ray-cast straight down; if `allow` is set keep going until we hit an allowed object."""
    scene = bpy.context.scene
    dg = bpy.context.evaluated_depsgraph_get()
    z = start_z
    first = None
    for _ in range(400):
        ok, loc, _n, _i, obj, _m = scene.ray_cast(dg, Vector((x, y, z)), Vector((0, 0, -1)))
        if not ok:
            break
        name = obj.name
        if first is None:
            first = (loc.z, name)
        if not allow or any(name == a or name.startswith(a) for a in allow):
            return loc.z, name
        z = loc.z - 0.02
    # nothing in the allow-list under this point (e.g. dense grass instances all the way down):
    # fall back to the topmost hit rather than failing the whole adaptation
    if first is not None:
        print(f"WARN ground filter {allow} missed at ({x:.2f},{y:.2f}); using first hit {first[1]} z={first[0]:.2f}")
        return first
    return None, None


def prune(cfg):
    for cname in cfg.get("delete_collections") or []:
        coll = bpy.data.collections.get(cname)
        if not coll:
            print("WARN collection not found:", cname)
            continue
        for o in list(coll.all_objects):
            bpy.data.objects.remove(o, do_unlink=True)
        bpy.data.collections.remove(coll)
        print("deleted collection", cname)
    for oname in cfg.get("hide_objects") or []:
        o = bpy.data.objects.get(oname)
        if o:
            o.hide_render = True
            o.hide_viewport = True
    for cname in cfg.get("hide_collections") or []:
        coll = bpy.data.collections.get(cname)
        if coll:
            coll.hide_render = True
            for o in coll.all_objects:
                o.hide_render = True
    # a stray object called char_main / anchor_* / cam_* in the source would collide with ours
    for o in list(bpy.data.objects):
        if o.name == "char_main" or o.name.startswith(("anchor_", "cam_", "body_", "story_")):
            o.name = "src_" + o.name


def append_character(path):
    with bpy.data.libraries.load(path, link=False) as (src, dst):
        wanted = [n for n in src.objects if n == "char_main" or n.startswith("body_")]
        dst.objects = wanted
    linked = 0
    for o in dst.objects:
        if o is None:
            continue
        if o.name not in bpy.context.scene.collection.objects:
            bpy.context.scene.collection.objects.link(o)
            linked += 1
    rig = bpy.data.objects.get("char_main")
    if rig is None or rig.type != "ARMATURE":
        raise SystemExit("char_main armature was not appended")
    print("appended character objects:", linked)
    return rig


def add_camera(name, world_pos, world_target, lens):
    old = bpy.data.objects.get(name)
    if old:
        bpy.data.objects.remove(old, do_unlink=True)
    cam_data = bpy.data.cameras.new(name)
    cam_data.lens = lens
    cam_data.sensor_fit = "VERTICAL"
    cam_data.clip_end = 5000
    cam = bpy.data.objects.new(name, cam_data)
    bpy.context.scene.collection.objects.link(cam)
    cam.location = world_pos
    cam.rotation_euler = (world_target - world_pos).to_track_quat("-Z", "Y").to_euler()
    return cam


def add_anchor(name, world_pos, rot_z):
    old = bpy.data.objects.get(name)
    if old:
        bpy.data.objects.remove(old, do_unlink=True)
    e = bpy.data.objects.new(name, None)
    e.empty_display_type = "ARROWS"
    e.empty_display_size = 0.5
    bpy.context.scene.collection.objects.link(e)
    e.location = world_pos
    e.rotation_euler = (0, 0, rot_z)
    return e


def add_light(name, world_pos, world_target, energy, size):
    old = bpy.data.objects.get(name)
    if old:
        bpy.data.objects.remove(old, do_unlink=True)
    data = bpy.data.lights.new(name, "AREA")
    data.energy = energy
    data.size = size
    lt = bpy.data.objects.new(name, data)
    bpy.context.scene.collection.objects.link(lt)
    lt.location = world_pos
    lt.rotation_euler = (world_target - world_pos).to_track_quat("-Z", "Y").to_euler()
    return lt


def clay_material():
    mat = bpy.data.materials.get("story_clay_override") or bpy.data.materials.new("story_clay_override")
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        bsdf.inputs["Base Color"].default_value = (0.45, 0.45, 0.46, 1.0)
        bsdf.inputs["Roughness"].default_value = 0.85
    return mat


def main():
    args = parse_args()
    cfg = load_config(args.config)
    scene = bpy.context.scene
    prune(cfg)

    ox, oy = cfg["origin"]
    allow = cfg.get("ground_objects")
    if cfg.get("ground_z") is not None:
        gz, gobj = float(cfg["ground_z"]), "config"
    else:
        gz, gobj = ground_at(ox, oy, allow)
        if gz is None:
            raise SystemExit(f"no ground under origin {cfg['origin']} (ground_objects={allow})")
    frame = Frame(cfg["origin"], cfg["yaw_deg"], gz)
    print(f"origin ground z={gz:.2f} on {gobj}")

    rig = append_character(args.character)

    report = {"anchors": {}, "cameras": {}}
    for name, a in cfg["anchors"].items():
        w = frame.to_world(a["pos"] + [0.0])
        az, aobj = ground_at(w.x, w.y, allow)
        if az is None:
            az, aobj = gz, "fallback-origin"
        w.z = az
        add_anchor(name, w, frame.yaw + math.radians(a.get("rot", 0)))
        report["anchors"][name] = {"world": [round(v, 2) for v in w], "ground_obj": aobj}

    for name, c in cfg["cameras"].items():
        pos = frame.to_world(c["pos"])
        tgt = frame.to_world(c["target"])
        # keep the camera above the terrain even if the ground rises behind the subject
        cz, _ = ground_at(pos.x, pos.y, allow)
        if cz is not None and pos.z < cz + 0.3:
            pos.z = cz + 0.3
        add_camera(name, pos, tgt, c["lens"])
        report["cameras"][name] = {"world": [round(v, 2) for v in pos], "target": [round(v, 2) for v in tgt], "lens": c["lens"]}
    scene.camera = bpy.data.objects["cam_medium"]

    if cfg["add_lights"]:
        subj = frame.to_world([0.0, 1.0, 1.0])
        add_light("story_key_light", frame.to_world([-4.5, -2.0, 4.0]), subj, cfg.get("key_energy", 1500), 3.0)
        add_light("story_fill_light", frame.to_world([3.5, -4.0, 3.0]), subj, cfg.get("fill_energy", 400), 4.0)

    rig.location = bpy.data.objects["anchor_center"].location
    rig.rotation_euler = (0, 0, frame.yaw)

    if cfg["clay_override"]:
        scene.view_layers[0].material_override = clay_material()
    if cfg.get("world_gray") is not None:
        world = bpy.data.worlds.new("story_world")
        world.use_nodes = True
        bg = world.node_tree.nodes["Background"]
        g = float(cfg["world_gray"])
        bg.inputs["Color"].default_value = (g, g, g * 1.02, 1)
        bg.inputs["Strength"].default_value = 1.0
        scene.world = world

    # exposure / view transform: demo scenes are tuned for their own look; clay override
    # plus their sun/sky often blows out, so configs can pull it back.
    if cfg.get("view_transform"):
        scene.view_settings.view_transform = cfg["view_transform"]
    if cfg.get("exposure") is not None:
        scene.view_settings.exposure = float(cfg["exposure"])
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x, scene.render.resolution_y = 1080, 1920
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"
    scene.render.film_transparent = False
    if cfg.get("frame") is not None:
        scene.frame_set(int(cfg["frame"]))
    try:
        bpy.ops.file.make_paths_absolute()
    except Exception as exc:  # noqa: BLE001
        print("WARN make_paths_absolute:", exc)

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=args.out, compress=True)
    print("SCENE_ADAPTED", json.dumps({"out": args.out, "ground_z": round(gz, 2), **report}))


if __name__ == "__main__":
    main()
