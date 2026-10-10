"""
Build assets/manifest.json — the ONLY thing the storyboard LLM sees about the 3D side.

It lists scenes, their cameras and anchors, and every pose in the procedural library
(plus any Mixamo actions registered in assets/poses/actions.json). The LLM picks ids from
this menu; it never emits joint angles or coordinates. Regenerate whenever the scene
builder, pose library or action registry changes:

    python3 build_manifest.py
"""

import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(HERE, "assets")

SCENES = {
    "warehouse": {
        "label": "空旷混凝土仓库",
        "description": "Bare concrete warehouse, raking side light from frame-left, one cube prop at frame-right. Neutral, cinematic, works for drama, dance, action and monologue.",
        "file": "scenes/warehouse.blend",
        "cameras": {
            "cam_wide": "Full body, very small in frame (~25% of height) with lots of room; establishing shot, shows the cube prop. NOTE: the restyle pass tends to enlarge small subjects, so prefer cam_medium unless the story needs emptiness.",
            "cam_medium": "Full body, tighter; default for action and gesture.",
            "cam_close": "Waist-up; emotion and face-adjacent beats. Only use with anchor_center.",
            "cam_low": "Low angle full body; heroic or ominous.",
        },
        "anchors": {
            "anchor_center": "Centre of the room, facing camera.",
            "anchor_left": "Frame-left (about 0.85m left of centre), angled 15 degrees toward centre. Safe in all cameras except cam_close.",
            "anchor_right": "Frame-right (about 0.85m right of centre), angled 15 degrees toward centre. Safe in all cameras except cam_close.",
            "anchor_near_prop": "Standing right beside the cube prop, angled toward it.",
        },
        "props": ["prop_cube"],
    },
    "pagoda_mountain": {
        "label": "云山古塔",
        "description": "Mountain crest at dusk directly below a colossal multi-storey Chinese pagoda: carved balustrades, bracketed eaves and lattice windows tower over the character; craggy rock and grass underfoot, misty ridges and a low sun behind. Eastern mythology / wuxia / dark epic; the strongest 'world-scale' scene in the library. Source: Blender demo 'Temple' by Dominik Graf (CC-BY), adapted.",
        "file": "scenes/pagoda_mountain.blend",
        "cameras": {
            "cam_wide": "Full body small on the rocky crest; the pagoda's balustrade and eaves fill the upper frame. Establishing / awe.",
            "cam_medium": "Full body, tighter; the carved railing and bracket sets loom right behind. Default for gestures and vows.",
            "cam_low": "Low angle looking up past the character into the pagoda eaves; heroic, oppressive.",
        },
        "anchors": {
            "anchor_center": "On the level crest, facing camera, pagoda centred behind.",
            "anchor_left": "Frame-left on the crest, angled toward centre.",
        },
        "props": [],
    },
    "ancient_hall": {
        "label": "古殿回廊",
        "description": "Stone cloister courtyard of an ancient monastery: two storeys of round-arched arcades on slender columns, tiled roofs, a well, tall grass between flagstones, soft overcast sky. Reads as a temple / palace courtyard once restyled; good for dialogue, ritual, stillness, arrivals. Source: Blender demo 'Lone Monk' by Carlo Bergonzini (CC-BY), adapted.",
        "file": "scenes/ancient_hall.blend",
        "cameras": {
            "cam_wide": "Full body small in the courtyard, the whole two-storey arcade behind. Establishing.",
            "cam_medium": "Full body in front of the arcade arches. Default for gesture and movement.",
            "cam_close": "Waist-up, columns and arch framing the head. Only with anchor_center.",
            "cam_low": "Low angle, arcade and roofline rising above the character.",
        },
        "anchors": {
            "anchor_center": "Courtyard centre-line on the flagstones, facing camera.",
            "anchor_left": "Frame-left, angled toward centre.",
            "anchor_right": "Frame-right, angled toward centre.",
        },
        "props": ["well"],
    },
    "mist_forest": {
        "label": "雾林枯木",
        "description": "A small clearing in cold night mist with one huge gnarled bare tree whose branches spread over the whole frame; soft ground, drifting embers, deep blue haze beyond. Intimate, eerie, spirit-forest / ghost-story mood; the world ends in mist a few metres away, so it feels enclosed. Source: Blender demo 'Ember Forest' by Mike Pan (CC-BY), adapted.",
        "file": "scenes/mist_forest.blend",
        "cameras": {
            "cam_wide": "Full body under the whole tree, branches crowning the frame. Establishing / solitude.",
            "cam_medium": "Full body in front of the trunk, canopy above. Default.",
            "cam_close": "Waist-up against the trunk and branches. Only with anchor_center.",
            "cam_low": "Low angle up through the branches; ominous.",
        },
        "anchors": {
            "anchor_center": "Just in front of the trunk, facing camera.",
            "anchor_left": "Frame-left of the trunk, angled toward centre.",
            "anchor_right": "Frame-right of the trunk, angled toward centre.",
            "anchor_near_prop": "Right at the base of the trunk, angled toward it.",
        },
        "props": ["tree"],
    },
}


def load(path, default):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except FileNotFoundError:
        return default


def main():
    lib = load(os.path.join(ASSETS, "poses", "library.json"), {"poses": {}})
    actions = load(os.path.join(ASSETS, "poses", "actions.json"), {"actions": {}})
    poses = {}
    for pid, pose in lib["poses"].items():
        poses[pid] = {
            "label": pose.get("label", pid),
            "description": pose.get("description", ""),
            "tags": pose.get("tags", []),
            "source": "procedural",
            **({"character_rotation_hint": pose["character_rotation_hint"]} if "character_rotation_hint" in pose else {}),
        }
    for aid, act in actions.get("actions", {}).items():
        poses[aid] = {
            "label": act.get("label", aid),
            "description": act.get("description", ""),
            "tags": act.get("tags", []) + ["mixamo"],
            "source": "action",
            "pose_action": act["action"],
            "pose_frames": act.get("frames", [1]),
        }
    manifest = {
        "version": 1,
        "camera_forward_axis": "+Y",
        "scene_guidance": "Pick the scene whose world matches the brief (pagoda_mountain for epic/mythic scale, ancient_hall for ritual/dialogue in a temple courtyard, mist_forest for eerie intimacy, warehouse for modern/neutral). You may change scene_id between segments when the story moves location, but hold each scene for at least two consecutive segments.",
        "output_resolution": [1080, 1920],
        "shot_spec_schema": {
            "scene_id": "one of scenes[]",
            "camera": "one of scenes[scene_id].cameras",
            "pose_id": "one of poses[] (procedural) — or use pose_action + pose_frame for action poses",
            "character_anchor": "one of scenes[scene_id].anchors",
            "character_rotation": "degrees, optional; extra turn on top of the anchor facing",
            "character_offset": "[x, y] metres, optional",
        },
        "scenes": SCENES,
        "poses": poses,
    }
    out = os.path.join(ASSETS, "manifest.json")
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, ensure_ascii=False, indent=2)
    print(f"manifest: {out} scenes={len(SCENES)} poses={len(poses)}")


if __name__ == "__main__":
    main()
