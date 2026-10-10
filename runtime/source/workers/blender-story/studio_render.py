"""Blender CLI entry point for a baked GLB, never an AI-generated Python script."""
from __future__ import annotations
import argparse
import json
import math
import os
import sys
from pathlib import Path

import bpy
from mathutils import Matrix, Vector


def y_up(value):
    return Vector((value[0], -value[2], value[1]))


Y_TO_Z = Matrix.Rotation(math.pi / 2, 4, "X")


def color(value):
    value = str(value or "#808080").lstrip("#")
    if len(value) != 6:
        raise ValueError("Expected #rrggbb color")
    rgb = [int(value[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(c / 12.92 if c <= .04045 else ((c + .055) / 1.055) ** 2.4 for c in rgb)


def descendants(obj):
    return [obj, *obj.children_recursive]


def find_object(identifier):
    direct = bpy.data.objects.get(identifier)
    if direct:
        return direct
    return next((obj for obj in bpy.data.objects if obj.get("studioObjectId") == identifier and not obj.get("studioBoneId")), None)


def value_at(track, frame):
    keys = sorted(track.get("keys", []), key=lambda key: key["frame"])
    if not keys:
        return None
    if frame <= keys[0]["frame"]:
        return keys[0]["value"]
    for left, right in zip(keys, keys[1:]):
        if frame < right["frame"]:
            if left.get("interpolation") == "hold":
                return left["value"]
            t = (frame - left["frame"]) / (right["frame"] - left["frame"])
            if left.get("ease"):
                x1, y1, x2, y2 = left["ease"]
                def bezier(value, a, b):
                    inv = 1 - value
                    return 3 * inv * inv * value * a + 3 * inv * value * value * b + value ** 3
                low, high = 0.0, 1.0
                for _ in range(24):
                    mid = (low + high) / 2
                    if bezier(mid, x1, x2) < t:
                        low = mid
                    else:
                        high = mid
                t = bezier((low + high) / 2, y1, y2)
            elif left.get("interpolation") == "smooth":
                t = t * t * (3 - 2 * t)
            a, b = left["value"], right["value"]
            if isinstance(a, list):
                return [x + (y - x) * t for x, y in zip(a, b)]
            return a + (b - a) * t
    return keys[-1]["value"]


def setup_scene(sidecar, resolution):
    scene = bpy.context.scene
    scene.render.engine = os.getenv("STUDIO_RENDER_ENGINE", "BLENDER_EEVEE")
    if scene.render.engine == "CYCLES":
        scene.cycles.samples = int(os.getenv("STUDIO_RENDER_SAMPLES", "16"))
        scene.cycles.use_denoising = False
        scene.cycles.seed = 0
    scene.render.resolution_x, scene.render.resolution_y = resolution
    scene.render.resolution_percentage = 100
    scene.render.fps, scene.render.fps_base = 24, 1.0
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"
    scene.render.film_transparent = False
    scene.view_settings.view_transform = "AgX"
    # Three exposure is a multiplier; Blender exposure is measured in stops.
    scene.view_settings.exposure = math.log2(max(.001, float(sidecar.get("exposure", 1))))
    scene.world = scene.world or bpy.data.worlds.new("StudioWorld")
    scene.world.use_nodes = True
    nodes, links = scene.world.node_tree.nodes, scene.world.node_tree.links
    nodes.clear()
    output = nodes.new("ShaderNodeOutputWorld")
    background = nodes.new("ShaderNodeBackground")
    background.inputs["Color"].default_value = (*color(sidecar.get("background", "#202630")), 1)
    background.inputs["Strength"].default_value = 1
    lights = sidecar.get("lights", [{"id": "key", "type": "directional", "position": [4, 7, 5], "intensity": 3, "color": "#ffffff"}, {"id": "fill", "type": "ambient", "intensity": .7, "color": "#d9e2ff"}])
    ambient = nodes.new("ShaderNodeBackground")
    ambient_rgb = [0., 0., 0.]
    for light in lights:
        if light.get("type") == "ambient":
            for index, component in enumerate(color(light.get("color", "#ffffff"))):
                ambient_rgb[index] += component * float(light.get("intensity", 1))
    ambient.inputs["Color"].default_value = (*ambient_rgb, 1)
    ambient.inputs["Strength"].default_value = 1
    paths = nodes.new("ShaderNodeLightPath")
    mix = nodes.new("ShaderNodeMixShader")
    links.new(paths.outputs["Is Camera Ray"], mix.inputs[0])
    links.new(ambient.outputs[0], mix.inputs[1])
    links.new(background.outputs[0], mix.inputs[2])
    links.new(mix.outputs[0], output.inputs["Surface"])
    for light in lights:
        if light.get("type") == "ambient":
            continue
        light_type = {"directional": "SUN", "point": "POINT"}.get(light.get("type"))
        if light_type is None:
            raise ValueError("Unsupported light type")
        obj = find_object(light["id"])
        if obj is None or obj.type != "LIGHT":
            data = bpy.data.lights.new(light["id"], light_type)
            obj = bpy.data.objects.new(light["id"], data)
            scene.collection.objects.link(obj)
        obj.data.type = light_type
        obj.location = y_up(light.get("position", [5, 8, 5]))
        if light_type == "SUN":
            obj.rotation_euler = (-obj.location).to_track_quat("-Z", "Y").to_euler()
        obj.data.energy = float(light.get("intensity", 1))
        obj.data.color = color(light.get("color", "#ffffff"))
    cameras = sidecar.get("cameras", [])
    selected = next((cam for cam in cameras if cam["id"] == sidecar.get("activeCameraId")), None)
    if selected is None:
        raise ValueError("Active camera is missing from scene sidecar")
    camera = find_object(selected["id"])
    if camera is None:
        data = bpy.data.cameras.new(selected["id"])
        camera = bpy.data.objects.new(selected["id"], data)
        scene.collection.objects.link(camera)
        camera.location = y_up(selected["position"])
        camera.rotation_euler = (y_up(selected["target"]) - camera.location).to_track_quat("-Z", "Y").to_euler()
    if camera.type != "CAMERA":
        raise ValueError("Active camera id resolves to a non-camera node")
    camera.data.lens = float(selected.get("focalLength", 50))
    camera.data.sensor_width = float(selected.get("sensorWidth", 36))
    camera.data.sensor_height = camera.data.sensor_width
    # Three filmGauge spans the larger film dimension; AUTO with equal sensor
    # dimensions reproduces that convention for landscape and portrait outputs.
    camera.data.sensor_fit = "AUTO"
    scene.camera = camera
    if sidecar.get("showGround") and not bpy.data.objects.get("studio-ground"):
        bpy.ops.mesh.primitive_plane_add(size=200, location=(0, 0, -.025))
        ground = bpy.context.object
        ground.name = "studio-ground"
        material = bpy.data.materials.new("StudioGround")
        material.diffuse_color = (*color(sidecar.get("groundColor", "#555b65")), 1)
        material.use_nodes = True
        shader = material.node_tree.nodes.get("Principled BSDF")
        shader.inputs["Base Color"].default_value = material.diffuse_color
        shader.inputs["Roughness"].default_value = .9
        ground.data.materials.append(material)
    return scene


def apply_sidecar(sidecar, frame):
    objects = {obj["id"]: obj for obj in sidecar.get("objects", [])}
    visibility = {identifier: bool(obj.get("visible", True)) for identifier, obj in objects.items()}
    part_visibility = {(identifier, part["id"]): bool(part.get("visible", True)) for identifier, obj in objects.items() for part in obj.get("parts", [])}
    for track in sidecar.get("tracks", []):
        if track.get("muted"):
            continue
        prop = track.get("property")
        if prop not in ("visible", "focalLength"):
            continue  # TRS, FK, IK and morph are already baked exactly once.
        value = value_at(track, frame)
        if value is None:
            continue
        target = find_object(track["targetId"])
        if prop == "visible":
            if track.get("partId"):
                part_visibility[(track["targetId"], track["partId"])] = bool(value)
            else:
                visibility[track["targetId"]] = bool(value)
        elif target and target.type == "CAMERA":
            target.data.lens = max(1, float(value))
    controls, imported = {}, set()
    for identifier, visible in visibility.items():
        parent = objects.get(identifier, {}).get("parentId")
        visited = {identifier}
        while parent:
            if parent in visited:
                raise ValueError("Cyclic object parent hierarchy")
            visited.add(parent)
            visible = visible and visibility.get(parent, True)
            parent = objects.get(parent, {}).get("parentId")
        target = find_object(identifier)
        if target:
            controls[target] = visible
            imported.update(descendants(target))
    for (identifier, part_id), visible in part_visibility.items():
        root = find_object(identifier)
        matches = [obj for obj in descendants(root) if obj.get("studioPartRoot") and obj.get("studioPartId") == part_id and obj.get("studioObjectId") == identifier] if root else []
        if len(matches) != 1:
            raise ValueError(f"Part root missing or ambiguous: {identifier}/{part_id}")
        controls[matches[0]] = visible
    # Resolve every ancestor for every node. Parent traversal is independent of
    # sidecar object ordering, and a visible child cannot unhide a hidden parent.
    for obj in imported:
        current, visible = obj, True
        while current:
            visible = visible and controls.get(current, True)
            current = current.parent
        obj.hide_render = not visible


def landmark(sample, frame):
    root = find_object(sample["objectId"])
    if root is None:
        raise ValueError(f"Landmark object missing: {sample['objectId']}")
    bone = sample.get("bone")
    target = root
    if bone and bone != "root":
        name = f"studio-landmark:{sample['objectId']}:{bone}"
        target = next((obj for obj in descendants(root) if obj.name == name or (obj.get("studioLandmark") and obj.get("studioBoneId") == bone)), None)
        if target is None:
            raise ValueError(f"Bone landmark helper missing: {name}; Blender edit-bone axes are not glTF joint axes")
    # Conjugate the *entire* world matrix; changing position alone is insufficient.
    matrix = Y_TO_Z.inverted() @ target.matrix_world @ Y_TO_Z
    position, rotation, scale = matrix.decompose()
    quaternion = [rotation.x, rotation.y, rotation.z, rotation.w]
    result = {"frame": frame, "objectId": sample["objectId"], "bone": bone or "root", "position": list(position), "rotation": quaternion, "quaternion": quaternion, "scale": list(scale), "visible": not target.hide_render}
    if sample.get("partId"):
        result["partId"] = sample["partId"]
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--spec", required=True)
    parser.add_argument("--glb", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
    spec = json.loads(Path(args.spec).read_text(encoding="utf8"))
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    bpy.context.scene.render.fps, bpy.context.scene.render.fps_base = 24, 1.0
    bpy.ops.import_scene.gltf(filepath=args.glb)
    scene = setup_scene(spec["scene"], spec["resolution"])
    samples = {}
    for sample in spec.get("landmarks", []):
        samples.setdefault(sample["frame"], []).append(sample)
    observed = []
    origin = spec.get("bakeFrameStart", 0)
    for frame in range(spec["frameStart"], spec["frameEnd"]):
        scene.frame_set(frame - origin)
        apply_sidecar(spec["scene"], frame)
        bpy.context.view_layer.update()
        observed.extend(landmark(sample, frame) for sample in samples.get(frame, []))
        scene.render.filepath = str(out / f"frame_{frame:06d}.png")
        bpy.ops.render.render(write_still=True)
        print(json.dumps({"event": "STUDIO_FRAME", "frame": frame}), flush=True)
    (out / "result.json").write_text(json.dumps({"frames": spec["frameEnd"] - spec["frameStart"], "landmarks": observed}), encoding="utf8")


if __name__ == "__main__":
    main()
