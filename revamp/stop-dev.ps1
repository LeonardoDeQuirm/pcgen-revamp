# Stops the engine and UI dev server started by start-dev.ps1, and nothing else.
param([switch]$Quiet)
$run = Join-Path $PSScriptRoot '.run'
$ui = Join-Path $PSScriptRoot 'ui'
$stopped = @()

function Stop-Tree([int]$id, [string]$label) {
    # /T also takes down child processes (npx -> node).
    taskkill /PID $id /T /F 2>$null | Out-Null
    $script:stopped += "$label $id"
}

# 1. The processes recorded by start-dev.ps1 - but only if the pid still belongs to one of ours, because
#    Windows reuses pids and a stale file must never take down an unrelated program.
foreach ($entry in @(@('sidecar', '*pcgen.sidecar.Sidecar*'), @('vite', '*vite*'))) {
    $pidFile = Join-Path $run "$($entry[0]).pid"
    if (Test-Path $pidFile) {
        $id = [int](Get-Content $pidFile)
        $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue
        if ($proc -and $proc.CommandLine -like $entry[1]) { Stop-Tree $id $entry[0] }
        Remove-Item $pidFile -ErrorAction SilentlyContinue
    }
}

# 2. Leftovers that are recognisably ours: an engine started with this folder's classpath, and a Vite
#    serving this folder's ui. Not "whatever is on port 5173".
Get-CimInstance Win32_Process -Filter "Name='java.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*pcgen.sidecar.Sidecar*' -and $_.CommandLine -like '*revamp/sidecar/build*' } |
    ForEach-Object { Stop-Tree $_.ProcessId 'engine' }
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*$ui*" -and $_.CommandLine -like '*vite*' } |
    ForEach-Object { Stop-Tree $_.ProcessId 'ui' }

if (-not $Quiet) { if ($stopped) { "Stopped: $($stopped -join ', ')" } else { 'Nothing was running.' } }
