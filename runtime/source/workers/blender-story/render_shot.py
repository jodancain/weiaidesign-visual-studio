"""
Render one Story Mode greybox keyframe from a shot spec.

    blender --background <scene.blend> --python render_shot.py -- --spec shot.json --out frame.png

Shot spec (all keys optional except where noted):
{
  "camera": "cam_medium",              # named camera in the scene (required)
  "pose_id": "arm_up_point",           # key in poses/library.json (procedural) OR
  "pose_action": "Mixamo_Idle",        # a Blender action name present in the scene/pose lib
  "pose_frame": 12,                    # frame of that action to freeze
  "character_anchor": "anchor_center", # named empty; character is snapped to it
  "character_offset": [0.0, 0.0],      # extra X/Y metres relative to the anchor
  "character_rotation": 0,             # extra Z rotation in degrees
  "camera_offset": [0, 0, 0],          # nudge the camera in world metres
  "resolution": [1080, 1920]
}

Poses in the procedural library are expressed as Rigify control-bone rotations in degrees
(XYZ Euler, pose space). The LLM never emits joint angles; it picks pose_id from manifest.json.
"""

import argparse
import json
import math
import os
import sys

import bpy
from mathutils import Euler, Vector


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--spec", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--pose-lib", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets", "poses", "library.json"))
    p.add_argument("--engine", default="BLENDER_EEVEE")
    return p.parse_args(argv)


def load_json(path):
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def get_rig():
    rig = bpy.data.objects.get("char_main")
    if rig is None or rig.type != "ARMATURE":
        raise SystemExit("scene has no armature named char_main")
    return rig


def force_fk(rig):
    """Rigify limbs default to IK (IK_FK=0), which would override FK rotations. Switch every
    limb to FK and flush the depsgraph BEFORE posing so the drivers pick the new mode up."""
    for side in ("L", "R"):
        for limb in ("upper_arm_parent", "thigh_parent"):
            pb = rig.pose.bones.get(f"{limb}.{side}")
            if pb is not None and "IK_FK" in pb:
                pb["IK_FK"] = 1.0
                pb["IK_Stretch"] = 0.0
    rig.update_tag()
    bpy.context.view_layer.update()


def clear_pose(rig):
    for pb in rig.pose.bones:
        pb.location = (0, 0, 0)
        pb.rotation_mode = "XYZ"
        pb.rotation_euler = (0, 0, 0)
        pb.scale = (1, 1, 1)
    force_fk(rig)


def apply_procedural_pose(rig, pose):
    """pose = {"bones": {"upper_arm_fk.L": [x, y, z], ...}} in degrees."""
    missing = []
    for bone_name, rot in pose.get("bones", {}).items():
        pb = rig.pose.bones.get(bone_name)
        if pb is None:
            missing.append(bone_name)
            continue
        pb.rotation_mode = "XYZ"
        pb.rotation_euler = Euler([math.radians(v) for v in rot], "XYZ")
    for bone_name, loc in pose.get("bone_locations", {}).items():
        pb = rig.pose.bones.get(bone_name)
        if pb is not None:
            pb.location = Vector(loc)
    if missing:
        print("POSE_WARN missing bones:", missing)
    bpy.context.view_layer.update()


def apply_action_pose(rig, action_name, frame):
    action = bpy.data.actions.get(action_name)
    if action is None:
        raise SystemExit(f"action not found: {action_name}")
    if rig.animation_data is None:
        rig.animation_data_create()
    rig.animation_data.action = action
    bpy.context.scene.frame_set(int(frame))


def place_character(rig, spec):
    anchor_name = spec.get("character_anchor", "anchor_center")
    anchor = bpy.data.objects.get(anchor_name)
    if anchor is None:
        raise SystemExit(f"anchor not found: {anchor_name}")
    off = spec.get("character_offset", [0.0, 0.0])
    rig.location = anchor.location + Vector((float(off[0]), float(off[1]), 0.0))
    rig.rotation_euler = (0, 0, anchor.rotation_euler.z + math.radians(float(spec.get("character_rotation", 0))))


def set_camera(spec):
    cam = bpy.data.objects.get(spec["camera"])
    if cam is None or cam.type != "CAMERA":
        raise SystemExit(f"camera not found: {spec.get('camera')}")
    off = spec.get("camera_offset")
    if off:
        cam.location = cam.location + Vector([float(v) for v in off])
    bpy.context.scene.camera = cam
    return cam


def configure_render(spec, out_path, engine):
    scene = bpy.context.scene
    scene.render.engine = engine
    res = spec.get("resolution", [1080, 1920])
    scene.render.resolution_x, scene.render.resolution_y = int(res[0]), int(res[1])
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"
    scene.render.filepath = out_path
    if engine.startswith("BLENDER_EEVEE"):
        try:
            scene.eevee.taa_render_samples = 16
        except AttributeError:
            pass


def main():
    args = parse_args()
    spec = load_json(args.spec)
    rig = get_rig()
    clear_pose(rig)

    if spec.get("pose_action"):
        apply_action_pose(rig, spec["pose_action"], spec.get("pose_frame", 1))
        pose_used = f"action:{spec['pose_action']}@{spec.get('pose_frame', 1)}"
    else:
        lib = load_json(args.pose_lib)
        pose_id = spec.get("pose_id", "idle_neutral")
        pose = lib["poses"].get(pose_id)
        if pose is None:
            raise SystemExit(f"pose_id not in library: {pose_id}")
        apply_procedural_pose(rig, pose)
        pose_used = f"pose:{pose_id}"

    place_character(rig, spec)
    cam = set_camera(spec)
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    configure_render(spec, args.out, args.engine)
    bpy.ops.render.render(write_still=True)
    print(json.dumps({
        "event": "RENDER_DONE",
        "out": args.out,
        "bytes": os.path.getsize(args.out),
        "camera": cam.name,
        "pose": pose_used,
        "anchor": spec.get("character_anchor", "anchor_center"),
        "resolution": [bpy.context.scene.render.resolution_x, bpy.context.scene.render.resolution_y],
    }))


if __name__ == "__main__":
    main()
