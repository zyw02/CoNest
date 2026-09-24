// git-inspector component for dsh-bridge
// Git repository inspection using cancellable direct binary execution.
import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execGit = promisify(execFile);
function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function repoPathFor(args, invocation) {
  const root = realpathSync(invocation.workspaceRoot);
  const target = realpathSync(path.resolve(root, args.path || '.'));
  if (!isWithin(root, target)) {
    throw new Error('Repository path is outside the admitted workspace');
  }
  return target;
}

async function disabledFilters(repoPath, signal, timeoutMs) {
  let names;
  try {
    const result = await execGit('git', ['config', '--null', '--name-only', '--get-regexp',
      '^filter\\..*\\.(clean|smudge|process|required)$'], {
      cwd: repoPath,
      timeout: timeoutMs,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      signal,
    });
    names = result.stdout;
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? error;
    if (error.code === 1) return [];
    throw error;
  }
  return names.split('\0').filter(Boolean).flatMap(name => {
    if (!/^filter\..*\.(clean|smudge|process|required)$/i.test(name)) {
      throw new Error('Unexpected Git filter configuration key');
    }
    return ['-c', `${name}=${/\.required$/i.test(name) ? 'false' : ''}`];
  });
}

async function git(repoPath, args, signal, timeoutMs = 10000) {
  const filterOverrides = await disabledFilters(repoPath, signal, timeoutMs);
  try {
    const result = await execGit('git', ['-c', 'core.fsmonitor=false', ...filterOverrides, ...args], {
      cwd: repoPath,
      timeout: timeoutMs,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      signal,
    });
    return result.stdout;
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? error;
    if (error.code === 'EACCES' || error.code === 1 || error.code === 128) return null;
    throw error;
  }
}

async function isGitRepo(repoPath, workspaceRoot, signal) {
  const topLevel = await git(repoPath, ['rev-parse', '--show-toplevel'], signal);
  if (topLevel === null) return false;
  const discoveredRoot = realpathSync(topLevel.replace(/\r?\n$/, ''));
  return isWithin(realpathSync(workspaceRoot), discoveredRoot);
}

export default {
  name: 'git-inspector',
  inject: ['bridgeCapabilities'],
  apply(ctx, config) {
    ctx.bridgeCapabilities.register(ctx, 'git_status', async (args, invocation) => {
      const repoPath = repoPathFor(args, invocation);
      invocation.signal.throwIfAborted();
      invocation.progress(`Inspecting git status at ${repoPath}`);

      if (!await isGitRepo(repoPath, invocation.workspaceRoot, invocation.signal)) {
        return { isRepository: false };
      }

      const branch = (await git(repoPath, ['branch', '--show-current'], invocation.signal))?.trim() || 'detached';
      const upstream = (await git(repoPath, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], invocation.signal))?.trim() || '';

      let ahead = 0, behind = 0;
      if (upstream) {
        const counts = (await git(repoPath, ['rev-list', '--left-right', '--count', `HEAD...${upstream}`], invocation.signal))?.trim();
        if (counts) {
          [ahead, behind] = counts.split('\t').map(Number);
        }
      }

      // Do NOT trim leading space on first line — porcelain X-column is a meaningful space.
      const raw = await git(repoPath, ['status', '--porcelain=v1'], invocation.signal) || '';
      const statusPorcelain = raw.replace(/^\n+|\n+$/g, '');
      const modified = [], staged = [], untracked = [];

      // porcelain v1: "XY<whitespace>filename" (rename: "XY<whitespace>orig -> new")
      // Use regex to avoid off-by-one when whitespace count varies.
      const re = /^(.)(.)\s+(.+)$/;
      for (const line of statusPorcelain.split('\n')) {
        if (!line) continue;
        const m = line.match(re);
        if (!m) continue;
        const x = m[1], y = m[2], rest = m[3];
        const file = rest.split(' -> ').pop();
        if (x !== ' ' && x !== '?') staged.push(file);
        if (y !== ' ' && y !== '?') modified.push(file);
        if (x === '?' && y === '?') untracked.push(file);
      }

      return {
        isRepository: true,
        branch,
        upstream,
        ahead, behind,
        modified, staged, untracked,
      };
    });

    ctx.bridgeCapabilities.register(ctx, 'git_log', async (args, invocation) => {
      const repoPath = repoPathFor(args, invocation);
      invocation.signal.throwIfAborted();
      const count = Math.min(args.count || 10, 50);
      invocation.progress(`Reading recent ${count} commits`);

      if (!await isGitRepo(repoPath, invocation.workspaceRoot, invocation.signal)) {
        return { commits: [] };
      }

      const output = (await git(repoPath, ['log', `-${count}`, '--format=%h|%an|%aI|%s'], invocation.signal))?.trim() || '';
      const commits = output.split('\n').filter(Boolean).map(line => {
        const [hash, author, date, ...msgParts] = line.split('|');
        return { hash, author, date, message: msgParts.join('|') };
      });

      return { commits };
    });

    ctx.bridgeCapabilities.register(ctx, 'git_diff', async (args, invocation) => {
      const repoPath = repoPathFor(args, invocation);
      invocation.signal.throwIfAborted();
      const ref = args.ref || 'HEAD';
      if (ref.startsWith('-')) throw new Error('Invalid Git ref');
      invocation.progress(`Computing diff against ${ref}`);

      if (!await isGitRepo(repoPath, invocation.workspaceRoot, invocation.signal)) {
        return { filesChanged: 0, insertions: 0, deletions: 0, diff: '' };
      }

      const fileArg = args.file || null;
      const statArgs = ['diff', '--no-ext-diff', '--no-textconv', ref, '--stat'];
      if (fileArg) statArgs.push('--', fileArg);
      const diffArgs = ['diff', '--no-ext-diff', '--no-textconv', ref];
      if (fileArg) diffArgs.push('--', fileArg);

      const diffOutput = (await git(repoPath, statArgs, invocation.signal, 15000))?.trim() || '';
      const fullDiff = (await git(repoPath, diffArgs, invocation.signal, 15000))?.trim() || '';

      let filesChanged = 0, insertions = 0, deletions = 0;
      const statMatch = diffOutput.match(/(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/);
      if (statMatch) {
        filesChanged = parseInt(statMatch[1]) || 0;
        insertions = parseInt(statMatch[2]) || 0;
        deletions = parseInt(statMatch[3]) || 0;
      }

      const cappedDiff = fullDiff.length > 50000 ? fullDiff.slice(0, 50000) + '\n... [truncated]' : fullDiff;

      return { filesChanged, insertions, deletions, diff: cappedDiff };
    });
  },
};
