$ErrorActionPreference = "Continue"
$dst = "D:\story-assets\downloads"
New-Item -ItemType Directory -Force -Path $dst | Out-Null
$log = "$dst\download.log"
"start $(Get-Date -Format s)" | Out-File $log -Encoding utf8
$files = @(
  @{u="https://mirror.blender.org/demo/eevee/temple/temple.blend"; n="temple.blend"},
  @{u="https://mirror.blender.org/demo/eevee/ember_forest/forest.blend"; n="forest.blend"},
  @{u="https://mirror.blender.org/demo/eevee/wanderer/wanderer_v2.blend"; n="wanderer_v2.blend"},
  @{u="https://mirror.blender.org/demo/cycles/lone-monk_cycles_and_exposure-node_demo.blend"; n="lone-monk.blend"}
)
foreach ($f in $files) {
  $out = Join-Path $dst $f.n
  if (Test-Path $out) { "skip $($f.n) exists" | Out-File $log -Append; continue }
  try {
    curl.exe -sL --retry 3 -o $out $f.u
    "done $($f.n) $((Get-Item $out).Length)" | Out-File $log -Append -Encoding utf8
  } catch { "fail $($f.n) $_" | Out-File $log -Append -Encoding utf8 }
}
"end $(Get-Date -Format s)" | Out-File $log -Append -Encoding utf8
