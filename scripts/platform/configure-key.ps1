$ErrorActionPreference = 'Stop'
$Config = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'conest-launch.json') -Raw | ConvertFrom-Json
$Dir = Split-Path $Config.credentials
& $Config.node (Join-Path $PSScriptRoot 'launch.mjs') --protect-credentials
if ($LASTEXITCODE -ne 0) { throw 'Cannot create a private credentials directory.' }
$Secret = Read-Host 'DeepSeek API Key' -AsSecureString
$Pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secret)
try {
  $Value = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($Pointer)
  if ($Value -notmatch '^\S{8,2048}$') { throw 'Invalid API Key format.' }
  [IO.File]::WriteAllText($Config.credentials,"DEEPSEEK_API_KEY=$Value`n",[Text.UTF8Encoding]::new($false))
} finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($Pointer); $Value=$null; $Secret=$null }
Write-Host 'Model credentials saved. OpenClaw Loop and DSH Loop share this key.'
