param(
  [string]$Cloudflared = 'C:\Program Files (x86)\cloudflared\cloudflared.exe',
  [string]$Root = 'C:\Projects\flashydex'
)
# Quick tunnels are deliberately supervised here rather than accepted as a
# static URL: every restart creates a new hostname that must be republished.
$ErrorActionPreference = 'Continue'
$logs = Join-Path $Root 'services\recognition\data\logs'
New-Item -ItemType Directory -Force $logs | Out-Null
$urlFile = Join-Path $logs 'tunnel-url.txt'
$logFile = Join-Path $logs 'cloudflared.log'
$tunnelLog = Join-Path $logs 'tunnel.log'
$publish = Join-Path $Root 'scripts\recognition\publish-url.sh'
$bash = 'C:\Program Files\Git\bin\bash.exe'
if (-not (Test-Path $bash)) { $bash = 'C:\Program Files (x86)\Git\bin\bash.exe' }
if (-not (Test-Path $bash)) { $bash = Join-Path $env:LOCALAPPDATA 'Programs\Git\bin\bash.exe' }
if (-not (Test-Path $bash)) { $bash = (Get-Command bash.exe -ErrorAction SilentlyContinue).Source }

function Publish-Url([string]$Url) {
  Set-Content -Path $urlFile -Value $Url -NoNewline -Encoding ascii
  & $bash -lc "'$publish' '$Url'" *>> $tunnelLog
  return $LASTEXITCODE -eq 0
}

function Tunnel-Healthy([string]$Url) {
  if (-not $Url) { return $false }
  try {
    $response = Invoke-WebRequest -Uri "$Url/health" -UseBasicParsing -TimeoutSec 15
    return $response.StatusCode -eq 200
  } catch { return $false }
}

while ($true) {
  if (-not (Test-Path $Cloudflared)) {
    "$(Get-Date -Format o) cloudflared not found: $Cloudflared" | Add-Content $tunnelLog
    Start-Sleep -Seconds 60
    continue
  }
  Remove-Item $logFile -Force -ErrorAction SilentlyContinue
  "$(Get-Date -Format o) starting quick tunnel -> http://127.0.0.1:8900" | Add-Content $tunnelLog
  $errFile = Join-Path $logs 'cloudflared.err.log'
  Remove-Item $errFile -Force -ErrorAction SilentlyContinue
  # Launch cloudflared directly (cmd.exe /c with a quoted exe path mangles quotes and never creates the log).
  $process = Start-Process -FilePath $Cloudflared -ArgumentList @('tunnel', '--url', 'http://127.0.0.1:8900', '--no-autoupdate', '--protocol', 'http2') -PassThru -WindowStyle Hidden -RedirectStandardOutput $logFile -RedirectStandardError $errFile
  $url = $null
  for ($i = 0; $i -lt 90 -and -not $process.HasExited; $i++) {
    Start-Sleep -Seconds 1
    $line = Get-Content $logFile, $errFile -ErrorAction SilentlyContinue | Select-String -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -AllMatches | Select-Object -Last 1
    if ($line -and $line.Matches.Count) { $url = $line.Matches[$line.Matches.Count - 1].Value; break }
  }
  if (-not $url) {
    "$(Get-Date -Format o) quick tunnel never provided a URL" | Add-Content $tunnelLog
    if (-not $process.HasExited) { & taskkill.exe /PID $process.Id /T /F | Out-Null }
    Start-Sleep -Seconds 15
    continue
  }
  "$(Get-Date -Format o) tunnel url $url" | Add-Content $tunnelLog
  if (-not (Publish-Url $url)) { "$(Get-Date -Format o) publish failed; continuing health checks" | Add-Content $tunnelLog }

  while (-not $process.HasExited) {
    Start-Sleep -Seconds 60
    if (-not (Tunnel-Healthy $url)) {
      "$(Get-Date -Format o) tunnel health failed; restarting" | Add-Content $tunnelLog
      & taskkill.exe /PID $process.Id /T /F | Out-Null
      break
    }
  }
  Start-Sleep -Seconds 5
}
