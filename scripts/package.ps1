$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
$extensionDir = Join-Path $projectDir 'extension'
$manifest = Get-Content -LiteralPath (Join-Path $extensionDir 'manifest.json') -Raw | ConvertFrom-Json
$distDir = Join-Path $projectDir 'dist'
New-Item -ItemType Directory -Force -Path $distDir | Out-Null
$zipPath = Join-Path $distDir ('xdeporter-v' + $manifest.version + '.zip')
Compress-Archive -Path (Join-Path $extensionDir '*') -DestinationPath $zipPath -Force
$checksum = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
$checksum + '  ' + (Split-Path -Leaf $zipPath) | Set-Content -LiteralPath (Join-Path $distDir 'SHA256SUMS.txt') -Encoding ascii
Write-Output $zipPath
