import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import gitInspector from '../examples/git-inspector/component.mjs';
import webFetch from '../examples/web-fetch/component.mjs';
import aiDebate from '../examples/ai-debate/component.mjs';
import systemInfo from '../examples/system-info/component.mjs';

const runGit = promisify(execFile);

function handler(component, name, config = {}) {
  const handlers = new Map();
  component.apply({ bridgeCapabilities: { register(_ctx, id, fn) { handlers.set(id, fn); } } }, config);
  assert.ok(handlers.has(name));
  return handlers.get(name);
}

function invocation(workspaceRoot, signal = new AbortController().signal) {
  return { workspaceRoot, signal, progress() {} };
}

test('git inspector confines caller paths to the admitted workspace', async t => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'conest-git-workspace-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'conest-git-outside-'));
  t.after(async () => { await rm(workspace, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); });
  await symlink(outside, path.join(workspace, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  const status = handler(gitInspector, 'git_status');
  await assert.rejects(status({ path: outside }, invocation(workspace)), /outside the admitted workspace/);
  await assert.rejects(status({ path: 'escape' }, invocation(workspace)), /outside the admitted workspace/);
  assert.deepEqual(await status({}, invocation(workspace)), { isRepository: false });
  const diff = handler(gitInspector, 'git_diff');
  await assert.rejects(diff({ ref: '--output=/tmp/unwanted' }, invocation(workspace)), /Invalid Git ref/);
});

test('git inspector does not discover a repository above the admitted workspace', async t => {
  const outer = await mkdtemp(path.join(os.tmpdir(), 'conest-git-parent-'));
  const workspace = path.join(outer, 'workspace');
  t.after(() => rm(outer, { recursive: true, force: true }));
  await runGit('git', ['init', '-q', outer]);
  await writeFile(path.join(outer, 'outside.txt'), 'outside workspace');
  await runGit('git', ['-C', outer, 'add', 'outside.txt']);
  await runGit('git', ['-C', outer, '-c', 'user.name=Tester', '-c', 'user.email=test@example.com', 'commit', '-qm', 'private parent commit']);
  await mkdir(workspace);

  assert.deepEqual(await handler(gitInspector, 'git_status')({}, invocation(workspace)), { isRepository: false });
  assert.deepEqual(await handler(gitInspector, 'git_log')({}, invocation(workspace)), { commits: [] });
});

test('git status does not run a repository configured fsmonitor', async t => {
  if (process.platform === 'win32') return t.skip('fsmonitor fixture uses a POSIX executable');
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'conest-git-fsmonitor-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await runGit('git', ['init', '-q', workspace]);
  await writeFile(path.join(workspace, 'tracked.txt'), 'tracked');
  await runGit('git', ['-C', workspace, 'add', 'tracked.txt']);
  await runGit('git', ['-C', workspace, '-c', 'user.name=Tester', '-c', 'user.email=test@example.com', 'commit', '-qm', 'initial']);
  const monitor = path.join(workspace, 'monitor.sh');
  await writeFile(monitor, '#!/bin/sh\nprintf invoked > "$0.marker"\n');
  await chmod(monitor, 0o755);
  await runGit('git', ['-C', workspace, 'config', 'core.fsmonitor', monitor]);

  assert.equal((await handler(gitInspector, 'git_status')({}, invocation(workspace))).isRepository, true);
  await assert.rejects(access(`${monitor}.marker`), { code: 'ENOENT' });
  await runGit('git', ['-C', workspace, 'status', '--porcelain=v1']);
  await access(`${monitor}.marker`);
});

test('git diff does not run configured clean or process filters', async t => {
  if (process.platform === 'win32') return t.skip('filter fixture uses a POSIX executable');
  for (const kind of ['clean', 'process']) {
    const workspace = await mkdtemp(path.join(os.tmpdir(), `conest-git-${kind}-`));
    t.after(() => rm(workspace, { recursive: true, force: true }));
    await runGit('git', ['init', '-q', workspace]);
    await writeFile(path.join(workspace, '.gitattributes'), '*.txt filter=probe\n');
    await writeFile(path.join(workspace, 'tracked.txt'), 'before\n');
    await runGit('git', ['-C', workspace, 'add', '.gitattributes', 'tracked.txt']);
    await runGit('git', ['-C', workspace, '-c', 'user.name=Tester', '-c', 'user.email=test@example.com', 'commit', '-qm', 'initial']);
    const marker = path.join(workspace, `${kind}.marker`);
    const helper = path.join(workspace, `${kind}.sh`);
    await writeFile(helper, `#!/bin/sh\nprintf invoked > "${marker}"\ncat\n`);
    await chmod(helper, 0o755);
    await runGit('git', ['-C', workspace, 'config', `filter.probe.${kind}`, helper]);
    await runGit('git', ['-C', workspace, 'config', 'filter.probe.required', 'true']);
    await writeFile(path.join(workspace, 'tracked.txt'), 'after\n');

    const status = await handler(gitInspector, 'git_status')({}, invocation(workspace));
    assert.ok(status.modified.includes('tracked.txt'), 'status should include the modified file');
    const result = await handler(gitInspector, 'git_diff')({}, invocation(workspace));
    assert.ok(result.diff.includes('+after'), 'diff should include the modified line');
    await assert.rejects(access(marker), { code: 'ENOENT' });
  }
});

test('web fetch requires operator-approved origins and checks every redirect', async t => {
  let hits = 0;
  const server = createServer((req, res) => {
    hits++;
    if (req.url === '/redirect') {
      res.writeHead(302, { location: `http://localhost:${server.address().port}/secret` });
      res.end();
    } else res.end('<title>Approved page</title><p>content</p>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const denied = await handler(webFetch, 'fetch_url')({ url: origin + '/secret' }, invocation(process.cwd()));
  assert.equal(denied.statusCode, 0);
  assert.equal(hits, 0, 'default configuration must make no network request');
  const permitted = handler(webFetch, 'fetch_url', { allowedOrigins: [origin] });
  const page = await permitted({ url: origin + '/page' }, invocation(process.cwd()));
  assert.equal(page.statusCode, 200);
  assert.equal(page.title, 'Approved page');
  const redirected = await permitted({ url: origin + '/redirect' }, invocation(process.cwd()));
  assert.equal(redirected.statusCode, 0);
  assert.equal(hits, 2, 'redirect must not contact an origin absent from operator configuration');
  const credentials = await permitted({ url: origin.replace('://', '://user:pass@') }, invocation(process.cwd()));
  assert.equal(credentials.statusCode, 0);
  assert.equal(hits, 2);
});

test('web fetch stops after cancellation and bounds redirects', async t => {
  const server = createServer((req, res) => {
    if (req.url === '/slow') {
      setTimeout(() => { if (!res.destroyed) res.end('<title>late</title>'); }, 500);
    } else {
      res.writeHead(302, { location: '/loop' });
      res.end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const fetchUrl = handler(webFetch, 'fetch_url', { allowedOrigins: [base] });
  const loop = await fetchUrl({ url: base + '/loop' }, invocation(process.cwd()));
  assert.match(loop.error, /Too many redirects/);
  const abort = new AbortController();
  const pending = fetchUrl({ url: base + '/slow' }, invocation(process.cwd(), abort.signal));
  abort.abort(new Error('task cancelled'));
  await assert.rejects(pending, /task cancelled/);
});

test('top processes returns executable names without command arguments', async t => {
  if (process.platform === 'win32') return t.skip('process listing fixture uses a POSIX executable');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'conest-process-list-'));
  const oldPath = process.env.PATH;
  t.after(async () => {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    await rm(dir, { recursive: true, force: true });
  });
  const ps = path.join(dir, 'ps');
  await writeFile(ps, '#!/bin/sh\nif [ "$1" = "-eo" ]; then\n  printf "%s\\n" "4242 12.5 3.0 2048 node"\nelse\n  printf "%s\\n" "root 4242 12.5 3.0 10000 2048 ? R 00:00 0:01 node server.js --token=private-value"\nfi\n');
  await chmod(ps, 0o755);
  process.env.PATH = `${dir}${path.delimiter}${oldPath || ''}`;

  const result = await handler(systemInfo, 'top_processes')({ count: 1 }, invocation(process.cwd()));
  assert.deepEqual(result, { processes: [{ pid: 4242, cpuPercent: 12.5, memPercent: 3, rssMB: 2, name: 'node' }] });
  assert.doesNotMatch(JSON.stringify(result), /private-value/);
});

test('AI debate reports missing credentials as a component error', async () => {
  const debate = handler(aiDebate, 'ai_debate');
  await assert.rejects(debate({ topic: 'Should teams use one repository?' }, invocation(process.cwd())), /No DeepSeek API key configured/);
});
