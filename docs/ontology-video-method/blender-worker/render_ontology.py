"""
render_ontology.py — build a studio from an *ontology Blender layer* and render every anchor.

Subject-agnostic: a car, a bottle, a chair, a person-proxy. The ontology decides the studio
preset, how the subject is normalised (up/forward axis, real length), which named parts are
shown/hidden per *state*, and each anchor's camera in a bounded grammar (azimuth / elevation /
distance factor / focal length / look-at). Nothing here is SU7-specific.

Run headless:
  blender --background --factory-startup --python render_ontology.py -- --spec spec.json --out-dir D:\\...\\job

Spec:
{
  "scene": {"preset": "showroom_dark|studio_white|garage|outdoor_overcast", "floor_reflective": true},
  "subject": {
    "asset": {"path": "D:/story-assets/models/su7.glb"}      # OR
    "proxy": {"shape": "box|cylinder|capsule", "dims_m": [4.9, 1.96, 1.45]},
    "up_axis": "Y|Z", "forward_axis": "Z|-Z|X|-X|Y|-Y",       # of the asset file
    "length_m": 4.997,                                          # real-world length along forward; scales asset
    "rotation_deg": 0                                           # yaw on the turntable
  },
  "states": [{"id": "spoiler_on", "ops": [{"op": "show", "match": "(?i)spoiler|wing"}]},
             {"id": "doors_open", "ops": [{"op": "rotate", "match": "(?i)door_fl", "axis": "Z", "deg": 60}]}],
  "anchors": [{"id": "anc-front-3q", "camera": {"azimuth_deg": 35, "elevation_deg": 12, "distance_factor": 2.2,
               "focal_mm": 35, "look_at": "center|front|rear|roof|wheel_front|ground"}, "states": ["spoiler_on"]}],
  "resolution": [1280, 720], "engine": "BLENDER_EEVEE", "samples": 24
}
Prints one JSON line per anchor: {"event":"ANCHOR_DONE","id":...,"out":...} and a final {"event":"RENDER_DONE",...}.
"""
import argparse
import json
import math
import os
import re
import sys

import bpy
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
}
LOOK_AT = {  # fraction of bbox: (x along forward -1..1, z 0..1)
    "center": (0.0, 0.45), "front": (0.75, 0.35), "rear": (-0.75, 0.4), "roof": (0.0, 0.95),
    "wheel_front": (0.6, 0.15), "ground": (0.0, 0.05),
}


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--spec", required=True)
    p.add_argument("--out-dir", required=True)
    return p.parse_args(argv)


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    return scene


def make_material(name, color, rough, metal):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = metal
    return mat


def build_studio(preset_name, floor_reflective, subject_len):
    p = PRESETS.get(preset_name, PRESETS["showroom_dark"])
    scene = bpy.context.scene
    world = bpy.data.worlds.new("World")
    scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    bg.inputs["Color"].default_value = (*p["bg"], 1.0)
    bg.inputs["Strength"].default_value = p["world"]
    size = max(30.0, subject_len * 8)
    bpy.ops.mesh.primitive_plane_add(size=size, location=(0, 0, 0))
    floor = bpy.context.active_object
    floor.name = "studio_floor"
    rough = p["floor_rough"] if floor_reflective is None else (0.16 if floor_reflective else 0.6)
    floor.data.materials.append(make_material("floor", p["floor"], rough, p["floor_metal"]))
    # cyclorama back wall + soft ceiling glow so reflections have something to show
    bpy.ops.mesh.primitive_plane_add(size=size * 2, location=(0, size * 0.9, size / 2), rotation=(math.radians(90), 0, 0))
    wall = bpy.context.active_object
    wall.name = "studio_backwall"
    wall.data.materials.append(make_material("wall", p["bg"], 0.9, 0.0))

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
        direction = Vector((0, 0, subject_len * 0.25)) - Vector(loc)
        ob.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
        return ob

    L = subject_len
    light("key", "AREA", (L * 0.9, -L * 1.1, L * 1.4), p["key"] * L, size=L * 1.2, color=(1.0, 0.98, 0.95))
    light("fill", "AREA", (-L * 1.2, -L * 0.8, L * 0.9), p["fill"] * L, size=L * 1.6, color=(0.9, 0.95, 1.0))
    light("rim", "AREA", (-L * 0.2, L * 1.2, L * 1.2), p["rim"] * L, size=L * 0.8, color=(0.85, 0.92, 1.0))
    light("top", "AREA", (0, 0, L * 2.0), p["top"] * L, size=L * 2.2)
    return p


def import_subject(subject):
    before = set(bpy.data.objects)
    asset = subject.get("asset") or {}
    proxy = subject.get("proxy") or {}
    if asset.get("path"):
        path = asset["path"]
        ext = os.path.splitext(path)[1].lower()
        if ext in (".glb", ".gltf"):
            bpy.ops.import_scene.gltf(filepath=path)
        elif ext == ".obj":
            bpy.ops.wm.obj_import(filepath=path)
        elif ext == ".fbx":
            bpy.ops.import_scene.fbx(filepath=path)
        else:
            raise SystemExit(f"unsupported asset: {path}")
    else:
        dims = proxy.get("dims_m") or [1.0, 1.0, 1.0]
        shape = proxy.get("shape", "box")
        if shape == "cylinder":
            bpy.ops.mesh.primitive_cylinder_add(radius=dims[0] / 2, depth=dims[2], location=(0, 0, dims[2] / 2))
        else:
            bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, dims[2] / 2))
            bpy.context.active_object.scale = (dims[0], dims[1], dims[2])
        ob = bpy.context.active_object
        ob.name = "subject_proxy"
        ob.data.materials.append(make_material("proxy", (0.55, 0.55, 0.58), 0.45, 0.0))
    new = [o for o in bpy.data.objects if o not in before]
    meshes = [o for o in new if o.type == "MESH"]
    if not meshes:
        raise SystemExit("subject produced no mesh objects")
    # group under one empty so we can normalise as a whole
    root = bpy.data.objects.new("subject_root", None)
    bpy.context.collection.objects.link(root)
    for o in new:
        if o.parent is None or o.parent not in new:
            o.parent = root
    return root, meshes


def world_bbox(meshes):
    bpy.context.view_layer.update()
    pts = [o.matrix_world @ Vector(c) for o in meshes if not o.hide_render for c in o.bound_box]
    if not pts:
        pts = [o.matrix_world @ Vector(c) for o in meshes for c in o.bound_box]
    mn = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    mx = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    return mn, mx


AXIS = {"X": Vector((1, 0, 0)), "-X": Vector((-1, 0, 0)), "Y": Vector((0, 1, 0)), "-Y": Vector((0, -1, 0)), "Z": Vector((0, 0, 1)), "-Z": Vector((0, 0, -1))}


def normalise_subject(root, meshes, subject):
    """Rotate so asset 'up' -> +Z and 'forward' -> +X, scale to length_m, sit on the floor, centre at origin."""
    up = AXIS.get(str(subject.get("up_axis", "Y")).upper(), AXIS["Y"])
    fwd = AXIS.get(str(subject.get("forward_axis", "Z")).upper(), AXIS["Z"])
    # glTF importer already converts Y-up to Blender Z-up; treat declared axes as *file* axes and undo double conversion
    if (subject.get("asset") or {}).get("path", "").lower().endswith((".glb", ".gltf")):
        conv = {"Y": AXIS["Z"], "Z": AXIS["-Y"], "-Z": AXIS["Y"], "X": AXIS["X"], "-X": AXIS["-X"], "-Y": AXIS["-Z"]}
        up = conv.get(str(subject.get("up_axis", "Y")).upper(), AXIS["Z"])
        fwd = conv.get(str(subject.get("forward_axis", "Z")).upper(), AXIS["-Y"])
    right = fwd.cross(up)
    # rotation that maps (fwd, right, up) -> (X, -Y?, Z): we want forward=+X, up=+Z
    import mathutils
    m = mathutils.Matrix((fwd, -right, up)).transposed()  # columns fwd,right',up
    rot = m.inverted() if abs(m.determinant()) > 1e-6 else mathutils.Matrix.Identity(3)
    root.matrix_world = rot.to_4x4() @ root.matrix_world
    bpy.context.view_layer.update()
    mn, mx = world_bbox(meshes)
    cur_len = max(mx.x - mn.x, 1e-6)
    target = float(subject.get("length_m") or cur_len)
    s = target / cur_len
    root.matrix_world = mathutils.Matrix.Scale(s, 4) @ root.matrix_world
    bpy.context.view_layer.update()
    mn, mx = world_bbox(meshes)
    centre = (mn + mx) / 2
    root.matrix_world = mathutils.Matrix.Translation(Vector((-centre.x, -centre.y, -mn.z))) @ root.matrix_world
    yaw = math.radians(float(subject.get("rotation_deg") or 0))
    root.matrix_world = mathutils.Matrix.Rotation(yaw, 4, "Z") @ root.matrix_world
    bpy.context.view_layer.update()
    return world_bbox(meshes)


def apply_states(meshes, states, active_ids):
    for o in meshes:
        o.hide_render = False
        o.hide_viewport = False
    # remember base transforms
    for o in meshes:
        if "ont_base" not in o:
            o["ont_base"] = [list(r) for r in o.matrix_basis]
        else:
            import mathutils
            o.matrix_basis = mathutils.Matrix(o["ont_base"])
    by_id = {s["id"]: s for s in states}
    applied = []
    for sid in active_ids:
        st = by_id.get(sid)
        if not st:
            continue
        for op in st.get("ops", []):
            rx = re.compile(op.get("match", "$^"))
            targets = [o for o in meshes if rx.search(o.name) or (o.data and rx.search(o.data.name))]
            for o in targets:
                if op["op"] == "hide":
                    o.hide_render = True
                elif op["op"] == "show":
                    o.hide_render = False
                elif op["op"] == "rotate":
                    import mathutils
                    ax = str(op.get("axis", "Z")).upper()
                    piv = op.get("pivot")
                    R = mathutils.Matrix.Rotation(math.radians(float(op.get("deg", 0))), 4, ax)
                    if piv:
                        P = mathutils.Matrix.Translation(Vector(piv))
                        o.matrix_basis = P @ R @ P.inverted() @ o.matrix_basis
                    else:
                        o.matrix_basis = o.matrix_basis @ R
                elif op["op"] == "add_part":
                    pass  # handled below (needs bbox), see add_parts()
                elif op["op"] == "translate":
                    import mathutils
                    o.matrix_basis = mathutils.Matrix.Translation(Vector(op.get("delta", [0, 0, 0]))) @ o.matrix_basis
            applied.append({"state": sid, "op": op["op"], "matched": len(targets)})
    return applied


PART_AT = {  # (x frac along forward -1..1, y frac -1..1, z: 0..1 of height, or "top"=1.0)
    "rear-top": (-0.84, 0.0, 0.75), "roof-center": (0.0, 0.0, 1.0), "front-bottom": (0.95, 0.0, 0.15),
    "rear-bottom": (-0.95, 0.0, 0.15), "side-left": (0.0, 0.95, 0.4), "side-right": (0.0, -0.95, 0.4), "front-top": (0.6, 0.0, 0.95),
}


def add_parts(states, active_ids, mn, mx):
    """Create proxy accessory meshes for states with add_part ops; returns created objects (removed after render)."""
    created = []
    by_id = {s["id"]: s for s in states}
    cx, cy = (mn.x + mx.x) / 2, (mn.y + mx.y) / 2
    hx, hy, H = (mx.x - mn.x) / 2, (mx.y - mn.y) / 2, (mx.z - mn.z)
    for sid in active_ids:
        for op in (by_id.get(sid) or {}).get("ops", []):
            if op.get("op") != "add_part":
                continue
            fx, fy, fz = PART_AT.get(op.get("at", "roof-center"), PART_AT["roof-center"])
            dims = op.get("dims_m") or [1.0, 0.3, 0.1]
            off = op.get("offset_m") or [0, 0, 0]
            px, py = cx + fx * hx + off[0], cy + fy * hy + off[1]
            pz = mn.z + fz * H
            if op.get("snap", True):
                # drop a ray from above onto the subject so the part sits on the real surface (trunk lid, roof, bumper...)
                deps = bpy.context.evaluated_depsgraph_get()
                hit, loc_hit, _n, _i, ob_hit, _m = bpy.context.scene.ray_cast(deps, Vector((px, py, mx.z + 1.0)), Vector((0, 0, -1)))
                if hit and ob_hit and not ob_hit.name.startswith(("studio_", "part_")):
                    pz = loc_hit.z
            loc = (px, py, pz + dims[2] / 2 + off[2])
            shape = op.get("shape", "box")
            if shape == "cylinder":
                bpy.ops.mesh.primitive_cylinder_add(radius=dims[0] / 2, depth=dims[2], location=loc)
            else:
                bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
                bpy.context.active_object.scale = (dims[1], dims[0], dims[2])  # dims = [width across car, depth along car, height]
            ob = bpy.context.active_object
            ob.name = f"part_{op.get('name', sid)}"
            col = op.get("color") or [0.05, 0.05, 0.05]
            ob.data.materials.append(make_material(ob.name, tuple(col), float(op.get("roughness", 0.35)), float(op.get("metallic", 0.2))))
            if op.get("tilt_deg"):
                ob.rotation_euler = (0, math.radians(float(op["tilt_deg"])), 0)
            created.append(ob)
    return created


def make_camera(anchor_cam, mn, mx, resolution):
    H = max(mx.z - mn.z, 0.3)
    fx, fz = LOOK_AT.get(anchor_cam.get("look_at", "center"), LOOK_AT["center"])
    target = Vector(((mn.x + mx.x) / 2 + fx * (mx.x - mn.x) / 2, (mn.y + mx.y) / 2, mn.z + fz * H))
    az = math.radians(float(anchor_cam.get("azimuth_deg", 35)))
    el = math.radians(float(anchor_cam.get("elevation_deg", 12)))
    focal = float(anchor_cam.get("focal_mm", 35))
    radius = (mx - mn).length / 2  # bounding sphere
    aspect = resolution[0] / max(resolution[1], 1)
    hfov = 2 * math.atan(36 / (2 * focal))
    vfov = 2 * math.atan(math.tan(hfov / 2) / aspect)
    fit = radius / math.sin(min(hfov, vfov) / 2)  # distance at which the sphere just fits
    detail = anchor_cam.get("look_at", "center") not in ("center",)
    dist = float(anchor_cam.get("distance_factor", 1.0)) * fit * (0.8 if not detail else 0.45)
    loc = target + Vector((math.cos(el) * math.cos(az) * dist, -math.cos(el) * math.sin(az) * dist, math.sin(el) * dist))
    loc.z = max(loc.z, 0.15)
    cam_data = bpy.data.cameras.new("cam")
    cam_data.lens = float(anchor_cam.get("focal_mm", 35))
    cam_data.sensor_width = 36
    cam = bpy.data.objects.new("cam", cam_data)
    bpy.context.collection.objects.link(cam)
    cam.location = loc
    cam.rotation_euler = (target - loc).to_track_quat("-Z", "Y").to_euler()
    bpy.context.scene.camera = cam
    return cam, {"location": [round(v, 3) for v in loc], "target": [round(v, 3) for v in target], "focal_mm": cam_data.lens}


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


def main():
    args = parse_args()
    spec = json.load(open(args.spec, encoding="utf-8"))
    os.makedirs(args.out_dir, exist_ok=True)
    reset_scene()
    subject = spec.get("subject") or {}
    root, meshes = import_subject(subject)
    mn, mx = normalise_subject(root, meshes, subject)
    subject_len = mx.x - mn.x
    build_studio((spec.get("scene") or {}).get("preset", "showroom_dark"), (spec.get("scene") or {}).get("floor_reflective"), subject_len)
    resolution = spec.get("resolution", [1280, 720])
    engine = spec.get("engine", "BLENDER_EEVEE")
    samples = spec.get("samples", 24)
    results = []
    for anchor in spec.get("anchors", []):
        applied = apply_states(meshes, spec.get("states", []), anchor.get("states", []))
        bpy.context.view_layer.update()
        amn, amx = world_bbox(meshes)
        parts = add_parts(spec.get("states", []), anchor.get("states", []), amn, amx)
        applied += [{"state": "add_part", "op": "add_part", "matched": len(parts)}]
        cam, cam_info = make_camera(anchor.get("camera") or {}, amn, amx, resolution)
        out = os.path.join(args.out_dir, f"{anchor['id']}.png")
        configure_render(resolution, engine, samples, out)
        bpy.ops.render.render(write_still=True)
        bpy.data.objects.remove(cam, do_unlink=True)
        for ob in parts:
            bpy.data.objects.remove(ob, do_unlink=True)
        results.append({"id": anchor["id"], "out": out, "bytes": os.path.getsize(out), "camera": cam_info, "states": applied})
        print(json.dumps({"event": "ANCHOR_DONE", **results[-1]}), flush=True)
    print(json.dumps({"event": "RENDER_DONE", "count": len(results), "subject_bbox": {"min": [round(v, 3) for v in mn], "max": [round(v, 3) for v in mx]},
                      "mesh_names": sorted({o.name for o in meshes})[:200]}), flush=True)


if __name__ == "__main__":
    main()
