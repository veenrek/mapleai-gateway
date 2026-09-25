$os = Get-CimInstance Win32_OperatingSystem
"{0:N1} GB free / {1:N1} GB total" -f ($os.FreePhysicalMemory/1MB), ($os.TotalVisibleMemorySize/1MB)
$nodes = Get-Process node -ErrorAction SilentlyContinue
"node procs: " + ($nodes | Measure-Object).Count
$nodes | ForEach-Object { "{0,8} {1,8:N0} MB  {2}" -f $_.Id, ($_.WorkingSet64/1MB), $_.MainWindowTitle }
Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 8 Name, Id, @{n='MB';e={[math]::Round($_.WorkingSet64/1MB)}} | Format-Table -AutoSize
