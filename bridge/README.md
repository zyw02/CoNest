# CoNest Connector for OpenClaw

**Development version: 0.6.4.** See the [Windows demo guide](docs/windows-0.6.4-zh.md) and [release scope](docs/release-0.6.4-zh.md). Historical release artifacts remain unchanged.

The 2026-09-14 development changes connect [both loops to the component runtime](docs/dual-loop-component-runtime-zh.md) through finalized host tool admission and lifecycle hooks. The [search](docs/search-component-zh.md), [read](docs/read-component-zh.md) and [memory](docs/memory-component-zh.md) migrations move their tools into managed workers while preserving permissions, guarded-edit observations and shared memory. In 0.6.4 the fixed DSH composition, including Agent/Session and write/edit/image/Bash tools, has moved into the shared CoNest Host. Gateway retains the Connector and admitted host tool callbacks. Existing release archives are unchanged.

For the 0.6.2 baseline, see the [Ubuntu installation and demo guide](docs/ubuntu-installation-demo-zh.md) and [architecture, deployment boundaries and validation scope](docs/conest-design-zh.md), both in Chinese.

CoNest Connector 0.6.2 adds an opt-in **CoNest Studio** to the unmodified OpenClaw 2026.9.2 release: a shared OpenClaw + DSH Market catalog, selectable OpenClaw/DSH agent loops, tools from both ecosystems in either loop, persistent shared memory, and a visual execution timeline. A companion DSH Web plugin exposes the same Studio inside DSH. See [the Studio installation and demo guide](./STUDIO-zh.md).

The plugin ID remains `dsh-bridge`. Without `config.studio`, the component worker and its authorization/lifecycle behavior remain available; shared memory additionally requires a runtime `memoryFilePath`. Studio requires explicit configuration and model/tool admission. Market entries are discoverable metadata, not a claim that every upstream plugin is installed or runtime-compatible.

Historical 0.6.1 component-runtime qualification remains in [HOST-ENHANCEMENT-ACCEPTANCE.md](./HOST-ENHANCEMENT-ACCEPTANCE.md); previous reports are not relabeled as 0.6.2 evidence. The preserved source trees are unchanged. Studio is currently an internal Linux x64/Node 24 demonstration, not a general multi-user production deployment.

## Architecture and tool contract

The development adapter registers sixteen stable OpenClaw tools:

| Tool | Purpose |
| --- | --- |
| `dsh_mcp__reference_memory__*` (nine tools) | Shared graph operations in the managed memory component, with separate read/write permissions. |
| `bridge_capabilities` | Discover currently available capabilities, provider IDs/versions, permissions, input/output schemas, and a generation token. |
| `bridge_invoke` | Call a discovered capability using its name, generation, and schema-valid arguments. |
| `knowledge_search` | Convenience tool for the built-in DSH literal search capability. |
| `knowledge_verify` | Convenience tool for the built-in exact-quote verifier. |
| `dsh_grep` | DSH regular-expression search with workspace path and file filtering, served by the search component. |
| `dsh_glob` | DSH file-path glob search, served by the same search component. |
| `dsh_read` | DSH text read with original line windows and guarded-edit observation handoff. |

New component capabilities appear through discovery and generic invocation without adapter edits, a host restart, or another Agent Loop. They do not each become separately named OpenClaw tools. Capability schemas remain discoverable, rather than being flattened into a generated host tool list.

The Gateway's service and request-time plugin registries share one supervised worker per canonical CoNest Connector configuration in the same process. Worker ownership is exclusive across processes. A private inherited NDJSON pipe carries task traffic; a same-user Unix socket carries explicit operator management. A second Gateway cannot independently own the same configuration.

## Standalone local pilot

Use the private Linux x64 release archive for installation without the restored source workspace. It bundles the pinned runtime dependency closure, including Cordis Loader, licenses, and tested native assets; `runtime-lock.json` records the exact package count and hashes. Install the exact official host and DeepSeek provider separately, then use `conest-local setup`, `doctor`, `start`, `ask`, `status`, and `stop`. See [INSTALLATION.md](./INSTALLATION.md) for the complete commands and platform requirements.

The local profile references a private credential file, uses the official DeepSeek provider directly, and keeps state outside the searchable workspace. It does not overwrite an existing profile, install a global service, connect a channel, or restart failed Gateway work automatically. Component workers inherit an OS environment allowlist without provider credentials or Gateway tokens. Trusted code remains able to access files available to its OS account; this is not a hostile-code sandbox.

## Development requirements and setup

Linux x64 is the development validation baseline. Use Node.js 24.15.0, pnpm 11.7.0 and tar; Python 3, make and a C++ compiler are required when native dependencies build from source. OpenClaw 2026.9.2 and ordinary dependencies install from npm. The preserved DSH SDK downloads from a checksum-pinned Release, with source, JavaScript libraries, types and licenses.

From the repository root:

```sh
node maintenance/bootstrap.mjs
pnpm --dir bridge install --frozen-lockfile
pnpm --dir bridge run build
pnpm --dir bridge exec tsx --test 'test/*.test.ts'
```

No original `.runtime`, `.tooling` or `source/workspace` directory is required. See [dependency provenance and offline SDK use](../maintenance/DEPENDENCIES-zh.md) and [the contribution guide](../CONTRIBUTING-zh.md). Git ignores downloaded SDK content and installed dependencies.

The commands below run from the `bridge/` package directory.

Create a dedicated configuration outside the searchable workspace when practical:

```sh
node dist/cli.js init --config /absolute/config/bridge.json --workspace /absolute/workspace
```

`init` requires an existing parent directory and refuses to overwrite a file. Add the following to your existing OpenClaw plugin configuration, preserving its other entries:

```json
{
  "plugins": {
    "enabled": true,
    "allow": ["dsh-bridge"],
    "load": { "paths": ["/absolute/path/to/openclaw-dsh-bridge/bridge"] },
    "entries": {
      "dsh-bridge": {
        "enabled": true,
        "hooks": { "allowConversationAccess": true },
        "config": { "configFile": "/absolute/config/bridge.json" }
      }
    }
  }
}
```

For an ephemeral built-in-only setup, `config.workspaceRoot` can replace `config.configFile`. Persistent component management requires a configuration file. Changing the searchable workspace requires a plugin service restart, not a component reload.

Changing the Connector package requires stopping the old worker and restarting the plugin service; live component reload does not replace the worker implementation. The private protocol remains version 3 from 0.4 through 0.6. Review third-party manifests whose `bridgeVersion` excludes 0.6; widening that range requires compatibility validation, not bypassing the check. OpenClaw requires the explicit `hooks.allowConversationAccess` opt-in above for the public post-policy hook. The CoNest Connector ignores conversation content and retains only additional tool denials, not the host authority object. Without a valid finalized policy snapshot, main-Loop calls fail closed with `HOST_POLICY_UNAVAILABLE`. Do not enable this permission in a real deployment without reviewing it. The isolated tests and generated local pilot profile explicitly enable this permission.

## Live component management

The 0.6.1 candidate supports one explicitly enabled [dynamic workspace context provider](./CONTEXT-PROVIDERS.md). It passes bounded current-task text to an installed component and appends bounded source data after live permission/generation revalidation. It is disabled by default, does not pass conversation history, and is not included in older 0.6.0 archives. The authenticated status page and `/conest` expose payload-free outcome counters shared across host registries.

In the 0.6.1 candidate, `plugins.entries.dsh-bridge.config.capabilityGuidance: true` enables a short static prompt-context contribution through the same authorized prompt hook, without changing the system prompt. Default is false. Both `bridge_capabilities` and `bridge_invoke` must be available in the finalized host tool set. This does not enumerate components, read conversation content, grant execution rights, or create another loop. Catalogs remain live and policy-filtered at tool execution; component text is never promoted into system instructions. See [HOST-ADAPTER.md](./HOST-ADAPTER.md) for scope and verification. Existing 0.6.0 archives do not contain this option.

The CLI connects to the worker already owned by the Gateway. If no worker is running, it starts and cleans up a temporary worker for the command. All component operations persist configuration only after the candidate generation is accepted.

```sh
node dist/cli.js --config /absolute/config/bridge.json components list
node dist/cli.js --config /absolute/config/bridge.json components install ./examples/source-verifier/component.json
node dist/cli.js --config /absolute/config/bridge.json catalog
node dist/cli.js --config /absolute/config/bridge.json invoke source_verify '{"query":"release marker","quote":"exact source text"}'
node dist/cli.js --config /absolute/config/bridge.json components configure source-verifier ./component-settings.json
node dist/cli.js --config /absolute/config/bridge.json components disable source-verifier
node dist/cli.js --config /absolute/config/bridge.json components enable source-verifier
node dist/cli.js --config /absolute/config/bridge.json components upgrade source-verifier /absolute/new-bundle/component.json
node dist/cli.js --config /absolute/config/bridge.json components uninstall source-verifier
```

Add `--json` for machine-readable output. `component-settings.json` is a JSON object, for example `{"label":"reviewed-source"}`. `status`, `catalog`, `reload`, `search QUERY`, and `verify QUERY QUOTE` are also available.

Installation copies the self-contained bundle into a content-addressed snapshot beside the configuration under `.dsh-bridge/`. Bundles are limited to 1,024 files and 10 MiB, with no symlinks. A SHA-256 integrity value protects the installed snapshot against accidental changes. Changed executable content requires a new component version when upgrading through the manager. Keep relative imports inside the bundle; bundled artifacts are recommended for third-party dependencies.

Failed activation, incompatible dependency upgrades, configuration conflicts, and stale management revisions leave the accepted runtime and manager-owned configuration unchanged. Candidate startup can still have component-defined external effects: trusted components must implement reversible activation and cleanup. An operator's manual disk edits are not automatically reverted.

Uninstall removes the component from the configuration and live catalog. Old snapshots are deliberately retained for recovery; reinstall or upgrade from a retained manifest is possible. There is no automatic disk garbage collection in this release. Do not remove snapshots while a worker may still reference them.

## Component contract and lifecycle

The `bridge/examples/` directory contains independently installable example components:

| Example | Capabilities | Notes |
| --- | --- | --- |
| [source-verifier](./examples/source-verifier/component.json) | `source_verify` | Declares `requires: {"dsh-search":"^0.2.0"}`; demonstrates cross-component dependency and invocation. |
| [git-inspector](./examples/git-inspector/component.json) | `git_status`, `git_log`, `git_diff` | Git repository inspection via `spawnSync` (direct binary execution, no shell). Demonstrates subprocess-free component pattern. |
| [web-fetch](./examples/web-fetch/component.json) | `fetch_url` | Fetch a URL and extract clean text. Demonstrates outbound HTTP via Node built-in `https`. |
| [system-info](./examples/system-info/component.json) | `system_metrics`, `top_processes` | CPU/memory/disk metrics via `/proc` and `spawnSync`. Demonstrates host introspection. |

Each example is a self-contained bundle with `component.json` (manifest) and `component.mjs` (ESM entry). They are not hardcoded in the adapter; install them through the management API or reference their manifest directly in config.

A manifest declares `id`, semantic `version`, `description`, `entry`, required component version ranges, and capability descriptors. Optional `bridgeVersion`, `configSchema`, and per-capability `outputSchema` are validated. `bridge_capabilities` and `bridge_invoke` are reserved names. Discovery reads declarative JSON and hashes bundle content without executing component code.

The ESM entry exports an object with `apply(ctx, config)` and optional string-array `inject`. Register a capability with `ctx.bridgeCapabilities.register(ctx, name, handler)`. Invoke another through `ctx.bridgeCapabilities.invoke(name, args, invocation)`, forwarding the invocation context. Cross-component calls require a declared component dependency; every call checks permissions and input/output contracts. Recursive capability calls are rejected. Component configuration remains literal JSON; Loader expression objects are not evaluated.

Use Cordis-owned effects for listeners, timers, and service registrations. Handlers must honor `invocation.signal`; never retain invocation authority for later background work. Write diagnostics to stderr, since worker stdout is reserved for protocol frames. Cordis is a lifecycle framework, not a hostile-code sandbox.

The adapter maps manifest dependencies to Cordis readiness services. Missing or disabled dependencies prevent activation. Loss of an injected service withdraws the provider and dependent capabilities, releases their effects, and aborts affected cooperative calls; service recovery reactivates them without configuration reload. A completely disposed/failed component may require explicit reload. New calls use a validated candidate generation after upgrades; already admitted work stays on its original version until it finishes or is cancelled. Retired generations are bounded.

One native Loader owns uniquely identified component entries. An unchanged ready component is reused only when its configuration, manifest/integrity, and dependency instances are unchanged. Updates create separate entries for affected dependents; unrelated caches, listeners, and ports survive. Accepted and leased graphs jointly own shared entries. An entry is removed only when its last graph owner releases it, and removal awaits native asynchronous cleanup. Nested capability calls follow the original admitted graph even when the calling component is shared with newer graphs. Every published graph has a unique opaque token, including when configuration is reverted to earlier bytes; do not parse or persist a token as a reusable authorization.

Application services are isolated per component and explicitly joined through its declared dependency closure. An `inject` service supplied by another component therefore requires that provider in `requires` (directly or transitively); ambiguous multiple providers are rejected. Undeclared services and the Loader management service are not inherited from unrelated entries. The search entry owns its DSH `tools`, `systemPrompt`, and `subprocess` children. This is lifecycle scoping, not protection from trusted JavaScript using `ctx.root`, process globals, or external side effects. Shared provider APIs must support overlapping consumers; candidate startup must not mutate accepted shared state irreversibly. Arbitrary DSH plugins are not automatically qualified for this mode.

## Configuration

See [conest.config.example.json](./conest.config.example.json). External `components` entries accept a manifest path or `{manifest, enabled, config, integrity}`. Path-only entries are for development; use managed snapshots for reliable upgrades of bundles with relative imports. Built-ins are independently configurable through `builtins.dsh-search` and `builtins.result-verifier`; they can be disabled but not uninstalled.

| Setting | Default | Meaning |
| --- | ---: | --- |
| `memoryFilePath` | Studio binding, otherwise absent | Shared JSONL file; changes require worker restart. |
| `permissions` | `["workspace:read"]`, plus `memory:read` and `memory:write` when a memory file is configured | Worker-wide permission ceiling; explicit arrays preserve their restrictions. |
| `maxConcurrent` / `maxQueued` | `4` / `32` | Running and queued capability limits. |
| `maxTasks` | `128` | Bound for pending grants plus admitted tasks. |
| `taskTtlMs` | `120000` | Maximum authorization and execution lifetime. |
| `abortGraceMs` | `1000` | Worker watchdog grace for work ignoring task cancellation. |
| `startupTimeoutMs` | `15000` | Worker/component startup deadline. |
| `shutdownTimeoutMs` | `5000` | Graceful process shutdown window before forced reaping. |
| `maxPayloadBytes` | `256000` | Configurable request framing bound. Responses also have a fixed 2 MB ceiling. |
| `maxRetiredGenerations` | `2` | Old generations retaining active calls. |

Unknown fields, duplicate IDs/capability names, invalid schemas, incompatible CoNest Connector versions, and out-of-range limits are rejected. Initial missing dependencies produce observable degraded state. A failed runtime is not silently reported as healthy.

## Authorization and recovery boundaries

OpenClaw admits these host tools under its own policy. The adapter refuses sandboxed execution because its host-side worker would escape that sandbox. Workspace-only host policies must contain the configured canonical root. The worker independently checks workspace identity and permissions for every admitted and nested capability call.

The adapter, not model arguments, supplies subject, agent/requester principal, task/call identity, parent run, workspace, capability ceiling, permissions, and abort signal. A random one-use grant binds that scope to an immutable generation and expiry. Replay, forged scope, stale generation, revocation, and expiry are rejected. Host run completion/cancellation revokes retained call bindings; direct operator calls have their own bounded call lifetime.

Worker capability rules now apply equally to discovery, direct tools, generic invocation, and nested component calls. Defaults, Agent rules, requester rules, and the adapter ceiling intersect; an allow never overrides a denial. OpenClaw global/Agent/provider tool restrictions additionally narrow the CoNest Connector ceiling, and a supported main Loop supplies final tool-surface denials through the public post-policy hook. Denying `knowledge_search` in the tested host policy cannot be bypassed with `bridge_invoke` or a dependent verifier. See [AUTHORIZATION.md](./AUTHORIZATION.md) for exact supported host-policy boundaries, requester identity requirements, and operator behavior.

```sh
node dist/cli.js --config /absolute/config/bridge.json policy show
node dist/cli.js --config /absolute/config/bridge.json policy set ./examples/capability-policy.json
```

Policy changes use the same validated atomic commit as component changes. A changed worker policy or permission ceiling revokes pending grants and cancels all active/queued tasks; clients must start new tasks. Component-only upgrades continue to pin active work to its old generation. `status.policyDenials` exposes a process-lifetime denial counter without recording source contents or requester identifiers. The same-user operator socket cannot supply an Agent identity to escape its own rules.

The built-in components declare workspace-read and memory-read/write permissions. Installed JavaScript is trusted and can access the worker OS account; use separate OS/container isolation for untrusted code. Neither manifest permissions nor content hashes sandbox arbitrary imports, environment access, or network calls.

Task timeout cancels actual cooperative work. An uncooperative task causes worker termination; the client also reaps a worker with a blocked event loop. Worker loss fails interrupted calls without replaying them. A new request can start a replacement worker, bounded to three automatic starts per minute. Use `/conest restart` after correcting repeated failures. Cleanup errors from both rejected disposal promises and structured Cordis unloading diagnostics are exposed as degraded status. A committed update is not reported as rolled back merely because retiring an old entry encountered an error. Process restart is the recovery boundary for uncertain cleanup.

## DSH compatibility

The tested local snapshot uses `@deepseek-ai/cordis` 4.0.1 and `@deepseek-ai/dsh-tool-fs-search` 0.1.0-rc.5. It assembles the actual DSH `tools`, `systemPrompt`, and local `subprocess` services and executes the packaged ripgrep-backed `grep` tool. The CoNest Connector component version `dsh-search@0.2.0` describes the adapter contract, not the upstream DSH package version.

The tested support level is independent filesystem search with real service dependencies. Exact-quote verification checks occurrence in the same source file, not factual truth. Search results are bounded and may be truncated. DSH-specific session history, spill/retention modes, inference events, executor/UI plugins, arbitrary DSH plugin loading, and additional Agent Loops are not certified.

## Validation and operation

```sh
pnpm run typecheck
pnpm test
pnpm run test:runtime
pnpm exec openclaw plugins build --root .
pnpm exec openclaw plugins validate --root . --json
pnpm run test:openclaw
pnpm run test:e2e
pnpm run benchmark
```

`test:e2e` launches an isolated official Gateway and local deterministic model fixture. The fixture selects tools but never executes them itself. The actual main Loop reads source material, performs DSH search, discovers an installed verifier, invokes it, and returns a final source-backed result through the Gateway agent CLI. The script also checks live component changes, failed-upgrade rollback, host policy denial, native tool survival, and crash recovery. It needs no paid model credentials and does not deploy a persistent Gateway or send a channel message.

### Optional live DeepSeek acceptance

Store `DEEPSEEK_API_KEY=...` in an owner-only, non-symlink credential file outside the repository. The default is `/root/.config/dsh-bridge/deepseek.env`; set `CONEST_CREDENTIAL_FILE` to select another absolute path (`BRIDGE_CREDENTIAL_FILE` remains a fallback). This is a test-runner input, not an automatically loaded OpenClaw dotenv location. Do not paste credentials into commands, reports, or source control.

```sh
pnpm run test:live:deepseek
```

This command incurs DeepSeek API usage. It runs the same isolated official OpenClaw Gateway against the real `deepseek-v4-flash` model with thinking disabled. A loopback recording transport forwards messages and tool schemas to the fixed official HTTPS endpoint, bounds each run to 12 upstream requests, 400,000 total serialized input bytes, and 2,048 output tokens per request, and records actual returned model decisions and usage. Upstream completions are non-streaming and are framed as SSE for the host; native DeepSeek streaming and the official DeepSeek provider plugin are not qualified by this transport test. The transport never executes tools, invents decisions, or fabricates tool results. The API key stays in the transport process and is not placed in Gateway configuration or worker environment.

The live workflow checks successful native read, DSH search, schema discovery, dependent verification, final delivery, and a separate real permission denial followed by stopping without retry. OpenClaw normalizes tool-call IDs; evidence correlation uses the IDs in the actual outgoing host history. Explicit Agent workspaces keep relative `read` paths aligned with the CoNest Connector root. No live channel is connected and no persistent Gateway is deployed.

An explicitly authorized live run saves its result under the current package version's `reports/conest-VERSION/live-deepseek.json`, including real upstream token usage. No such run has been authorized for this 0.6.1 candidate. Historical 0.6.0 reports remain separate. Gateway `cost: 0` fields reflect the custom test route's zero local cost table, **not free API usage**; use upstream usage and the provider bill for accounting. Failed runs save a separate `live-deepseek-failure.json` and exit nonzero; a previously successful report is not evidence that a later run passed. Automatic offline tests never invoke the paid provider.

For separately authorized direct official-provider qualification without the recording transport, `pnpm run test:installation ARCHIVE.tgz --live` installs outside the checkout and saves the current version's `installation-live.json`. It performs two chargeable, non-thinking model tasks under the local profile's task/output limits; these are not a hard request-count or currency cap. Omit `--live` for checks without model inference, or use `--host-enhancements` for the local deterministic-model context/session/diagnostics flow against the installed archive. Only when both same-version reports exist may `node scripts/verify-release.mjs FINAL_ARCHIVE LIVE_TESTED_ARCHIVE` link a documentation-only archive to its live-tested candidate. Do not use historical 0.6.0 live evidence for 0.6.1.

Candidate reports are under `reports/conest-0.6.1/`, with separate default-off and archive-installed Gateway profiles; older reports remain historical evidence. The additional [real DSH compatibility matrix](./DSH-COMPATIBILITY.md) has developer-profile evidence in `reports/dsh-compatibility/`; candidate reruns use `CONEST_REPORT_PROFILE=conest-0.6.1 node scripts/test-dsh-compat.mjs` without overwriting it. It does not expand the default tools. Benchmarks are observations, not performance acceptance thresholds. The `/conest` command and authenticated `/plugins/conest-connector` status route are supplementary diagnostic surfaces; a management Web product and live-channel/browser qualification are outside this stage.
