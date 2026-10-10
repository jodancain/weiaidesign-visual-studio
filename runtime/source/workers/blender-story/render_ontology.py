"""
render_ontology.py — build a set from an *ontology Blender layer* and render every anchor.

v2: multi-subject. Subject-agnostic: cars, bottles, rigged characters, monsters, proxies. The
ontology decides the scene (studio preset or an imported environment asset with a *stage* origin),
each subject's asset/proxy, normalisation (up/forward axis, real size), placement on the stage,
optional pose (a clip + phase from a shared animation library), the *states* that show/hide/pose/move
subjects or attach proxy parts, and each anchor's camera in a bounded grammar (azimuth / elevation /
distance factor / focal / look-at). Nothing here is specific to any one asset.

Run headless:
  blender --background --factory-startup --python render_ontology.py -- --spec spec.json --out-dir D:\\...\\job

Spec (v2; v1 single "subject" specs are still accepted and wrapped):
{
  "scene": {"preset": "showroom_dark|studio_white|garage|outdoor_overcast|night_rooftop", "floor_reflective": true,
            "asset": {"path": ".../Rooftop.glb"},                  # optional environment
            "stage": {"origin_m": [x, y, z], "yaw_deg": 0},        # point in the asset that becomes world origin / floor
            "sky": {"path": ".../sky.glb"},                        # optional emissive backdrop mesh
            "hide_match": "(?i)trees"},                            # optional regex of env objects to hide
  "subjects": [
    {"id": "hero", "asset": {"path": ".../Hero.gltf"}, "up_axis": "Y", "forward_axis": "Z", "height_m": 1.7,
     "position_m": [0, 0], "rotation_deg": 0 | "face": "<subject id>",
     "pose": {"library": ".../UAL1_Standard.glb", "clip": "Idle_Loop", "phase": 0.0}, "tint": [r, g, b]},
    {"id": "ghoul", "proxy": {"shape": "cylinder", "dims_m": [1.2, 1.2, 2.2]}, "position_m": [2.5, 1], "tint": [0.02, 0.02, 0.02]}
  ],
  "states": [{"id": "s1", "ops": [{"op": "hide", "subject": "ghoul"}, {"op": "pose", "subject": "hero", "clip": "Punch_Cross", "phase": 0.6},
                                   {"op": "move", "subject": "ghoul", "delta_m": [1, 0, 0]}, {"op": "rotate", "subject": "hero", "deg": 30},
                                   {"op": "add_part", "subject": "hero", "shape": "box", "dims_m": [0.9, 0.03, 0.6], "at": "side-left", "offset_m": [0, 0, 0]}]}],
  "anchors": [{"id": "anc-1", "camera": {"azimuth_deg": 35, "elevation_deg": 8, "distance_factor": 1.2, "focal_mm": 35,
               "look_at": "group | <subject id> | <subject id>:front|rear|roof|ground"}, "states": ["s1"]}],
  "resolution": [1280, 720], "engine": "BLENDER_EEVEE", "samples": 24
}
Conventions: after normalisation every subject faces +X at rotation 0 and stands on z=0; camera azimuth 0 is in
front of the look-at target (on its +X side), 90 = its left side, 180 = behind. position_m is world XY on the stage.
Prints one JSON line per anchor: {"event":"ANCHOR_DONE",...} and a final {"event":"RENDER_DONE",...}.
"""
import argparse
import json
import math
import os
import re
import sys

import bpy
import mathutils
from mathutils import Vector

PRESETS = {
    "showroom_dark": {"bg": (0.02, 0.022, 0.03), "floor": (0.03, 0.03, 0.035), "floor_rough": 0.18, "floor_metal": 0.5,
                      "key": 500, "fill": 180, "rim": 700, "top": 350, "world": 0.15},
    "studio_white": {"bg": (0.92, 0.92, 0.93), "floor": (0.9, 0.9, 0.9), "floor_rough": 0.5, "floor_metal": 0.0,
                     "key": 1200, "fill": 700, "rim": 600, "top": 1200, "world": 1.0},
    "garage": {"bg": (0.12, 0.12, 0.13), "floor": (0.18, 0.18, 0.19), "floor_rough": 0.7, "floor_metal": 0.1,
               "key": 700, "fill": 300, "rim": 500, "top": 900, "world": 0.35},
    "outdoor_overcast": {"bg": (0.55, 0.6, 0.68), "floor": (0.3, 0.3, 0.29), "floor_rough": 0.9, "floor_metal": 0.0,
                         "key": 400, "fill": 400, "rim": 200, "top": 2500, "world": 2.0},
    # night exterior: dark concrete, low ambient, cool key, violet rim so restyle reads the light direction
    "night_rooftop": {"bg": (0.03, 0.03, 0.07), "floor": (0.11, 0.11, 0.12), "floor_rough": 0.85, "floor_metal": 0.0,
                      "key": 350, "fill": 120, "rim": 650, "top": 150, "world": 0.12,
                      "key_color": (0.8, 0.86, 1.0), "rim_color": (0.7, 0.45, 1.0)},
}
LOOK_AT = {  # fraction of a subject's bbox: (x along forward -1..1, z 0..1)
    "center": (0.0, 0.45), "front": (0.75, 0.35), "rear": (-0.75, 0.4), "roof": (0.0, 0.95),
    "wheel_front": (0.6, 0.15), "ground": (0.0, 0.05), "head": (0.0, 0.9), "chest": (0.0, 0.7),
}
PART_AT = {  # (x frac along forward -1..1, y frac -1..1, z frac of height)
    "rear-top": (-0.84, 0.0, 0.75), "roof-center": (0.0, 0.0, 1.0), "front-bottom": (0.95, 0.0, 0.15),
    "rear-bottom": (-0.95, 0.0, 0.15), "side-left": (0.0, 0.95, 0.4), "side-right": (0.0, -0.95, 0.4), "front-top": (0.6, 0.0, 0.95),
}
AXIS = {"X": Vector((1, 0, 0)), "-X": Vector((-1, 0, 0)), "Y": Vector((0, 1, 0)), "-Y": Vector((0, -1, 0)), "Z": Vector((0, 0, 1)), "-Z": Vector((0, 0, -1))}
POSE_FRAME = 1000  # scene frame at which every posed armature's NLA strip is evaluated


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--spec", required=True)
    p.add_argument("--out-dir", required=True)
    return p.parse_args(argv)


def make_material(name, color, rough, metal, emission=None):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = metal
    if emission:
        bsdf.inputs["Emission Color"].default_value = (*emission, 1.0)
        bsdf.inputs["Emission Strength"].default_value = 2.0
    return mat


def import_file(path):
    before = set(bpy.data.objects)
    ext = os.path.splitext(path)[1].lower()
    if ext in (".glb", ".gltf"):
        bpy.ops.import_scene.gltf(filepath=path)
    elif ext == ".obj":
        bpy.ops.wm.obj_import(filepath=path)
    elif ext == ".fbx":
        bpy.ops.import_scene.fbx(filepath=path)
    else:
        raise SystemExit(f"unsupported asset: {path}")
    return [o for o in bpy.data.objects if o not in before]


def world_bbox(objs, evaluated=False):
    bpy.context.view_layer.update()
    deps = bpy.context.evaluated_depsgraph_get() if evaluated else None
    pts = []
    for o in objs:
        if o.type != "MESH" or o.hide_render:
            continue
        src = o.evaluated_get(deps) if deps else o
        pts += [o.matrix_world @ Vector(c) for c in src.bound_box]
    if not pts:
        return Vector((0, 0, 0)), Vector((0.1, 0.1, 0.1))
    mn = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    mx = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    return mn, mx


# ------------------------------------------------------------------ scene
def build_world(p):
    scene = bpy.context.scene
    world = bpy.data.worlds.new("World")
    scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    bg.inputs["Color"].default_value = (*p["bg"], 1.0)
    bg.inputs["Strength"].default_value = p["world"]


def build_studio_floor(p, floor_reflective, size):
    bpy.ops.mesh.primitive_plane_add(size=size, location=(0, 0, 0))
    floor = bpy.context.active_object
    floor.name = "studio_floor"
    rough = p["floor_rough"] if floor_reflective is None else (0.16 if floor_reflective else 0.6)
    floor.data.materials.append(make_material("floor", p["floor"], rough, p["floor_metal"]))
    bpy.ops.mesh.primitive_plane_add(size=size * 2, location=(0, size * 0.9, size / 2), rotation=(math.radians(90), 0, 0))
    wall = bpy.context.active_object
    wall.name = "studio_backwall"
    wall.data.materials.append(make_material("wall", p["bg"], 0.9, 0.0))


def build_lights(p, L):
    def light(name, kind, loc, energy, size=4.0, color=(1, 1, 1)):
        ld = bpy.data.lights.new(name, kind)
        ld.energy = energy
        ld.color = color
        if kind == "AREA":
            ld.size = size
            ld.shape = "RECTANGLE"
            ld.size_y = size * 0.5
        ob = bpy.data.objects.new(name, ld)
        bpy.context.collection.objects.link(ob)
        ob.location = loc
        direction = Vector((0, 0, L * 0.25)) - Vector(loc)
        ob.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
        return ob

    light("key", "AREA", (L * 0.9, -L * 1.1, L * 1.4), p["key"] * L, size=L * 1.2, color=p.get("key_color", (1.0, 0.98, 0.95)))
    light("fill", "AREA", (-L * 1.2, -L * 0.8, L * 0.9), p["fill"] * L, size=L * 1.6, color=(0.9, 0.95, 1.0))
    light("rim", "AREA", (-L * 0.2, L * 1.2, L * 1.2), p["rim"] * L, size=L * 0.8, color=p.get("rim_color", (0.85, 0.92, 1.0)))
    light("top", "AREA", (0, 0, L * 2.0), p["top"] * L, size=L * 2.2)


def import_environment(scene_spec):
    """Import the environment asset and move it so the stage origin sits at world origin, stage yaw -> +Y forward."""
    asset = (scene_spec.get("asset") or {}).get("path")
    if not asset:
        return []
    objs = import_file(asset)
    root = bpy.data.objects.new("env_root", None)
    bpy.context.collection.objects.link(root)
    for o in objs:
        if o.parent is None or o.parent not in objs:
            o.parent = root
    stage = scene_spec.get("stage") or {}
    origin = Vector(stage.get("origin_m") or [0, 0, 0])
    yaw = math.radians(float(stage.get("yaw_deg") or 0))
    root.matrix_world = mathutils.Matrix.Rotation(-yaw, 4, "Z") @ mathutils.Matrix.Translation(-origin)
    hide = scene_spec.get("hide_match")
    if hide:
        rx = re.compile(hide)
        for o in objs:
            if rx.search(o.name):
                o.hide_render = True
    for o in objs:
        o.name = f"env_{o.name}"
    bpy.context.view_layer.update()
    return objs


def import_sky(scene_spec):
    sky = (scene_spec.get("sky") or {}).get("path")
    if not sky:
        return []
    objs = import_file(sky)
    for o in objs:
        o.name = f"sky_{o.name}"
        if o.type != "MESH":
            continue
        o.visible_shadow = False
        for slot in o.material_slots:
            mat = slot.material
            if not mat or not mat.use_nodes:
                continue
            nodes, links = mat.node_tree.nodes, mat.node_tree.links
            tex = next((n for n in nodes if n.type == "TEX_IMAGE"), None)
            out = next((n for n in nodes if n.type == "OUTPUT_MATERIAL"), None)
            if tex and out:
                em = nodes.new("ShaderNodeEmission")
                em.inputs["Strength"].default_value = 1.0
                links.new(tex.outputs["Color"], em.inputs["Color"])
                for l in list(out.inputs["Surface"].links):
                    links.remove(l)
                links.new(em.outputs["Emission"], out.inputs["Surface"])
    return objs


# ------------------------------------------------------------------ subjects
class Subject:
    def __init__(self, spec):
        self.spec = spec
        self.id = spec["id"]
        self.root = None
        self.meshes = []
        self.armature = None
        self.parts = []
        self.base_matrix = None
        self.hidden = False
        self.yaw = 0.0
        self.extra_yaw, self.extra_delta = 0.0, (0, 0, 0)
        self.pose = {}

    def visible_meshes(self):
        return [m for m in self.meshes if not m.hide_render] + list(self.parts)


def import_subject(sj):
    spec = sj.spec
    asset = spec.get("asset") or {}
    proxy = spec.get("proxy") or {}
    if asset.get("path"):
        new = import_file(asset["path"])
    else:
        dims = proxy.get("dims_m") or [1.0, 1.0, 1.0]
        if proxy.get("shape") == "cylinder":
            bpy.ops.mesh.primitive_cylinder_add(radius=dims[0] / 2, depth=dims[2], location=(0, 0, dims[2] / 2))
        else:
            bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, dims[2] / 2))
            bpy.context.active_object.scale = (dims[0], dims[1], dims[2])
        ob = bpy.context.active_object
        ob.data.materials.append(make_material(f"proxy_{sj.id}", (0.55, 0.55, 0.58), 0.45, 0.0))
        new = [ob]
    sj.meshes = [o for o in new if o.type == "MESH"]
    sj.armature = next((o for o in new if o.type == "ARMATURE"), None)
    if not sj.meshes:
        raise SystemExit(f"subject {sj.id} produced no mesh objects")
    root = bpy.data.objects.new(f"subject_{sj.id}", None)
    bpy.context.collection.objects.link(root)
    for o in new:
        if o.parent is None or o.parent not in new:
            o.parent = root
        o.name = f"{sj.id}_{o.name}"
    sj.root = root
    tint = spec.get("tint")
    if tint:
        mat = make_material(f"tint_{sj.id}", tuple(tint), float(spec.get("roughness", 0.6)), 0.0, spec.get("emission"))
        for m in sj.meshes:
            m.data.materials.clear()
            m.data.materials.append(mat)
    return sj


def normalise_subject(sj):
    """Rotate so asset 'up' -> +Z and 'forward' -> +X, scale to height_m/length_m, sit on the floor, centre at origin."""
    spec = sj.spec
    is_gltf = (spec.get("asset") or {}).get("path", "").lower().endswith((".glb", ".gltf"))
    up_key, fwd_key = str(spec.get("up_axis", "Y")).upper(), str(spec.get("forward_axis", "Z")).upper()
    if is_gltf:
        # glTF importer already converts Y-up to Blender Z-up; declared axes are *file* axes
        conv = {"Y": AXIS["Z"], "Z": AXIS["-Y"], "-Z": AXIS["Y"], "X": AXIS["X"], "-X": AXIS["-X"], "-Y": AXIS["-Z"]}
        up, fwd = conv.get(up_key, AXIS["Z"]), conv.get(fwd_key, AXIS["-Y"])
    elif spec.get("proxy"):
        up, fwd = AXIS["Z"], AXIS["X"]
    else:
        up, fwd = AXIS.get(up_key, AXIS["Y"]), AXIS.get(fwd_key, AXIS["Z"])
    right = fwd.cross(up)
    m = mathutils.Matrix((fwd, -right, up)).transposed()
    rot = m.inverted() if abs(m.determinant()) > 1e-6 else mathutils.Matrix.Identity(3)
    root = sj.root
    root.matrix_world = rot.to_4x4() @ root.matrix_world
    bpy.context.view_layer.update()
    mn, mx = world_bbox(sj.meshes)
    if spec.get("height_m"):
        cur, target = max(mx.z - mn.z, 1e-6), float(spec["height_m"])
    else:
        cur, target = max(mx.x - mn.x, 1e-6), float(spec.get("length_m") or (mx.x - mn.x))
    root.matrix_world = mathutils.Matrix.Scale(target / cur, 4) @ root.matrix_world
    bpy.context.view_layer.update()
    mn, mx = world_bbox(sj.meshes)
    centre = (mn + mx) / 2
    root.matrix_world = mathutils.Matrix.Translation(Vector((-centre.x, -centre.y, -mn.z))) @ root.matrix_world
    bpy.context.view_layer.update()
    sj.base_matrix = root.matrix_world.copy()
    sj.size = (mx - mn)


def place_subject(sj, subjects_by_id, extra_yaw=0.0, extra_delta=(0, 0, 0)):
    """Apply placement (position, yaw) on top of the normalised base matrix."""
    spec = sj.spec
    pos = spec.get("position_m") or [0, 0]
    x, y = float(pos[0]), float(pos[1])
    if spec.get("face") and spec["face"] in subjects_by_id and spec["face"] != sj.id:
        tp = subjects_by_id[spec["face"]].spec.get("position_m") or [0, 0]
        yaw = math.degrees(math.atan2(float(tp[1]) - y, float(tp[0]) - x))
    else:
        yaw = float(spec.get("rotation_deg") or 0)
    yaw += extra_yaw
    T = mathutils.Matrix.Translation(Vector((x + extra_delta[0], y + extra_delta[1], extra_delta[2] + float(spec.get("elevation_m") or 0))))
    R = mathutils.Matrix.Rotation(math.radians(yaw), 4, "Z")
    sj.root.matrix_world = T @ R @ sj.base_matrix
    sj.yaw = yaw


# ------------------------------------------------------------------ poses
_LIBRARIES = {}


def load_library(path):
    """Import an animation library once; keep its actions, delete its mannequin objects."""
    if path in _LIBRARIES:
        return _LIBRARIES[path]
    before_actions = set(bpy.data.actions)
    objs = import_file(path)
    actions = {a.name: a for a in bpy.data.actions if a not in before_actions}
    for o in objs:
        bpy.data.objects.remove(o, do_unlink=True)
    _LIBRARIES[path] = actions
    return actions


def apply_pose(sj, pose):
    """Pose the subject's armature at clip phase 0..1 using an NLA strip offset so every armature can differ."""
    arm = sj.armature
    if not arm or not pose or not pose.get("clip"):
        return None
    lib = pose.get("library")
    actions = load_library(lib) if lib else {a.name: a for a in bpy.data.actions}
    act = actions.get(pose["clip"]) or next((a for k, a in actions.items() if k.lower().startswith(str(pose["clip"]).lower())), None)
    if not act:
        return {"clip": pose["clip"], "error": "clip not found", "available": sorted(actions)[:60]}
    arm.animation_data_create()
    ad = arm.animation_data
    ad.action = None
    for t in list(ad.nla_tracks):
        ad.nla_tracks.remove(t)
    s, e = act.frame_range
    phase = min(max(float(pose.get("phase", 0.0)), 0.0), 1.0)
    target = s + phase * max(e - s, 0)
    track = ad.nla_tracks.new()
    start = int(round(POSE_FRAME - (target - s)))
    strip = track.strips.new(act.name, start, act)
    try:  # Blender 4.4+ slotted actions
        if hasattr(strip, "action_slot") and len(act.slots):
            strip.action_slot = act.slots[0]
    except Exception:  # noqa: BLE001
        pass
    strip.action_frame_start, strip.action_frame_end = s, e
    strip.extrapolation = "HOLD"
    bpy.context.scene.frame_set(POSE_FRAME)
    bpy.context.view_layer.update()
    return {"clip": act.name, "phase": phase, "frame": round(target, 1)}


# ------------------------------------------------------------------ states & parts
def apply_states(subjects, states, active_ids):
    """Reset all subjects, then apply active states in order. Returns (applied log, pending add_part ops)."""
    by_id = {s.id: s for s in subjects}
    for sj in subjects:
        for m in sj.meshes:
            m.hide_render = False
        sj.hidden = False
        for p in sj.parts:
            bpy.data.objects.remove(p, do_unlink=True)
        sj.parts = []
        sj.extra_yaw, sj.extra_delta = 0.0, (0, 0, 0)
        sj.pose = dict(sj.spec.get("pose") or {})
    st_by_id = {s["id"]: s for s in states}
    part_ops = []
    applied = []
    default_subject = subjects[0].id if len(subjects) == 1 else None
    for sid in active_ids:
        st = st_by_id.get(sid)
        if not st:
            applied.append({"state": sid, "error": "unknown state"})
            continue
        for op in st.get("ops", []):
            kind = op.get("op")
            sj = by_id.get(op.get("subject") or default_subject)
            if kind in ("hide", "show") and op.get("match") and sj:
                rx = re.compile(op["match"])
                targets = [m for m in sj.meshes if rx.search(m.name) or (m.data and rx.search(m.data.name))]
                for m in targets:
                    m.hide_render = kind == "hide"
                applied.append({"state": sid, "op": kind, "subject": sj.id, "matched": len(targets)})
            elif kind in ("hide", "show") and sj:
                for m in sj.meshes:
                    m.hide_render = kind == "hide"
                sj.hidden = kind == "hide"
                applied.append({"state": sid, "op": kind, "subject": sj.id})
            elif kind == "pose" and sj:
                sj.pose = {"library": op.get("library") or sj.pose.get("library"), "clip": op.get("clip"), "phase": op.get("phase", 0.0)}
                applied.append({"state": sid, "op": "pose", "subject": sj.id, "clip": op.get("clip")})
            elif kind == "move" and sj:
                d = op.get("delta_m") or [0, 0, 0]
                sj.extra_delta = (float(d[0]), float(d[1]), float(d[2]) if len(d) > 2 else 0.0)
                applied.append({"state": sid, "op": "move", "subject": sj.id, "delta_m": d})
            elif kind == "rotate" and sj and not op.get("match"):
                sj.extra_yaw = float(op.get("deg", 0))
                applied.append({"state": sid, "op": "rotate", "subject": sj.id, "deg": op.get("deg")})
            elif kind == "add_part" and sj:
                part_ops.append((sj, op, sid))
            else:
                applied.append({"state": sid, "op": kind, "error": "unsupported op or unknown subject"})
    return applied, part_ops


def add_parts(part_ops):
    created = []
    deps = bpy.context.evaluated_depsgraph_get()
    for sj, op, sid in part_ops:
        if sj.hidden:
            continue
        mn, mx = world_bbox(sj.meshes, evaluated=True)
        cx, cy = (mn.x + mx.x) / 2, (mn.y + mx.y) / 2
        hx, hy, H = (mx.x - mn.x) / 2, (mx.y - mn.y) / 2, (mx.z - mn.z)
        fx, fy, fz = PART_AT.get(op.get("at", "roof-center"), PART_AT["roof-center"])
        dims = op.get("dims_m") or [1.0, 0.3, 0.1]
        off = op.get("offset_m") or [0, 0, 0]
        # part offsets follow the subject's yaw so "side-left" stays on its left
        yaw = math.radians(sj.yaw)
        lx, ly = fx * hx + off[0], fy * hy + off[1]
        px = cx + lx * math.cos(yaw) - ly * math.sin(yaw)
        py = cy + lx * math.sin(yaw) + ly * math.cos(yaw)
        pz = mn.z + fz * H
        if op.get("snap", True) and fz >= 0.7:
            hit, loc_hit, _n, _i, ob_hit, _m = bpy.context.scene.ray_cast(deps, Vector((px, py, mx.z + 1.0)), Vector((0, 0, -1)))
            if hit and ob_hit and ob_hit.name.startswith(f"{sj.id}_"):
                pz = loc_hit.z
        loc = (px, py, pz + dims[2] / 2 + (off[2] if len(off) > 2 else 0))
        if op.get("shape", "box") == "cylinder":
            bpy.ops.mesh.primitive_cylinder_add(radius=dims[0] / 2, depth=dims[2], location=loc)
        else:
            bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
            bpy.context.active_object.scale = (dims[1], dims[0], dims[2])
        ob = bpy.context.active_object
        ob.name = f"part_{sj.id}_{op.get('name', sid)}"
        ob.rotation_euler = (0, math.radians(float(op.get("tilt_deg") or 0)), yaw)
        col = op.get("color") or [0.05, 0.05, 0.05]
        ob.data.materials.append(make_material(ob.name, tuple(col), float(op.get("roughness", 0.35)), float(op.get("metallic", 0.2)), op.get("emission")))
        sj.parts.append(ob)
        created.append(ob)
    return created


# ------------------------------------------------------------------ camera
def make_camera(cam_spec, subjects, resolution):
    look = str(cam_spec.get("look_at", "group"))
    by_id = {s.id: s for s in subjects}
    sid, _, part = look.partition(":")
    visible = [s for s in subjects if not s.hidden and not s.spec.get("camera_ignore")]
    if sid in by_id and not by_id[sid].hidden:
        focus = [by_id[sid]]
    elif look in LOOK_AT and len(visible) == 1:
        focus, part = visible, look
    else:
        focus = visible or subjects
    objs = [m for s in focus for m in s.visible_meshes()]
    mn, mx = world_bbox(objs, evaluated=True)
    H = max(mx.z - mn.z, 0.3)
    single = len(focus) == 1
    fx, fz = LOOK_AT.get(part or "center", LOOK_AT["center"]) if single else (0.0, 0.5)
    yaw = math.radians(focus[0].yaw) if single else 0.0
    cx, cy = (mn.x + mx.x) / 2, (mn.y + mx.y) / 2
    half = (mx.x - mn.x) / 2 if single else 0
    target = Vector((cx + fx * half * math.cos(yaw), cy + fx * half * math.sin(yaw), mn.z + fz * H))
    az = math.radians(float(cam_spec.get("azimuth_deg", 35))) + yaw
    el = math.radians(float(cam_spec.get("elevation_deg", 12)))
    focal = float(cam_spec.get("focal_mm", 35))
    aspect = resolution[0] / max(resolution[1], 1)
    hfov = 2 * math.atan(36 / (2 * focal))
    vfov = 2 * math.atan(math.tan(hfov / 2) / aspect)
    view_dir = Vector((-math.cos(el) * math.cos(az), math.cos(el) * math.sin(az), -math.sin(el)))  # camera -> target
    right = view_dir.cross(Vector((0, 0, 1))).normalized()
    up = right.cross(view_dir).normalized()
    # exact fit: smallest distance along the view axis at which every bbox corner lies inside both FOV wedges
    fit = 0.0
    for cx_, cy_, cz_ in ((x, y, z) for x in (mn.x, mx.x) for y in (mn.y, mx.y) for z in (mn.z, mx.z)):
        rel = Vector((cx_, cy_, cz_)) - target
        depth = rel.dot(view_dir)  # positive = beyond target
        fit = max(fit, abs(rel.dot(right)) / math.tan(hfov / 2) - depth, abs(rel.dot(up)) / math.tan(vfov / 2) - depth)
    detail = bool(part) and part not in ("center", "")
    # distance_factor 1.0 -> the group fills ~80% of the frame; detail look-ats come in closer
    dist = float(cam_spec.get("distance_factor", 1.0)) * max(fit, 0.5) * (0.6 if detail else 1.25)
    loc = target + Vector((math.cos(el) * math.cos(az) * dist, -math.cos(el) * math.sin(az) * dist, math.sin(el) * dist))
    loc.z = max(loc.z, 0.15)
    cam_data = bpy.data.cameras.new("cam")
    cam_data.lens = focal
    cam_data.sensor_width = 36
    cam_data.clip_end = 5000
    cam = bpy.data.objects.new("cam", cam_data)
    bpy.context.collection.objects.link(cam)
    cam.location = loc
    cam.rotation_euler = (target - loc).to_track_quat("-Z", "Y").to_euler()
    bpy.context.scene.camera = cam
    return cam, {"location": [round(v, 3) for v in loc], "target": [round(v, 3) for v in target], "focal_mm": focal,
                 "focus": [s.id for s in focus], "group_bbox": [[round(v, 2) for v in mn], [round(v, 2) for v in mx]]}


def configure_render(resolution, engine, samples, out_path):
    scene = bpy.context.scene
    scene.render.engine = engine
    scene.render.resolution_x, scene.render.resolution_y = int(resolution[0]), int(resolution[1])
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"
    scene.render.filepath = out_path
    scene.view_settings.view_transform = "Filmic" if "Filmic" in [i.identifier for i in bpy.types.ColorManagedViewSettings.bl_rna.properties["view_transform"].enum_items] else "AgX"
    if engine.startswith("BLENDER_EEVEE"):
        try:
            scene.eevee.taa_render_samples = int(samples)
            scene.eevee.use_raytracing = True
        except AttributeError:
            pass


# ------------------------------------------------------------------ main
def main():
    args = parse_args()
    spec = json.load(open(args.spec, encoding="utf-8"))
    os.makedirs(args.out_dir, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.scene.unit_settings.system = "METRIC"

    scene_spec = spec.get("scene") or {}
    preset = PRESETS.get(scene_spec.get("preset", "showroom_dark"), PRESETS["showroom_dark"])
    subject_specs = spec.get("subjects")
    if not subject_specs and spec.get("subject"):
        subject_specs = [{"id": "subject", "position_m": [0, 0], **spec["subject"]}]
    subjects = [Subject(s) for s in subject_specs or []]
    if not subjects:
        raise SystemExit("spec needs subjects[] or subject")

    env_objs = import_environment(scene_spec)
    sky_objs = import_sky(scene_spec)
    build_world(preset)

    by_id = {s.id: s for s in subjects}
    for sj in subjects:
        import_subject(sj)
        normalise_subject(sj)
        place_subject(sj, by_id)
    # group extent drives studio floor size and light scale
    mn_all, mx_all = world_bbox([m for s in subjects for m in s.meshes])
    group_span = max((mx_all - mn_all).length, 1.5)
    if not env_objs:
        build_studio_floor(preset, scene_spec.get("floor_reflective"), max(30.0, group_span * 8))
    build_lights(preset, max(group_span * 0.9, 2.0))

    resolution = spec.get("resolution", [1280, 720])
    engine = spec.get("engine", "BLENDER_EEVEE")
    samples = spec.get("samples", 24)
    results = []
    for anchor in spec.get("anchors", []):
        applied, part_ops = apply_states(subjects, spec.get("states", []), anchor.get("states", []))
        poses = {}
        for sj in subjects:
            place_subject(sj, by_id, sj.extra_yaw, sj.extra_delta)
            if sj.armature and sj.pose.get("clip"):
                poses[sj.id] = apply_pose(sj, sj.pose)
        bpy.context.scene.frame_set(POSE_FRAME)
        bpy.context.view_layer.update()
        parts = add_parts(part_ops)
        applied.append({"op": "add_part", "created": len(parts)})
        cam, cam_info = make_camera(anchor.get("camera") or {}, subjects, resolution)
        out = os.path.join(args.out_dir, f"{anchor['id']}.png")
        configure_render(resolution, engine, samples, out)
        bpy.ops.render.render(write_still=True)
        bpy.data.objects.remove(cam, do_unlink=True)
        results.append({"id": anchor["id"], "out": out, "bytes": os.path.getsize(out), "camera": cam_info, "states": applied, "poses": poses,
                        "subjects": {s.id: {"hidden": s.hidden, "position": [round(v, 2) for v in s.root.matrix_world.translation], "yaw": round(s.yaw, 1)} for s in subjects}})
        print(json.dumps({"event": "ANCHOR_DONE", **results[-1]}), flush=True)
    print(json.dumps({"event": "RENDER_DONE", "count": len(results),
                      "subject_bbox": {"min": [round(v, 3) for v in mn_all], "max": [round(v, 3) for v in mx_all]},
                      "subjects": [s.id for s in subjects], "env_objects": len(env_objs), "sky_objects": len(sky_objs),
                      "mesh_names": sorted({m.name for s in subjects for m in s.meshes})[:200]}), flush=True)


if __name__ == "__main__":
    main()
