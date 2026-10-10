$b = "C:\Program Files\Blender Foundation\Blender 5.2\blender.exe"
$log = "D:\story-assets\inspect\preview.log"
"start $(Get-Date -Format s)" | Out-File $log -Encoding utf8
# re-adapt hall with the fixed anchor first
& $b --background "D:\story-assets\downloads\lone-monk.blend" --python D:\story-worker\adapt_scene.py -- --config "D:\story-worker\scene_configs\ancient_hall.json" --character D:\story-assets\scenes\warehouse.blend --out "D:\story-assets\scenes\ancient_hall.blend" 2>&1 | Select-String "SCENE_ADAPTED|WARN" | Out-File $log -Append -Encoding utf8 -Width 4000
New-Item -ItemType Directory -Force -Path D:\story-assets\renders\preview | Out-Null
$poses = @{ "cam_wide"="idle_neutral"; "cam_medium"="arm_up_point"; "cam_close"="look_back_turn"; "cam_low"="reach_forward" }
foreach ($scene in @("pagoda_mountain","ancient_hall","mist_forest")) {
  foreach ($cam in @("cam_wide","cam_medium","cam_close","cam_low")) {
    $anchor = if ($cam -eq "cam_close") { "anchor_center" } else { "anchor_left" }
    $spec = @{ camera=$cam; pose_id=$poses[$cam]; character_anchor=$anchor; character_rotation=0; resolution=@(540,960) } | ConvertTo-Json -Compress
    $specPath = "D:\story-assets\renders\preview\$scene-$cam.json"
    Set-Content -Path $specPath -Value $spec -Encoding ascii
    $t0 = Get-Date
    & $b --background "D:\story-assets\scenes\$scene.blend" --python D:\story-worker\render_shot.py -- --spec $specPath --out "D:\story-assets\renders\preview\$scene-$cam.png" --pose-lib D:\story-worker\assets\poses\library.json 2>&1 | Select-String "RENDER_DONE|Error|Traceback|SystemExit" | Out-File $log -Append -Encoding utf8 -Width 4000
    "$scene $cam $([int]((Get-Date)-$t0).TotalSeconds)s" | Out-File $log -Append -Encoding utf8
  }
}
"end $(Get-Date -Format s)" | Out-File $log -Append -Encoding utf8
