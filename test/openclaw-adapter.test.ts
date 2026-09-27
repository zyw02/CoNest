import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

// The SDK owns process-lifetime SQLite handles. Test it in a child so Windows
// releases those handles before cleanup, and no test can touch the user's state.
test('real SDK config, policy and transcript contracts', async () => {
  const state = await mkdtemp(path.join(tmpdir(), 'conest-sdk-state-'));
  try {
    await promisify(execFile)(process.execPath,
      ['--import', 'tsx', '--test', 'test/fixtures/openclaw-adapter.ts'], {
        env: { ...process.env, OPENCLAW_STATE_DIR: state }, timeout: 90_000, maxBuffer: 4 * 1024 * 1024,
      }).catch(error => assert.fail(`${error.stdout ?? ''}\n${error.stderr ?? ''}\n${error.message}`));
  } finally {
    await rm(state, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
