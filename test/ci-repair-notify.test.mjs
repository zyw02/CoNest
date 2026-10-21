import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/ci-repair-notify.yml', import.meta.url), 'utf8');
const script = workflow.split('          script: |\n')[1].split('\n').map(line => line.slice(12)).join('\n');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const notify = new AsyncFunction('github', 'context', 'core', 'process', 'fetch', script);
const sha = 'a'.repeat(40);
const nextSha = 'b'.repeat(40);

function pr(overrides = {}) {
  return { number: 19, state: 'open', head: { sha }, merge_commit_sha: null,
    user: { login: 'contributor' }, labels: [], ...overrides };
}

async function execute(options = {}) {
  const run = { id: 123, run_attempt: 1, workflow_id: 456, head_sha: sha,
    head_branch: 'develop', head_repository: { full_name: 'zyw02/CoNest' },
    event: 'push', status: 'completed', conclusion: 'failure',
    created_at: '2026-10-21T10:00:00Z', pull_requests: [], ...options.run };
  const event = { ...run, ...options.event };
  const calls = [];
  const messages = [];
  const summaries = [];
  const listRuns = () => {};
  const listAssociated = () => {};
  const github = {
    rest: {
      actions: { getWorkflowRun: async () => ({ data: run }), listWorkflowRuns: listRuns },
      git: {
        getRef: async () => ({ data: { object: { sha: options.branchSha || sha } } }),
        getCommit: async () => ({ data: { parents: (options.mergeParents || [nextSha]).map(sha => ({ sha })) } }),
      },
      repos: { listPullRequestsAssociatedWithCommit: listAssociated },
      pulls: { get: async ({ pull_number }) => {
        const found = (options.prs || []).find(item => item.number === pull_number);
        assert.ok(found, 'must resolve the current PR through GitHub');
        return { data: found };
      } },
    },
    paginate: async (method, params) => {
      assert.equal(params.per_page, 100);
      if (method === listRuns) return options.runs || [run];
      if (method === listAssociated) {
        assert.equal(options.noAssociation, undefined, 'baseline must not inherit historical PR authorship');
        return options.prs || [];
      }
      throw new Error('Unexpected GitHub API');
    },
  };
  const summary = { addRaw: value => { summaries.push(value); return summary; }, write: async () => {} };
  const core = { info: value => messages.push(value), summary };
  const env = { AGENT_TRIGGER_ID: 'agtch_test', AGENT_ACCESS_TOKEN: 'test-token',
    EXCLUDED_PR_AUTHOR: 'zyw02', ...options.env };
  const fetch = async (url, init) => {
    calls.push({ url, init });
    if (options.fetchError) throw options.fetchError;
    return { status: options.httpStatus || 202, json: async () => ({ agent_trigger_run_id: 'apirun_test' }) };
  };
  await notify(github, { repo: { owner: 'zyw02', repo: 'CoNest' }, payload: { workflow_run: event } }, core, { env }, fetch);
  return { calls, messages, summaries };
}

function payload(result) {
  return JSON.parse(JSON.parse(result.calls[0].init.body).input);
}

test('current branch failure notifies once with a stable idempotency key and fixed HTTPS destination', async () => {
  const result = await execute({ noAssociation: true });
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].url, 'https://api.chatgpt.com/v1/workspace_agents/agtch_test/trigger');
  assert.equal(result.calls[0].init.headers['Idempotency-Key'], 'conest-ci:zyw02/CoNest:123:1');
  assert.equal(result.calls[0].init.redirect, 'error');
  assert.equal(payload(result).head_sha, sha);
  assert.equal(payload(result).run_attempt, 1);
  assert.match(result.summaries[0], /require separate evidence/);
  assert.ok(result.messages.includes('Cloud trigger run: apirun_test'));
  assert.ok(!JSON.stringify(result.messages).includes('test-token'));
});

test('scheduled baseline remains eligible even if its commit came from a manual PR', async () => {
  const result = await execute({ run: { event: 'schedule' }, noAssociation: true,
    prs: [pr({ user: { login: 'zyw02' } })] });
  assert.equal(result.calls.length, 1);
  assert.deepEqual(payload(result).pull_requests, []);
});

test('manual owner PR is excluded using the PR author, not the CI actor', async () => {
  const result = await execute({ run: { event: 'pull_request', head_branch: 'feature', actor: { login: 'someone-else' } },
    prs: [pr({ user: { login: 'ZYW02' } })] });
  assert.equal(result.calls.length, 0);
});

test('other contributors remain eligible even when the owner reruns CI', async () => {
  const result = await execute({ run: { event: 'pull_request', actor: { login: 'zyw02' } }, prs: [pr()] });
  assert.equal(payload(result).pull_requests[0].automation_managed, false);
});

for (const conclusion of ['failure', 'success']) {
  test(`explicitly registered repair PR authored by the owner remains eligible on ${conclusion}`, async () => {
    const result = await execute({ run: { event: 'pull_request', conclusion },
      prs: [pr({ user: { login: 'zyw02' }, labels: [{ name: 'conest:ci-repair' }] })] });
    assert.equal(payload(result).pull_requests[0].automation_managed, true);
  });
}

test('a repair-looking title or branch cannot register a manual PR', async () => {
  const result = await execute({ run: { event: 'pull_request', head_branch: 'fix/ci-repair' },
    prs: [pr({ title: 'ci: automatic repair', user: { login: 'zyw02' } })] });
  assert.equal(result.calls.length, 0);
});

test('fork PR with an empty workflow payload resolves through commit associations', async () => {
  const result = await execute({ run: { event: 'pull_request', head_branch: 'fork-branch',
    head_repository: { full_name: 'contributor/CoNest' } }, prs: [pr()] });
  assert.equal(payload(result).pull_requests[0].number, 19);
});

test('an unresolved PR event fails visibly instead of being treated as baseline', async () => {
  await assert.rejects(execute({ run: { event: 'pull_request' } }), /Unable to resolve PR provenance/);
});

test('old PR head cannot trigger a repair', async () => {
  const result = await execute({ run: { event: 'pull_request', pull_requests: [{ number: 19 }] }, prs: [pr({ head: { sha: nextSha } })] });
  assert.equal(result.calls.length, 0);
});

test('current GitHub PR merge SHA is accepted', async () => {
  const result = await execute({ run: { event: 'pull_request' },
    prs: [pr({ head: { sha: nextSha }, merge_commit_sha: sha })] });
  assert.equal(payload(result).pull_requests[0].head_sha, nextSha);
});

test('a cached merge SHA for the old head cannot dispatch after the PR changes', async () => {
  const result = await execute({ run: { event: 'pull_request' },
    prs: [pr({ head: { sha: nextSha }, merge_commit_sha: sha })], mergeParents: ['c'.repeat(40)] });
  assert.equal(result.calls.length, 0);
});

test('closed PR cannot trigger a repair', async () => {
  const result = await execute({ run: { event: 'pull_request', pull_requests: [{ number: 19 }] }, prs: [pr({ state: 'closed' })] });
  assert.equal(result.calls.length, 0);
});

test('stale branch SHA is ignored', async () => {
  assert.equal((await execute({ branchSha: nextSha })).calls.length, 0);
});

test('newer successful or pending run supersedes an earlier failed run', async () => {
  for (const status of ['completed', 'in_progress']) {
    const result = await execute({ runs: [{ id: 124, head_sha: sha, head_repository: { full_name: 'zyw02/CoNest' },
      created_at: '2026-10-21T10:01:00Z', status, conclusion: status === 'completed' ? 'success' : null }] });
    assert.equal(result.calls.length, 0);
  }
});

test('a newer run in another fork does not supersede this repository run', async () => {
  const result = await execute({ runs: [{ id: 124, head_sha: sha, head_repository: { full_name: 'another/CoNest' },
    created_at: '2026-10-21T10:01:00Z' }] });
  assert.equal(result.calls.length, 1);
});

test('an old attempt or changed conclusion cannot dispatch', async () => {
  for (const event of [{ run_attempt: 0 }, { conclusion: 'success' }]) {
    assert.equal((await execute({ event })).calls.length, 0);
  }
  assert.equal((await execute({ run: { status: 'in_progress' } })).calls.length, 0);
});

for (const conclusion of ['cancelled', 'skipped', 'neutral', 'success']) {
  test(`ordinary ${conclusion} CI does not invoke the agent`, async () => {
    assert.equal((await execute({ run: { conclusion } })).calls.length, 0);
  });
}

for (const conclusion of ['timed_out', 'action_required', 'startup_failure']) {
  test(`${conclusion} is actionable`, async () => {
    assert.equal((await execute({ run: { conclusion } })).calls.length, 1);
  });
}

test('missing credentials or malformed channel ID fails without sending a request', async () => {
  for (const env of [{ AGENT_TRIGGER_ID: '' }, { AGENT_TRIGGER_ID: 'https://other.example/token' }, { AGENT_ACCESS_TOKEN: '' }]) {
    await assert.rejects(execute({ env }), /not configured/);
  }
});

test('API errors and network errors are reported, without blind retries or fallback', async () => {
  for (const httpStatus of [200, 401, 403, 429, 500]) {
    await assert.rejects(execute({ httpStatus }), new RegExp(`HTTP ${httpStatus}`));
  }
  await assert.rejects(execute({ fetchError: new Error('connection failed') }), /connection failed/);
});
