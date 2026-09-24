import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, rm } from 'node:fs/promises';
import net, { type Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { readFrames } from './framing.js';
import { protectDirectory, assertPrivateFile } from './platform-support.mjs';
import { BridgeError, errorData, type RuntimeStatus } from './types.js';
import { isWireResponse } from './protocol.js';

function controlLocation(configFile: string): { address: string; directory: string; lockFile: string } {
  const identity = createHash('sha256').update(realpathSync(configFile)).digest('hex').slice(0, 24);
  const directory = path.join(os.tmpdir(), `dsh-bridge-${process.getuid?.() ?? 'local'}`);
  const socket = path.join(directory, `${identity}.sock`);
  return { directory, lockFile: socket + '.lock', address: process.platform === 'win32' ? `\\\\.\\pipe\\conest-${identity}` : socket };
}
export function controlAddress(configFile: string): string { return controlLocation(configFile).address; }

export type ControlMethod = 'status' | 'catalog' | 'reload' | 'manage' | 'call';

/** Filesystem-authenticated local operator control; raw task grants are never exported. */
export async function serveControl(
  configFile: string,
  handle: (method: ControlMethod, params: unknown, signal: AbortSignal) => Promise<unknown>,
): Promise<() => Promise<void>> {
  const { address, directory, lockFile } = controlLocation(configFile);
  await protectDirectory(directory);
  const directoryStat = await lstat(directory);
  if (!directoryStat.isDirectory() || (process.platform !== 'win32' && ((directoryStat.mode & 0o077) !== 0
    || (process.getuid && directoryStat.uid !== process.getuid())))) throw new BridgeError('CONTROL_DIRECTORY_UNSAFE', 'The control directory must be owned by the current user with mode 0700');
  const nonce = randomUUID();
  await acquireLock(lockFile, nonce);
  const sockets = new Set<Socket>();
  const server = net.createServer(socket => {
    const lifetime = new AbortController();
    sockets.add(socket);
    socket.once('close', () => { sockets.delete(socket); lifetime.abort(new BridgeError('TASK_CANCELLED', 'The operator connection closed')); });
    socket.setTimeout(120_000, () => socket.destroy());
    let handled = false;
    readFrames(socket, () => 256_000, line => {
      if (handled) { socket.destroy(); return; }
      handled = true;
      void (async () => {
        let id = 'invalid';
        try {
          const request = JSON.parse(line) as { id?: unknown; method?: unknown; params?: unknown; nonce?: unknown };
          if (typeof request.id !== 'string') throw new BridgeError('INVALID_REQUEST', 'A control request id is required');
          id = request.id;
          if (process.platform === 'win32' && request.nonce !== nonce) throw new BridgeError('CONTROL_AUTH_REQUIRED', 'Control pipe authentication failed');
          if (request.method !== 'status' && request.method !== 'catalog' && request.method !== 'reload' && request.method !== 'manage' && request.method !== 'call') {
            throw new BridgeError('METHOD_DENIED', 'The operator socket accepts only status, reload, component management, and scoped calls');
          }
          const result = await handle(request.method, request.params, lifetime.signal);
          socket.end(`${JSON.stringify({ id, ok: true, result })}\n`);
        } catch (error) { socket.end(`${JSON.stringify({ id, ok: false, error: errorData(error) })}\n`); }
      })();
    }, () => socket.destroy());
  });
  try {
    try {
      if (process.platform !== 'win32') {
      const socketStat = await lstat(address);
      if (!socketStat.isSocket()) throw new BridgeError('CONTROL_ADDRESS_UNSAFE', 'The control address already exists and is not a socket');
      await rm(address);
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(address, () => { server.off('error', reject); resolve(); });
    });
    if (process.platform !== 'win32') await chmod(address, 0o600);
  } catch (error) {
    server.close();
    await releaseLock(lockFile, nonce);
    throw error;
  }
  return async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await releaseLock(lockFile, nonce);
  };
}

/** Returns undefined only when there is no reachable owner of this configuration. */
export async function controlRequest<T = RuntimeStatus>(configFile: string, method: ControlMethod, params?: unknown): Promise<T | undefined> {
  const { address, lockFile } = controlLocation(configFile);
  let nonce: string | undefined;
  if (process.platform === 'win32') {
    try { await assertPrivateFile(lockFile); nonce = JSON.parse(await readFile(lockFile, 'utf8')).nonce; }
    catch(error) { if((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    if (!nonce) throw new BridgeError('CONTROL_LOCK_INVALID', 'Control pipe credential is missing');
  }
  return await new Promise((resolve, reject) => {
    const socket = net.connect(address);
    const id = randomUUID();
    const timer = setTimeout(() => { socket.destroy(); reject(new BridgeError('CONTROL_TIMEOUT', 'The worker control operation timed out')); }, 120_000);
    let responded = false;
    socket.once('connect', () => socket.write(`${JSON.stringify({ id, method, params, ...(nonce ? { nonce } : {}) })}\n`));
    socket.once('error', error => {
      clearTimeout(timer);
      if (['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code ?? '')) resolve(undefined);
      else reject(error);
    });
    socket.once('close', () => {
      clearTimeout(timer);
      if (!responded) reject(new BridgeError('CONTROL_DISCONNECTED', 'The worker disconnected before confirming the management result; inspect state before retrying'));
    });
    readFrames(socket, () => 2_000_000, line => {
      responded = true;
      clearTimeout(timer);
      try {
        const response = JSON.parse(line) as unknown;
        if (!isWireResponse(response) || response.id !== id) throw new BridgeError('INVALID_RESPONSE', 'The worker returned an invalid control response');
        if (response.ok) resolve(response.result as T);
        else reject(new BridgeError(response.error.code, response.error.message));
      } catch (error) { reject(error); }
      socket.destroy();
    }, error => { clearTimeout(timer); socket.destroy(); reject(error); });
  });
}

export async function acquireLock(file: string, nonce: string): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(file, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, nonce }), 'utf8'); } finally { await handle.close(); }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let previous: { pid?: unknown };
      try { previous = JSON.parse(await readFile(file, 'utf8')); } catch { throw new BridgeError('WORKER_ALREADY_RUNNING', 'Another worker is acquiring this configuration'); }
      if (typeof previous.pid !== 'number' || previous.pid <= 0) throw new BridgeError('CONTROL_LOCK_INVALID', 'The worker lock is invalid');
      try { process.kill(previous.pid, 0); } catch (probe) {
        if ((probe as NodeJS.ErrnoException).code === 'ESRCH') { await rm(file); continue; }
        throw probe;
      }
      throw new BridgeError('WORKER_ALREADY_RUNNING', 'A worker already owns this configuration; use its control socket');
    }
  }
  throw new BridgeError('WORKER_ALREADY_RUNNING', 'Another worker acquired this configuration');
}

export async function releaseLock(file: string, nonce: string): Promise<void> {
  try {
    const current = JSON.parse(await readFile(file, 'utf8')) as { nonce?: string };
    if (current.nonce === nonce) await rm(file);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
