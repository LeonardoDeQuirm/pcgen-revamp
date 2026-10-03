# Stops the engine and UI dev server started by start-dev.ps1.
param([switch]$Quiet)
$run = Join-Path $PSScriptRoot '.run'
$stopped = @()

foreach ($name in 'sidecar', 'vite') {
    $pidFile = Join-Path $run "$name.pid"
    if (Test-Path $pidFile) {
        $id = [int](Get-Content $pidFile)
        # taskkill /T also takes down the child processes (npx -> node).
        taskkill /PID $id /T /F 2>$null | Out-Null
        Remove-Item $pidFile -ErrorAction SilentlyContinue
        $stopped += $name
    }
}

# Belt and braces: any engine process still holding our classes, and anything listening on the UI port.
Get-CimInstance Win32_Process -Filter "Name='java.exe'" |
    Where-Object { $_.CommandLine -like '*pcgen.sidecar.Sidecar*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force; $stopped += "java $($_.ProcessId)" }
Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue |
    ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue; $stopped += "ui $($_.OwningProcess)" }

if (-not $Quiet) { if ($stopped) { "Stopped: $($stopped -join ', ')" } else { 'Nothing was running.' } }
