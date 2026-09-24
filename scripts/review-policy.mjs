const IMPORT = /\bfrom\s+["'](?:openclaw\/|@deepseek-ai\/)|\bimport\s*\(["'](?:openclaw\/|@deepseek-ai\/)/;
const PRIVATE_PATH = /^(?:\.local|\.worktrees|maintenance\/local|docs\/(?:archive|research|scripts))(?:\/|$)/;

export async function analyzeReview({ files, readFile, patches = new Map() }) {
  const findings = [];
  const add = (severity, id, path, message) => findings.push({ severity, id, path, message });
  const changed = new Set(files);

  for (const file of files) {
    if (PRIVATE_PATH.test(file)) add('blocker', 'private-content', file, 'Local plans, worktrees and private records cannot enter the public repository.');
    if (file.startsWith('bridge/')) add('blocker', 'legacy-layout', file, 'The retired bridge/ package layout cannot be restored.');
    if (file.startsWith('src/') && !file.startsWith('src/adapters/') && /\.(?:[cm]?ts|[cm]?js)$/.test(file)) {
      let source = '';
      try { source = await readFile(file); } catch {}
      if (IMPORT.test(source)) add('blocker', 'adapter-bypass', file, 'Third-party Agent SDK imports must stay behind src/adapters/.');
    }
  }

  const adapterChange = files.some(file => file.startsWith('src/adapters/') || file === 'src/compatibility.ts' || file === 'compatibility.json');
  if (adapterChange && !files.some(file => /^test\/compatibility(?:-|\.)/.test(file))) {
    add('blocker', 'compatibility-evidence', 'test/compatibility.test.ts', 'Adapter or compatibility changes require focused contract tests.');
  }
  if (adapterChange) add('info', 'compatibility-matrix', 'compatibility.json', 'The compatibility workflow will exercise OpenClaw range endpoints and every declared DSH release.');

  const protocolPatch = patches.get('src/types.ts') ?? '';
  if (/^[+-].*PROTOCOL_VERSION/m.test(protocolPatch) && !files.some(file => /^test\/(?:client|runtime|protocol).*\.test\./.test(file))) {
    add('blocker', 'protocol-evidence', 'src/types.ts', 'Runtime protocol changes require a protocol/client/runtime compatibility test.');
  }
  if (changed.has('package.json') && !changed.has('pnpm-lock.yaml')) {
    add('warning', 'manifest-without-lock', 'package.json', 'Confirm that the manifest-only change does not alter the resolved dependency graph.');
  }
  if (files.some(file => file.startsWith('.github/workflows/') || ['SECURITY.md', '.github/CODEOWNERS'].includes(file))) {
    add('warning', 'governance-change', '.github/', 'Review token permissions, untrusted checkout boundaries and ownership changes manually.');
  }
  if (files.some(file => file.startsWith('src/')) && !files.some(file => file.startsWith('test/'))) {
    add('warning', 'source-without-test', 'test/', 'Runtime source changed without a focused test in this diff.');
  }
  if (files.length > 80) add('warning', 'large-change', '.', `This change touches ${files.length} files; verify that it remains one reviewable concern.`);

  const rank = { blocker: 0, warning: 1, info: 2 };
  findings.sort((a, b) => rank[a.severity] - rank[b.severity] || a.path.localeCompare(b.path) || a.id.localeCompare(b.id));
  const allFindings = findings.length;
  return {
    schemaVersion: 1,
    decision: findings.some(item => item.severity === 'blocker') ? 'changes-requested' : 'ready-for-human-review',
    changedFiles: files.length,
    counts: Object.fromEntries(['blocker', 'warning', 'info'].map(severity => [severity, findings.filter(item => item.severity === severity).length])),
    omittedFindings: Math.max(0, allFindings - 100),
    findings: findings.slice(0, 100),
  };
}

export function renderReview(report) {
  const icon = { blocker: '⛔', warning: '⚠️', info: 'ℹ️' };
  const lines = [
    '<!-- conest-review:v1 -->',
    '## CoNest Review',
    '',
    report.decision === 'changes-requested'
      ? `Changes requested: ${report.counts.blocker} blocking finding(s).`
      : `Ready for human review: no deterministic blockers across ${report.changedFiles} changed file(s).`,
    '',
  ];
  if (!report.findings.length) lines.push('No policy findings. CI results and maintainer judgment still apply.');
  for (const finding of report.findings) lines.push(`- ${icon[finding.severity]} **${finding.id}** · \`${finding.path}\` — ${finding.message}`);
  if (report.omittedFindings) lines.push(`- … ${report.omittedFindings} additional finding(s) are available in the JSON artifact.`);
  lines.push('', '_Generated from the reviewed head commit. This report does not approve or merge the PR._', '');
  return lines.join('\n');
}
