import bpy, json, sys
from mathutils import Vector
argv = sys.argv[sys.argv.index("--")+1:]
names = argv[0].split(",")
out = {}
for o in bpy.context.scene.objects:
    if any(o.name.startswith(n) for n in names):
        bb = [o.matrix_world @ Vector(c) for c in o.bound_box] if o.type == "MESH" else [o.matrix_world.translation]
        out[o.name] = {"type": o.type, "loc": [round(v,2) for v in o.matrix_world.translation],
                       "bb_min": [round(min(p[i] for p in bb),2) for i in range(3)], "bb_max": [round(max(p[i] for p in bb),2) for i in range(3)],
                       "coll": [c.name for c in o.users_collection]}
# ground probe: raycast down at grid points
scene = bpy.context.scene; dg = bpy.context.evaluated_depsgraph_get()
pts = json.loads(argv[1]) if len(argv) > 1 else []
hits = []
for (x,y) in pts:
    ok, loc, nrm, idx, obj, mat = scene.ray_cast(dg, Vector((x,y,500)), Vector((0,0,-1)))
    hits.append({"xy":[x,y],"hit":ok,"z":round(loc.z,2) if ok else None,"obj":obj.name if ok else None})
print("POSITIONS", json.dumps({"objects":out,"ground":hits}))
