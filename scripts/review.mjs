#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { analyzeReview, renderReview } from './review-policy.mjs';

const args = process.argv.slice(2);
const value = name => { const index = args.indexOf(name); return index === -1 ? undefined : args[index + 1]; };
const workingTree = args.includes('--working-tree');
const base = value('--base') ?? (process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : undefined) ?? 'HEAD^';
const head = value('--head') ?? process.env.GITHUB_SHA ?? 'HEAD';
const output = path.resolve(value('--output') ?? '.local/review');
const range = workingTree ? ['HEAD'] : [`${base}...${head}`];
const git = (...gitArgs) => execFileSync('git', gitArgs, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });

const files = git('diff', '--name-only', '--diff-filter=ACMRTUXB', ...range).split('\n').filter(Boolean);
const patches = new Map(files.map(file => [file, git('diff', '--unified=0', ...range, '--', file)]));
const report = await analyzeReview({
  files,
  patches,
  readFile: async file => await readFile(file, 'utf8'),
});
report.base = base;
report.head = head;
report.generatedAt = new Date().toISOString();
const markdown = renderReview(report);
await mkdir(output, { recursive: true });
await writeFile(path.join(output, 'review.json'), `${JSON.stringify(report, null, 2)}\n`);
await writeFile(path.join(output, 'review.md'), markdown);
if (process.env.GITHUB_STEP_SUMMARY) await writeFile(process.env.GITHUB_STEP_SUMMARY, markdown, { flag: 'a' });
process.stdout.write(markdown);
if (report.decision === 'changes-requested') process.exitCode = 1;
