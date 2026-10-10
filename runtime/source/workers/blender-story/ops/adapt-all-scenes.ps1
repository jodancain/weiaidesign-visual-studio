$b = "C:\Program Files\Blender Foundation\Blender 5.2\blender.exe"
$log = "D:\story-assets\inspect\adapt.log"
"start $(Get-Date -Format s)" | Out-File $log -Encoding utf8
$map = @{ "pagoda_mountain"="temple"; "ancient_hall"="lone-monk"; "mist_forest"="forest" }
foreach ($id in $map.Keys) {
  "=== $id" | Out-File $log -Append -Encoding utf8
  & $b --background "D:\story-assets\downloads\$($map[$id]).blend" --python D:\story-worker\adapt_scene.py -- --config "D:\story-worker\scene_configs\$id.json" --character D:\story-assets\scenes\warehouse.blend --out "D:\story-assets\scenes\$id.blend" 2>&1 | Select-String -Pattern 'SCENE_ADAPTED|origin ground|appended|deleted|WARN|Error|Traceback|SystemExit|no ground' | Out-File $log -Append -Encoding utf8 -Width 4000
}
"end $(Get-Date -Format s)" | Out-File $log -Append -Encoding utf8
