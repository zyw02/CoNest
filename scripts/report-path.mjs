import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
export const packageVersion = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
// Keep pre-CoNest acceptance reports immutable; never relabel historical paid runs.
const profile = process.env.CONEST_REPORT_PROFILE;
if (profile && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(profile)) throw new Error('Invalid CONEST_REPORT_PROFILE');
export const reportDirectory = path.join(root, '.local/reports', profile ?? `conest-${packageVersion}`);
export const reportPath = name => path.join(reportDirectory, name);
