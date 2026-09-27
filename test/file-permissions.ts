import { chmod } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/** Exercise real platform permissions on disposable test paths. */
export async function setTestPermissions(file: string, mode: number) {
  if (process.platform !== 'win32') return chmod(file, mode);
  const privateMode = (mode & 0o077) === 0;
  await promisify(execFile)('icacls.exe', privateMode
    ? [file, '/remove:g', '*S-1-1-0']
    : [file, '/grant', '*S-1-1-0:(R)'], { windowsHide: true });
}
