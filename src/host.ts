import type { Progress, RuntimeStatus, CatalogRequest, CapabilityCatalog } from './types.js';
import { BridgeClient, type ClientInvocation } from './client.js';
import type { ComponentOperation } from './management.js';
import { BridgeError } from './types.js';
import type { ExtensionCall } from './extension-protocol.js';

export type HostOptions = ConstructorParameters<typeof BridgeClient>[0];

/** Mutable adapter-side owner for the supervised worker client. */
export class BridgeHost {
  private client: BridgeClient | undefined;
  private lastStatus: RuntimeStatus | undefined;
  private lastProgress: Progress | undefined;
  private starting: Promise<RuntimeStatus> | undefined;
  private stopped = false;
  private readonly restarts: number[] = [];

  constructor(private readonly options: HostOptions) {}

  snapshot(): { client: ReturnType<BridgeClient['getState']>; runtime?: RuntimeStatus; lastProgress?: Progress } {
    return {
      client: this.client?.getState() ?? { state: 'stopped' },
      ...(this.lastStatus ? { runtime: this.lastStatus } : {}),
      ...(this.lastProgress ? { lastProgress: this.lastProgress } : {}),
    };
  }

  async start(): Promise<RuntimeStatus> {
    if (this.starting) return await this.starting;
    this.stopped = false;
    this.starting = (async () => {
      if (this.client?.getState().state === 'ready') return await this.client.status();
      if (this.client) await this.client.stop();
      const client = new BridgeClient(this.options);
      this.client = client;
      this.lastStatus = await client.start();
      return this.lastStatus;
    })();
    try { return await this.starting; } finally { this.starting = undefined; }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.starting?.catch(() => {});
    const client = this.client;
    this.client = undefined;
    if (client) await client.stop();
  }

  async invoke(input: ClientInvocation): Promise<{ value: unknown; generation: string }> {
    const client = await this.ensureClient();
    const callerProgress = input.onProgress;
    const result = await client.invoke({
      ...input,
      onProgress: progress => {
        if (input.recordProgress !== false) this.lastProgress = progress;
        callerProgress?.(progress);
      },
    });
    return result;
  }

  async refresh(): Promise<RuntimeStatus> {
    const client = await this.ensureClient();
    this.lastStatus = await client.status();
    return this.lastStatus;
  }

  async catalog(request: CatalogRequest): Promise<CapabilityCatalog> {
    return await (await this.ensureClient()).catalog(request);
  }

  async reload(): Promise<RuntimeStatus> {
    const client = await this.ensureClient();
    this.lastStatus = await client.reload();
    return this.lastStatus;
  }

  async manage(operation: ComponentOperation): Promise<RuntimeStatus> {
    const client = await this.ensureClient();
    this.lastStatus = await client.manage(operation);
    return this.lastStatus;
  }

  async extension<T>(call: ExtensionCall): Promise<T> {
    return await (await this.ensureClient()).extension<T>(call);
  }

  async restart(): Promise<RuntimeStatus> {
    await this.stop();
    this.restarts.length = 0;
    return await this.start();
  }

  private async ensureClient(): Promise<BridgeClient> {
    if (this.stopped) throw new BridgeError('BRIDGE_STOPPING', 'The CoNest Connector service is stopped');
    if (this.client?.getState().state === 'ready') return this.client;
    if (!this.starting) {
      while (this.restarts.length && this.restarts[0]! < Date.now() - 60_000) this.restarts.shift();
      if (this.restarts.length >= 3) throw new BridgeError('RESTART_LIMIT', 'The worker failed repeatedly; inspect its configuration and use /bridge restart');
      this.restarts.push(Date.now());
    }
    await this.start();
    if (this.stopped) throw new BridgeError('BRIDGE_STOPPING', 'The CoNest Connector service stopped during startup');
    return this.client!;
  }
}
