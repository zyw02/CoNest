#!/usr/bin/env python3
"""Dependency-free checks for source imports and future GitHub commits."""
import json
import posixpath
import re
import subprocess
from pathlib import Path
from urllib.parse import unquote, urlsplit
root = Path(__file__).resolve().parents[2]
files = subprocess.check_output(['git', 'ls-files', '-z'], cwd=root).decode().split('\0')
files = [name for name in files if name]
errors = []
blocked = {'.local', '.worktrees', 'node_modules', '.vendor', '.runtime', '.tooling', '.platform-testing', 'private', 'backups', 'source', 'dist', 'lib', '__pycache__', '.dsh'}
public_markdown = {
    '.github/pull_request_template.md',
    'CONTRIBUTING.md',
    'AGENTS.md',
    'SECURITY.md',
    'THIRD_PARTY_NOTICES.md',
    'README-zh.md',
    'README.md',
    'docs/README.md',
    'extensions/dsh-ui/README.md',
    'docs/components.md',
    'docs/host-integration.md',
    'docs/installation.md',
    'test/experiments/dsh-compat/README.md',
    'test/experiments/loader/README.md',
    'docs/assets/brand/README.md',
    'docs/assets/readme/README.md',
    'docs/dependencies.md',
}
secret_patterns = [
    rb'gh[pousr]_[A-Za-z0-9]{30,}',
    rb'github_pat_[A-Za-z0-9_]{40,}',
    rb'sk-[A-Za-z0-9_-]{24,}',
    rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',
]
for name in files:
    path = Path(name)
    if not name.isascii():
        errors.append(f'File names must use English/ASCII characters: {name}')
    if blocked.intersection(path.parts) or name.startswith(('releases/', 'reports/', '.local/')) or path.name.startswith('.env') and path.name != '.env.example' or path.suffix in {'.log', '.jsonl', '.pem', '.key', '.tgz', '.zip', '.bundle'}:
        errors.append(f'Excluded state, dependency or artifact path: {name}')
    if path.as_posix().endswith('.tar.gz'):
        errors.append(f'Archive must be distributed separately: {name}')
    if name.startswith('delivery/') or 'customer-delivery' in path.parts:
        errors.append(f'Customer handoff material must stay outside Git: {name}')
    if name.startswith('docs/') and (path.suffix in {'.html', '.pdf'} or
            any(marker in path.name.lower() for marker in ('installation-demo', 'speaker-notes', 'customer', 'start-here')) or
            re.match(r'windows-\d', path.name)):
        errors.append(f'Customer or rendered document must stay outside Git: {name}')
    if path.suffix.lower() == '.md' and name not in public_markdown:
        errors.append(f'Unregistered public document; consolidate into an existing guide: {name}')
    if path.suffix.lower() == '.md' and '-zh' in path.stem and name != 'README-zh.md':
        errors.append(f'Only the startup README has a Chinese counterpart: {name}')
    if name.startswith(('docs/archive/', 'docs/research/', 'docs/scripts/')) or any(
            marker in path.name.lower() for marker in ('.prompt.', '.review.', 'speaker-notes')):
        errors.append(f'Internal planning/research material must stay outside Git: {name}')
    if path.suffix.lower() in {'.pdf', '.ppt', '.pptx', '.doc', '.docx'}:
        errors.append(f'Office and presentation documents must stay outside Git: {name}')
    if path.suffix.lower() == '.html' and name != 'src/studio/studio.html':
        errors.append(f'Rendered documents must stay outside Git: {name}')
    if name.startswith('docs/') and path.suffix.lower() in {'.png', '.jpg', '.jpeg', '.svg', '.webp'}:
        public_asset = (
            name.startswith('docs/assets/conest-banner') and path.suffix == '.svg' or
            name.startswith('docs/assets/readme/') and path.suffix == '.svg' or
            name.startswith('docs/assets/brand/') and path.stem in {
                'conest-logo', 'conest-logo-dark', 'conest-logo-mono',
                'conest-avatar', 'conest-social-preview'})
        if not public_asset:
            errors.append(f'Unregistered public image; internal planning art stays local: {name}')
    if name.startswith(('bridge/', 'maintenance/')):
        errors.append(f'Legacy source layout is not allowed: {name}')
    target = root / path
    if target.is_symlink():
        errors.append(f'Unexpected tracked symlink: {name}')
        continue
    data = target.read_bytes()
    if len(data) > 5_000_000:
        errors.append(f'File exceeds source repository size limit: {name}')
    if any(re.search(pattern, data) for pattern in secret_patterns):
        errors.append(f'Possible credential material; inspect locally: {name}')
    if name.startswith('src/') and not name.startswith('src/adapters/') and path.suffix.lower() in {'.ts', '.js', '.mts', '.mjs'}:
        if re.search(rb'''\bfrom\s+["'](?:openclaw/|@deepseek-ai/)|\bimport\s*\(["'](?:openclaw/|@deepseek-ai/)''', data):
            errors.append(f'Third-party Agent SDK import bypasses src/adapters/: {name}')
    if path.suffix.lower() == '.md':
        text = re.sub(r'<!--.*?-->', '', data.decode(), flags=re.S)
        links = re.findall(r'\]\(([^)\s]+)\)', text)
        links += re.findall(r'(?:href|src|srcset)="([^"\s]+)"', text)
        for link in links:
            url = urlsplit(link)
            if url.scheme or url.netloc or not url.path or url.path.startswith('/'):
                continue
            destination = posixpath.normpath(posixpath.join(path.parent.as_posix(), unquote(url.path)))
            if destination not in files and not any(f.startswith(destination.rstrip('/') + '/') for f in files):
                errors.append(f'Broken tracked documentation link in {name}: {link}')
pkg = json.loads((root / 'package.json').read_text())
manifest = json.loads((root / 'openclaw.plugin.json').read_text())
compatibility = json.loads((root / 'compatibility.json').read_text())
node_version = (root / '.node-version').read_text().strip()
if pkg.get('license') != 'MIT' or not (root / 'LICENSE').read_text().startswith('MIT License'):
    errors.append('Project SPDX metadata and the approved license must agree')
if pkg['version'] != manifest['version']:
    errors.append('Package and plugin manifest versions disagree')
if manifest['id'] != 'dsh-bridge':
    errors.append('The existing plugin identity must be retained')
openclaw_range = compatibility.get('adapters', {}).get('openclaw', {}).get('supported')
if openclaw_range != pkg.get('peerDependencies', {}).get('openclaw') or openclaw_range != pkg.get('openclaw', {}).get('compat', {}).get('pluginApi'):
    errors.append('OpenClaw public compatibility metadata must agree')
if compatibility.get('contracts', {}).get('runtimeProtocol') != 4:
    errors.append('Published runtime protocol does not match the implemented protocol')
dsh = compatibility.get('adapters', {}).get('dsh', {})
dsh_qualifications = dsh.get('qualifications', [])
if [entry.get('version') for entry in dsh_qualifications] != dsh.get('tested'):
    errors.append('Every tested DSH version must have one ordered qualification source')
sdk_lock = json.loads((root / 'scripts/maintenance/sdk.lock.json').read_text())
frozen_dsh = [entry for entry in dsh_qualifications if entry.get('source') == 'frozen-sdk']
if len(frozen_dsh) != 1 or frozen_dsh[0].get('version') != sdk_lock.get('upstreamVersion') or frozen_dsh[0].get('sha256') != sdk_lock.get('sha256'):
    errors.append('Frozen DSH qualification must match the verified SDK lock')
if any(entry.get('source') == 'upstream-release' and not re.fullmatch(r'[0-9a-f]{40}', entry.get('revision', '')) for entry in dsh_qualifications):
    errors.append('Public DSH qualifications must pin a full upstream commit SHA')
for workflow in ('.github/workflows/compatibility.yml', '.github/workflows/review.yml'):
    workflow_text = (root / workflow).read_text()
    if 'node scripts/maintenance/bootstrap.mjs' not in workflow_text or 'run: pnpm bootstrap' in workflow_text:
        errors.append(f'Clean-checkout workflow must bootstrap the SDK before pnpm resolves local dependencies: {workflow}')
windows_installer = (root / 'scripts/platform/install.ps1').read_text()
if f'node-v{node_version}-win-x64.zip' not in windows_installer or f'node-v{node_version.replace(".", r"\.")}-win-x64' not in windows_installer:
    errors.append('Windows installer download and checksum match must use .node-version')
required = ['LICENSE', 'AGENTS.md', 'SECURITY.md', 'THIRD_PARTY_NOTICES.md', 'compatibility.json', 'src/index.ts', 'src/runtime.ts', 'src/adapters/openclaw-sdk.ts', 'src/adapters/dsh-cordis.ts', 'scripts/build.mjs', 'scripts/review.mjs', 'scripts/maintenance/select-dsh-version.mjs', 'test/select-dsh-version.test.mjs', 'pnpm-lock.yaml', 'README.md', 'README-zh.md', 'CONTRIBUTING.md']
for name in required:
    if name not in files:
        errors.append(f'Missing tracked project file: {name}')
if errors:
    print('\n'.join(errors))
    raise SystemExit(1)
for group in ('dependencies', 'devDependencies'):
    for name, spec in pkg.get(group, {}).items():
        if spec.startswith('link:') or 'source/workspace' in spec or '.runtime' in spec:
            raise SystemExit(f'Non-portable dependency: {name}')
print(f'Repository checks passed: {len(files)} files, CoNest {pkg["version"]}; full runtime tests are separate.')
