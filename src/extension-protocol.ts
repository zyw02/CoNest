/** Private Gateway–Host channel. Callback authority exists only during its parent call. */
export type ExtensionCallbacks = Record<string, (args: any, signal: AbortSignal) => unknown | Promise<unknown>>;
export type ExtensionCall = {
  operation: string;
  setup?: unknown;
  args?: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
  callbacks?: ExtensionCallbacks;
};
export type HostCallback = {
  event: 'host.callback';
  data: { channel: string; id: string; name: string; args: unknown };
};
