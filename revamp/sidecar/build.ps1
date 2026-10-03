# Compile the sidecar against the built PCGen jars (run `gradlew qbuild -x test` at the repository root first).
$jdk = 'C:\Program Files\Eclipse Adoptium\jdk-25.0.4.101-hotspot'
$repo = Split-Path (Split-Path $PSScriptRoot)   # sidecar -> revamp -> repository root (the PCGen checkout)
$out = Join-Path $PSScriptRoot 'build'
New-Item -ItemType Directory -Force $out | Out-Null
$src = Get-ChildItem (Join-Path $PSScriptRoot 'src') -Recurse -Filter *.java | % FullName
& "$jdk\bin\javac.exe" -d $out -cp "$repo\build\libs\*" $src
exit $LASTEXITCODE
