#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { BridgeClient } from './client.js';
import { controlRequest, type ControlMethod } from './control.js';
import { parseOperation, type ComponentOperation } from './management.js';
import { readConfig, resolveConfig } from './config.js';
import { ALL_PERMISSIONS, errorData, type JsonObject, type RuntimeStatus } from './types.js';
import { formatStatus, renderToolResult } from './ui.js';

const usage = 'Usage: conest init|status|catalog|reload|policy [show|set JSON_FILE]|components ACTION|invoke CAPABILITY JSON|search QUERY|verify QUERY QUOTE [--config FILE] [--workspace DIR] [--json]';
const args = process.argv.slice(2);
const positional: string[] = [];
let configFile: string | undefined;
let workspaceRoot = process.cwd();
let json = false;
for (let index = 0; index < args.length; index += 1) {
  const value = args[index]!;
  if (value === '--config') configFile = path.resolve(required(args[++index], '--config'));
  else if (value === '--workspace') workspaceRoot = path.resolve(required(args[++index], '--workspace'));
  else if (value === '--json') json = true;
  else if (value === '--help') positional.push('help');
  else if (value.startsWith('--')) throw new Error(`Unknown option: ${value}`);
  else positional.push(value);
}

let client: BridgeClient | undefined;
try {
  const command = positional[0] ?? 'status';
  if (command === 'help') {
    process.stdout.write(`${usage}\n`);
  } else if (command === 'init') {
    if (!configFile) throw new Error('init requires --config FILE');
    const config = { workspaceRoot: resolveConfig({ workspaceRoot }).workspaceRoot, components: [] };
    await writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    process.stdout.write(`${JSON.stringify({ created: configFile })}\n`);
  } else {
    const connect = async (): Promise<BridgeClient> => {
      if (client) return client;
      const config = configFile ? readConfig(configFile) : resolveConfig({ workspaceRoot });
      workspaceRoot = config.workspaceRoot;
      client = new BridgeClient({
        workerFile: fileURLToPath(new URL('./worker.js', import.meta.url)),
        ...(configFile ? { configFile } : { workspaceRoot }),
        startupTimeoutMs: config.startupTimeoutMs,
        shutdownTimeoutMs: config.shutdownTimeoutMs,
        maxPayloadBytes: config.maxPayloadBytes,
        onLog: (_level, message) => process.stderr.write(`${message}\n`),
      });
      await client.start();
      return client;
    };
    const operatorRequest = async <T>(method: ControlMethod, params?: unknown): Promise<T> => {
      if (configFile) {
        const live = await controlRequest<T>(configFile, method, params);
        if (live !== undefined) return live;
      }
      const owner = await connect();
      if (method === 'status') return await owner.status() as T;
      if (method === 'catalog') return await owner.catalog({ principal: { kind: 'operator' }, permissions: [...ALL_PERMISSIONS] }) as T;
      if (method === 'reload') return await owner.reload() as T;
      if (method === 'manage') return await owner.manage(params as ComponentOperation) as T;
      const call = params as { capability: string; args: JsonObject; expectedGeneration?: string };
      return await owner.invoke({
        ...call, workspaceRoot, permissions: [...ALL_PERMISSIONS], subject: 'bridge-cli',
        principal: { kind: 'operator' },
        taskId: randomUUID(), callId: randomUUID(),
        onProgress: event => process.stderr.write(`[${event.state}] ${event.message}\n`),
      }) as T;
    };
    if (command === 'catalog') {
      process.stdout.write(`${JSON.stringify(await operatorRequest('catalog'), null, 2)}\n`);
    } else if (command === 'policy') {
      if (positional[1] === 'set') {
        if (!configFile) throw new Error('Policy management requires --config FILE');
        const policy = JSON.parse(await readFile(required(positional[2], 'policy JSON file'), 'utf8'));
        const status = await operatorRequest<RuntimeStatus>('manage', parseOperation({ action: 'policy', policy }));
        process.stdout.write(`${JSON.stringify({ generation: status.revision, policy: status.capabilityPolicy }, null, 2)}\n`);
      } else if (positional.length === 1 || positional[1] === 'show') {
        const status = await operatorRequest<RuntimeStatus>('status');
        process.stdout.write(`${JSON.stringify({ generation: status.revision, policy: status.capabilityPolicy }, null, 2)}\n`);
      } else throw new Error('Usage: conest policy [show|set JSON_FILE] --config FILE');
    } else if (command === 'status' || command === 'reload' || command === 'components') {
      let status: RuntimeStatus;
      if (command === 'components' && positional[1] !== 'list') {
        if (!configFile) throw new Error('Component management requires --config FILE');
        const action = required(positional[1], 'component action');
        const current = await operatorRequest<RuntimeStatus>('status');
        const operation: JsonObject = { action, expectedRevision: current.revision };
        if (action === 'install') operation.manifest = path.resolve(required(positional[2], 'manifest path'));
        else {
          operation.id = required(positional[2], 'component id');
          if (action === 'upgrade') operation.manifest = path.resolve(required(positional[3], 'manifest path'));
          if (action === 'configure') operation.config = JSON.parse(await readFile(required(positional[3], 'configuration JSON file'), 'utf8'));
        }
        status = await operatorRequest('manage', parseOperation(operation));
      } else status = await operatorRequest(command === 'reload' ? 'reload' : 'status');
      process.stdout.write(`${json ? JSON.stringify(status, null, 2) : formatStatus({ client: { state: 'ready' }, runtime: status })}\n`);
    } else if (command === 'search' || command === 'verify' || command === 'invoke') {
      const capability = command === 'invoke' ? required(positional[1], 'capability name') : `knowledge_${command === 'search' ? 'search' : 'verify'}`;
      const input = command === 'invoke' ? JSON.parse(required(positional[2], 'arguments JSON')) as JsonObject
        : command === 'search' ? { query: required(positional[1], 'search query') }
          : { query: required(positional[1], 'verification query'), quote: required(positional[2], 'quoted text') };
      const status = await operatorRequest<RuntimeStatus>('status');
      const result = await operatorRequest<{ value: unknown; generation: string }>('call', { capability, args: input, expectedGeneration: status.revision });
      process.stdout.write(`${json ? JSON.stringify(result, null, 2) : renderToolResult(capability, result.value)}\n`);
    } else throw new Error(usage);
  }
} catch (error) {
  process.stderr.write(`${JSON.stringify(errorData(error))}\n`);
  process.exitCode = 1;
} finally { await client?.stop(); }

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
