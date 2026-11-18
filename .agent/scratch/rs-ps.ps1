Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Where-Object { $_.CommandLine -match 'eval-m2|app.cli' } | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }
"cpu load: " + (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'node|chrome|python|playwright|cloudflared' } | Group-Object Name | ForEach-Object { "$($_.Name) x$($_.Count)" }
