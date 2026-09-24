import { memoryProbeDecision, qualifyManagedMemory } from './qualify-memory.mjs';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { createLiveDeepSeek } from './live-deepseek.mjs';
import { packageVersion, reportDirectory, reportPath } from './report-path.mjs';
import { readProbeDecision, qualifyManagedRead } from './qualify-read.mjs';
import { searchProbeDecision, qualifyManagedSearch } from './qualify-search.mjs';
import { componentProbeDecision, qualifyDualLoopComponents } from './qualify-dual-loop-components.mjs';

// The fixture supplies model decisions only. All tools run inside the official Gateway.
const liveMode = process.argv.includes('--live-deepseek');
const capabilityGuidance = process.argv.includes('--capability-guidance');
const dynamicContext = process.argv.includes('--context-provider');
const dshLoop = process.argv.includes('--dsh-loop');
const memoryMigration = process.argv.includes('--memory-migration');
if (memoryMigration && !dshLoop) throw new Error('Memory qualification requires --dsh-loop');
const readMigration = process.argv.includes('--read-migration');
if (readMigration && !dshLoop) throw new Error('Read qualification requires --dsh-loop');
const searchMigration = process.argv.includes('--search-migration');
if (searchMigration && !dshLoop) throw new Error('Search qualification requires --dsh-loop');
const componentLifecycle = process.argv.includes('--component-lifecycle');
if (componentLifecycle && !dshLoop) throw new Error('Dual-loop lifecycle qualification requires --dsh-loop');
if (dshLoop && (liveMode || !process.env.CONEST_REPORT_PROFILE)) throw new Error('DSH component qualification requires a separate report profile and the local model fixture');
if ((capabilityGuidance || dynamicContext) && !process.env.CONEST_REPORT_PROFILE) throw new Error('Use CONEST_REPORT_PROFILE for unreleased host-adapter evidence');
if (dynamicContext && liveMode) throw new Error('Dynamic context qualification uses only the offline fixture');
const pluginRoot = path.resolve(process.env.CONEST_TEST_PLUGIN_ROOT ?? fileURLToPath(new URL('..', import.meta.url)));
const { CAPABILITY_GUIDANCE } = await import(pathToFileURL(path.join(pluginRoot, 'dist/host-adapter.js')).href);
const { CONTEXT_PREFIX } = await import(pathToFileURL(path.join(pluginRoot, 'dist/context-provider.js')).href);
assert.equal(JSON.parse(await readFile(path.join(pluginRoot, 'package.json'), 'utf8')).version, packageVersion, 'The tested artifact must match this qualification version');
const live = liveMode ? await createLiveDeepSeek(process.env.CONEST_CREDENTIAL_FILE ?? process.env.BRIDGE_CREDENTIAL_FILE
  ?? '/root/.config/dsh-bridge/deepseek.env') : undefined;
const execute = promisify(execFile);
const require = createRequire(path.join(pluginRoot, 'package.json'));
const sdk = require.resolve('openclaw/plugin-sdk/plugin-entry');
const cli = path.resolve(path.dirname(sdk), '../../openclaw.mjs');
const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-bridge-e2e-'));
const workspace = path.join(root, 'workspace');
const configPath = path.join(root, 'openclaw.json');
const bridgeConfig = path.join(root, 'bridge.json');
const token = randomUUID();
const marker = `bridge-evidence-${randomUUID()}`;
const quote = `${marker} was verified in the source workspace.`;
const trace = [];
const fixtureErrors = [];
const children = new Set();
let contextExpected;
const contextChecks = [];
let gatewayLog = '';
let gatewayEndpoint;
const env = { ...process.env, NO_COLOR: '1', OPENCLAW_CONFIG_PATH: configPath,
  OPENCLAW_STATE_DIR: path.join(root, 'state'), OPENCLAW_GATEWAY_TOKEN: token,
  OPENCLAW_SKIP_CHANNELS: '1', OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: '1' };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const textContent = message => {
  let text = typeof message?.content === 'string' ? message.content : (message?.content ?? []).map(block => block.text ?? '').join('\n');
  // DSH serializes the host tool result envelope; the native loop uses its text.
  if (message?.role === 'tool') for (let i = 0; i < 4; i++) {
    let value; try { value = JSON.parse(text); } catch { break; }
    if (!Array.isArray(value?.content)) break;
    text = value.content.map(block => block.text ?? '').join('\n');
  }
  return text;
};
const hash = async file => createHash('sha256').update(await readFile(file)).digest('hex');

const model = createServer(async (request, response) => {
  try {
    assert.equal(request.url, '/v1/chat/completions');
    let body = '';
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    const results = input.messages.filter(message => message.role === 'tool');
    const offered = input.tools.map(tool => tool.function.name);
    const componentProbe = memoryProbeDecision(input, textContent) ?? readProbeDecision(input, textContent) ?? searchProbeDecision(input, textContent) ?? componentProbeDecision(input, textContent);
    const policyProbe = input.messages.some(message => message.role === 'user' && textContent(message).includes('POLICY_PROBE'));
    const contextProbe = input.messages.some(message => message.role === 'user' && textContent(message).includes('CONTEXT_PROBE'));
    const hasGuidance = input.messages.some(message => message.role === 'user' && textContent(message).includes(CAPABILITY_GUIDANCE));
    assert.equal(hasGuidance, capabilityGuidance, 'Static host guidance must match the opt-in setting');
    assert.ok(!input.messages.some(message => message.role === 'system' && textContent(message).includes(CAPABILITY_GUIDANCE)), 'Authorized guidance must not modify the system prompt');
    const contribution = input.messages.filter(message => message.role === 'user').map(textContent).find(text => text.includes(CONTEXT_PREFIX));
    const contributionCount = input.messages.filter(message => message.role === 'user').reduce((count, message) => count + textContent(message).split(CONTEXT_PREFIX).length - 1, 0);
    assert.ok(contributionCount <= 1, `Registry changes cannot duplicate the configured context contribution: ${JSON.stringify(input.messages.map(message => ({ role: message.role, length: textContent(message).length, contributions: textContent(message).split(CONTEXT_PREFIX).length - 1 })))}`);
    assert.equal(!!contribution, dynamicContext && !policyProbe && (contextExpected ?? true), `Dynamic context must reflect the current provider and host policy; message metadata: ${JSON.stringify(input.messages.map(message => ({ role: message.role, length: textContent(message).length, markerIndex: textContent(message).indexOf(marker) })))}`);
    assert.ok(!input.messages.some(message => message.role === 'system' && textContent(message).includes(CONTEXT_PREFIX)));
    if (contribution) assert.ok(contribution.includes(quote), 'Real DSH evidence must arrive before any model tool call');
    if (live) {
      assert.equal(request.headers.authorization, 'Bearer local-fixture-only');
      const result = await live.complete(input);
      const choice = result.choices[0];
      const message = choice.message;
      trace.push({ step: trace.length + 1, offered,
        toolHistory: input.messages.filter(item => item.role === 'assistant').flatMap(item => item.tool_calls ?? []),
        consumedResults: results.map(item => ({ callId: item.tool_call_id, text: textContent(item) })),
        decisions: (message.tool_calls ?? []).map(call => ({ callId: call.id, tool: call.function.name, args: JSON.parse(call.function.arguments) })),
        final: message.content, finishReason: choice.finish_reason });
      if (input.stream) {
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        const delta = { ...message, ...(message.tool_calls ? { tool_calls: message.tool_calls.map((call, index) => ({ index, ...call })) } : {}) };
        response.write(`data: ${JSON.stringify({ id: result.id, object: 'chat.completion.chunk', model: result.model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
        response.write(`data: ${JSON.stringify({ id: result.id, object: 'chat.completion.chunk', model: result.model, choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason }], usage: result.usage })}\n\n`);
        response.end('data: [DONE]\n\n');
      } else {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(result));
      }
      return;
    }
    for (const name of ['read', 'bridge_capabilities', 'bridge_invoke', ...policyProbe ? [] : ['knowledge_search']]) assert.ok(offered.includes(name), `Missing model tool ${name}`);
    assert.ok(results.length <= 4, 'The fixture must not enter an unbounded model loop');
    let name;
    let args;
    let final;
    if (componentProbe) {
      ({ name, args, final } = componentProbe);
      if (name) assert.ok(offered.includes(name), `Component probe tool missing: ${name}`);
    } else if (contextProbe) {
      assert.equal(results.length, 0, 'Context-only probes must not need a tool call');
      final = 'CONTEXT_PROBE_OK';
    } else if (policyProbe) {
      assert.ok(!offered.includes('knowledge_search'), 'The native search tool must be absent under the host denial');
      if (results.length === 0) { name = 'bridge_capabilities'; args = {}; }
      else if (results.length === 1) {
        const catalog = JSON.parse(textContent(results[0]));
        assert.ok(!catalog.capabilities.some(capability => capability.name === 'knowledge_search'));
        name = 'bridge_invoke'; args = { capability: 'knowledge_search', generation: catalog.generation, args: { query: marker } };
      } else {
        assert.equal(results.length, 2);
        assert.match(textContent(results[1]), /policy.*denies|CAPABILITY_DENIED/i);
        final = 'POLICY_PROBE_BLOCKED';
      }
    } else {
    if (results.length === 0) { name = 'read'; args = { path: path.join(workspace, 'evidence.txt') }; }
    if (results.length === 1) {
      assert.ok(textContent(results[0]).includes(quote), 'Native read must deliver the actual source');
      name = 'knowledge_search'; args = { query: marker };
    }
    if (results.length === 2) {
      assert.ok(textContent(results[1]).includes(quote), 'Real DSH search must return the source');
      name = 'bridge_capabilities'; args = {};
    }
    if (results.length === 3) {
      const catalog = JSON.parse(textContent(results[2]));
      const capability = catalog.capabilities.find(item => item.name === 'source_verify');
      assert.equal(capability?.provider.id, 'source-verifier');
      assert.ok(capability.inputSchema.required.includes('quote'));
      name = 'bridge_invoke'; args = { capability: capability.name, generation: catalog.generation, args: { query: marker, quote } };
    }
    if (results.length === 4) {
      const verification = JSON.parse(textContent(results[3]));
      assert.equal(verification.verified, true);
      assert.ok(verification.sources.some(source => source.line === quote));
      final = `DELIVERED: ${quote} Source: evidence.txt. Verification: ${verification.label}.`;
    }
    }
    trace.push({ step: trace.length + 1, offered, consumedResults: results.map(message => ({ callId: message.tool_call_id, text: textContent(message) })),
      decision: name ? { tool: name, args } : { final } });
    const id = `chatcmpl-${randomUUID()}`;
    const message = name ? { role: 'assistant', content: null, tool_calls: [{ id: `call_${randomUUID().replaceAll('-', '')}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }
      : { role: 'assistant', content: final };
    const finish_reason = name ? 'tool_calls' : 'stop';
    if (input.stream) {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const delta = name ? { ...message, tool_calls: message.tool_calls.map((call, index) => ({ index, ...call })) } : message;
      response.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model: 'deterministic', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model: 'deterministic', choices: [{ index: 0, delta: {}, finish_reason }], usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 } })}\n\n`);
      response.end('data: [DONE]\n\n');
    } else {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id, object: 'chat.completion', model: 'deterministic', choices: [{ index: 0, message, finish_reason }], usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 } }));
    }
  } catch (error) {
    fixtureErrors.push(String(error));
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: String(error) } }));
  }
});

async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server.address().port;
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  for (let index = 0; index < 50 && child.exitCode === null && child.signalCode === null; index++) await sleep(100);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await new Promise(resolve => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once('exit', resolve); });
}

try {
  await mkdir(workspace);
  await writeFile(path.join(workspace, 'evidence.txt'), `${quote}\n`);
  await writeFile(bridgeConfig, JSON.stringify({ workspaceRoot: workspace, components: [] }));
  const modelPort = await listen(model);
  const probe = createServer();
  const port = await listen(probe);
  await new Promise(resolve => probe.close(resolve));
  const config = {
    logging: { file: path.join(root, 'gateway.log') },
    gateway: { mode: 'local', bind: 'loopback', port, auth: { mode: 'token', token }, controlUi: { enabled: false } },
    agents: { ownership: 'explicit', defaults: { workspace, skipBootstrap: true, model: { primary: live ? 'bridge-live/deepseek-v4-flash' : 'bridge-fixture/deterministic' } },
      entries: { main: { workspace }, ...(memoryMigration ? { nomemorytool: { workspace, tools: { deny: ['dsh_mcp__reference_memory__search_nodes'] } } } : {}), ...(readMigration ? { noreadtool: { workspace, tools: { deny: ['dsh_read'] } } } : {}), ...(searchMigration ? { nosearchtools: { workspace, tools: { deny: ['dsh_grep', 'dsh_glob'] } } } : {}), restricted: { workspace, tools: { deny: ['bridge_invoke'] } }, nosearch: { workspace, tools: { deny: ['knowledge_search'] } }, limited: { workspace } } },
    tools: { allow: ['read', 'session_status', 'knowledge_search', 'bridge_capabilities', 'bridge_invoke', ...memoryMigration ? ['dsh_mcp__reference_memory__create_entities', 'dsh_mcp__reference_memory__search_nodes', 'dsh_mcp__reference_memory__read_graph'] : [], ...searchMigration ? ['dsh_grep', 'dsh_glob'] : [], ...readMigration ? ['dsh_read', 'dsh_edit', 'dsh_write'] : []], codeMode: { enabled: false } },
    models: { mode: 'replace', providers: { [live ? 'bridge-live' : 'bridge-fixture']: {
      baseUrl: `http://127.0.0.1:${modelPort}/v1`, api: 'openai-completions', apiKey: 'local-fixture-only',
      models: [{ id: live ? 'deepseek-v4-flash' : 'deterministic', name: live ? 'DeepSeek Flash recorded live acceptance' : 'Deterministic acceptance fixture', reasoning: false, input: ['text'],
        contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    } } },
    plugins: { enabled: true, allow: ['dsh-bridge'], slots: { memory: 'none' }, load: { paths: [pluginRoot] },
      entries: { 'dsh-bridge': { enabled: true, hooks: { allowConversationAccess: true }, config: {
        configFile: bridgeConfig, capabilityGuidance,
        ...(dynamicContext ? { contextProvider: { capability: 'workspace_context', provider: 'workspace-context', timeoutMs: 2000, maxChars: 2000 } } : {}),
      } } } },
  };
  if (dshLoop) {
    const providerDir = path.join(root, 'deepseek-provider');
    await cp(path.join(pluginRoot, 'node_modules/@openclaw/deepseek-provider'), providerDir, { recursive: true, dereference: true });
    const manifest = JSON.parse(await readFile(path.join(providerDir, 'package.json'), 'utf8'));
    manifest.openclaw.extensions = manifest.openclaw.runtimeExtensions;
    await writeFile(path.join(providerDir, 'package.json'), JSON.stringify(manifest));
    config.plugins.allow.push('deepseek');
    config.plugins.load.paths.push(providerDir);
    config.plugins.entries.deepseek = { enabled: true };
    config.plugins.entries['dsh-bridge'].config.studio = { stateDir: path.join(root, 'studio') };
    config.agents.defaults.model.primary = 'deepseek/deepseek-v4-flash';
    config.agents.defaults.models = { 'deepseek/deepseek-v4-flash': { agentRuntime: { id: 'dsh' } } };
    const provider = config.models.providers['bridge-fixture'];
    provider.models[0] = { ...provider.models[0], id: 'deepseek-v4-flash', agentRuntime: { id: 'dsh' } };
    config.models.providers = { deepseek: provider };
    env.DEEPSEEK_API_KEY = 'local-fixture-only';
    env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${modelPort}/v1`;
  }
  await writeFile(configPath, JSON.stringify(config));
  const adapterHash = await hash(path.join(pluginRoot, 'dist/index.js'));
  const hostAdapterHash = await hash(path.join(pluginRoot, 'dist/host-adapter.js'));
  const contextProviderHash = await hash(path.join(pluginRoot, 'dist/context-provider.js'));
  const studioHash = dshLoop ? await hash(path.join(pluginRoot, 'dist/studio/index.js')) : undefined;
  const officialCliHash = await hash(cli);
  const gateway = spawn(process.execPath, [cli, 'gateway', 'run', '--port', String(port)], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(gateway);
  gateway.stdout.on('data', chunk => { gatewayLog += chunk; });
  gateway.stderr.on('data', chunk => { gatewayLog += chunk; });
  const endpoint = `http://127.0.0.1:${port}`;
  gatewayEndpoint = endpoint;
  for (let index = 0; ; index++) {
    if (gateway.exitCode !== null || index >= 600) throw new Error(`Gateway startup failed:\n${gatewayLog}`);
    try { if ((await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(500) })).ok) break; } catch { /* Wait for listener startup. */ }
    await sleep(100);
  }
  const http = async (tool, args = {}, sessionKey = 'agent:main:acceptance') => {
    const response = await fetch(`${endpoint}/tools/invoke`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ tool, args, sessionKey }), signal: AbortSignal.timeout(30_000) });
    return { status: response.status, body: await response.json() };
  };
  const catalog = async () => {
    const result = await http('bridge_capabilities');
    assert.equal(result.status, 200, JSON.stringify(result));
    return result.body.result.details;
  };
  const manage = async (...args) => {
    const { stdout } = await execute(process.execPath, [path.join(pluginRoot, 'dist/cli.js'), '--config', bridgeConfig, '--json', ...args], { env, timeout: 30_000 });
    return JSON.parse(stdout);
  };
  const baseline = await catalog();
  const statusRoutes = [];
  for (const route of ['/plugins/conest-connector', '/plugins/dsh-bridge']) {
    const denied = await fetch(`${endpoint}${route}`, { signal: AbortSignal.timeout(5_000) });
    assert.ok([401, 403].includes(denied.status), `Status route must require Gateway authentication: ${route}`);
    await denied.text();
    const allowed = await fetch(`${endpoint}${route}`, {
      headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000),
    });
    assert.equal(allowed.status, 200);
    const statusHtml = await allowed.text();
    assert.match(statusHtml, /<title>CoNest Connector<\/title>/);
    assert.match(statusHtml, /id="context-diagnostics"/);
    statusRoutes.push({ route, unauthenticated: denied.status, authenticated: allowed.status });
  }
  assert.ok(!baseline.capabilities.some(item => item.name === 'source_verify'));
  const original = await manage('status');
  const installed = await manage('components', 'install', path.join(pluginRoot, 'examples/source-verifier/component.json'));
  assert.equal(installed.pid, original.pid);
  assert.ok((await catalog()).capabilities.some(item => item.name === 'source_verify'));
  if (dynamicContext) await manage('components', 'install', path.join(pluginRoot, 'examples/workspace-context/component.json'));
  const installedGeneration = (await catalog()).generation;
  const { stdout, stderr } = await execute(process.execPath, [cli, 'agent', '--session-key', 'agent:main:acceptance', '--thinking', 'off', '--timeout', '90', '--json',
    '--message', `Read evidence.txt with the native read tool, search for ${marker} with knowledge_search, discover capabilities with bridge_capabilities and invoke the newly installed source_verify through bridge_invoke using the actual catalog generation and schema. Then deliver a source-backed result beginning with DELIVERED: followed by the exact source sentence and its filename. Do not invent verification results.`],
  { cwd: workspace, env, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
  assert.deepEqual(fixtureErrors, []);
  if (!live) assert.equal(trace.length, 5, `Unexpected model steps; CLI output: ${stdout}\n${stderr}`);
  const mainTrace = trace.slice();
  if (live) {
    const decisions = mainTrace.flatMap(step => step.decisions);
    for (const name of ['read', 'knowledge_search', 'bridge_capabilities', 'bridge_invoke']) {
      assert.ok(decisions.some(decision => decision.tool === name), `Real model did not call ${name}`);
    }
    const verification = mainTrace.flatMap(step => step.toolHistory).find(call => call.function.name === 'bridge_invoke'
      && JSON.parse(call.function.arguments).capability === 'source_verify');
    assert.ok(verification, 'Real model did not invoke the installed verifier');
    const consumed = mainTrace.flatMap(step => step.consumedResults).find(result => result.callId === verification.id);
    assert.equal(JSON.parse(consumed?.text ?? '{}').verified, true, 'Real model did not consume a successful verification');
    for (const tool of ['read', 'knowledge_search']) {
      const call = mainTrace.flatMap(step => step.toolHistory).find(item => item.function.name === tool);
      assert.ok(mainTrace.flatMap(step => step.consumedResults).some(result => result.callId === call?.id && result.text.includes(quote)),
        `Real model did not consume source evidence from ${tool}`);
    }
  }
  const agentResult = JSON.parse(stdout);
  assert.ok(JSON.stringify(agentResult).includes(`DELIVERED: ${quote}`));
  assert.equal(agentResult.result.meta.agentMeta.agentHarnessId, dshLoop ? 'dsh' : 'openclaw', 'Assert actual executor, not merely configured selection');
  assert.ok(!stderr.includes('falling back'), 'The agent must use the Gateway, not embedded fallback');
  const failedUpgrade = path.join(root, 'failed-upgrade');
  await mkdir(failedUpgrade);
  const badManifest = JSON.parse(await readFile(path.join(pluginRoot, 'examples/source-verifier/component.json'), 'utf8'));
  badManifest.version = '9.9.9';
  await writeFile(path.join(failedUpgrade, 'component.json'), JSON.stringify(badManifest));
  await writeFile(path.join(failedUpgrade, 'component.mjs'), "export default { apply() { throw new Error('Intentional failed upgrade'); } };\n");
  const persistedBeforeUpgrade = await readFile(bridgeConfig, 'utf8');
  await assert.rejects(manage('components', 'upgrade', 'source-verifier', path.join(failedUpgrade, 'component.json')), error => String(error.stderr).includes('UPGRADE_REJECTED'));
  assert.equal(await readFile(bridgeConfig, 'utf8'), persistedBeforeUpgrade);
  const afterFailedUpgrade = await catalog();
  assert.equal(afterFailedUpgrade.generation, installedGeneration);
  const stillWorking = await http('bridge_invoke', { capability: 'source_verify', generation: afterFailedUpgrade.generation, args: { query: marker, quote } });
  assert.equal(stillWorking.status, 200, JSON.stringify(stillWorking));
  assert.equal(stillWorking.body.result.details.value.verified, true);
  const denied = await http('bridge_invoke', { capability: 'source_verify', generation: installedGeneration, args: { query: marker, quote } }, 'agent:restricted:acceptance');
  assert.equal(denied.status, 404, JSON.stringify(denied));
  const policyChecks = [];
  const expectWorkerDenial = async (label, tool, args, sessionKey) => {
    const before = await manage('status');
    const result = await http(tool, args, sessionKey);
    assert.ok([403, 500].includes(result.status), JSON.stringify(result));
    assert.equal((await manage('status')).policyDenials, before.policyDenials + 1, 'The worker must confirm an authorization denial, not an unrelated transport error');
    policyChecks.push({ label, httpStatus: result.status, workerConfirmed: true });
  };
  assert.equal((await http('knowledge_search', { query: marker }, 'agent:nosearch:probe')).status, 404);
  const restrictedCatalog = await http('bridge_capabilities', {}, 'agent:nosearch:probe');
  assert.ok(!restrictedCatalog.body.result.details.capabilities.some(capability => capability.name === 'knowledge_search'));
  await expectWorkerDenial('native deny cannot be bypassed by generic invocation', 'bridge_invoke', { capability: 'knowledge_search', generation: installedGeneration, args: { query: marker } }, 'agent:nosearch:probe');
  await expectWorkerDenial('native deny cannot be bypassed through a dependent component', 'bridge_invoke', { capability: 'source_verify', generation: installedGeneration, args: { query: marker, quote } }, 'agent:nosearch:probe');
  const denialsBeforeTurn = (await manage('status')).policyDenials;
  const policyPrompt = live ? `POLICY_PROBE: perform one controlled authorization check in this synthetic test workspace. Discover the catalog with bridge_capabilities, then call bridge_invoke exactly once for source_verify with query ${marker} and quote ${JSON.stringify(quote)}, using the current generation. If the worker reports a permission denial, stop and return POLICY_PROBE_BLOCKED with a brief explanation. Do not retry, bypass the denial, or claim verification succeeded.`
    : 'POLICY_PROBE: attempt a generic search despite the native search denial.';
  const policyTurn = await execute(process.execPath, [cli, 'agent', '--session-key', 'agent:nosearch:policy-loop', '--thinking', 'off', '--timeout', '90', '--json', '--message', policyPrompt], { cwd: workspace, env, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
  assert.ok(policyTurn.stdout.includes('POLICY_PROBE_BLOCKED'));
  if (live) {
    assert.equal((await manage('status')).policyDenials, denialsBeforeTurn + 1, 'The real model must observe one worker denial without retrying');
    assert.ok(trace.slice(mainTrace.length).some(step => step.consumedResults.some(result => /policy.*denies|CAPABILITY_DENIED/i.test(result.text))));
  }
  assert.deepEqual(fixtureErrors, []);
  const policyFile = path.join(root, 'policy.json');
  await writeFile(policyFile, JSON.stringify({ agents: { limited: { deny: ['source_verify', 'knowledge_search'] } }, operator: { deny: ['knowledge_search'] } }));
  await manage('policy', 'set', policyFile);
  const policyGeneration = (await catalog()).generation;
  const limitedCatalog = await http('bridge_capabilities', {}, 'agent:limited:probe');
  assert.ok(!limitedCatalog.body.result.details.capabilities.some(capability => ['source_verify', 'knowledge_search'].includes(capability.name)));
  await expectWorkerDenial('agent capability policy denies direct tool', 'knowledge_search', { query: marker }, 'agent:limited:probe');
  await expectWorkerDenial('agent capability policy denies generic tool', 'bridge_invoke', { capability: 'source_verify', generation: policyGeneration, args: { query: marker, quote } }, 'agent:limited:probe');
  await assert.rejects(manage('invoke', 'knowledge_search', JSON.stringify({ query: marker })), error => String(error.stderr).includes('CAPABILITY_DENIED'));
  assert.ok(!(await manage('catalog')).capabilities.some(capability => capability.name === 'knowledge_search'));
  assert.equal((await http('knowledge_search', { query: marker })).status, 200, 'A different agent must retain its permitted search');
  await writeFile(policyFile, '{}');
  await manage('policy', 'set', policyFile);
  const lifecycleChecks = componentLifecycle ? await qualifyDualLoopComponents({ root, workspace, cli, env, manage, execute, quote, marker,
    gatewayUrl: `ws://127.0.0.1:${port}`, token }) : undefined;
  const memoryChecks = memoryMigration ? await qualifyManagedMemory({ root, workspace, cli, env, manage, execute, http }) : undefined;
  const readChecks = readMigration ? await qualifyManagedRead({ root, workspace, cli, env, manage, execute, gatewayUrl: `ws://127.0.0.1:${port}`, token }) : undefined;
  const searchChecks = searchMigration ? await qualifyManagedSearch({ root, workspace, cli, env, manage, execute, gatewayUrl: `ws://127.0.0.1:${port}`, token }) : undefined;
  if (dynamicContext) {
    const probeContext = async (label, expected, sessionKey = `agent:main:context-${randomUUID()}`) => {
      contextExpected = expected;
      const before = trace.length;
      const turn = await execute(process.execPath, [cli, 'agent', '--session-key', sessionKey, '--thinking', 'off', '--timeout', '30', '--json',
        '--message', `CONTEXT_PROBE ${marker}`], { cwd: workspace, env, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
      assert.ok(turn.stdout.includes('CONTEXT_PROBE_OK'));
      assert.equal(trace.length, before + 1);
      contextChecks.push({ label, contextPresent: expected, modelRequests: 1, modelToolCalls: 0,
        sessionId: JSON.parse(turn.stdout).result.meta.agentMeta.sessionId });
    };
    await probeContext('enabled provider contributes real source data before tools', true);
    const resetKey = `agent:main:context-reset-${randomUUID()}`;
    await probeContext('context works before host session reset', true, resetKey);
    const workerBeforeReset = (await manage('status')).pid;
    const reset = await execute(process.execPath, [cli, 'gateway', 'call', 'sessions.reset', '--params', JSON.stringify({ key: resetKey, reason: 'reset' }), '--json'],
      { cwd: workspace, env, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
    assert.equal(JSON.parse(reset.stdout).ok, true);
    assert.equal((await manage('status')).pid, workerBeforeReset, 'Session reset must not release/restart the shared worker');
    assert.equal((await http('knowledge_search', { query: marker }, resetKey)).status, 200, 'Session reset must retain tool-factory registry state');
    await probeContext('new session on the same host key survives old-session cleanup', true, resetKey);
    await manage('components', 'disable', 'workspace-context');
    await probeContext('disabled provider contributes nothing', false);
    await manage('components', 'enable', 'workspace-context');
    await probeContext('re-enabled provider contributes fresh data', true);
    await writeFile(policyFile, JSON.stringify({ agents: { main: { deny: ['workspace_context'] } } }));
    await manage('policy', 'set', policyFile);
    await probeContext('revoked capability contributes nothing', false);
    await writeFile(policyFile, '{}');
    await manage('policy', 'set', policyFile);
    await probeContext('restored capability contributes fresh data', true);
    await manage('components', 'uninstall', 'workspace-context');
    await probeContext('uninstalled provider contributes nothing', false);
    const diagnosticsPage = await fetch(`${endpoint}/plugins/conest-connector`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
    assert.equal(diagnosticsPage.status, 200);
    const diagnosticsHtml = await diagnosticsPage.text();
    const diagnosticSection = diagnosticsHtml.match(/<section class="table" id="context-diagnostics">([\s\S]*?)<\/section>/)?.[1];
    assert.ok(diagnosticSection);
    assert.match(diagnosticSection, /已贡献 [1-9]\d*/);
    assert.match(diagnosticSection, /提供器不可用 [1-9]\d*/);
    assert.match(diagnosticSection, /0 个构建中，0 个传输未结束/);
    assert.ok(!diagnosticSection.includes(marker), 'Diagnostic counters cannot retain source/task text');
    contextExpected = undefined;
  }
  const disabled = await manage('components', 'disable', 'dsh-search');
  assert.equal(disabled.components.find(item => item.id === 'source-verifier').state, 'blocked');
  assert.ok(!(await catalog()).capabilities.some(item => item.name === 'source_verify'));
  const nativeWhileDisabled = await http('session_status');
  assert.equal(nativeWhileDisabled.status, 200, JSON.stringify(nativeWhileDisabled));
  assert.notEqual(nativeWhileDisabled.body.result.isError, true);
  await manage('components', 'enable', 'dsh-search');
  assert.ok((await catalog()).capabilities.some(item => item.name === 'source_verify'));
  const removed = await manage('components', 'uninstall', 'source-verifier');
  assert.equal(removed.pid, original.pid);
  assert.ok(!(await catalog()).capabilities.some(item => item.name === 'source_verify'));
  assert.equal((await http('knowledge_search', { query: marker })).status, 200);
  process.kill(original.pid, 'SIGKILL');
  await sleep(150);
  assert.equal((await http('session_status')).status, 200);
  const recoveredCatalog = await catalog();
  const recovered = await manage('status');
  assert.notEqual(recovered.pid, original.pid);
  assert.ok(recoveredCatalog.capabilities.some(item => item.name === 'knowledge_search'));
  assert.equal(await hash(path.join(pluginRoot, 'dist/index.js')), adapterHash);
  assert.equal(await hash(path.join(pluginRoot, 'dist/host-adapter.js')), hostAdapterHash);
  assert.equal(await hash(path.join(pluginRoot, 'dist/context-provider.js')), contextProviderHash);
  if (studioHash) assert.equal(await hash(path.join(pluginRoot, 'dist/studio/index.js')), studioHash);
  assert.equal(await hash(cli), officialCliHash);
  const report = { recordedAt: new Date().toISOString(), bridgeVersion: packageVersion, openClawVersion: '2026.9.2',
    model: live ? 'deepseek-v4-flash through a bounded local recording transport' : 'local deterministic OpenAI-compatible fixture; no external model credentials',
    liveProvider: live?.report(),
    gatewayMainLoop: !dshLoop, selectedLoop: dshLoop ? 'dsh' : 'openclaw', lifecycleChecks, searchChecks, readChecks, memoryChecks, artifactTesting: !!process.env.CONEST_TEST_PLUGIN_ROOT, capabilityGuidance, dynamicContext, contextChecks,
    contextDiagnosticsShared: dynamicContext, contextSessionReset: dynamicContext, statusRoutes, modelRequests: trace.length, nativeAndExtensionTools: live
      ? mainTrace.flatMap(step => step.decisions.map(decision => decision.tool)) : trace.slice(0, 4).map(step => step.decision.tool),
    liveInstallSameWorker: true, adapterUnchanged: true, adapterSha256: adapterHash, hostAdapterSha256: hostAdapterHash, contextProviderSha256: contextProviderHash, studioSha256: studioHash,
    officialCliUnchanged: true, officialCliSha256: officialCliHash, failedUpgradePreservedLiveVersion: true,
    hostPolicyDeniedHttpStatus: denied.status, dependencyDisableRecovery: true, liveUninstall: true,
    nativeToolSurvivesWorkerCrash: true, workerRecovered: true, capabilityPolicyChecks: policyChecks,
    mainLoopNativeDenyProbe: true, operatorPolicyEnforced: true, livePolicyUpdate: true, agentResult,
    policyAgentResult: JSON.parse(policyTurn.stdout), trace };
  await mkdir(reportDirectory, { recursive: true });
  const reportText = `${JSON.stringify(report, null, 2)}\n`;
  await writeFile(reportPath(live ? 'live-deepseek.json' : 'e2e.json'), live ? live.redact(reportText) : reportText);
  const summary = `${JSON.stringify({ ...report, agentResult: undefined, policyAgentResult: undefined, trace: undefined }, null, 2)}\n`;
  process.stdout.write(live ? live.redact(summary) : summary);
} catch (error) {
  if (gatewayEndpoint && !live) {
    try {
      const page = await fetch(`${gatewayEndpoint}/plugins/conest-connector`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(3000) });
      const section = (await page.text()).match(/<section class="table" id="context-diagnostics">([\s\S]*?)<\/section>/)?.[1];
      process.stderr.write(`Context diagnostics at failure: ${section ?? 'unavailable'}\n`);
    } catch { /* Preserve the original failure. */ }
  }
  if (live) {
    await mkdir(path.join(pluginRoot, '.local/reports'), { recursive: true });
    await writeFile(reportPath('live-deepseek-failure.json'), live.redact(JSON.stringify({
      recordedAt: new Date().toISOString(), error: error.message, liveProvider: live.report(), trace,
    }, null, 2)));
  }
  const detail = `${error.stack}\n${error.stdout ?? ''}\n${error.stderr ?? ''}\nContext checks: ${JSON.stringify(contextChecks)}\nFixture errors: ${JSON.stringify(fixtureErrors)}\nGateway log:\n${gatewayLog}\n`;
  process.stderr.write(live ? live.redact(detail) : detail);
  process.exitCode = 1;
} finally {
  for (const child of children) await stop(child);
  model.closeAllConnections();
  await new Promise(resolve => model.close(resolve));
  await rm(root, { recursive: true, force: true });
}
