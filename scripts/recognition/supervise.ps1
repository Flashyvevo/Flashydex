param(
  [Parameter(Mandatory)][ValidateSet('recognizer','tunnel')][string]$Name,
  [Parameter(Mandatory)][string]$Bash
)
# Supervisor loop: runs the service script under git-bash, restarts on exit with backoff.
$ErrorActionPreference = 'Continue'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$logs = Join-Path $root 'services\recognition\data\logs'
New-Item -ItemType Directory -Force $logs | Out-Null
$sup = Join-Path $logs 'supervisor.log'

$created = $false
$mutex = New-Object System.Threading.Mutex($true, "Local\FlashyDexSupervisor-$Name", [ref]$created)
if (-not $created) { exit 0 }   # already running

$script = if ($Name -eq 'recognizer') { 'scripts/recognition/serve.sh' } else { 'scripts/recognition/tunnel.sh' }
$serveLog = Join-Path $logs 'serve.log'
$delay = 5
while ($true) {
  $t0 = Get-Date
  "$($t0.ToString('s')) [$Name] starting" | Add-Content $sup
  Push-Location $root
  if ($Name -eq 'recognizer') {
    # serve.sh output -> serve.log (stdout+stderr; contains request metadata only, never image content)
    $p = Start-Process -FilePath $Bash -ArgumentList @('-lc', "exec ./$script >> services/recognition/data/logs/serve.log 2>&1") -WorkingDirectory $root -WindowStyle Hidden -PassThru
  } else {
    $tunnelPs = Join-Path $root 'scripts\recognition\tunnel.ps1'
    $p = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $tunnelPs, '-Root', $root) -WorkingDirectory $root -WindowStyle Hidden -PassThru
  }
  Pop-Location
  $p.WaitForExit()
  $ran = ((Get-Date) - $t0).TotalSeconds
  "$((Get-Date).ToString('s')) [$Name] exited code=$($p.ExitCode) after $([int]$ran)s; restart in ${delay}s" | Add-Content $sup
  Start-Sleep -Seconds $delay
  if ($ran -gt 120) { $delay = 5 } else { $delay = [Math]::Min($delay * 2, 60) }
}
