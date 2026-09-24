# CoNest developer references

To **start CoNest**, use the [project README](../README.md). To **submit a change**, use [CONTRIBUTING](../CONTRIBUTING.md). The references below are needed only when modifying their corresponding implementation.

| Task | Reference | Source entry points |
| --- | --- | --- |
| Implement or configure a component | [Components](components.md) | `src/components.ts`, `src/runtime.ts`, `examples/` |
| Change host integration or authorization | [Host integration](host-integration.md) | `src/index.ts`, `src/host-adapter.ts`, `src/authorization.ts`, `src/studio/` |
| Build and validate installation artifacts | [Packaging](installation.md) | `scripts/pack-release.mjs`, `scripts/test-installation.mjs` |
| Restore or update the pinned SDK | [Dependency provenance](dependencies.md) | `scripts/maintenance/bootstrap.mjs`, `scripts/maintenance/sdk.lock.json` |

This branch contains **0.6.4**. The plugin ID is `dsh-bridge`; package version and host compatibility are declared in [package.json](../package.json) and [openclaw.plugin.json](../openclaw.plugin.json).

```text
src/          Connector, runtime, host services and Studio
test/         Behavioral and regression tests
scripts/      Builds, packaging and integration checks
docs/         Implementation and dependency references
examples/     Minimal installable components and policies
test/experiments/  Isolated Loader and DSH compatibility probes
extensions/   Optional DSH Web integration
patches/      Pinned dependency patches
```

Experiment notes live beside their fixtures; they qualify only the stated probe. Test and validation commands belong in CONTRIBUTING. Internal plans, customer materials and run reports stay outside Git.

The public checkout and your working source tree are the same layout. `.local/` holds private plans, archives, validation reports and release candidates; `.worktrees/` holds separately registered Git worktrees. Both are ignored. Dependencies (`node_modules/`, `.vendor/`) and generated output (`lib/`, `dist/`) are local additions, never a second source tree.

For repository maintenance, see [CONTRIBUTING](../CONTRIBUTING.md#checkout-and-worktree-layout), [security reporting](../SECURITY.md) and [agent instructions](../AGENTS.md).
