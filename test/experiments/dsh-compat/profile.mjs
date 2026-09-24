// Developer qualification only. Real DSH modules from the verified development SDK.
import path from 'node:path';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local';
import * as Search from '@deepseek-ai/dsh-tool-fs-search';
import { CallId } from '@deepseek-ai/dsh-llm';
import { BridgeError } from '../../../dist/types.js';

export const packagePaths = {
  fs: 'fs/fs', local: 'fs/fs-local', read: 'fs/tool-fs', search: 'fs/tool-fs-search',
  skills: 'skill/skill', skillFiles: 'skill/skill-filesystem', skillTool: 'skill/tool-skill',
  todo: 'todo/tool-todo', plan: 'plan/plan-mode', web: 'web/web-fetch-http', webTool: 'web/tool-web',
  tools: 'core/tools', prompt: 'core/system-prompt', subprocess: 'subprocess/subprocess-local',
};
export const sourceRoot = new URL('../../../.vendor/dsh/', import.meta.url);
const nativePackages = { local: 'dsh-fs-local', skills: 'dsh-skill', skillFiles: 'dsh-skill-filesystem',
  read: 'dsh-tool-fs', skillTool: 'dsh-tool-skill', todo: 'dsh-tool-todo', plan: 'dsh-plan-mode' };
const native = key => import(`@deepseek-ai/${nativePackages[key]}`);
const [Local, Skills, SkillFiles, Read, SkillTool, Todo, Plan] = await Promise.all(
  ['local', 'skills', 'skillFiles', 'read', 'skillTool', 'todo', 'plan'].map(native));
// Observability only: tests retain actual service references to verify native teardown.
export const observations = new Map();
export const name = 'dsh-qualification';
export const inject = ['bridgeCapabilities'];
export async function apply(ctx, config) {
  const root = config.workspaceRoot;
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(ToolRuntime, { mode: 'native' });
  await ctx.plugin(LocalSubprocess, {});
  await ctx.plugin(Local.default, { cwd: root });
  await ctx.plugin(Skills.default, {});
  await ctx.plugin(SkillFiles, {
    includeDefaultRoots: false, customSkillDirs: [path.join(root, 'skills')], watch: false,
    dshHome: path.join(root, 'unused-dsh-home'), agentsHome: path.join(root, 'unused-agents-home'),
  });
  await ctx.plugin(Read, { readLimit: 3, readMaxLineLength: 32, readMaxBytes: 128, readStreamMinSize: 1 });
  await ctx.plugin(Search, { sampleOverCapGlobResults: false, globMaxResults: 3, grepMaxMatches: 3 });
  await ctx.plugin(Todo, { allowParallelInProgress: false });
  await ctx.plugin(Plan.default, { section: 'Qualification only: no agent loop is provided.' });
  // A pending real plugin must NOT be advertised as a usable skill tool.
  const skillFiber = ctx.plugin(SkillTool, {});
  await ctx.inject(['fs', 'tools', 'skills', 'bridgeCapabilities'], consumer => registerCapabilities(consumer, root, skillFiber));
}

function registerCapabilities(ctx, root, skillFiber) {
  const fs = ctx.fs, tools = ctx.tools, skills = ctx.skills;
  observations.set(root, { ctx, fs, tools, skills, skillFiber });
  if (!tools.get('read') || !tools.get('glob') || !tools.get('todo_write') || !tools.get('exit_plan_mode')) {
    throw new Error('Real DSH tool registration did not complete');
  }
  const checkedTarget = async (file, invocation) => {
    const base = await fs.resolve(root, { signal: invocation.signal });
    const target = await fs.resolve(file, { cwd: root, signal: invocation.signal });
    if (!fs.contains(base, target)) throw new BridgeError('PATH_OUTSIDE_WORKSPACE', 'Path is outside the qualification workspace');
    return target;
  };
  const execute = async (name, args, invocation) => {
    const result = await tools.execute({ name, arguments: args, callId: CallId(invocation.callId), signal: invocation.signal });
    if (result.isError) throw new BridgeError(result.error.info?.code ?? 'DSH_TOOL_ERROR', result.error.message);
    return result.value;
  };
  ctx.bridgeCapabilities.register(ctx, 'compat_fs', async (args, invocation) => {
    const target = await checkedTarget(args.path, invocation);
    if (args.op === 'stat') return { info: await fs.stat(target, invocation.signal) ?? null };
    if (args.op === 'list') {
      const entries = await fs.listDir(target, invocation.signal);
      return { entries: entries.slice(0, 3).map(({ name, type }) => ({ name, type })), truncated: entries.length > 3 };
    }
    // Provider enforces a byte cap even if the file grows between stat and read.
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(await fs.readBytes(target, invocation.signal, 4096)) };
  });
  ctx.bridgeCapabilities.register(ctx, 'compat_read', async (args, invocation) => {
    const target = await checkedTarget(args.path, invocation);
    return execute('read', { file_path: fs.processPath(target), offset: args.offset ?? 1, limit: args.limit ?? 3 }, invocation);
  });
  ctx.bridgeCapabilities.register(ctx, 'compat_glob', async (_args, invocation) =>
    execute('glob', { pattern: '*.txt', path: root }, invocation));
  ctx.bridgeCapabilities.register(ctx, 'compat_skills', async (args, invocation) => {
    const options = { cwd: root, signal: invocation.signal };
    // This profile only inspects trusted fixture data; it never injects instructions.
    if (args.name) {
      const skill = await skills.get(args.name, options);
      return { skill: skill ? { name: skill.name, content: skill.content.slice(0, 4096), invocation: skill.invocation } : null };
    }
    return { skills: (await skills.list(options)).slice(0, 10).map(({ name, description, invocation }) => ({ name, description, invocation })) };
  });
  ctx.bridgeCapabilities.register(ctx, 'compat_host_requirements', async (_args, invocation) => {
    if (ctx.get('agents')) throw new Error('This negative probe must run without DSH agents');
    const results = {};
    for (const [name, args] of Object.entries({ todo_write: { todos: [{ content: 'probe', status: 'pending' }] }, exit_plan_mode: { plan: '# Probe' } })) {
      const result = await tools.execute({ name, arguments: args, callId: CallId(`${invocation.callId}-${name}`), signal: invocation.signal });
      if (!result.isError) throw new Error(`Unexpected success: ${name}`);
      results[name] = { activated: !!tools.get(name), error: result.error.message };
    }
    results.skill = { required: SkillTool.inject, missing: SkillTool.inject.filter(key => !ctx.get(key)), registered: !!tools.get('skill') };
    return results;
  });
}

export const capabilities = [
  ['compat_fs', { op: { enum: ['read', 'stat', 'list'], type: 'string' }, path: { type: 'string', minLength: 1, maxLength: 4096 } }, ['op', 'path']],
  ['compat_read', { path: { type: 'string', minLength: 1, maxLength: 4096 }, offset: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 3 } }, ['path']],
  ['compat_glob', {}, []],
  ['compat_skills', { name: { type: 'string', minLength: 1, maxLength: 64 } }, []],
  ['compat_host_requirements', {}, []],
].map(([name, properties, required]) => ({ name, description: `Developer qualification: ${name}`, permissions: ['workspace:read'],
  inputSchema: { type: 'object', additionalProperties: false, properties, required } }));
