param([switch]$Verify,[switch]$Connection,[switch]$Core,[switch]$Components,[switch]$Live)
$ErrorActionPreference = 'Stop'
$Node = Join-Path $PSScriptRoot 'node/node-v24.16.0-win-x64/node.exe'
$Launch = Join-Path $PSScriptRoot 'launch.mjs'
$LaunchArgs = @()
if ($Verify) { $LaunchArgs += '--verify' }
if ($Connection) { $LaunchArgs += '--connection' }
if ($Core) { $LaunchArgs += '--core' }
if ($Components) { $LaunchArgs += '--components' }
if ($Live) { $LaunchArgs += '--live' }
& $Node $Launch @LaunchArgs
exit $LASTEXITCODE
