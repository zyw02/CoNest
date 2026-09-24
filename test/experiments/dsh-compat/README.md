# Real DSH compatibility matrix

This document describes the isolated developer profile in `experiments/dsh-compat`, not the complete Studio integration or the default tool catalog. Results below apply only to that profile and its probes; run `pnpm run test:compat` from `` for current evidence.

Evidence: machine-readable result, executed TAP, [native-plugin profile](profile.mjs), and [assertions](compat.test.mjs). The passing run has 10 tests, zero failures, zero skipped tests, no paid model calls, and no external web requests. It includes the production worker RPC, but is not a new OpenClaw agent/model or clean-install acceptance run.

## Version and evidence boundary

All DSH packages below are `@deepseek-ai/…` version **0.1.0-rc.5** from the existing frozen source checkout. Cordis is **4.0.1**, native Loader **1.0.2**. Execution was on **Linux x64, Node 24.15.0**. Other operating systems and DSH versions are unqualified.

The report records each selected package's manifest, complete `src` tree, and complete `lib` tree SHA-256, plus the test/profile, selected runtime files and lockfile hashes. Hashes are checked again after execution. These identify the selected source/build content, not a publisher signature or the complete transitive dependency closure. No upstream DSH package was edited to obtain these results.

There are 11 candidate/contract packages in the matrix, plus three supporting infrastructure packages. This is **not 14 compatible plugins**: a dependency contract, a working service, a working subset of a tool suite, an activated-but-unusable tool, and a static review are separate outcomes.

## Candidate matrix

Names below omit the common `@deepseek-ai/` prefix. “Qualified” always means only the stated profile and probes.

| Package | Required services | Executed profile / observed behavior | Verdict |
| --- | --- | --- | --- |
| `dsh-fs` | Provider contract; not a concrete backend | Native target identity, metadata and containment contract exercised through `dsh-fs-local` | Dependency contract exercised; not a standalone tool |
| `dsh-fs-local` | No injected service | Explicit workspace `cwd`; real bounded byte read, stat/missing stat, directory listing, over-limit rejection, pre-abort and mid-stream abort | Qualified read-only service profile |
| `dsh-tool-fs` | `tools`, `fs`, `systemPrompt` | Native `read` executes without a DSH Agent; real streamed line windows, long-line cap, binary/missing-file rejection; also crosses worker RPC | Qualified **read tool only**; not the full suite |
| `dsh-tool-fs-search` | `tools`, `systemPrompt`, `subprocess` | Native `glob` in an isolated profile; existing `knowledge_search` invokes native `grep`; both execute packaged ripgrep | Qualified fixed-root glob plus existing literal-grep mapping |
| `dsh-skill` | No injected service | Real registry `list`/`get`, absent-name result, and provider removal on disposal | Qualified registry data API; not instruction injection |
| `dsh-skill-filesystem` | `skills`; optional `fs` supplied here | Real frontmatter/body discovery from one controlled custom root; default roots disabled and `watch:false` | Qualified explicit-root, watcher-disabled provider |
| `dsh-tool-skill` | `agents`, `tools`, `skills` | Actual plugin mounted; `agents` is missing and `skill` never registers | Blocked activation; not published as a usable capability |
| `dsh-tool-todo` | `tools` | Actual `todo_write` registers; a valid call without `exec.agent` returns `todo_write requires an owning agent session` | Activated, but unusable under the current host mapping |
| `dsh-plan-mode` | `tools`, `systemPrompt` | Actual controller and `exit_plan_mode` register; valid call returns `exit_plan_mode requires a calling agent (no session to switch)` | Activated, but agent/session workflow is unmapped |
| `dsh-web-fetch-http` | `web` | Source review only; not mounted and no fetch performed | Unqualified / outside current permission scope |
| `dsh-tool-web` | `tools`, `web`, `systemPrompt` | Source review only; no provider or network permission installed | Unqualified / outside current permission scope |

Supporting packages, also pinned to 0.1.0-rc.5:

| Package | Composition and evidence | Not established here |
| --- | --- | --- |
| `dsh-system-prompt` | Real service receives the native plugins' sections and tool registrations | Its prompt assembly is not bridged into OpenClaw's prompt |
| `dsh-tools` | `systemPrompt` injected, `mode:native`; real schema validation, execute/results and scoped registration cleanup | DSH agent execution events, approvals, UI or session logging |
| `dsh-subprocess-local` | Actual packaged ripgrep subprocesses used by glob/grep | General shell access or arbitrary model-controlled command execution |

## Host mapping and permissions

| CoNest surface | Native mapping | Boundary |
| --- | --- | --- |
| `compat_fs` | `fs.resolve`, `contains`, `stat`, `readBytes`, `listDir` | `workspace:read`; canonical path containment; byte reads capped at 4096; at most three directory entries returned |
| `compat_read` | `tools.execute({name:'read', arguments, callId, signal})` | `workspace:read`; canonical target checked before dispatch; at most three lines, 32 characters per source line, 128 source-content bytes; streaming threshold 1 byte |
| `compat_glob` | Native `glob` with fixed `*.txt` and workspace root | `workspace:read`; at most three paths retained; no arbitrary glob/path parameters exposed by this profile |
| `knowledge_search` | Existing literal query → escaped regex → native `grep` | Existing release behavior and permissions unchanged |
| `compat_skills` | `skills.list/get({cwd,signal})` | Controlled fixture inspection only; at most ten summaries / 4096 body characters returned; invocation metadata preserved |
| `compat_host_requirements` | Fixed valid Todo/Plan negative calls and Skill registration diagnostics | Developer-only probe; no user-supplied tool name or mutation arguments; fails if DSH `agents` unexpectedly exists |

The CoNest call ID and abort signal reach native execution. Its workspace becomes the provider's explicit cwd or a checked absolute tool path. The CoNest principal remains a policy identity: it is **not** converted into `exec.agent`, a DSH Session, a UI channel, or a second loop. No fake Agent/Session is supplied to make an incompatible plugin appear functional. Native successful values return as JSON; native errors become CoNest errors. Rich cards and attachments are not mapped.

The actual filesystem suite registers `write` and `edit` internally, but the profile exposes neither them nor a generic native-tool dispatcher. Tests assert they are absent from the CoNest catalog; `read_image` is not even registered without `attachments`. Todo/Plan names and native `skill` likewise never enter that catalog. Every profile capability requires `workspace:read`, and permission denial is exercised.

## Lifecycle, cancellation and limits

The profile owns real, isolated tools, prompt, subprocess, filesystem and skill services; it does not borrow the existing search component's mutable registry. Disabling it through the production Runtime removes read/glob/Todo/Plan registrations, removes its skill provider, and withdraws capabilities. Re-enabling creates a different native tools instance and successfully reads again. The baseline search component runs alongside it without a name collision.

Actual filesystem pre-abort and cancellation after the first real stream chunk are tested. The wrapper passes invocation signals through; this run does **not** establish new end-to-end cancellation guarantees for every plugin. Existing scheduler/worker cancellation qualification remains in [runtime acceptance](../../../docs/components.md#component-contract-and-lifecycle). No watcher teardown is claimed because skill watching is explicitly disabled. No new overlapping-upgrade or module-global rollback guarantee is claimed by this profile's disable/enable test.

Important limits:

- `fs-local` cwd is not a sandbox. The adapter rejects stable traversal and symlink escapes, but does not defend against hostile concurrent filesystem replacement. Directory listings and skill bodies can be materialized before output slicing; output caps are not complete memory/I/O caps.
- Skill fixture roots are trusted, controlled test data. Default project/user roots and watchers are disabled. Symlink-heavy or untrusted skill trees, live catalog invalidation, user/model invocation routing, and automatic instruction injection are not qualified.
- Plan additionally needs a real session workflow and user-question approval channel for success. Todo needs a real owning session and an explicit state-mutation policy. Those are host design work, not reasons to fabricate DSH objects.
- Network needs a new explicit permission and egress policy. The pinned HTTP provider README explicitly defers private-network/SSRF defenses; it must not simply be exposed with `workspace:read`. No web execution or cancellation claim is made.
- The profile imports built modules from the restored development SDK. It is not a relocatable component bundle, installed market item, default OpenClaw tool extension, or production filesystem security boundary.

## Reproduce and next boundary

From ``, after restoring the pinned SDK and installing dependencies, run:

```sh
pnpm run test:compat
pnpm test
```

The first command builds CoNest and runs the real-plugin test suite, saving `reports/dsh-compatibility/result.json` and `result.tap`. A failed attempt writes `failure.json` and exits nonzero; an older success is not proof that a later attempt passed. Tests create and remove their own temporary workspace and component fixtures. They do not install plugins into the user's running host, scan real user skill roots, or contact model providers.
