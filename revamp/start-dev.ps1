# Starts the PCGen engine (sidecar) and the UI dev server, then opens the browser.
#
#   .\revamp\start-dev.ps1 -Character some.pcg   # any character; it also decides which rules/sources are loaded
#   .\revamp\start-dev.ps1                       # uses revamp\local\clarent.pcg if you have one
#   .\revamp\start-dev.ps1 -ExtraSources "Dragon Empires Gazetteer"   # also load that book (its gods, classes...)
#
# Your .pcg is copied to .run\ first and the app works on the copy, so nothing is saved to your original
# unless you copy the file back yourself. Stop everything with .\stop-dev.ps1.
param(
    [string]$Character = (Join-Path $PSScriptRoot 'local\clarent.pcg'),
    [int]$Port = 8765,
    [string]$ExtraSources = '',   # more source books to load, comma separated, e.g. "Dragon Empires Gazetteer"
    [switch]$NoBrowser
)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot                  # <repo>\revamp
$repo = Split-Path $root               # <repo>: the PCGen checkout
$run = Join-Path $root '.run'
$jdk = 'C:\Program Files\Eclipse Adoptium\jdk-25.0.4.101-hotspot'
New-Item -ItemType Directory -Force $run | Out-Null

if (-not (Test-Path $Character)) { throw "Character file not found: $Character" }
if (-not (Test-Path (Join-Path $repo 'build\libs'))) { throw "The engine is not built. From the repository root run: .\gradlew qbuild -x test (with JAVA_HOME set to $jdk)" }
if (-not (Test-Path (Join-Path $root 'sidecar\build'))) { & (Join-Path $root 'sidecar\build.ps1') }
if (-not (Test-Path (Join-Path $root 'ui\node_modules'))) { Push-Location (Join-Path $root 'ui'); npm install; Pop-Location }

& (Join-Path $root 'stop-dev.ps1') -Quiet

$copy = Join-Path $run (Split-Path $Character -Leaf)
Copy-Item $Character $copy -Force
Write-Host "Working on a copy: $copy"

# Engine. Loading the rules takes 5-15 seconds depending on how many source books the character uses.
Push-Location $repo
$engineArgs = @('-cp', 'revamp/sidecar/build;build/libs/*', 'pcgen.sidecar.Sidecar', '--settings-dir', 'revamp/.run/settings',
                '--from-character', "revamp/.run/$(Split-Path $Character -Leaf)", '--port', $Port)
if ($ExtraSources) { $engineArgs += @('--extra-sources', "`"$ExtraSources`"") }
$engine = Start-Process "$jdk\bin\java.exe" -PassThru -NoNewWindow `
    -ArgumentList $engineArgs `
    -RedirectStandardOutput (Join-Path $run 'sidecar.out') -RedirectStandardError (Join-Path $run 'sidecar.err')
Pop-Location
$engine.Id | Out-File (Join-Path $run 'sidecar.pid')

Write-Host -NoNewline 'Starting the engine'
$ready = $false
for ($i = 0; $i -lt 90; $i++) {
    Start-Sleep 1
    Write-Host -NoNewline '.'
    if ((Test-Path (Join-Path $run 'sidecar.out')) -and ((Get-Content (Join-Path $run 'sidecar.out')) -match 'READY')) { $ready = $true; break }
    if ($engine.HasExited) { break }
}
Write-Host ''
if (-not $ready) { throw "The engine did not start. See $run\sidecar.err" }

# Open the character in the engine so the UI has something to show.
$body = @{ path = ($copy -replace '\\', '/') } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$Port/characters" -Body $body -ContentType 'application/json' | Out-Null

# UI
$env:SIDECAR_URL = "http://127.0.0.1:$Port"
$ui = Start-Process cmd.exe -WindowStyle Hidden -PassThru -WorkingDirectory (Join-Path $root 'ui') `
    -ArgumentList '/c', 'npx vite --host 127.0.0.1' `
    -RedirectStandardOutput (Join-Path $run 'vite.out') -RedirectStandardError (Join-Path $run 'vite.err')
$ui.Id | Out-File (Join-Path $run 'vite.pid')
Start-Sleep 3

$url = 'http://127.0.0.1:5173/'
Write-Host "Ready: $url"
if (-not $NoBrowser) { Start-Process $url }
