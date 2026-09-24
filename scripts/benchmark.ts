import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BridgeClient } from '../src/client.js';
import type { JsonObject, Progress, RuntimeStatus } from '../src/types.js';
import { BRIDGE_VERSION } from '../src/types.js';

type Distribution = {
  samples: number;
  minMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  meanMs: number;
};

const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const reportFile = path.join(projectRoot, '.local/reports', `conest-${BRIDGE_VERSION}`, 'benchmark.json');
const testRoot = await mkdtemp(path.join(os.tmpdir(), 'dsh-bridge-benchmark-'));
const workspaceRoot = path.join(testRoot, 'workspace');
const componentRoot = path.join(testRoot, 'component');
const componentManifest = path.join(componentRoot, 'component.json');
const configFile = path.join(testRoot, 'bridge.config.json');
const workerFile = path.join(projectRoot, 'dist', 'worker.js');
const marker = 'repeatable DSH benchmark marker';

await Promise.all([mkdir(workspaceRoot, { recursive: true }), mkdir(componentRoot, { recursive: true })]);
await Promise.all(Array.from({ length: 200 }, async (_, index) => {
  const content = index < 40
    ? `Fixture ${index}\n${marker} ${index}\nEnd of fixture\n`
    : `Fixture ${index}\nNo matching content in this file\nEnd of fixture\n`;
  await writeFile(path.join(workspaceRoot, `fixture-${String(index).padStart(3, '0')}.txt`), content, 'utf8');
}));
await writeBenchmarkComponent();
await writeFile(configFile, `${JSON.stringify({
  workspaceRoot,
  components: [componentManifest],
  maxConcurrent: 4,
  maxQueued: 8,
  maxTasks: 32,
  taskTtlMs: 30_000,
}, null, 2)}\n`, 'utf8');

const coldStartSamples: number[] = [];
let client: BridgeClient | undefined;
let finalStatus: RuntimeStatus | undefined;
const progressEvents: Progress[] = [];

try {
  for (let index = 0; index < 3; index += 1) {
    const candidate = createClient();
    const started = performance.now();
    finalStatus = await candidate.start();
    coldStartSamples.push(performance.now() - started);
    if (index < 2) await candidate.stop();
    else client = candidate;
  }
  assert.ok(client && finalStatus);
  const activeClient = client;

  await invoke(activeClient, 'benchmark_noop', { value: 'warmup' });
  await invoke(activeClient, 'knowledge_search', { query: marker });

  const statusSamples = await measureMany(30, async () => { await activeClient.status(); });
  const invokeSamples = await measureMany(50, async () => {
    const result = await invoke(activeClient, 'benchmark_noop', { value: 'measured' });
    assert.equal((result.value as { value?: unknown }).value, 'measured');
  });
  const searchSamples = await measureMany(10, async () => {
    const result = await invoke(activeClient, 'knowledge_search', { query: marker }, progress => progressEvents.push(progress));
    assert.equal((result.value as { totalMatches?: unknown }).totalMatches, 40);
  });
  const verificationSamples = await measureMany(5, async () => {
    const result = await invoke(activeClient, 'knowledge_verify', {
      query: marker,
      quote: `${marker} 7`,
    }, progress => progressEvents.push(progress));
    assert.equal((result.value as { verified?: unknown }).verified, true);
  });

  let settled = 0;
  let peakActive = 0;
  let peakQueued = 0;
  const concurrentStarted = performance.now();
  const concurrent = Array.from({ length: 12 }, () => invoke(
    activeClient,
    'benchmark_delay',
    { delayMs: 50 },
    progress => progressEvents.push(progress),
  )
    .finally(() => { settled += 1; }));
  while (settled < concurrent.length) {
    const status = await activeClient.status();
    peakActive = Math.max(peakActive, status.active);
    peakQueued = Math.max(peakQueued, status.queued);
    await delay(2);
  }
  await Promise.all(concurrent);
  const concurrentDurationMs = performance.now() - concurrentStarted;
  assert.equal(peakActive, 4);
  assert.ok(peakQueued > 0);

  const abort = new AbortController();
  let runningResolve: (() => void) | undefined;
  const running = new Promise<void>(resolve => { runningResolve = resolve; });
  const cancelled = invoke(activeClient, 'benchmark_delay', { delayMs: 5_000 }, progress => {
    if (progress.state === 'running') runningResolve?.();
  }, abort.signal);
  await running;
  const cancellationStarted = performance.now();
  abort.abort(new Error('Benchmark cancellation'));
  await assert.rejects(cancelled, /Benchmark cancellation/);
  const callerCancellationMs = performance.now() - cancellationStarted;
  while ((await activeClient.status()).tasks > 0) await delay(2);
  const workerCancellationDrainMs = performance.now() - cancellationStarted;

  finalStatus = await activeClient.status();
  const report = {
    schemaVersion: 1,
    bridgeVersion: BRIDGE_VERSION,
    measuredAt: new Date().toISOString(),
    environment: {
      node: process.version,
      openClaw: '2026.9.2',
      platform: `${process.platform}-${process.arch}`,
      cpuModel: os.cpus()[0]?.model ?? 'unknown',
      logicalCpuCount: os.cpus().length,
    },
    fixture: {
      files: 200,
      matchingFiles: 40,
      maxConcurrent: 4,
      maxQueued: 8,
    },
    latency: {
      coldWorkerStart: distribution(coldStartSamples),
      warmStatusRoundTrip: distribution(statusSamples),
      warmNoopInvokeRoundTrip: distribution(invokeSamples),
      warmDshSearch: distribution(searchSamples),
      warmDependentVerification: distribution(verificationSamples),
    },
    concurrency: {
      requests: concurrent.length,
      delayPerRequestMs: 50,
      totalDurationMs: round(concurrentDurationMs),
      peakActive,
      peakQueued,
    },
    cancellation: {
      callerSettledMs: round(callerCancellationMs),
      workerDrainedMs: round(workerCancellationDrainMs),
    },
    progress: {
      eventsObserved: progressEvents.length,
      statesObserved: [...new Set(progressEvents.map(event => event.state))].sort(),
    },
    worker: {
      pid: finalStatus.pid,
      rssBytes: finalStatus.memoryRssBytes,
      activeAfterBenchmark: finalStatus.active,
      queuedAfterBenchmark: finalStatus.queued,
      tasksAfterBenchmark: finalStatus.tasks,
    },
    interpretation: 'Measured baseline only; no numerical performance acceptance threshold was applied.',
  };
  await mkdir(path.dirname(reportFile), { recursive: true });
  await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await client?.stop();
  await rm(testRoot, { recursive: true, force: true });
}

function createClient(): BridgeClient {
  return new BridgeClient({
    workerFile,
    configFile,
    startupTimeoutMs: 15_000,
    shutdownTimeoutMs: 5_000,
    onLog: (_level, message) => process.stderr.write(`${message}\n`),
  });
}

async function invoke(
  activeClient: BridgeClient,
  capability: string,
  args: JsonObject,
  onProgress?: (progress: Progress) => void,
  signal?: AbortSignal,
): Promise<{ value: unknown; generation: string }> {
  return await activeClient.invoke({
    capability,
    args,
    taskId: randomUUID(),
    callId: randomUUID(),
    subject: 'benchmark',
    principal: { kind: 'agent', agentId: 'main' },
    workspaceRoot,
    permissions: ['workspace:read'],
    signal,
    onProgress,
  });
}

async function measureMany(count: number, operation: () => Promise<void>): Promise<number[]> {
  const samples: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const started = performance.now();
    await operation();
    samples.push(performance.now() - started);
  }
  return samples;
}

function distribution(samples: number[]): Distribution {
  const ordered = [...samples].sort((left, right) => left - right);
  const percentile = (value: number): number => ordered[Math.max(0, Math.ceil(value * ordered.length) - 1)]!;
  return {
    samples: ordered.length,
    minMs: round(ordered[0]!),
    p50Ms: round(percentile(0.5)),
    p95Ms: round(percentile(0.95)),
    maxMs: round(ordered.at(-1)!),
    meanMs: round(ordered.reduce((total, value) => total + value, 0) / ordered.length),
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function writeBenchmarkComponent(): Promise<void> {
  await writeFile(path.join(componentRoot, 'component.js'), `export default {
  name: 'benchmark-component',
  inject: ['bridgeCapabilities'],
  apply(ctx) {
    ctx.bridgeCapabilities.register(ctx, 'benchmark_noop', async args => args);
    ctx.bridgeCapabilities.register(ctx, 'benchmark_delay', async (args, invocation) => {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          invocation.signal.removeEventListener('abort', abort);
          resolve();
        }, args.delayMs);
        const abort = () => {
          clearTimeout(timer);
          reject(invocation.signal.reason);
        };
        if (invocation.signal.aborted) abort();
        else invocation.signal.addEventListener('abort', abort, { once: true });
      });
      return { delayedMs: args.delayMs };
    });
  },
};
`, 'utf8');
  await writeFile(componentManifest, `${JSON.stringify({
    id: 'benchmark-component',
    version: '1.0.0',
    description: 'Deterministic benchmark-only capabilities',
    entry: './component.js',
    requires: {},
    capabilities: [
      {
        name: 'benchmark_noop',
        description: 'Return input without additional work',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: { value: { type: 'string' } },
          required: ['value'],
        },
        permissions: ['workspace:read'],
      },
      {
        name: 'benchmark_delay',
        description: 'Wait for a deterministic bounded duration',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: { delayMs: { type: 'integer', minimum: 0, maximum: 10_000 } },
          required: ['delayMs'],
        },
        permissions: ['workspace:read'],
      },
    ],
  }, null, 2)}\n`, 'utf8');
}
