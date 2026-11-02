# Installs per-user logon auto-start for the recognizer and the quick tunnel (idempotent).
# Primary: Task Scheduler (AtLogOn, Limited). Fallback: Startup-folder launcher.
param([switch]$NoStart)
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$vbs = Join-Path $here 'run-hidden.vbs'

# Find a real git-bash (not WSL's System32\bash.exe / WindowsApps stub).
$bash = $env:FLASHYDEX_BASH
if (-not $bash) {
  $cands = @('C:\Program Files\Git\bin\bash.exe','C:\Program Files (x86)\Git\bin\bash.exe')
  $cands += (Get-Command bash.exe -All -ErrorAction SilentlyContinue | ForEach-Object { $_.Source })
  $bash = $cands | Where-Object { $_ -and (Test-Path $_) -and ($_ -notmatch 'System32|WindowsApps') } | Select-Object -First 1
}
if (-not $bash) { throw 'git-bash not found; set FLASHYDEX_BASH' }
Write-Host "bash: $bash"

$names = @{ 'FlashyDex-Recognizer' = 'recognizer'; 'FlashyDex-Tunnel' = 'tunnel' }
$startup = [Environment]::GetFolderPath('Startup')
$user = "$env:USERDOMAIN\$env:USERNAME"
$mode = 'task'
try {
  foreach ($t in $names.GetEnumerator()) {
    $action  = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "//B //Nologo `"$vbs`" $($t.Value) `"$bash`""
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $t.Key -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
    Write-Host "registered task $($t.Key)"
  }
} catch {
  Write-Host "Task Scheduler denied ($($_.Exception.Message)); using Startup folder"
  $mode = 'startup'
  foreach ($t in $names.GetEnumerator()) {
    $f = Join-Path $startup "$($t.Key).vbs"
    $body = "CreateObject(`"WScript.Shell`").Run `"wscript.exe //B //Nologo `"`"$vbs`"`" $($t.Value) `"`"$bash`"`"`", 0, False"
    Set-Content -Path $f -Value $body -Encoding ASCII
    Write-Host "wrote $f"
  }
}
Write-Host "mode: $mode"
if (-not $NoStart) {
  foreach ($t in $names.GetEnumerator()) {
    if ($mode -eq 'task') { Start-ScheduledTask -TaskName $t.Key }
    else { Start-Process wscript.exe -ArgumentList "//B //Nologo `"$vbs`" $($t.Value) `"$bash`"" }
  }
}
