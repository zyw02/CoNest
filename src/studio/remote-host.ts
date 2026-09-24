import type { BridgeHost } from '../host.js';
import type { CordisBridgeHost } from './cordis-bridge-host.js';
import { CordisAgentRunError } from './agent-error.js';
import { BridgeError } from '../types.js';

type Setup = Parameters<CordisBridgeHost['start']>[0];
/** Gateway facade. No Cordis context, DSH Agent or Session is created here. */
export class RemoteCordisHost {
  private setup?: Setup;
  private ready = false;
  private pid?: number;
  constructor(private readonly owner: BridgeHost) {}
  status(): 'ready' | 'stopped' { return this.ready && this.owner.snapshot().client.state === 'ready' ? 'ready' : 'stopped'; }
  processInfo() { return { gatewayPid: process.pid, hostPid: this.pid, deployment: 'gateway+host' }; }
  async start(options: Setup): Promise<void> {
    this.setup = { ...options, modelRoute: { apiKey: process.env.DEEPSEEK_API_KEY, baseURL: process.env.DEEPSEEK_BASE_URL } };
    const result = await this.call<{ pid: number }>('start');
    this.pid = result.pid; this.ready = true;
  }
  // The shared BridgeHost owns process shutdown; this facade owns no additional process.
  async stop(): Promise<void> { this.ready = false; }
  async observeRead(...[receipt, sessionKey, signal]: Parameters<CordisBridgeHost['observeRead']>) {
    await this.call('observeRead', { receipt, sessionKey }, signal);
  }
  async execute(...[callId, name, params, sessionKey, signal]: Parameters<CordisBridgeHost['execute']>): ReturnType<CordisBridgeHost['execute']> {
    return await this.call('execute', { callId, name, params, sessionKey }, signal);
  }
  async endHarnessSession(session: Parameters<CordisBridgeHost['endHarnessSession']>[0]) {
    if (this.status() === 'ready') await this.call('endHarnessSession', session);
  }
  async runHarnessAgent(options: Parameters<CordisBridgeHost['runHarnessAgent']>[0]): ReturnType<CordisBridgeHost['runHarnessAgent']> {
    const { signal, onEvent, approvalRequester, hostTools, ...args } = options;
    const tools = new Map(hostTools?.map(tool => [tool.name, tool]));
    try {
      return await this.owner.extension({ operation: 'runHarnessAgent', setup: this.setup,
        args: { ...args, hostTools: hostTools?.map(({ name, label, description, parameters }) => ({ name, label, description, parameters })) },
        timeoutMs: options.timeoutMs + 15_000, signal,
        callbacks: {
          event: async event => { await onEvent?.(event); return null; },
          approval: request => approvalRequester ? approvalRequester(request) : 'unavailable',
          tool: async (request, callbackSignal) => {
            const tool = tools.get(request.name);
            if (!tool) throw new BridgeError('CALLBACK_DENIED', 'Tool is not in the admitted OpenClaw surface');
            return await tool.execute(request.callId, request.args,
              signal ? AbortSignal.any([signal, callbackSignal]) : callbackSignal);
          },
        },
      });
    } catch (error) {
      if (signal?.aborted) throw new CordisAgentRunError('aborted', 'The OpenClaw turn was cancelled');
      if (error instanceof BridgeError && ['DSH_ABORTED', 'DSH_FAILED', 'DSH_TIMEOUT'].includes(error.code)) {
        throw new CordisAgentRunError(error.code.slice(4).toLowerCase() as 'aborted' | 'failed' | 'timeout', error.message);
      }
      throw error;
    }
  }
  private async call<T>(operation: string, args?: unknown, signal?: AbortSignal): Promise<T> {
    if (!this.setup) throw new Error('CoNest support pack has not been configured');
    return await this.owner.extension<T>({ operation, setup: this.setup, args, signal });
  }
}
