import { managedMemoryTools } from '../memory-contract.js';
import type { AnyAgentTool } from '../adapters/openclaw-sdk.js';
import assert from 'node:assert/strict';
import { mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BridgeClient } from '../client.js';
import { protectDirectory, assertPrivateFile } from '../platform-support.mjs';

/** Real DSH runtime/tool smoke test; model decisions use the explicit proof adapter. */
export async function probeRuntime() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'conest-platform-'));
  await protectDirectory(root);
  const privateFile = path.join(root, 'private-probe.txt');
  await writeFile(privateFile, 'synthetic permissions probe', { mode: 0o600 });
  await assertPrivateFile(privateFile);
  const workspace = path.join(root, 'workspace'); await mkdir(workspace);
  await writeFile(path.join(workspace, 'evidence.txt'), 'CoNest cross-platform probe\nCONEST_PLATFORM_OK\n');
  const searchWorker = new BridgeClient({ workerFile: fileURLToPath(new URL('../worker.js', import.meta.url)), workspaceRoot: workspace, memoryFilePath: path.join(root, 'memory.jsonl'), startupTimeoutMs: process.platform === 'win32' ? 60000 : 15000, shutdownTimeoutMs: 5000, onLog: (level, message) => console.error(`[CoNest Host ${level}] ${message}`) });
  const options = { workspaceRoot: workspace, enableBridgeProofAdapter: true };
  try {
    const worker = await searchWorker.start();
    const support = await searchWorker.extension<{ pid: number }>({ operation: 'start', setup: options });
    assert.equal(support.pid, worker.pid, 'DSH and components must share the same Host process');
    const execute = (callId: string, name: string, params: unknown, sessionKey: string) => searchWorker.extension<{ isError: boolean }>({
      operation: 'execute', setup: options, args: { callId, name, params, sessionKey },
    });
    const read = await searchWorker.invoke({ capability: 'dsh_read', args: { file_path: 'evidence.txt' }, taskId: 'platform-read', callId: 'read-probe', subject: 'platform-probe', principal: { kind: 'operator' }, workspaceRoot: workspace, permissions: ['workspace:read'] });
    assert(!(read.value as { isError: boolean }).isError, JSON.stringify(read)); assert(JSON.stringify(read).includes('CONEST_PLATFORM_OK'));
    assert((await execute('local-read-absent', 'read', { file_path: 'evidence.txt' }, 'platform-read')).isError, 'Gateway must not retain local read');
    assert.notEqual(worker.pid, process.pid);
    const grep = await searchWorker.invoke({ capability: 'dsh_grep', args: { pattern: 'CONEST_PLATFORM_OK', path: '.' },
      taskId: 'platform-search', callId: 'grep-probe', subject: 'platform-probe', principal: { kind: 'operator' }, workspaceRoot: workspace, permissions: ['workspace:read'] });
    assert(JSON.stringify(grep.value).includes('CONEST_PLATFORM_OK'));
    await assert.rejects(searchWorker.invoke({ capability: 'dsh_grep', args: { pattern: 'CONEST_PLATFORM_OK', path: root },
      taskId: 'outside-search', callId: 'outside-search', subject: 'platform-probe', principal: { kind: 'operator' }, workspaceRoot: workspace, permissions: ['workspace:read'] }), /inside the authorized workspace/);
    const localSearch = await execute('local-search-absent', 'grep', { pattern: 'CONEST_PLATFORM_OK' }, 'platform-search');
    assert(localSearch.isError, 'Gateway composition must not retain a second grep implementation');
    assert((await execute('local-memory-absent', 'mcp__reference_memory__read_graph', {}, 'platform')).isError);
    const memoryCall = (capability: string, args: Record<string, unknown>) => searchWorker.invoke({ capability, args, taskId: crypto.randomUUID(), callId: crypto.randomUUID(), subject: 'platform', principal: { kind: 'operator' }, workspaceRoot: workspace, permissions: ['memory:read', 'memory:write'] });
    const hostTools: AnyAgentTool[] = managedMemoryTools.map(tool => ({
      name: tool.openClawName, label: tool.openClawName, description: tool.description, parameters: tool.parameters,
      async execute(_id, args) {
        const result = (await memoryCall(tool.openClawName, args as Record<string, unknown>)).value as { content: Array<{ type: 'text'; text: string }>; value: unknown };
        return { content: result.content, details: { value: result.value } };
      },
    }));
    const loop = await searchWorker.extension<{ toolResults: Array<{ isError?: boolean }> }>({ operation: 'runHarnessAgent', setup: options,
      args: { task: 'PROOF:MEMORY_WRITE:platform-user:portable-memory-ok', sessionKey: 'platform-loop', provider: 'bridge-proof', model: 'proof', timeoutMs: 30000,
        hostTools: hostTools.map(({ name, label, description, parameters }) => ({ name, label, description, parameters })) },
      callbacks: { event() {}, tool: async (request, signal) => {
        const tool = hostTools.find(tool => tool.name === request.name);
        assert.ok(tool, 'Only admitted tools can be called back');
        return await tool.execute(request.callId, request.args, signal);
      } },
    });
    assert(loop.toolResults.some(result => !result.isError), JSON.stringify(loop.toolResults));
    await memoryCall('memory_remember', { observation: 'Remember: portable-automatic-ok' });
    await searchWorker.stop(); await searchWorker.start();
    const memory = await memoryCall('memory_recall', {});
    assert(JSON.stringify(memory.value).includes('portable-automatic-ok'));
    const recall = await memoryCall('dsh_mcp__reference_memory__search_nodes', { query: 'platform-user' });
    assert(JSON.stringify(recall.value).includes('portable-memory-ok'));
    return { platform: process.platform, arch: process.arch, node: process.version, glibc: (process.report.getReport() as {header:{glibcVersionRuntime?: string}}).header.glibcVersionRuntime,
      passed: true, privateState: process.platform === 'win32' ? 'current user / system / administrators only' : 'owner-only mode', read: 'real DSH read in managed component worker', grep: 'real packaged ripgrep in managed component worker; outside workspace rejected', loop: 'real DSH loop in shared CoNest Host, deterministic model decisions', hostPid: support.pid, memory: 'persisted across runtime restart', nativeWindowsHostQualification: process.platform === 'win32' ? 'Record whether this is native Windows or an emulation environment in the test report' : undefined };
  } finally { await searchWorker.stop(); await rm(root, {recursive:true,force:true}); }
}
