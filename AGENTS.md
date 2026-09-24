# Working in CoNest

Read [CONTRIBUTING.md](CONTRIBUTING.md) before changing the repository. The project uses one root Node package. Run commands from the checkout root; do not recreate a nested `bridge/` package or a separate export tree.

- `src/` contains the runtime, Connector and Studio. `test/` contains behavior tests and isolated experiments. `extensions/` contains optional host integrations.
- On a clean checkout, use `node scripts/maintenance/bootstrap.mjs` before pnpm reads the local SDK dependencies. Then use `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm test` and `pnpm check`. Use the relevant integration checks in CONTRIBUTING for affected behavior.
- Preserve the existing `dsh-bridge` plugin/configuration ID, CLI aliases and persisted state identifiers unless a separately reviewed migration changes them. A directory refactor is not a protocol rename.
- Each worktree owns its dependency installation, `.vendor/`, build outputs and local state. Use `git worktree` to manage `.worktrees/`; do not share `node_modules` or check out another branch over active work.
- Public documentation starts at README (startup), CONTRIBUTING (collaboration), SECURITY (security reports), and `docs/README.md` (implementation references). Only the startup README has a Chinese counterpart.
- Keep internal plans, research, customer materials, prompts, reports and local migration records under ignored `.local/` or outside the repository. Do not add them to Git, PRs or release packages.
- Inspect current changes before editing. Preserve unrelated work, credentials and user data. Do not rewrite historical archives or start paid model tests as part of routine validation.
- Update paths in scripts, workflows, docs, lockfiles and package manifests together. A clean checkout must build without `.local/` or another worktree.
- Keep direct OpenClaw and DSH/Cordis imports inside `src/adapters/`. Keep adapter modules narrow so importing one capability does not activate unrelated SDK packages. Extend the public CoNest component/runtime contracts before adding another Agent-specific path, and update `compatibility.json` only with matrix evidence.
- Describe the actual checks run and remaining gaps. Do not equate a package build with native Windows execution or a fixture response with live-model inference.
