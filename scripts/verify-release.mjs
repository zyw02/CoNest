import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { reportPath } from './report-path.mjs';

const execute = promisify(execFile);
const source = fileURLToPath(new URL('..', import.meta.url));
assert.equal(process.argv.length, 4, 'Usage: verify-release.mjs FINAL_ARCHIVE LIVE_TESTED_ARCHIVE');
const readJson = async file => JSON.parse(await readFile(path.resolve(source, file), 'utf8'));
const finalReport = await readJson(reportPath('installation.json'));
const liveReport = await readJson(reportPath('installation-live.json'));
const fingerprint = async (file, report) => {
  const archive = path.resolve(file);
  const sha256 = createHash('sha256').update(await readFile(archive)).digest('hex');
  assert.equal(sha256, report.archiveSha256, 'The supplied archive must match its actual installation report');
  assert.ok(report.checks.every(check => check.passed), 'All recorded installation checks must pass');
  const listing = (await execute('tar', ['-tzf', archive], { maxBuffer: 4_000_000 })).stdout.trim().split('\n');
  const files = listing.filter(member => !member.endsWith('/') && (
    member.startsWith('package/dist/') || member.startsWith('package/examples/') ||
    ['package/package.json', 'package/openclaw.plugin.json', 'package/runtime-lock.json', 'package/conest.config.example.json'].includes(member)
  )).sort();
  assert.ok(files.length > 10, 'A release must include its compiled runtime and metadata');
  const hash = createHash('sha256');
  for (const member of files) {
    const result = await execute('tar', ['-xOzf', archive, member], { encoding: 'buffer', maxBuffer: 8_000_000 });
    hash.update(member).update('\0').update(result.stdout).update('\0');
  }
  return { archive: path.relative(source, archive), sha256, runtimeFingerprint: hash.digest('hex'), fingerprintedFiles: files.length };
};
assert.equal(finalReport.directProvider, false);
assert.equal(liveReport.directProvider, true);
const final = await fingerprint(process.argv[2], finalReport);
const live = await fingerprint(process.argv[3], liveReport);
assert.equal(final.runtimeFingerprint, live.runtimeFingerprint, 'Documentation-only repackaging must not change runtime content');
const report = { recordedAt: new Date().toISOString(), bridgeVersion: finalReport.bridgeVersion, final, live,
  equivalentRuntime: true, finalArchiveCleanInstallPassed: true, liveCandidateDirectProviderPassed: true,
  method: 'Compiled runtime, examples, plugin/package metadata, default config, and complete bundled dependency content hashes are identical; documentation and archive bytes may differ.' };
await writeFile(reportPath('release.json'), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
