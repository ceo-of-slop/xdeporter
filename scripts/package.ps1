$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
& node (Join-Path $PSScriptRoot 'package.cjs') @args
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
