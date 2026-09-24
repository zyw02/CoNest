import { managedDshTools } from '../src/managed-tools.js';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { satisfies } from 'semver';
import { COMMAND_NAMES, CONNECTOR_FULL_NAME, CONNECTOR_NAME, PLUGIN_ID, PRODUCT_NAME, RUNTIME_NAME, STATUS_PATHS } from '../src/branding.js';
import { generatedComposition } from '../src/studio/generated/composition.generated.js';
import { BRIDGE_VERSION } from '../src/types.js';
import { formatStatus, renderProgress, renderStatusPage } from '../src/ui.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const json = async (file: string) => JSON.parse(await readFile(path.join(root, file), 'utf8'));
const execute = promisify(execFile);

test('CoNest product names, package, manifest, and runtime version agree without changing plugin identity', async () => {
  const pkg = await json('package.json');
  const manifest = await json('openclaw.plugin.json');
  assert.equal(PRODUCT_NAME, 'CoNest');
  assert.equal(CONNECTOR_FULL_NAME, 'CoNest Connector for OpenClaw');
  assert.equal(RUNTIME_NAME, 'CoNest Runtime');
  assert.equal(pkg.name, '@local/conest-connector');
  assert.equal(pkg.version, BRIDGE_VERSION);
  assert.equal(manifest.version, BRIDGE_VERSION);
  assert.equal(manifest.name, CONNECTOR_FULL_NAME);
  assert.equal(manifest.id, PLUGIN_ID);
  assert.equal(PLUGIN_ID, 'dsh-bridge');
  assert.deepEqual(manifest.commandAliases.map((alias: { name: string }) => alias.name), [...COMMAND_NAMES]);
  assert.deepEqual([...manifest.contracts.tools].sort(), ['bridge_capabilities', 'bridge_invoke', 'knowledge_search', 'knowledge_verify', ...[...managedDshTools, ...generatedComposition.tools].map(t => t.openClawName)].sort());
  assert.deepEqual([...STATUS_PATHS], ['/plugins/conest-connector', '/plugins/dsh-bridge']);
});

test('new CLI names and compatibility aliases resolve to identical help without starting a worker', async () => {
  const pkg = await json('package.json');
  for (const [canonical, legacy] of [['conest', 'dsh-bridge'], ['conest-local', 'dsh-bridge-local']]) {
    assert.equal(pkg.bin[canonical!], pkg.bin[legacy!]);
    const result = await execute(process.execPath, [path.join(root, pkg.bin[canonical!]), '--help'], { timeout: 10_000 });
    assert.match(result.stdout, new RegExp(`^Usage: ${canonical} `));
    assert.equal(result.stderr, '');
  }
});

test('CoNest branding keeps legacy component manifests and example configuration compatible', async () => {
  const component = await json('examples/source-verifier/component.json');
  assert.equal(satisfies(BRIDGE_VERSION, component.bridgeVersion), true);
  assert.equal(component.requires['dsh-search'], '^0.2.0');
});

test('status and progress surfaces use CoNest names and preserve HTML escaping', () => {
  const state = { client: { state: 'failed', failure: '<script>unsafe</script>' } };
  const status = formatStatus(state);
  assert.ok(status.startsWith(`${CONNECTOR_NAME}：`));
  assert.ok(status.includes('/conest reload'));
  const page = renderStatusPage(state);
  assert.ok(page.includes(`<title>${CONNECTOR_NAME}</title>`));
  assert.ok(page.includes(RUNTIME_NAME));
  assert.ok(page.includes('&lt;script&gt;unsafe&lt;/script&gt;'));
  assert.ok(!page.includes('<script>unsafe</script>'));
  assert.ok(!page.includes('DSH Bridge'));
  for (const state of ['queued', 'cancelled', 'failed', 'completed'] as const) {
    assert.ok(renderProgress({ state, message: '', callId: 'test', at: 0 }).startsWith(CONNECTOR_NAME));
  }
});
