<#
  Stops the local demo started by start-demo.ps1: whatever listens on the collector (4318),
  the demo shop (3000) and its internal services (4101, 4102), plus the traffic generator.
    powershell -ExecutionPolicy Bypass -File scripts\demo\stop-demo.ps1
#>
$stopped = 0
foreach ($port in 4318, 3000, 4101, 4102) {
  $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  foreach ($c in $conns) {
    try { Stop-Process -Id $c.OwningProcess -Force -ErrorAction Stop; $stopped++ } catch { }
  }
}
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*src\traffic.js*' } |
  ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop; $stopped++ } catch { } }
Write-Host "Stopped $stopped process(es). Your data stays in apps\collector\data (npm run reset deletes it)."
