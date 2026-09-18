// git-inspector component for dsh-bridge
// Git repository inspection using direct spawnSync (no shell, avoids sandbox EACCES).
import { spawnSync } from 'node:child_process';

function git(repoPath, args, timeoutMs = 10000) {
  const result = spawnSync('git', args, {
    cwd: repoPath,
    timeout: timeoutMs,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  if (result.error) {
    if (result.error.code === 'EACCES') return null;
    throw new Error(`git ${args.join(' ')}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim();
    if (stderr.includes('not a git repository') || stderr.includes('dubious ownership')) return null;
    // Non-zero exit for other reasons - return stderr for diagnostics
    return null;
  }
  return result.stdout;
}

function isGitRepo(repoPath) {
  return git(repoPath, ['rev-parse', '--is-inside-work-tree']) !== null;
}

export default {
  name: 'git-inspector',
  inject: ['bridgeCapabilities'],
  apply(ctx, config) {
    ctx.bridgeCapabilities.register(ctx, 'git_status', async (args, invocation) => {
      const repoPath = args.path || invocation.workspaceRoot;
      invocation.progress(`Inspecting git status at ${repoPath}`);

      if (!isGitRepo(repoPath)) {
        return { isRepository: false };
      }

      const branch = git(repoPath, ['branch', '--show-current'])?.trim() || 'detached';
      const upstream = git(repoPath, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])?.trim() || '';

      let ahead = 0, behind = 0;
      if (upstream) {
        const counts = git(repoPath, ['rev-list', '--left-right', '--count', `HEAD...${upstream}`])?.trim();
        if (counts) {
          [ahead, behind] = counts.split('\t').map(Number);
        }
      }

      // Do NOT trim leading space on first line — porcelain X-column is a meaningful space.
      const raw = git(repoPath, ['status', '--porcelain=v1']) || '';
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
      const repoPath = args.path || invocation.workspaceRoot;
      const count = Math.min(args.count || 10, 50);
      invocation.progress(`Reading recent ${count} commits`);

      if (!isGitRepo(repoPath)) {
        return { commits: [] };
      }

      const output = git(repoPath, ['log', `-${count}`, '--format=%h|%an|%aI|%s'])?.trim() || '';
      const commits = output.split('\n').filter(Boolean).map(line => {
        const [hash, author, date, ...msgParts] = line.split('|');
        return { hash, author, date, message: msgParts.join('|') };
      });

      return { commits };
    });

    ctx.bridgeCapabilities.register(ctx, 'git_diff', async (args, invocation) => {
      const repoPath = args.path || invocation.workspaceRoot;
      const ref = args.ref || 'HEAD';
      invocation.progress(`Computing diff against ${ref}`);

      if (!isGitRepo(repoPath)) {
        return { filesChanged: 0, insertions: 0, deletions: 0, diff: '' };
      }

      const fileArg = args.file || null;
      const statArgs = ['diff', ref, '--stat'];
      if (fileArg) statArgs.push('--', fileArg);
      const diffArgs = ['diff', ref];
      if (fileArg) diffArgs.push('--', fileArg);

      const diffOutput = git(repoPath, statArgs, 15000)?.trim() || '';
      const fullDiff = git(repoPath, diffArgs, 15000)?.trim() || '';

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
