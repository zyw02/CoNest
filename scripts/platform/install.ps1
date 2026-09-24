param([string]$InstallRoot = (Join-Path $HOME 'conest-demo-0.6.4'))
$ErrorActionPreference = 'Stop'
if (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { throw 'This package requires Windows x64.' }
$DownloadDir = Join-Path $InstallRoot 'node-downloads'
$NodeDir = Join-Path $InstallRoot 'node'
New-Item -ItemType Directory -Force -Path $DownloadDir,$NodeDir | Out-Null
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$Archive = Join-Path $DownloadDir 'node-v24.16.0-win-x64.zip'
Invoke-WebRequest -UseBasicParsing 'https://nodejs.org/dist/v24.16.0/node-v24.16.0-win-x64.zip' -OutFile $Archive
$Checks = (Invoke-WebRequest -UseBasicParsing 'https://nodejs.org/dist/v24.16.0/SHASUMS256.txt').Content
$Match = [regex]::Match($Checks,'(?m)^([a-f0-9]{64})\s+node-v24\.16\.0-win-x64\.zip\s*$')
if (-not $Match.Success -or (Get-FileHash -Algorithm SHA256 $Archive).Hash.ToLowerInvariant() -ne $Match.Groups[1].Value) { throw 'Node archive checksum mismatch.' }
Expand-Archive -LiteralPath $Archive -DestinationPath $NodeDir -Force
$Node = Join-Path $NodeDir 'node-v24.16.0-win-x64/node.exe'
& $Node (Join-Path $PSScriptRoot 'setup.mjs') $InstallRoot
if ($LASTEXITCODE -ne 0) { throw 'OpenClaw / CoNest installation failed; inspect the error above.' }
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'start.ps1') -Destination $InstallRoot
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'configure-key.ps1') -Destination $InstallRoot
Write-Host "Installed. Self-check: powershell -ExecutionPolicy Bypass -File `"$InstallRoot/start.ps1`" -Verify"
