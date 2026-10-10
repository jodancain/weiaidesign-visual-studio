$b = "C:\Program Files\Blender Foundation\Blender 5.2\blender.exe"
$log = "D:\story-assets\inspect\inspect.log"
New-Item -ItemType Directory -Force -Path D:\story-assets\inspect | Out-Null
"start $(Get-Date -Format s)" | Out-File $log -Encoding utf8
foreach ($n in @("temple","forest","wanderer_v2","lone-monk")) {
  "=== $n" | Out-File $log -Append -Encoding utf8
  & $b --background "D:\story-assets\downloads\$n.blend" --python D:\story-worker\inspect_scene.py -- --out "D:\story-assets\inspect\$n" --preview --size 25 2>&1 | Select-String -Pattern '"event"|Error|error|Traceback' | Out-File $log -Append -Encoding utf8
}
"end $(Get-Date -Format s)" | Out-File $log -Append -Encoding utf8
