#!/usr/bin/env python3
"""Wrap the verified Windows npm artifact with the isolated integration-test installer."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import zipfile

parser = argparse.ArgumentParser()
parser.add_argument('--archive', required=True, type=Path)
parser.add_argument('--out', required=True, type=Path)
args = parser.parse_args()
bridge = Path(__file__).resolve().parents[1]
version = json.loads((bridge / 'package.json').read_text())['version']
bundle = args.out / f'conest-{version}-windows-x64'
bundle.mkdir(parents=True, exist_ok=False)
packages = bundle / 'packages/win32-x64'
packages.mkdir(parents=True)
for file in [args.archive, Path(str(args.archive) + '.sha256')]:
    shutil.copy2(file, packages / file.name)
for name in ['install.ps1', 'start.ps1', 'setup.mjs', 'launch.mjs', 'configure-key.ps1', 'verify-windows.ps1']:
    shutil.copy2(bridge / 'scripts/platform' / name, bundle / name)
(bundle / 'README.md').write_text(f'''# CoNest {version} — Windows integration fixture

This bundle supports developer installation and regression checks on Windows x64.
The installer downloads Node.js 24.16.0 and the reproducible OpenClaw 2026.9.2 build pin.

Run in PowerShell from this directory:

```powershell
./install.ps1 -InstallRoot C:\\conest-dev
./verify-windows.ps1 -InstallRoot C:\\conest-dev
C:\\conest-dev/start.ps1 -Components
C:\\conest-dev/start.ps1 -Verify -Core
```

The default model is a deterministic local fixture. No API key is needed.
The developer source and build instructions are at https://github.com/zyw02/CoNest.
''', encoding='utf-8')
(bundle / 'delivery.json').write_text(json.dumps({
    'version': version, 'target': 'win32-x64', 'node': '24.16.0',
    'openclaw': '2026.9.2', 'defaultModel': 'deterministic-fixture',
    'validation': 'See the release validation report and Windows workflow; packaging is not execution evidence.',
}, indent=2) + '\n')
archive = Path(str(bundle) + '.zip')
with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as output:
    for file in sorted(bundle.rglob('*')):
        if file.is_file():
            output.write(file, file.relative_to(args.out))
digest = hashlib.sha256(archive.read_bytes()).hexdigest()
Path(str(archive) + '.sha256').write_text(f'{digest}  {archive.name}\n')
print(archive.resolve())
