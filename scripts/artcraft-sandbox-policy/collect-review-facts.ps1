# Read-only Docker queries. No connection setup, Env inspection, policy load,
# container mutation, credential access, or daemon/global configuration read.
param(
  [Parameter(Mandatory = $true)][ValidatePattern('^[a-zA-Z0-9_.-]+$')][string]$Container,
  [Parameter(Mandatory = $true)][string]$OutFile
)
$ErrorActionPreference = 'Stop'
if (Test-Path -LiteralPath $OutFile) { throw 'Refusing to overwrite prior evidence' }

function Read-DockerFields([string[]]$DockerArguments, [System.Collections.IDictionary]$Fields, [switch]$WithMounts) {
  # No literal double quotes in native arguments: Windows PowerShell 5.1 can
  # strip embedded JSON-template quotes while constructing Docker's argv.
  $template = ($Fields.Values | ForEach-Object { '{{json ' + $_ + '}}{{println}}' }) -join ''
  # Docker omits Name on bind mounts. Raw Go string keys survive Windows 5.1
  # argument handling; index emits JSON null only for this optional member.
  if ($WithMounts) { $template += '{{range .Mounts}}{{json .Type}}{{println}}{{json .Destination}}{{println}}{{json .RW}}{{println}}{{json .Source}}{{println}}{{json (index . `Name`)}}{{println}}{{end}}' }
  $lines = @(& docker @DockerArguments --format $template)
  if ($LASTEXITCODE -ne 0) { throw 'Read-only Docker query failed' }
  # Docker may append one empty line after the template's final println.
  $lines = @($lines | Where-Object { $_ -ne '' })
  if ($lines.Count -lt $Fields.Count) { throw 'Incomplete Docker field output' }
  $result = [ordered]@{}
  $index = 0
  foreach ($key in $Fields.Keys) {
    $value = ConvertFrom-Json -InputObject $lines[$index]
    # Windows PowerShell 5.1 can attach value/Count ETS wrappers to parsed
    # arrays. Enumerate these array fields so empty and populated arrays retain
    # their actual JSON values; nonempty Devices/Binds still reach the validator.
    if ($key -in @('SecurityOptions', 'CapAdd', 'CapDrop', 'SecurityOpt', 'Devices', 'Binds')) {
      if ($null -eq $value) { $value = @() } else { $value = @($value) }
    }
    $result[$key] = $value
    $index++
  }
  if ($WithMounts) {
    if (($lines.Count - $index) % 5 -ne 0) { throw 'Incomplete mount metadata' }
    $mounts = @()
    while ($index -lt $lines.Count) {
      $mounts += [ordered]@{
        Type = ConvertFrom-Json -InputObject $lines[$index]
        Destination = ConvertFrom-Json -InputObject $lines[$index + 1]
        RW = ConvertFrom-Json -InputObject $lines[$index + 2]
        Source = ConvertFrom-Json -InputObject $lines[$index + 3]
        Name = ConvertFrom-Json -InputObject $lines[$index + 4]
      }
      $index += 5
    }
    $result['Mounts'] = @($mounts)
  } elseif ($lines.Count -ne $Fields.Count) { throw 'Unexpected Docker field output' }
  return $result
}

$versionFields = [ordered]@{ Version = '.Server.Version'; GitCommit = '.Server.GitCommit'; Os = '.Server.Os'; Arch = '.Server.Arch' }
$infoFields = [ordered]@{ KernelVersion = '.KernelVersion'; SecurityOptions = '.SecurityOptions'; OperatingSystem = '.OperatingSystem' }
$containerFields = [ordered]@{
  Id = '.Id'; Image = '.Image'; Hostname = '.Config.Hostname'; User = '.Config.User'
  Privileged = '.HostConfig.Privileged'; CapAdd = '.HostConfig.CapAdd'; CapDrop = '.HostConfig.CapDrop'
  NetworkMode = '.HostConfig.NetworkMode'; PidMode = '.HostConfig.PidMode'; IpcMode = '.HostConfig.IpcMode'; UsernsMode = '.HostConfig.UsernsMode'
  SecurityOpt = '.HostConfig.SecurityOpt'; PortBindings = '.HostConfig.PortBindings'; ReadonlyRootfs = '.HostConfig.ReadonlyRootfs'; Tmpfs = '(index .HostConfig `Tmpfs`)'
  Memory = '.HostConfig.Memory'; NanoCpus = '.HostConfig.NanoCpus'; PidsLimit = '.HostConfig.PidsLimit'
  Sysctls = '(index .HostConfig `Sysctls`)'; Devices = '.HostConfig.Devices'; Binds = '.HostConfig.Binds'
  Running = '.State.Running'; ExitCode = '.State.ExitCode'
}
$facts = [ordered]@{
  recordedAt = [DateTime]::UtcNow.ToString('o')
  version = Read-DockerFields -DockerArguments @('version') -Fields $versionFields
  info = Read-DockerFields -DockerArguments @('info') -Fields $infoFields
  container = Read-DockerFields -DockerArguments @('inspect', '--type', 'container', $Container) -Fields $containerFields -WithMounts
}
# SecurityOpt contains JSON as a STRING. Do not parse/reserialize the embedded
# profile with PowerShell/JavaScript floating point: its uint64 mask is exact.
$json = $facts | ConvertTo-Json -Depth 12
$encoding = New-Object System.Text.UTF8Encoding($false)
$bytes = $encoding.GetBytes($json + "`n")
$stream = [System.IO.File]::Open($OutFile, [System.IO.FileMode]::CreateNew)
try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
Write-Output 'Allowlisted runtime facts saved; no policy applied.'
