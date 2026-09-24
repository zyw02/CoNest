import { Ajv } from 'ajv';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv, promisify } from 'node:util';
import { controlRequest, serveControl } from './control.js';
import { executionEnvironment } from './environment.js';
import { assertRuntime, assertPrivateFile, protectDirectory, stopProcessTree } from './platform-support.mjs';
import { BridgeError, HOST_VERSION, BRIDGE_VERSION, type CapabilityCatalog, type RuntimeStatus } from './types.js';
import { inspectOpenClaw, OPENCLAW_COMPATIBILITY_RANGE } from './compatibility.js';

const execute = promisify(execFile);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(packageRoot, 'package.json'));
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const validate = new Ajv({ allErrors: true }).compile({ type: 'object', additionalProperties: false,
  required: ['schemaVersion', 'workspaceRoot', 'credentialFile', 'port', 'timeoutSeconds', 'maxOutputTokens'],
  properties: {
    schemaVersion: { const: 1 }, workspaceRoot: { type: 'string', minLength: 1 }, credentialFile: { type: 'string', minLength: 1 },
    port: { type: 'integer', minimum: 1024, maximum: 65535 }, timeoutSeconds: { type: 'integer', minimum: 10, maximum: 600 },
    maxOutputTokens: { type: 'integer', minimum: 256, maximum: 8192 },
  },
});
export type LocalSettings = { schemaVersion: 1; workspaceRoot: string; credentialFile: string; port: number; timeoutSeconds: number; maxOutputTokens: number };
export type LocalProfile = { directory: string; file: string; bridgeFile: string; gatewayFile: string; settings: LocalSettings };
export type LocalStatus = { state: 'starting' | 'ready' | 'stopping' | 'stopped' | 'failed'; supervisorPid?: number; gatewayPid?: number;
  bridgeVersion: string; model: string; port: number; failure?: string; bridgeState?: RuntimeStatus['state'] | 'unavailable' };

function contained(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function privateFile(file: string): Promise<void> {
  if (process.platform === 'win32') { await assertPrivateFile(file); return; }
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) {
    throw new BridgeError('LOCAL_FILE_UNSAFE', 'Local configuration and credential files must be regular, current-user-owned files with mode 600 or 400');
  }
}

async function credential(file: string): Promise<string> {
  await privateFile(file);
  const key = parseEnv(await readFile(file, 'utf8')).DEEPSEEK_API_KEY?.trim();
  if (!key || key === 'YOUR_API_KEY_HERE' || !/^\S{8,2048}$/.test(key)) {
    throw new BridgeError('CREDENTIAL_MISSING', 'The private credential file must contain a valid DEEPSEEK_API_KEY value');
  }
  return key;
}

/** Resolve normal installed package roots; no developer workspace paths are accepted implicitly. */
export async function localInstallation(): Promise<{ host: string; provider: string; cli: string }> {
  const roots: string[] = [];
  for (const name of ['openclaw', '@openclaw/deepseek-provider']) {
    let root: string | undefined;
    for (const base of require.resolve.paths(name) ?? []) {
      const candidate = path.join(base, name);
      try { await lstat(path.join(candidate, 'package.json')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      root = await realpath(candidate);
      break;
    }
    if (!root) throw new BridgeError('INSTALLATION_INCOMPLETE', `Install ${name}@${OPENCLAW_COMPATIBILITY_RANGE} beside the CoNest Connector package`);
    const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as { version?: unknown };
    try { inspectOpenClaw(manifest.version); }
    catch (error) { throw new BridgeError('HOST_VERSION_MISMATCH', `${name}: ${String(error)}`); }
    roots.push(root);
  }
  return { host: roots[0]!, provider: roots[1]!, cli: path.join(roots[0]!, 'openclaw.mjs') };
}

function assertPlatform(): void {
  try { assertRuntime(); } catch(error) { throw new BridgeError('PLATFORM_UNSUPPORTED', String(error)); }
}

/** Create a new, private profile outside both source material and credentials. Existing profiles are never overwritten. */
export async function setupLocal(directory: string, options: { workspace: string; credentials: string; port?: number }): Promise<LocalProfile> {
  assertPlatform();
  const installation = await localInstallation();
  const workspaceRoot = await realpath(options.workspace);
  if (!(await lstat(workspaceRoot)).isDirectory()) throw new BridgeError('WORKSPACE_INVALID', 'The workspace must be an existing directory');
  const credentialFile = path.resolve(options.credentials);
  await credential(credentialFile);
  const canonicalCredential = await realpath(credentialFile);
  const requested = path.resolve(directory);
  await mkdir(path.dirname(requested), { recursive: true, mode: 0o700 });
  const target = path.join(await realpath(path.dirname(requested)), path.basename(requested));
  if (contained(workspaceRoot, target) || contained(workspaceRoot, canonicalCredential) || contained(target, workspaceRoot)) {
    throw new BridgeError('LOCAL_LAYOUT_UNSAFE', 'Keep the private state directory and credentials outside the searchable workspace, and keep the workspace outside private state');
  }
  const port = await availablePort(options.port ?? 0);
  const settings: LocalSettings = { schemaVersion: 1, workspaceRoot, credentialFile: canonicalCredential, port, timeoutSeconds: 90, maxOutputTokens: 2048 };
  await mkdir(target, { mode: 0o700 });
  await protectDirectory(target);
  const profile = profilePaths(target, settings);
  const token = randomUUID();
  await writeFile(path.join(target, 'gateway.token'), token, { flag: 'wx', mode: 0o600 });
  await writeFile(profile.bridgeFile, `${JSON.stringify({ workspaceRoot, permissions: ['workspace:read'], components: [] }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  const model = 'deepseek/deepseek-v4-flash';
  const config = {
    gateway: { mode: 'local', bind: 'loopback', port, auth: { mode: 'token', token: '${OPENCLAW_GATEWAY_TOKEN}' }, controlUi: { enabled: false } },
    logging: { file: path.join(target, 'gateway.log'), maxFileBytes: 1_048_576, level: 'info' },
    agents: { ownership: 'explicit', defaults: { workspace: workspaceRoot, skipBootstrap: true,
      model: { primary: model, fallbacks: [] }, thinkingDefault: 'off', timeoutSeconds: settings.timeoutSeconds, maxConcurrent: 1,
      heartbeat: { every: '0m' }, models: { [model]: { params: { maxTokens: settings.maxOutputTokens } } } },
      entries: { main: { workspace: workspaceRoot } } },
    tools: { allow: ['read', 'session_status', 'knowledge_search', 'knowledge_verify', 'bridge_capabilities', 'bridge_invoke'],
      codeMode: { enabled: false }, fs: { workspaceOnly: true }, loopDetection: { enabled: true } },
    models: { mode: 'replace', providers: { deepseek: {
      baseUrl: 'https://api.deepseek.com', api: 'openai-completions', apiKey: '${DEEPSEEK_API_KEY}', timeoutSeconds: 45,
      agentRuntime: { id: 'openclaw' }, models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', reasoning: true, input: ['text'],
        contextWindow: 128000, maxTokens: settings.maxOutputTokens,
        cost: { input: 0.44, output: 1.32, cacheRead: 0.014, cacheWrite: 0 },
        compat: { supportsUsageInStreaming: true, supportsReasoningEffort: true, maxTokensField: 'max_tokens' } }],
    } } },
    plugins: { enabled: true, allow: ['dsh-bridge', 'deepseek'], slots: { memory: 'none' },
      load: { paths: [packageRoot, installation.provider] }, entries: {
        'dsh-bridge': { enabled: true, hooks: { allowConversationAccess: true }, config: { configFile: profile.bridgeFile } },
        deepseek: { enabled: true },
      } },
  };
  await writeFile(profile.gatewayFile, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  await writeFile(profile.file, `${JSON.stringify(settings, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return profile;
}

async function availablePort(port: number): Promise<number> {
  if (!Number.isInteger(port) || (port !== 0 && (port < 1024 || port > 65535))) throw new BridgeError('PORT_INVALID', 'Use port 0 or an integer between 1024 and 65535');
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const address = server.address() as net.AddressInfo;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

function profilePaths(directory: string, settings: LocalSettings): LocalProfile {
  return { directory, file: path.join(directory, 'local.json'), bridgeFile: path.join(directory, 'bridge.json'), gatewayFile: path.join(directory, 'openclaw.json'), settings };
}

export async function readLocal(directory: string): Promise<LocalProfile> {
  assertPlatform();
  const supplied = path.resolve(directory);
  const stat = await lstat(supplied);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) {
    throw new BridgeError('LOCAL_DIRECTORY_UNSAFE', 'The local state directory must be current-user-owned, non-symlink, and mode 700');
  }
  const root = await realpath(supplied);
  const file = path.join(root, 'local.json');
  await privateFile(file);
  const raw: unknown = JSON.parse(await readFile(file, 'utf8'));
  if (!validate(raw)) throw new BridgeError('LOCAL_CONFIG_INVALID', 'Invalid local.json settings');
  const settings = raw as LocalSettings;
  if (!path.isAbsolute(settings.workspaceRoot) || !path.isAbsolute(settings.credentialFile)) throw new BridgeError('LOCAL_CONFIG_INVALID', 'Workspace and credential paths must be absolute');
  const workspace = await realpath(settings.workspaceRoot);
  const secret = await realpath(settings.credentialFile);
  if (workspace !== settings.workspaceRoot || secret !== settings.credentialFile || contained(workspace, root) || contained(root, workspace) || contained(workspace, secret)) {
    throw new BridgeError('LOCAL_LAYOUT_UNSAFE', 'Private state and credentials must remain outside the canonical searchable workspace');
  }
  const profile = profilePaths(root, settings);
  for (const item of [profile.bridgeFile, profile.gatewayFile, path.join(root, 'gateway.token')]) await privateFile(item);
  return profile;
}

async function localEnvironment(profile: LocalProfile): Promise<{ env: NodeJS.ProcessEnv; redact: (text: unknown) => string }> {
  await validateLocalBoundary(profile);
  const key = await credential(profile.settings.credentialFile);
  const token = (await readFile(path.join(profile.directory, 'gateway.token'), 'utf8')).trim();
  if (!token) throw new BridgeError('LOCAL_CONFIG_INVALID', 'The Gateway token is empty');
  return { env: { ...executionEnvironment(), NO_COLOR: '1', DEEPSEEK_API_KEY: key, OPENCLAW_GATEWAY_TOKEN: token,
    OPENCLAW_STATE_DIR: path.join(profile.directory, 'host-state'), OPENCLAW_CONFIG_PATH: profile.gatewayFile,
    OPENCLAW_SKIP_CHANNELS: '1', OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: '1' },
  redact: text => String(text).replaceAll(key, '[REDACTED]').replaceAll(token, '[REDACTED]') };
}

/** Prevent manually edited profile files from rerouting credentials or expanding searchable roots. */
export async function validateLocalBoundary(profile: LocalProfile): Promise<void> {
  const host = JSON.parse(await readFile(profile.gatewayFile, 'utf8'));
  const bridge = JSON.parse(await readFile(profile.bridgeFile, 'utf8'));
  const provider = host.models?.providers?.deepseek;
  const settings = profile.settings;
  if (bridge.workspaceRoot !== settings.workspaceRoot || host.agents?.defaults?.workspace !== settings.workspaceRoot ||
      Object.values(host.agents?.entries ?? {}).some(entry => (entry as { workspace?: unknown }).workspace !== settings.workspaceRoot) ||
      Object.keys(host.models?.providers ?? {}).join(',') !== 'deepseek' || provider?.baseUrl !== 'https://api.deepseek.com' ||
      provider.apiKey !== '${DEEPSEEK_API_KEY}' || provider.agentRuntime?.id !== 'openclaw' ||
      host.gateway?.bind !== 'loopback' || host.gateway?.port !== settings.port ||
      host.gateway?.auth?.mode !== 'token' || host.gateway.auth.token !== '${OPENCLAW_GATEWAY_TOKEN}' ||
      host.agents?.defaults?.model?.primary !== 'deepseek/deepseek-v4-flash' ||
      host.agents.defaults.model.fallbacks?.length !== 0 || host.agents.defaults.timeoutSeconds !== settings.timeoutSeconds ||
      host.agents.defaults.models?.['deepseek/deepseek-v4-flash']?.params?.maxTokens !== settings.maxOutputTokens ||
      host.plugins?.entries?.['dsh-bridge']?.config?.configFile !== profile.bridgeFile || host.tools?.fs?.workspaceOnly !== true) {
    throw new BridgeError('LOCAL_BOUNDARY_CHANGED', 'The local profile must retain its private loopback route, direct provider, bounded task settings, and canonical workspace; create a new profile for a different layout');
  }
  let lock: { platform?: string; arch?: string; nativeAbi?: string; libc?: string; napi?: boolean };
  try { lock = JSON.parse(await readFile(path.join(packageRoot, 'runtime-lock.json'), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  if (lock.platform && lock.platform !== process.platform || lock.arch && lock.arch !== process.arch) throw new BridgeError('PLATFORM_UNSUPPORTED', 'Install the CoNest archive for this operating system and architecture');
  const { header } = process.report.getReport() as { header: { glibcVersionRuntime?: string } };
  const current = (header.glibcVersionRuntime ?? '0.0').split('.').map(Number);
  const built = (lock.libc ?? '0.0').split('.').map(Number);
  if ((!lock.napi && lock.nativeAbi !== process.versions.modules) || (process.platform === 'linux' && (current[0]! < built[0]! || current[0] === built[0] && current[1]! < built[1]!))) {
    throw new BridgeError('PLATFORM_UNSUPPORTED', 'The installed native runtime requires the recorded Node ABI and a glibc version at least as recent as its build');
  }
}

/** Read-only checks. The optional provider probe lists models and does not run inference. */
export async function doctorLocal(profile: LocalProfile, probe = false): Promise<unknown> {
  const installation = await localInstallation();
  const { env, redact } = await localEnvironment(profile);
  try {
    const checked = await execute(process.execPath, [installation.cli, 'config', 'validate', '--json'], { env, cwd: profile.settings.workspaceRoot, timeout: 30_000, maxBuffer: 2_000_000 });
    const config = JSON.parse(checked.stdout) as { valid?: boolean; warnings?: Array<{ message?: string }> };
    if (!config.valid) throw new BridgeError('LOCAL_CONFIG_INVALID', 'OpenClaw configuration validation failed');
    if (config.warnings?.some(warning => /plugin not installed.*(?:deepseek|dsh-bridge)/i.test(warning.message ?? ''))) {
      throw new BridgeError('INSTALLATION_INCOMPLETE', 'A required plugin is not discoverable. Use an ordinary npm installation; hardlinked development-store files may be rejected by host security checks');
    }
    let provider: unknown = { checked: false };
    if (probe) {
      const response = await fetch('https://api.deepseek.com/models', { headers: { authorization: `Bearer ${env.DEEPSEEK_API_KEY}` }, signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new BridgeError('PROVIDER_UNAVAILABLE', `DeepSeek model listing returned HTTP ${response.status}`);
      const body = await response.json() as { data?: Array<{ id: string }> };
      if (!body.data?.some(item => item.id === 'deepseek-v4-flash')) throw new BridgeError('MODEL_UNAVAILABLE', 'The account catalog does not expose deepseek-v4-flash');
      provider = { checked: true, flashAvailable: true };
    }
    const hostManifest = JSON.parse(await readFile(path.join(installation.host, 'package.json'), 'utf8')) as { version?: string };
    return { ok: true, bridgeVersion: BRIDGE_VERSION, hostVersion: hostManifest.version ?? HOST_VERSION,
      hostCompatibility: OPENCLAW_COMPATIBILITY_RANGE, node: process.version,
      credential: 'configured-private-file', provider, config, service: await statusLocal(profile) };
  } catch (error) {
    const detail = error as Error & { stderr?: string };
    throw new BridgeError('LOCAL_CHECK_FAILED', redact(`${detail.message}${detail.stderr ? `\n${detail.stderr}` : ''}`));
  }
}

export async function statusLocal(profile: LocalProfile): Promise<LocalStatus> {
  return await controlRequest<LocalStatus>(profile.file, 'status') ?? { state: 'stopped', bridgeVersion: BRIDGE_VERSION,
    model: 'deepseek/deepseek-v4-flash', port: profile.settings.port };
}

/** Start only the owned local supervisor; no global OpenClaw service is installed or retargeted. */
export async function startLocal(profile: LocalProfile): Promise<LocalStatus> {
  const previous = await statusLocal(profile);
  if (previous.state === 'ready') return previous;
  if (previous.state !== 'stopped') throw new BridgeError('LOCAL_BUSY', `The local service is ${previous.state}`);
  await doctorLocal(profile);
  const log = path.join(profile.directory, 'launcher.log');
  try { await privateFile(log); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const output = await open(log, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  const child = spawn(process.execPath, [path.join(packageRoot, 'dist/local-cli.js'), 'serve', '--state', profile.directory],
    { cwd: profile.settings.workspaceRoot, env: executionEnvironment(), detached: true, stdio: ['ignore', output.fd, output.fd] });
  await output.close();
  let spawnError: Error | undefined;
  child.once('error', error => { spawnError = error; });
  child.unref();
  for (let i = 0; i < 300; i++) {
    if (spawnError || child.exitCode !== null || child.signalCode !== null) break;
    const status = await statusLocal(profile);
    if (status.state === 'ready') return status;
    if (status.state === 'failed') break;
    await pause(200);
  }
  // This child is owned by this start attempt, not a PID loaded from disk.
  await stopOwnedChild(child, 15_000);
  throw new BridgeError('LOCAL_START_FAILED', 'Local startup failed; inspect the private launcher.log and gateway.log');
}

export async function stopLocal(profile: LocalProfile): Promise<LocalStatus> {
  const before = await statusLocal(profile);
  if (before.state === 'stopped') return before;
  await controlRequest(profile.file, 'manage', { action: 'stop' });
  for (let i = 0; i < 150; i++) {
    const status = await statusLocal(profile);
    if (status.state === 'stopped') return status;
    await pause(100);
  }
  throw new BridgeError('LOCAL_STOP_TIMEOUT', 'The owned supervisor has not confirmed shutdown; no unrelated process was signalled');
}

/** Run a foreground supervisor until stopped. It never automatically replays model work or restarts the Gateway. */
export async function serveLocal(profile: LocalProfile): Promise<void> {
  const installation = await localInstallation();
  const { env, redact } = await localEnvironment(profile);
  const status: LocalStatus = { state: 'starting', supervisorPid: process.pid, bridgeVersion: BRIDGE_VERSION,
    model: 'deepseek/deepseek-v4-flash', port: profile.settings.port };
  let stop!: () => void;
  const stopped = new Promise<void>(resolve => { stop = resolve; });
  const close = await serveControl(profile.file, async (method, params) => {
    if (method === 'status') {
      const worker = status.state === 'ready' ? await controlRequest<RuntimeStatus>(profile.bridgeFile, 'status').catch(() => undefined) : undefined;
      return { ...status, ...(status.state === 'ready' ? { bridgeState: worker?.state ?? 'unavailable' } : {}) };
    }
    if (method === 'manage' && (params as { action?: unknown } | undefined)?.action === 'stop') {
      status.state = 'stopping';
      setTimeout(stop, 25);
      return { ...status };
    }
    throw new BridgeError('METHOD_DENIED', 'The local supervisor accepts only status and stop');
  });
  let child: ChildProcess | undefined;
  let tail = '';
  const onSignal = () => { status.state = 'stopping'; stop(); };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
  try {
    await availablePort(profile.settings.port);
    child = spawn(process.execPath, [installation.cli, 'gateway', 'run', '--port', String(profile.settings.port)],
      { cwd: profile.settings.workspaceRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
    status.gatewayPid = child.pid;
    const capture = (chunk: Buffer) => { tail = `${tail}${chunk.toString('utf8')}`.slice(-16_384); };
    child.stdout!.on('data', capture);
    child.stderr!.on('data', capture);
    child.once('error', error => { status.failure = redact(error.message); status.state = 'failed'; stop(); });
    child.once('exit', (code, signal) => {
      if (status.state !== 'stopping') {
        status.state = 'failed'; status.failure = `Gateway exited with code ${code} and signal ${signal}; interrupted work was not replayed`;
      }
      stop();
    });
    for (let i = 0; ; i++) {
      if (status.state === 'stopping') return;
      if (status.state === 'failed' || i >= 250) throw new BridgeError('LOCAL_START_FAILED', redact(`Gateway did not become ready. ${status.failure ?? ''}\n${tail}`));
      try {
        const response = await fetch(`http://127.0.0.1:${profile.settings.port}/health`, { signal: AbortSignal.timeout(500) });
        if (response.ok) {
          const catalog = await localTool(profile, 'bridge_capabilities', {});
          const body = catalog.body as { result?: { details?: CapabilityCatalog } };
          // An empty policy-filtered catalog is a successful response, not a startup failure.
          if (catalog.status === 200 && Array.isArray(body.result?.details?.capabilities)) break;
        }
      } catch { /* The listener and plugin service may still be starting. */ }
      await pause(200);
    }
    const worker = await controlRequest<RuntimeStatus>(profile.bridgeFile, 'status');
    if (!worker) throw new BridgeError('LOCAL_DEGRADED', 'The CoNest Runtime worker is not reachable');
    status.bridgeState = worker.state;
    status.state = 'ready';
    process.stdout.write(`${JSON.stringify(status)}\n`);
    await stopped;
    if (status.failure) throw new BridgeError('LOCAL_GATEWAY_EXITED', status.failure);
  } finally {
    status.state = 'stopping';
    if (child) await stopOwnedChild(child);
    await close();
    process.removeListener('SIGTERM', onSignal);
    process.removeListener('SIGINT', onSignal);
  }
}

async function stopOwnedChild(child: ChildProcess, graceMs = 10_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  if (process.platform === 'win32') { await stopProcessTree(child); return; }
  child.kill('SIGTERM');
  for (let i = 0; i < graceMs / 100 && child.exitCode === null && child.signalCode === null; i++) await pause(100);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  if (child.exitCode === null && child.signalCode === null) await new Promise<void>(resolve => child.once('exit', () => resolve()));
}

export async function localTool(profile: LocalProfile, tool: string, args: unknown, agent = 'main'): Promise<{ status: number; body: unknown }> {
  const token = (await readFile(path.join(profile.directory, 'gateway.token'), 'utf8')).trim();
  const response = await fetch(`http://127.0.0.1:${profile.settings.port}/tools/invoke`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ tool, args, sessionKey: `agent:${agent}:local-operator` }), signal: AbortSignal.timeout(5000),
  });
  return { status: response.status, body: await response.json() };
}

/** One explicit, chargeable CLI task through the already running Gateway. */
export async function askLocal(profile: LocalProfile, message: string, agent = 'main'): Promise<unknown> {
  if (!message.trim() || message.length > 32_000 || !/^[a-z][a-z0-9-]{0,63}$/.test(agent)) throw new BridgeError('LOCAL_ARGUMENT_INVALID', 'Provide a bounded message and a valid agent id');
  if ((await statusLocal(profile)).state !== 'ready') throw new BridgeError('LOCAL_NOT_READY', 'Start the local service before asking a question');
  const { cli } = await localInstallation();
  const { env, redact } = await localEnvironment(profile);
  try {
    const result = await execute(process.execPath, [cli, 'agent', '--session-key', `agent:${agent}:local-${randomUUID()}`,
      '--thinking', 'off', '--timeout', String(profile.settings.timeoutSeconds), '--json', '--message', message],
    { cwd: profile.settings.workspaceRoot, env, timeout: (profile.settings.timeoutSeconds + 30) * 1000, maxBuffer: 8_000_000 });
    const parsed = JSON.parse(redact(result.stdout)) as { status?: unknown };
    if (parsed.status !== 'ok') throw new BridgeError('LOCAL_TASK_FAILED', 'The Gateway did not report a successful task');
    return parsed;
  } catch (error) {
    const detail = error as Error & { stdout?: string; stderr?: string };
    throw new BridgeError('LOCAL_TASK_FAILED', redact(`${detail.message}\n${detail.stdout ?? ''}\n${detail.stderr ?? ''}`));
  }
}
