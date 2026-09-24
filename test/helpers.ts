import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';
import type { BridgeRuntime, InvokeRequest } from '../src/runtime.js';
import type { ComponentManifest, JsonObject } from '../src/types.js';

export async function fixture(context: TestContext): Promise<{ root: string; workspace: string; configFile: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-bridge-test-'));
  const workspace = path.join(root, 'workspace');
  const configFile = path.join(root, 'bridge.json');
  await mkdir(workspace);
  context.after(() => rm(root, { recursive: true, force: true }));
  return { root, workspace, configFile };
}

export async function component(
  root: string,
  manifest: ComponentManifest,
  body: string,
): Promise<string> {
  const directory = path.join(root, 'bundles', `${manifest.id}-${manifest.version}-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'component.mjs'), body, 'utf8');
  const file = path.join(directory, 'component.json');
  await writeFile(file, JSON.stringify({ ...manifest, entry: './component.mjs' }), 'utf8');
  return file;
}

export function request(workspaceRoot: string, capability: string, args: JsonObject = {}): Omit<InvokeRequest, 'authorization'> {
  return { workspaceRoot, capability, args, taskId: randomUUID(), callId: randomUUID(), subject: 'test-owner', principal: { kind: 'agent', agentId: 'main' }, permissions: ['workspace:read'] };
}

export async function invoke(runtime: BridgeRuntime, workspace: string, capability: string, args: JsonObject = {}) {
  const input = request(workspace, capability, args);
  const grant = runtime.authorize(input);
  return await runtime.invoke({ ...input, authorization: grant.token });
}

export function hasCode(code: string): (error: unknown) => boolean {
  return error => !!error && typeof error === 'object' && (error as { code?: unknown }).code === code;
}

export async function eventually(predicate: () => boolean | Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error('The expected lifecycle state did not arrive before the test deadline');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
