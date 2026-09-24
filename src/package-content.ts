import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { BridgeError } from './types.js';

/** Hash a self-contained local component bundle without importing its code. */
export function packageIntegrity(directory: string): string {
  const hash = createHash('sha256');
  let bytes = 0;
  let count = 0;
  const walk = (relative: string): void => {
    for (const name of readdirSync(path.join(directory, relative)).sort()) {
      const member = path.join(relative, name);
      const target = path.join(directory, member);
      const stat = lstatSync(target);
      if (stat.isSymbolicLink()) throw new BridgeError('INVALID_PACKAGE', `Component bundles cannot contain symbolic links: ${member}`);
      if (stat.isDirectory()) { walk(member); continue; }
      if (!stat.isFile()) throw new BridgeError('INVALID_PACKAGE', `Unsupported component package member: ${member}`);
      bytes += stat.size;
      count += 1;
      if (count > 1024 || bytes > 10 * 1024 * 1024) {
        throw new BridgeError('INVALID_PACKAGE', 'Component bundles are limited to 1024 files and 10 MiB; bundle dependencies before installation');
      }
      hash.update(`${member.split(path.sep).join('/')}\0${stat.size}\0`);
      hash.update(readFileSync(target));
    }
  };
  walk('');
  return hash.digest('hex');
}
