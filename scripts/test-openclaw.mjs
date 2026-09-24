import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { packageVersion, reportDirectory, reportPath } from './report-path.mjs';

const execute = promisify(execFile);
const require = createRequire(import.meta.url);
const pluginRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const openClawEntry = require.resolve('openclaw/plugin-sdk/plugin-entry');
const openClawRoot = path.resolve(path.dirname(openClawEntry), '../..');
const openClawCli = path.join(openClawRoot, 'openclaw.mjs');
const testRoot = await mkdtemp(path.join(os.tmpdir(), 'openclaw-dsh-plugin-'));
const workspaceRoot = path.join(testRoot, 'workspace');
const stateRoot = path.join(testRoot, 'state');
const configPath = path.join(testRoot, 'openclaw.json');

try {
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(path.join(workspaceRoot, 'acceptance.txt'), 'CoNest Connector acceptance marker\n', 'utf8');
  await writeFile(configPath, `${JSON.stringify({
    plugins: {
      enabled: true,
      allow: ['dsh-bridge'],
      load: { paths: [pluginRoot] },
      entries: {
        'dsh-bridge': {
          enabled: true,
          hooks: { allowConversationAccess: true },
          config: { workspaceRoot },
        },
      },
    },
  }, null, 2)}\n`, 'utf8');

  const { stdout, stderr } = await execute(
    process.execPath,
    [openClawCli, 'plugins', 'inspect', 'dsh-bridge', '--runtime', '--json'],
    {
      cwd: workspaceRoot,
      env: {
        ...process.env,
        NO_COLOR: '1',
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_STATE_DIR: stateRoot,
      },
      maxBuffer: 4 * 1024 * 1024,
      timeout: 120_000,
    },
  );
  const inspection = JSON.parse(stdout);
  const hostManifest = JSON.parse(await readFile(path.join(openClawRoot, 'package.json'), 'utf8'));
  const tools = inspection.tools.flatMap(registration => registration.names).sort();
  assert.equal(inspection.plugin.id, 'dsh-bridge');
  assert.equal(inspection.plugin.name, 'CoNest Connector for OpenClaw');
  assert.equal(inspection.plugin.status, 'loaded', `OpenClaw diagnostics: ${JSON.stringify(inspection.diagnostics)}`);
  assert.equal(inspection.plugin.activated, true);
  const memoryTools = JSON.parse(await readFile(path.join(pluginRoot, 'openclaw.plugin.json'), 'utf8')).contracts.tools.filter(name => name.startsWith('dsh_mcp__reference_memory__'));
  const expectedTools = [...memoryTools, 'bridge_capabilities', 'bridge_invoke', 'dsh_glob', 'dsh_grep', 'dsh_read', 'knowledge_search', 'knowledge_verify'].sort();
  assert.deepEqual(tools, expectedTools);
  assert.ok(inspection.services.includes('dsh-bridge-worker'));
  assert.ok(inspection.commands.includes('conest'));
  assert.ok(inspection.commands.includes('bridge'));
  assert.equal(inspection.httpRouteCount, 2);
  assert.ok(expectedTools.every(name => inspection.plugin.contracts.tools.includes(name)));
  assert.equal(inspection.plugin.contracts.tools.filter(name => name.startsWith('dsh_')).length, 16);
  assert.deepEqual(inspection.diagnostics, []);

  const report = {
    recordedAt: new Date().toISOString(),
    bridgeVersion: packageVersion,
    connectorName: inspection.plugin.name,
    openClawVersion: hostManifest.version,
    pluginId: inspection.plugin.id,
    status: inspection.plugin.status,
    activated: inspection.plugin.activated,
    tools,
    services: inspection.services,
    commands: inspection.commands,
    httpRouteCount: inspection.httpRouteCount,
    contracts: inspection.plugin.contracts,
    diagnostics: inspection.diagnostics,
    stderr: stderr.trim(),
  };
  await mkdir(reportDirectory, { recursive: true });
  await writeFile(reportPath('openclaw-inspection.json'), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await rm(testRoot, { recursive: true, force: true });
}
