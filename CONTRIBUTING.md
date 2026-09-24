# Contributing to CoNest

Start with the [README](README.md) to run CoNest. This file defines how changes are proposed, reviewed and maintained. [Developer references](docs/README.md) are for work on components, host integration or packaging; they are not an onboarding checklist.

## Where work belongs

| Work | Start here | Required context |
| --- | --- | --- |
| Reproducible defect or regression | Bug report | Affected commit/version, environment, reproduction, expected and actual results |
| Incorrect or missing instructions | Bug report, Documentation area | Exact page/section, command or statement, and observed failure |
| New capability or public contract change | Feature request before a substantial implementation | User problem, acceptance criteria, affected interface and alternatives |
| Small, clearly scoped fix | PR; an existing issue is enough | Standalone explanation and relevant checks |
| Setup question | Question form | Goal, exact commands, environment and what you tried |
| Potential vulnerability | [Security contact procedure](#security) | Arrange a private route before sharing exploit details |

Search existing issues and PRs first. Add evidence to the existing report instead of creating duplicates. A feature discussion is not a commitment to implement it. Maintainers may ask that an integration remain an optional component rather than expanding the core.

Issues and review discussions may use English or Chinese. Maintained developer documentation, templates and identifiers use English.

## Issue requirements

Use the issue forms and keep one independently actionable problem per report.

- Give the CoNest branch, version and commit; OS/architecture; Node and pnpm versions; and the pinned OpenClaw version. Identify fixture versus live model execution when relevant.
- Provide the smallest reproducible configuration and numbered commands. Use synthetic workspace files instead of customer data. State expected behavior separately from the actual result and explain who is affected.
- For regressions, give the last working and first failing version if known. Retest on the current affected branch when practical; explain if you cannot. Do not silently upgrade pinned dependencies to reproduce.
- Paste short, redacted error text rather than screenshots of terminal output. UI defects may include a screenshot with the viewport and reproduction steps. Performance claims need workload, environment and before/after measurements.
- For feature requests, describe the task that is blocked, an observable acceptance criterion, alternatives considered and compatibility or permission implications. Do not attach internal proposals, customer presentations or private roadmaps.

Reports without enough information may be marked as needing information and closed with an explanation. Supply the missing reproduction in the original report to request reconsideration. There is no guaranteed response time or automatic acceptance based on votes.

## Branches and scope

All repository changes must go through a pull request, including contributions by the owner, maintainers and coding agents, repairs, and branch promotions. Push commits to a task branch and open or update its PR; never push commits directly to `main` or `develop`. Merge through GitHub only after review and the required checks pass. Ownership or administrative access does not exempt a contribution from this process.

Create `fix/<short-name>`, `feat/<short-name>` or `docs/<short-name>` from `develop`, and normally target `develop`. `main` receives reviewed stable fixes or promotions with matching validation. A maintainer can request a PR targeting `main` for a stable fix; identify the equivalent development change or explain why it does not apply.

Keep one coherent problem per PR. Separate unrelated formatting, refactoring, dependency upgrades and feature work. Related changes across many files belong together when they form one reviewable unit. Keep intermediate commits buildable; identify dependencies between PRs. Do not change unrelated files to satisfy a failing test.

Use a title such as `fix(runtime): revoke grants when permissions change` or `docs: clarify the first startup`. Allowed types: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `build`, `ci`, `chore`, `revert`. Use the same convention for commits. Explain the reason and relevant compatibility effect in the commit body when the title cannot carry them. Retain authorship and never invent another person's review, testing or sign-off trailer.

## Required PR body

Use the [PR template](.github/pull_request_template.md). The description must remain understandable without reading the chat, issue history or earlier versions of the PR.

| Section | What to write |
| --- | --- |
| Problem | Concrete trigger, current failure or missing behavior, and affected users or maintainers. Internal cleanup can state its maintenance benefit directly. |
| Changes | Resulting behavior and the reason for the implementation choice. Include a before/after example when useful; do not substitute a file list. |
| Validation | Exact commands and outcomes on the submitted revision. Identify fixtures, platforms and omitted checks with reasons. For UI work include a focused comparison; for packaging list the inspected artifact contents. |
| Compatibility and risks | Changes to plugin IDs, tool names/schemas, protocol, persisted state, permissions, dependency versions or platform support. State required restart/migration/recovery actions. Write an explicit explanation when there is no compatibility change. |
| Related issues | `Closes #123` only for a completed fix, otherwise `Related: #123`. A small standalone change may say `None —` followed by its justification. Substantial features must link the earlier discussion. |
| Checklist | Confirm review of the diff, accurate validation and compliance with the repository content boundary. |

Edit the body when scope, validation or risks change. Put important qualifications in the body, not only a review reply. Draft PRs may be incomplete; ready-for-review PRs must complete every section and checkbox. The contribution check verifies format and completeness; a reviewer decides whether the evidence is sufficient. Passing that check is not approval.

## Validation

Use the pinned toolchain from the README. Run commands from the repository root unless shown otherwise.

| Changed surface | Minimum relevant evidence |
| --- | --- |
| Documentation and repository rules | `python3 scripts/maintenance/check-repository.py`; verify local links, documented commands and rendered layout when affected |
| Contribution automation | `python3 scripts/maintenance/test-contribution.py`; demonstrate accepted and rejected PR bodies |
| TypeScript/runtime behavior | `pnpm run build` and `pnpm exec tsx --test 'test/*.test.ts'`; cover the changed behavior and its failure path |
| Component graph or lifecycle | Runtime tests plus `pnpm run test:runtime`; exercise retained calls, cleanup or revocation as applicable |
| Host policy, tools or Studio | Relevant host/E2E checks and an isolated Studio run; verify actual tool admission and cancellation where changed |
| Dependencies or SDK | Clean bootstrap, frozen install, build and tests on affected maintained branches; review licenses and update locks together |
| Agent adapter or compatibility range | Focused compatibility tests plus the `Agent compatibility` matrix: OpenClaw range endpoints and every declared DSH release; keep direct SDK imports in `src/adapters/` |
| Packaging/platform scripts | Build the affected target package, inspect its file list and checksum, and run installation checks on the claimed platform |

An isolated Studio check:

```bash
CONEST_DEMO_STATE=/absolute/disposable/conest-check \
  pnpm exec node scripts/demo-studio.mjs --verify
```

Choose regression assertions that would catch the reported failure. Do not add tests that merely restate implementation details or disable a failing assertion to obtain green CI. Report unrelated baseline failures separately. A Linux build is not Windows execution evidence; a deterministic model fixture is not live-model inference. State those limits in the PR.

CI and default local checks must not require provider keys, customer workspaces or paid inference. Live-model tests are explicit, separately configured runs. Keep results and credentials outside Git. Changes to permissions, state formats or cancellation need corresponding denial, compatibility or recovery checks.

## Review and merge

The author owns the PR until it is merged or closed: answer review points, keep the body current and rerun affected checks after changes. Explain disagreements with code, a reproducer or measured evidence. Review code and behavior, not the person; harassment, spam and repeated pressure on maintainers are unacceptable.

A maintainer checks scope, contract compatibility, validation and repository contents before merging. Resolve blocking feedback and required CI failures. Substantive changes after approval need another review. Prefer squash merging a single change; a deliberately structured series may retain its commits. An issue is closed only when the delivered change actually meets its acceptance criteria.

`CoNest Review` performs deterministic diff checks, repository/type checks and behavior tests with read-only PR permissions. A separate `workflow_run` job reads only its generated artifact and maintains one `github-actions` review comment. Treat blocker findings as required fixes or explain a false positive in the PR; warnings guide human review. This deterministic bot does not approve or merge PRs. A separately operated maintainer service can take over repairs under the same PR and validation requirements.

PR events publish a queue receipt for the separately operated maintainer service. That service may review and repair the original PR branch, then merge after review and required CI pass; original contributor credit must be retained. Its controller code, deployment files, machine configuration and operational records are maintained outside this product repository. The repository retains CI checks and the PR notification workflow.

Release and SDK publication remain maintainer responsibilities. Do not move existing version tags, overwrite published artifacts, change branch protections or claim a platform is supported just because a workflow exists. Branch promotion must preserve that branch's implemented capabilities.

AI-assisted contributions follow the same rules. The submitting person remains responsible for understanding every change, reviewing generated code, preserving third-party notices and accurately reporting tests. Generated assertions or fabricated logs are not evidence. Do not include prompts, chat transcripts or internal planning documents as development records.

## Documentation and repository content

The public reading path is intentionally small:

1. **Run the project:** `README.md` and its Chinese startup counterpart `README-zh.md`.
2. **Contribute:** this English-only file, with GitHub issue and PR templates. [SECURITY.md](SECURITY.md) defines vulnerability reporting; [AGENTS.md](AGENTS.md) gives coding assistants the same repository rules.
3. **Modify an implementation:** `README.md` links the few relevant technical references.

Update an existing canonical section before adding a document. A new guide needs a distinct reader and task, an entry link, and an explanation of why the existing reference cannot cover it. Developer contracts describe implemented behavior; release evidence belongs in CI or release artifacts, not a growing collection of dated Markdown reports.

Only the root startup README has a maintained Chinese counterpart. Do not create translated contribution rules, implementation notes or internal planning files. Use English/ASCII file names. The public Markdown inventory is checked by `scripts/maintenance/check-repository.py`; adding another entry is a review decision, not a way to bypass this policy.

Never commit company/customer proposals, roadmaps, internal architecture plans, speaker notes, slide decks, generated planning images, prompts, meeting/chat records or delivery tutorials. Keep such material outside the checkout or under ignored `.local/`. Do not include it in issues, PR attachments or release packages either. Public feature discussion should contain only the minimum non-confidential problem and acceptance criteria.

Commit source, required configuration, locks, minimal examples, meaningful tests and maintained developer contracts. Dependencies, build output, credentials, runtime state and reports remain untracked. Package documentation uses an explicit allowlist. Preserve third-party licenses; a new dependency needs its origin, license and runtime impact reviewed. Never silently alter licensing in an unrelated change.

## Security

Follow [SECURITY.md](SECURITY.md) for private reporting and CoNest's trust boundaries. Keep exploit details and private data out of public issues and PRs.

## Licensing

CoNest original code is MIT licensed. Contributions to original project code are submitted under the same [LICENSE](LICENSE). Preserve existing authorship and third-party notices; identify imported code and its source. [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) describes dependency and asset attribution. The package remains marked private to prevent accidental npm publication; this does not change its open-source license.

## References

These are CoNest rules, informed by [OpenClaw's contribution workflow](https://github.com/openclaw/openclaw/blob/main/CONTRIBUTING.md), the Linux kernel's [patch submission guide](https://docs.kernel.org/process/submitting-patches.html) and [issue reporting guide](https://docs.kernel.org/admin-guide/reporting-issues.html). We use GitHub PRs, CoNest's pinned dependencies and the checks above; upstream project-specific commands and mailing-list procedures do not apply here.

## Checkout and worktree layout

CoNest is one root package. Its Git tree and local source tree use identical paths; there is no staging/export copy of source to publish. `git ls-files` is the public subset of this checkout. Local dependencies and outputs add `.vendor/`, `node_modules/`, `lib/` and `dist/`; private working material belongs under `.local/`.

Use `.worktrees/<branch>` for additional checkouts, managed by Git:

```bash
git worktree add .worktrees/main main
cd .worktrees/main
node scripts/maintenance/bootstrap.mjs
pnpm install --frozen-lockfile
pnpm build
```

Use `git worktree move` or `git worktree remove` when changing registered worktrees. Never remove an active/dirty worktree with a filesystem deletion. Each worktree owns its dependencies and generated state; do not link `node_modules` to another checkout. Keep `.local/` contents out of commits and package file lists.

Run `pnpm check` for repository, contributor-policy and type checks. `.node-version` and `packageManager` pin the toolchain; `.editorconfig` and `.gitattributes` define text conventions. `.github/CODEOWNERS` routes reviews to the current maintainer. These files do not themselves configure branch protection or grant a reviewer merge authority.