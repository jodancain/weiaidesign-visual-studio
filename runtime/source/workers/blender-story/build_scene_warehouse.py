"""
Build the fixed "warehouse" scene for Story Mode.

Run once, headless:
    blender --background --python build_scene_warehouse.py -- --out D:\\story-assets\\scenes\\warehouse.blend

Produces a .blend with:
  - a bare concrete room lit by a raking key light (matches the look validated in step 0)
  - named cameras  cam_wide / cam_medium / cam_close / cam_low   (all 9:16, 1080x1920)
  - a cube prop    prop_cube
  - character anchors  anchor_center / anchor_left / anchor_right / anchor_near_prop
  - a posable humanoid  char_main  (Rigify human meta-rig + generated rig, so pose bones
    are addressable by the standard Rigify names used in poses/manifest)

Greybox only: flat clay materials, no textures. The GPT-image restyle pass owns appearance.
"""

import argparse
import math
import sys

import bpy
from mathutils import Vector


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--out", required=True)
    return p.parse_args(argv)


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = 1080
    scene.render.resolution_y = 1920
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"
    scene.view_settings.view_transform = "Standard"
    return scene


def clay(name, gray, roughness=0.9):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (gray, gray, gray * 1.02, 1.0)
    bsdf.inputs["Roughness"].default_value = roughness
    return mat


def add_box(name, size, location, material):
    bpy.ops.mesh.primitive_cube_add(size=1, location=location)
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = Vector(size) / 2.0
    obj.data.materials.append(material)
    return obj


def build_room():
    floor_mat = clay("clay_floor", 0.42)
    wall_mat = clay("clay_wall", 0.55)
    prop_mat = clay("clay_prop", 0.60, 0.7)
    # 16m wide, 24m deep (extends behind the cameras), 9m tall with a ceiling, so no camera
    # in the 9:16 set can see past the room. Camera looks along +Y; cameras sit at y in [-9.5, -3.4].
    add_box("floor", (16, 24, 0.1), (0, 0, -0.05), floor_mat)
    add_box("ceiling", (16, 24, 0.1), (0, 0, 9.05), wall_mat)
    add_box("wall_back", (16, 0.2, 9), (0, 12.1, 4.5), wall_mat)
    add_box("wall_front", (16, 0.2, 9), (0, -12.1, 4.5), wall_mat)
    add_box("wall_left", (0.2, 24, 9), (-8.1, 0, 4.5), wall_mat)
    add_box("wall_right", (0.2, 24, 9), (8.1, 0, 4.5), wall_mat)
    add_box("prop_cube", (1.2, 1.2, 1.1), (2.4, 3.2, 0.55), prop_mat)


def add_light():
    # Raking key from frame-left, low and warm-ish in intensity terms (colour is irrelevant for greybox).
    bpy.ops.object.light_add(type="AREA", location=(-6.5, 1.5, 4.5))
    key = bpy.context.active_object
    key.name = "key_light"
    key.data.energy = 2500
    key.data.size = 3.0
    key.rotation_euler = (math.radians(70), 0, math.radians(-110))
    bpy.ops.object.light_add(type="AREA", location=(4.0, -3.0, 4.5))
    fill = bpy.context.active_object
    fill.name = "fill_light"
    fill.data.energy = 400
    fill.data.size = 5.0
    fill.rotation_euler = (math.radians(55), 0, math.radians(140))
    bpy.context.scene.world = bpy.data.worlds.new("world")
    bpy.context.scene.world.use_nodes = True
    bg = bpy.context.scene.world.node_tree.nodes["Background"]
    bg.inputs["Color"].default_value = (0.25, 0.25, 0.26, 1)
    bg.inputs["Strength"].default_value = 0.6


def add_camera(name, location, target, lens):
    cam_data = bpy.data.cameras.new(name)
    cam_data.lens = lens
    cam_data.sensor_fit = "VERTICAL"
    cam = bpy.data.objects.new(name, cam_data)
    bpy.context.scene.collection.objects.link(cam)
    cam.location = location
    direction = Vector(target) - Vector(location)
    cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    return cam


def add_cameras():
    # Subject stands around (0, 1, 0); cameras look along +Y.
    add_camera("cam_wide", (0.3, -9.5, 1.7), (0.0, 1.0, 1.0), 32)
    add_camera("cam_medium", (0.2, -6.5, 1.5), (0.0, 1.0, 1.0), 40)
    add_camera("cam_close", (0.1, -3.4, 1.5), (0.0, 1.0, 1.35), 55)
    add_camera("cam_low", (0.4, -7.0, 0.5), (0.0, 1.0, 1.1), 35)
    bpy.context.scene.camera = bpy.data.objects["cam_wide"]


def add_anchor(name, location, rot_z_deg=0.0):
    bpy.ops.object.empty_add(type="ARROWS", location=location)
    e = bpy.context.active_object
    e.name = name
    e.rotation_euler = (0, 0, math.radians(rot_z_deg))
    e.empty_display_size = 0.5
    return e


def add_anchors():
    # Measured: cam_medium keeps a subject inside the 10-90% frame band for x in [-1.0, 1.0]
    # at the y=1 subject line; anchors stay within that so every camera except cam_close frames them.
    add_anchor("anchor_center", (0.0, 1.0, 0.0))
    add_anchor("anchor_left", (-0.85, 1.2, 0.0), 15)
    add_anchor("anchor_right", (0.85, 1.0, 0.0), -15)
    add_anchor("anchor_near_prop", (1.0, 2.6, 0.0), -35)


def build_character():
    """Rigify human: meta-rig -> generate. Then a simple clay body via the rig's own
    metarig geometry is not available, so we attach primitive limbs skinned to the rig."""
    try:
        bpy.ops.preferences.addon_enable(module="rigify")
    except Exception as exc:  # noqa: BLE001
        print("WARN rigify enable:", exc)
    bpy.ops.object.armature_human_metarig_add()
    meta = bpy.context.active_object
    meta.name = "char_main_metarig"
    meta.location = (0.0, 1.0, 0.0)
    bpy.ops.object.mode_set(mode="OBJECT")
    bpy.ops.pose.rigify_generate()
    rig = bpy.context.active_object
    rig.name = "char_main"
    meta.hide_set(True)
    meta.hide_render = True
    build_clay_body(rig)
    return rig


def build_clay_body(rig):
    """Capsule-per-bone clay body parented to deform bones so poses read in the render."""
    mat = clay("clay_skin", 0.36, 0.8)
    body_bones = {
        "DEF-spine": 0.14, "DEF-spine.001": 0.15, "DEF-spine.002": 0.15, "DEF-spine.003": 0.13,
        "DEF-spine.004": 0.06, "DEF-spine.005": 0.06, "DEF-spine.006": 0.11,
        "DEF-upper_arm.L": 0.055, "DEF-upper_arm.L.001": 0.05, "DEF-forearm.L": 0.045, "DEF-forearm.L.001": 0.04, "DEF-hand.L": 0.045,
        "DEF-upper_arm.R": 0.055, "DEF-upper_arm.R.001": 0.05, "DEF-forearm.R": 0.045, "DEF-forearm.R.001": 0.04, "DEF-hand.R": 0.045,
        "DEF-thigh.L": 0.085, "DEF-thigh.L.001": 0.075, "DEF-shin.L": 0.06, "DEF-shin.L.001": 0.055, "DEF-foot.L": 0.05,
        "DEF-thigh.R": 0.085, "DEF-thigh.R.001": 0.075, "DEF-shin.R": 0.06, "DEF-shin.R.001": 0.055, "DEF-foot.R": 0.05,
    }
    made = 0
    for bone_name, radius in body_bones.items():
        bone = rig.data.bones.get(bone_name)
        if not bone:
            continue
        length = bone.length
        bpy.ops.mesh.primitive_cylinder_add(radius=radius, depth=length, vertices=16)
        seg = bpy.context.active_object
        seg.name = f"body_{bone_name}"
        seg.data.materials.append(mat)
        bpy.ops.object.shade_smooth()
        seg.parent = rig
        seg.parent_type = "BONE"
        seg.parent_bone = bone_name
        # Bone-parent space: bone tail at origin, bone axis is +Y. Centre the cylinder along it.
        seg.matrix_parent_inverse.identity()
        seg.location = (0, -length / 2, 0)
        seg.rotation_euler = (math.radians(90), 0, 0)
        made += 1
    # Head sphere on the head bone.
    head = rig.data.bones.get("DEF-spine.006")
    if head:
        bpy.ops.mesh.primitive_uv_sphere_add(radius=0.12, location=(0, 0, 0))
        sph = bpy.context.active_object
        sph.name = "body_head"
        sph.data.materials.append(mat)
        bpy.ops.object.shade_smooth()
        sph.parent = rig
        sph.parent_type = "BONE"
        sph.parent_bone = "DEF-spine.006"
        sph.matrix_parent_inverse.identity()
        sph.location = (0, -head.length * 0.45, 0)
    print("CLAY_BODY segments:", made)


def main():
    args = parse_args()
    reset_scene()
    build_room()
    add_light()
    add_cameras()
    add_anchors()
    rig = build_character()
    bpy.ops.object.select_all(action="DESELECT")
    bpy.ops.wm.save_as_mainfile(filepath=args.out)
    print("SCENE_SAVED", args.out, "rig_bones", len(rig.pose.bones))


if __name__ == "__main__":
    main()
