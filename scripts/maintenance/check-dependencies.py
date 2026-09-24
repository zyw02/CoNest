#!/usr/bin/env python3
"""Report required downloaded SDK package manifests without modifying them."""
import json
from pathlib import Path
root = Path(__file__).resolve().parents[2]
pkg = json.loads((root / 'package.json').read_text())
missing = []
for group in ('dependencies', 'devDependencies', 'optionalDependencies'):
    for name, spec in pkg.get(group, {}).items():
        if spec.startswith('file:') and not (root / spec[5:] / 'package.json').is_file():
            missing.append((name, spec[5:]))
if missing:
    print('Missing frozen dependencies:')
    for name, target in missing:
        print(f'  {name}: {target}')
    raise SystemExit(1)
print('All declared SDK dependency manifests exist. Bootstrap verifies their content; build verifies the compiled interfaces.')
