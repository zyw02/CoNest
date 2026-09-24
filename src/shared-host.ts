import { BridgeHost, type HostOptions } from './host.js';
import { RunScopes } from './run-scope.js';
import { ContextDiagnostics } from './context-diagnostics.js';

type Shared = { host: BridgeHost; scopes: RunScopes; contextDiagnostics: ContextDiagnostics; registrations: number; services: number };
const key = Symbol.for('openclaw-dsh-bridge.shared-hosts.v3');
const globals = globalThis as typeof globalThis & { [key]?: Map<string, Shared> };
const hosts = globals[key] ??= new Map<string, Shared>();

/** Gateway service and request-time registries can load separate module instances. */
export function borrowHost(identity: string, options: HostOptions, lifetimeMs: number, limit: number) {
  let shared = hosts.get(identity);
  if (!shared) {
    shared = { host: new BridgeHost(options), scopes: new RunScopes(lifetimeMs, limit), contextDiagnostics: new ContextDiagnostics(), registrations: 0, services: 0 };
    hosts.set(identity, shared);
  }
  const owner = shared;
  owner.registrations++;
  let serviceStarted = false;
  let released = false;
  const stopService = async () => {
    if (!serviceStarted) return;
    serviceStarted = false;
    if (--owner.services === 0) { owner.scopes.close(); await owner.host.stop(); }
  };
  return {
    host: owner.host, scopes: owner.scopes, contextDiagnostics: owner.contextDiagnostics,
    serviceRunning: () => owner.services > 0,
    async startService() {
      if (!serviceStarted) { serviceStarted = true; owner.services++; }
      return await owner.host.start();
    },
    stopService,
    async release() {
      if (released) return;
      released = true;
      await stopService();
      if (--owner.registrations === 0) {
        hosts.delete(identity);
        owner.scopes.close();
        await owner.host.stop();
      }
    },
  };
}
