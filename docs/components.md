# Component development

Commands run from the repository root after building.

The public component contract is the JSON manifest, capability schemas, permissions and lifecycle shape documented here. Component authors do not import OpenClaw or DSH types. The built-in DSH/Cordis implementation is an optional support pack behind the narrow `src/adapters/dsh-*.ts` modules; another Agent integration can map the same CoNest contracts without copying DSH sessions or OpenClaw tools.

## Live component management

The Connector supports one explicitly enabled [dynamic workspace context provider](host-integration.md#context-providers). It passes bounded current-task text to an installed component and appends bounded source data after live permission/generation revalidation. It is disabled by default and does not pass conversation history. The authenticated status page and `/conest` expose payload-free outcome counters shared across host registries.

`plugins.entries.dsh-bridge.config.capabilityGuidance: true` enables a short static prompt-context contribution through the same authorized prompt hook, without changing the system prompt. Default is false. Both `bridge_capabilities` and `bridge_invoke` must be available in the finalized host tool set. This does not enumerate components, read conversation content, grant execution rights, or create another loop. Catalogs remain live and policy-filtered at tool execution; component text is never promoted into system instructions. See [host adapter](host-integration.md#host-guidance) for scope and verification.

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

[examples/source-verifier](../examples/source-verifier/component.json) is a complete independently installable example. Its manifest declares `requires: {"dsh-search":"^0.2.0"}` and publishes `source_verify`; it is not hardcoded in the adapter.

Additional independently installable examples live under `examples/`: [git-inspector](../examples/git-inspector/component.json) publishes `git_status`, `git_log` and `git_diff` for the admitted workspace; [web-fetch](../examples/web-fetch/component.json) publishes `fetch_url` for outbound HTTP; [system-info](../examples/system-info/component.json) publishes host metrics and process information; and [ai-debate](../examples/ai-debate/component.json) publishes a DeepSeek backed debate with a configured API key. These examples run as trusted worker code and are not installed by default. The DeepSeek example requires paid API access and is not covered by the fixture integration checks.

The `web-fetch` example denies all network requests until an operator configures exact `allowedOrigins`, for example `{"allowedOrigins":["https://docs.example.com"]}` with `components configure web-fetch ./component-settings.json`. The scope includes all paths and resolved endpoints of those trusted origins, so list only services whose content this component may expose. Initial URLs and every redirect must match an allowed origin; URL credentials are rejected. An explicit local or private origin grants access to that service. This is an operator-managed origin permission, not a public-Internet-only network sandbox. Invocation arguments cannot widen it, and the existing `workspace:read` grant is still required.

A manifest declares `id`, semantic `version`, `description`, `entry`, required component version ranges, and capability descriptors. Optional `bridgeVersion`, `configSchema`, and per-capability `outputSchema` are validated. `bridge_capabilities` and `bridge_invoke` are reserved names. Discovery reads declarative JSON and hashes bundle content without executing component code.

The ESM entry exports an object with `apply(ctx, config)` and optional string-array `inject`. Register a capability with `ctx.bridgeCapabilities.register(ctx, name, handler)`. Invoke another through `ctx.bridgeCapabilities.invoke(name, args, invocation)`, forwarding the invocation context. Cross-component calls require a declared component dependency; every call checks permissions and input/output contracts. Recursive capability calls are rejected. Component configuration remains literal JSON; Loader expression objects are not evaluated.

Use Cordis-owned effects for listeners, timers, and service registrations. Handlers must honor `invocation.signal`; never retain invocation authority for later background work. Write diagnostics to stderr, since worker stdout is reserved for protocol frames. Cordis is a lifecycle framework, not a hostile-code sandbox.

The adapter maps manifest dependencies to Cordis readiness services. Missing or disabled dependencies prevent activation. Loss of an injected service withdraws the provider and dependent capabilities, releases their effects, and aborts affected cooperative calls; service recovery reactivates them without configuration reload. A completely disposed/failed component may require explicit reload. New calls use a validated candidate generation after upgrades; already admitted work stays on its original version until it finishes or is cancelled. Retired generations are bounded.

One native Loader owns uniquely identified component entries. An unchanged ready component is reused only when its configuration, manifest/integrity, and dependency instances are unchanged. Updates create separate entries for affected dependents; unrelated caches, listeners, and ports survive. Accepted and leased graphs jointly own shared entries. An entry is removed only when its last graph owner releases it, and removal awaits native asynchronous cleanup. Nested capability calls follow the original admitted graph even when the calling component is shared with newer graphs. Every published graph has a unique opaque token, including when configuration is reverted to earlier bytes; do not parse or persist a token as a reusable authorization.

Application services are isolated per component and explicitly joined through its declared dependency closure. An `inject` service supplied by another component therefore requires that provider in `requires` (directly or transitively); ambiguous multiple providers are rejected. Undeclared services and the Loader management service are not inherited from unrelated entries. The search entry owns its DSH `tools`, `systemPrompt`, and `subprocess` children. This is lifecycle scoping, not protection from trusted JavaScript using `ctx.root`, process globals, or external side effects. Shared provider APIs must support overlapping consumers; candidate startup must not mutate accepted shared state irreversibly. Arbitrary DSH plugins are not automatically qualified for this mode.

## Configuration

See [conest.config.example.json](../conest.config.example.json). External `components` entries accept a manifest path or `{manifest, enabled, config, integrity}`. Path-only entries are for development; use managed snapshots for reliable upgrades of bundles with relative imports. Built-ins are independently configurable through `builtins.dsh-search` and `builtins.result-verifier`; they can be disabled but not uninstalled.

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

Worker capability rules now apply equally to discovery, direct tools, generic invocation, and nested component calls. Defaults, Agent rules, requester rules, and the adapter ceiling intersect; an allow never overrides a denial. OpenClaw global/Agent/provider tool restrictions additionally narrow the CoNest Connector ceiling, and a supported main Loop supplies final tool-surface denials through the public post-policy hook. Denying `knowledge_search` in the tested host policy cannot be bypassed with `bridge_invoke` or a dependent verifier. See [host authorization](host-integration.md#authorization) for exact supported host-policy boundaries, requester identity requirements, and operator behavior.

```sh
node dist/cli.js --config /absolute/config/bridge.json policy show
node dist/cli.js --config /absolute/config/bridge.json policy set ./examples/capability-policy.json
```

Policy changes use the same validated atomic commit as component changes. A changed worker policy or permission ceiling revokes pending grants and cancels all active/queued tasks; clients must start new tasks. Component-only upgrades continue to pin active work to its old generation. `status.policyDenials` exposes a process-lifetime denial counter without recording source contents or requester identifiers. The same-user operator socket cannot supply an Agent identity to escape its own rules.

The built-in components declare workspace-read and memory-read/write permissions. Installed JavaScript is trusted and can access the worker OS account; use separate OS/container isolation for untrusted code. Neither manifest permissions nor content hashes sandbox arbitrary imports, environment access, or network calls.

Task timeout cancels actual cooperative work. An uncooperative task causes worker termination; the client also reaps a worker with a blocked event loop. Worker loss fails interrupted calls without replaying them. A new request can start a replacement worker, bounded to three automatic starts per minute. Use `/conest restart` after correcting repeated failures. Cleanup errors from both rejected disposal promises and structured Cordis unloading diagnostics are exposed as degraded status. A committed update is not reported as rolled back merely because retiring an old entry encountered an error. Process restart is the recovery boundary for uncertain cleanup.

## Built-in services

Search, text reading and shared memory are independently managed components in CoNest Host. Both integrated execution paths use the host-admitted tool set, one-use grants and the component registry. Fixed DSH Agent/Session, write/edit/image/Bash services also run in Host but are not managed as entries in the versioned component graph.

| Component | Contract and configuration |
| --- | --- |
| `dsh-search` | `knowledge_search`, `dsh_grep` and `dsh_glob`; shared DSH search service and workspace containment. Disabling it withdraws all three capabilities and blocks dependent providers. |
| `dsh-read` | `dsh_read`; native `file_path/offset/limit`, result envelope and cancellation. Trusted read observations are handed to the owning Studio tool session for guarded edits. |
| `dsh-memory` | Nine `dsh_mcp__reference_memory__*` graph tools plus internal `memory_recall` / `memory_remember` services; separately governed read and write permissions. |

### Filesystem behavior

Paths are resolved against the configured workspace; canonical targets must remain inside it. Path checks do not provide OS isolation against hostile code or concurrent filesystem replacement. Search preserves native grep/glob behavior and bounded output; `knowledge_search` remains literal search rather than an alias for every grep option.

Text reading retains native defaults: at most 2,000 lines, 2,000 characters per line and 50 KiB of selected content; files of at least 10 MiB use streaming reads. Invalid offsets, missing/non-text files and directories follow native errors. The returned envelope's `isError` determines file-operation success; the Connector converts it to a host tool error when needed.

Read observations carry the file identity and version actually observed during that call. They are isolated by invocation and transferred only to the owning session after workspace, identity and cancellation checks. Internal observations are removed from model-facing results. The edit/write policy rechecks the original version; another session cannot reuse it, and an externally modified file is not silently overwritten. Do not replace this handoff with a later stat or values supplied by a model.

### Shared memory behavior

An explicit runtime `memoryFilePath` takes precedence; otherwise Studio binds `studio.stateDir/memory.jsonl`. Without either binding, memory is disabled by default. A path change requires a worker restart. Omitted `permissions` adds memory read/write only when a file is bound; an explicit permission array retains its limits.

The graph tools access one shared graph, not a tenant-isolated database. Automatic memory derives its owner from the verified Agent/requester identity, retaining the existing `openclaw_auto_memory_v1:conest:<digest>` entity names. Automatic capture accepts only bounded, filtered text with explicit memory intent. Internal recall/remember services are unavailable through model-facing generic discovery/invocation; their policy is separate from explicit graph-tool admission.

Incognito sessions skip automatic memory and do not receive explicit or generic memory access. The authenticated Studio memory page uses the operator policy for the default main Agent's automatic memory; it is not a cross-user memory index.

One backend and serialized operation queue owns each canonical memory file across component generations; a file lock rejects a second worker. An operation already submitted remains in the queue until the MCP response even when its caller cancels. Cancellation does not undo a write. Failed native operations stop new work until the backend is recreated; interrupted writes are never replayed automatically.

Automatic service calls wait up to two seconds and degrade without blocking the main task; explicit tools report errors. Disabling memory retains the file. Corrupt data is preserved and reported, never replaced with an empty graph. The native JSONL implementation does not add power-loss atomicity or a recovery journal.

Relevant verification is in `test/search.test.ts`, `test/read.test.ts`, `test/memory.test.ts` and the corresponding `scripts/qualify-*.mjs` runners. E2E checks must distinguish fixture decisions from actual host and component execution.
