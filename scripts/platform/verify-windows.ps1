param([string]$InstallRoot = (Join-Path $HOME 'conest-demo-0.6.4'))
$ErrorActionPreference = 'Stop'
$Config = Get-Content -LiteralPath (Join-Path $InstallRoot 'conest-launch.json') -Raw | ConvertFrom-Json
& $Config.node (Join-Path $Config.plugin 'dist/probe-platform.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Windows DSH component probe failed.' }
& $Config.node (Join-Path $InstallRoot 'launch.mjs') --verify
if ($LASTEXITCODE -ne 0) { throw 'Windows OpenClaw integration acceptance failed.' }
Write-Host 'Windows native component and Gateway acceptance passed.'
