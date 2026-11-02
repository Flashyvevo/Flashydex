# Removes the FlashyDex recognizer/tunnel auto-start and stops the supervisors + children.
$ErrorActionPreference = 'Continue'
foreach ($n in 'FlashyDex-Recognizer','FlashyDex-Tunnel') {
  if (Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $n -Confirm:$false
    Write-Host "removed task $n"
  }
  $f = Join-Path ([Environment]::GetFolderPath('Startup')) "$n.vbs"
  if (Test-Path $f) { Remove-Item $f; Write-Host "removed $f" }
}
# Stop supervisors, then the service and the tunnel they launched.
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'supervise\.ps1' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; Write-Host "stopped supervisor $($_.ProcessId)" }
Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'cloudflared.exe' -and $_.CommandLine -match '127\.0\.0\.1:8900' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; Write-Host "stopped cloudflared $($_.ProcessId)" }
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'flashydex.*(serve|tunnel)\.sh' -or $_.CommandLine -match 'app\.cli serve' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; Write-Host "stopped $($_.Name) $($_.ProcessId)" }
