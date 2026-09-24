import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

// Build a relocatable artifact from installed, pinned packages; never rewrite source packages.
const execute = promisify(execFile);
const source = fileURLToPath(new URL('..', import.meta.url));
const npmCli = path.join(source, 'node_modules/npm/bin/npm-cli.js');
const packlist = createRequire(npmCli)('npm-packlist');
const packResult = output => { const parsed = JSON.parse(output); return Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0]; };
const args = process.argv.slice(2); const flags = {};
while (args.length) { const key=args.shift(), value=args.shift(); assert.ok(['--out','--target','--native-dir'].includes(key) && value && !flags[key], 'Usage: pack-release.mjs [--out DIR] [--target linux-x64|win32-x64] [--native-dir DIR]'); flags[key]=value; }
const target = flags['--target'] ?? `${process.platform}-${process.arch}`;
assert.ok(['linux-x64','win32-x64'].includes(target), 'Unsupported target');
const [platform, arch] = target.split('-');
const nativeRoot = flags['--native-dir'] ? path.resolve(flags['--native-dir']) : undefined;
const output = flags['--out'] ? path.resolve(flags['--out']) : path.join(source, '.local/releases', target);
const matches = (list, value) => !list || (!list.includes('!'+value) && (list.every(x=>x.startsWith('!')) || list.includes(value)));
const compatible = manifest => matches(manifest.os,platform) && matches(manifest.cpu,arch) && (platform!=='linux' || matches(manifest.libc,'glibc'));
const temporary = await mkdtemp(path.join(os.tmpdir(), 'dsh-bridge-pack-'));
const stage = path.join(temporary, 'package');
const packages = new Map();
const provenance = [];
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
const inside = (parent, file) => { const relative = path.relative(parent, file); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); };

async function resolvePackage(name, parent) {
  if (nativeRoot) { const candidate=path.join(nativeRoot,'node_modules',name); try { await lstat(path.join(candidate,'package.json')); return await realpath(candidate); } catch (error) { if(error.code!=='ENOENT')throw error; } }
  const require = createRequire(path.join(parent, 'package.json'));
  for (const base of require.resolve.paths(name) ?? []) {
    const candidate = path.join(base, name);
    try { await lstat(path.join(candidate, 'package.json')); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    return await realpath(candidate);
  }
}

async function collect(parent, manifest, owner) {
  const references = { ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies };
  const discovered = [];
  for (const name of Object.keys(references).sort()) {
    if (name === 'openclaw' || (platform !== 'linux' && name === '@deepseek-ai/node-addon-landlock-run-linux-x64')) continue;
    const directory = await resolvePackage(name, parent);
    if (!directory) {
      assert.ok(manifest.optionalDependencies?.[name] || manifest.peerDependenciesMeta?.[name]?.optional,
        `Missing required runtime package ${name} from ${manifest.name}`);
      continue;
    }
    const value = await readJson(path.join(directory, 'package.json'));
    if (!compatible(value)) { assert.ok(manifest.optionalDependencies?.[name], `Required package ${name} is incompatible with ${target}`); continue; }
    // Resolve in the staged npm hierarchy. Preserve incompatible versions under
    // their actual consumer instead of flattening them into one incorrect version.
    const candidates = [];
    let ancestor = owner;
    while (ancestor) {
      candidates.push(`${ancestor}/node_modules/${name}`);
      const split = ancestor.lastIndexOf('/node_modules/');
      ancestor = split < 0 ? '' : ancestor.slice(0, split);
    }
    candidates.push(name);
    const visible = candidates.find(candidate => packages.has(candidate));
    let location = visible ?? name;
    if (visible && packages.get(visible).directory !== directory) {
      assert.ok(owner, `Root dependency conflict: ${name}`);
      location = `${owner}/node_modules/${name}`;
    }
    if (owner) packages.get(owner).references.set(name, location);
    if (packages.has(location)) {
      assert.equal(packages.get(location).directory, directory, `Unresolved dependency conflict at ${location}`);
      continue;
    }
    packages.set(location, { directory, manifest: value, references: new Map() });
    discovered.push(location);
  }
  // Reserve each direct dependency before recursively collecting transitive ones.
  for (const location of discovered) {
    const entry = packages.get(location);
    await collect(entry.directory, entry.manifest, location);
  }
}

async function filesIn(directory, base = '') {
  const files = [];
  for (const entry of await readdir(path.join(directory, base), { withFileTypes: true })) {
    const relative = path.join(base, entry.name);
    assert.ok(!entry.isSymbolicLink(), `Artifact contains a symlink: ${relative}`);
    if (entry.isDirectory()) files.push(...await filesIn(directory, relative));
    else if (entry.isFile()) files.push(relative);
    else throw new Error(`Artifact contains a special file: ${relative}`);
  }
  return files.sort();
}

try {
  assert.ok(nativeRoot, 'Supply --native-dir with verified target assets; host-built binaries are not a portable release');
  const rootManifest = await readJson(path.join(source, 'package.json'));
  await collect(source, { name: rootManifest.name, dependencies: rootManifest.dependencies });
  await mkdir(stage);
  const topFiles = [
    "dist",
    "examples",
    "README.md",
    "LICENSE",
    "compatibility.json",
    "docs/README.md",
    "docs/dependencies.md",
    "docs/components.md",
    "docs/host-integration.md",
    "docs/installation.md",
    "conest.config.example.json",
    "openclaw.plugin.json"
];
  for (const file of topFiles) {
    await mkdir(path.dirname(path.join(stage, file)), { recursive: true });
    await cp(path.join(source, file), path.join(stage, file), { recursive: true, dereference: false });
  }
  for (const file of await filesIn(path.join(stage, 'dist'))) {
    if (file.endsWith('.meta.json')) await rm(path.join(stage, 'dist', file));
  }
  await mkdir(path.join(stage, 'extensions/dsh-ui'), {recursive:true});
  for(const file of ['package.json','index.js','client.js','cordis.patch.yml','README.md','LICENSE']) await cp(path.join(source,'extensions/dsh-ui',file),path.join(stage,'extensions/dsh-ui',file));
  topFiles.push('extensions');
  const rootLicense = path.join(path.dirname(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-tools/package.json')), 'LICENSE');
  const pending = [...packages.entries()];
  let completed = 0;
  const results = await Promise.allSettled(Array.from({ length: 4 }, async () => {
    for (;;) {
      const item = pending.shift();
      if (!item) return;
      const [location, { directory, manifest, references }] = item;
      const name = manifest.name;
      const targetDirectory = path.join(stage, 'node_modules', location);
      // Let npm's pinned file-list implementation apply publishing rules without asking
      // Arborist to traverse the source workspace's linked development dependency graph.
      const listed = await packlist({ path: directory, package: { ...manifest, bundleDependencies: [] },
        isProjectRoot: true, edgesOut: new Map() });
      if (name === 'node-pty' && platform === 'linux') {
        listed.push('build/Release/pty.node');
      }
      const licenses = (await readdir(directory)).filter(file => /^(licen[sc]e|notice|copying)([.-]|$)/i.test(file));
      listed.push(...licenses);
      for (const file of [...new Set(listed)].sort()) {
        if (name === 'node-pty' && file.startsWith('prebuilds/') && !file.startsWith(`prebuilds/${target}/`)) continue;
        if (file.endsWith('.pdb')) continue;
        assert.ok(!path.isAbsolute(file) && inside(directory, path.resolve(directory, file)), `Unsafe package member ${file}`);
        assert.ok(!file.split('/').some(part => part === 'node_modules' || /^\.env(?:\.|$)/.test(part)), `Unexpected private/package member ${file}`);
        const member = path.join(directory, file);
        const stat = await lstat(member);
        assert.ok(stat.isFile() && !stat.isSymbolicLink(), `Package member must be a regular file: ${name}/${file}`);
        await mkdir(path.dirname(path.join(targetDirectory, file)), { recursive: true });
        await cp(member, path.join(targetDirectory, file));
      }
      if (licenses.length === 0) {
        if (name === '@openclaw/deepseek-provider') await cp(path.join(await resolvePackage('openclaw', source), 'LICENSE'),path.join(targetDirectory,'LICENSE'));
        else if (name.startsWith('@img/sharp-libvips-')) {
          assert.ok((await readFile(path.join(directory,'README.md'),'utf8')).includes('## Licensing'));
          await cp(path.join(directory,'README.md'),path.join(targetDirectory,'NOTICE.md'));
        } else if (name.startsWith('@koromix/koffi-')) await cp(path.join(source, 'node_modules/koffi/LICENSE.txt'), path.join(targetDirectory, 'LICENSE'));
        else { assert.ok(name.startsWith('@deepseek-ai/dsh-'), `No preserved license found for ${name}`); await cp(rootLicense, path.join(targetDirectory, 'LICENSE')); }
      }
      const rewritten = { ...manifest };
      if (name === 'node-pty' && platform === 'linux') rewritten.files = [...manifest.files, 'build/Release/pty.node'];
      // The artifact is already built and contains exact dependencies. Installation runs no upstream hooks.
      // The staging tree already applies the publisher's file list. Do not let a
      // second pack pass drop added license notices or verified native assets.
      for (const field of ['devDependencies', 'scripts', 'pnpm', 'workspaces', 'packageManager', 'files']) delete rewritten[field];
      for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
        if (!rewritten[field]) continue;
        rewritten[field] = Object.fromEntries(Object.keys(rewritten[field]).filter(key => references.has(key))
          .map(key => [key, packages.get(references.get(key)).manifest.version]));
      }
      rewritten.bundledDependencies = [...references].filter(([name, child]) => child === `${location}/node_modules/${name}`).map(([name]) => name);
      await writeFile(path.join(targetDirectory, 'package.json'), `${JSON.stringify(rewritten, null, 2)}\n`);
      provenance.push({ name, location, version: manifest.version, license: manifest.license, metadataRewritten: true,
        ...(name === 'node-pty' ? { napi: true, patched: true, target } : {}) });
      process.stderr.write(`Packed dependency ${++completed}/${packages.size}: ${name}\n`);
    }
  }));
  const failed = results.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
  for (const [location, entry] of packages) {
    const resolver = createRequire(path.join(stage, 'node_modules', location, 'package.json'));
    for (const [name, expected] of entry.references) {
      let actual;
      for (const base of resolver.resolve.paths(name) ?? []) {
        try { actual = await realpath(path.join(base, name)); break; }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      assert.equal(actual, path.join(stage, 'node_modules', expected), `Staged dependency resolves incorrectly: ${location} -> ${name}`);
    }
  }
  for (const record of provenance) {
    const directory = path.join(stage, 'node_modules', record.location);
    const files = (await filesIn(directory)).filter(file => !file.split(path.sep).includes('node_modules'));
    const digest = createHash('sha256');
    for (const file of files) digest.update(file).update('\0').update(await readFile(path.join(directory, file))).update('\0');
    record.files = files.length; record.sha256 = digest.digest('hex');
  }
  const dependencies = Object.fromEntries([...packages].filter(([location]) => !location.includes('/node_modules/')).sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => [name, value.manifest.version]));
  const manifest = { name: rootManifest.name, version: rootManifest.version, private: true, type: 'module',
    description: `CoNest Connector for OpenClaw with a self-contained ${target} CoNest Runtime`, license: rootManifest.license,
    engines: rootManifest.engines, os: [platform], cpu: [arch], ...(platform==='linux'?{libc:['glibc']} : {}),
    bin: rootManifest.bin, files: [...topFiles, 'THIRD_PARTY_NOTICES.md', 'runtime-lock.json'],
    dependencies, bundledDependencies: Object.keys(dependencies), peerDependencies: rootManifest.peerDependencies,
    openclaw: rootManifest.openclaw };
  await writeFile(path.join(stage, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(path.join(stage, 'runtime-lock.json'), `${JSON.stringify({ bridgeVersion: manifest.version,
    platform, arch, node: process.version, napi: true,
    ...(platform==='linux'?{libc:'2.28', kernel:'4.18'}:{}),
    nativeAssets: JSON.parse(await readFile(path.join(nativeRoot,'provenance.json'),'utf8')),
    dependencies: provenance.sort((a, b) => a.name.localeCompare(b.name)) }, null, 2)}\n`);
  await writeFile(path.join(stage, 'THIRD_PARTY_NOTICES.md'), `# Third-party runtime notices\n\nCoNest original code is MIT licensed; see LICENSE. Third-party code retains its own licenses and copyright notices. This artifact remains private in npm metadata to prevent accidental registry publication.\n\nBundled packages retain their own licenses and notices under \`node_modules/<package>/\`. DSH leaf packages additionally include the original DeepSeek root MIT license. Package manifests have exact versions and no install hooks. Studio JavaScript is bundled from the tested snapshot; its additional upstream notices are in dist/studio-licenses. Other executable JavaScript is preserved. The node-pty package includes the snapshot's existing JavaScript patch and ${target} N-API assets. Target native provenance is recorded in runtime-lock.json.\n\nSee \`runtime-lock.json\` for versions, file counts, and content hashes. These hashes record the produced artifact; they are not publisher signatures.\n`);
  // Force explicit target assets instead of silently shipping incomplete optional dependencies.
  for (const name of platform==='win32'?['@img/sharp-win32-x64','@koromix/koffi-win32-x64','@vscode/ripgrep-win32-x64']:['@img/sharp-linux-x64','@img/sharp-libvips-linux-x64','@koromix/koffi-linux-x64','@vscode/ripgrep-linux-x64']) assert.ok(packages.has(name), `Missing target asset ${name}`);
  for (const asset of platform === 'win32' ? ['node_modules/node-pty/prebuilds/win32-x64/pty.node'] : ['node_modules/node-pty/build/Release/pty.node']) assert.ok((await lstat(path.join(stage, asset))).isFile(), `Missing PTY asset ${asset}`);
  await filesIn(stage);
  await mkdir(output, { recursive: true });
  const packed = await execute(process.execPath, [npmCli, 'pack', '--ignore-scripts', '--json', '--pack-destination', temporary], {
    cwd: stage, timeout: 120_000, maxBuffer: 32 * 1024 * 1024,
  });
  const result = packResult(packed.stdout);
  for (const location of packages.keys()) assert.ok(result.files.some(file => file.path === `node_modules/${location}/package.json`), `npm omitted bundled runtime package ${location}`);
  for (const record of provenance) {
    const prefix = `node_modules/${record.location}/`;
    const files = result.files.filter(file => file.path.startsWith(prefix) && !file.path.slice(prefix.length).split('/').includes('node_modules'));
    assert.equal(files.length, record.files, `npm changed the staged file list for ${record.location}`);
  }
  const archive = path.join(output, result.filename);
  await cp(path.join(temporary, result.filename), archive, { errorOnExist: true, force: false });
  const sha256 = createHash('sha256').update(await readFile(archive)).digest('hex');
  await writeFile(`${archive}.sha256`, `${sha256}  ${result.filename}\n`, { flag: 'wx' });
  process.stdout.write(`${JSON.stringify({ archive, sha256, bundledPackages: packages.size, bytes: result.size, unpackedBytes: result.unpackedSize }, null, 2)}\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
