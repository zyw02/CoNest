# Host integration

This reference describes the OpenClaw adapter. CoNest supports the range declared in [`compatibility.json`](../compatibility.json), currently `>=2026.9.2 <2027.0.0`; `2026.9.2` remains the reproducible development pin. Commands run from the repository root after building.

All OpenClaw SDK imports are owned by `src/adapters/openclaw-sdk.ts`. Connector code consumes that boundary and the public CoNest capability contract. A host SDK path or shape change is fixed and tested in the adapter instead of spreading version checks through the runtime. Releases outside the declared range receive an explicit compatibility error; silently claiming support for an untested breaking release is not part of the contract.

## Process and identity

Gateway retains the Connector and Studio. A separate CoNest Host contains Management, the managed component runtime and the optional fixed DSH Agent/Session composition. Private stdio RPC carries host callbacks bound to the active call and actual child process; callbacks expire with that call. Protocol version 4 requires updating the whole plugin and restarting the Gateway.

The OpenClaw plugin ID and configuration key remain `dsh-bridge`. The package is `@local/conest-connector`; the `conest` and `conest-local` commands retain `dsh-bridge` / `dsh-bridge-local` aliases. Do not rename persisted identifiers as part of UI branding.

## Plugin configuration

From the repository root, create a configuration in an existing directory:

```sh
node dist/cli.js init --config /absolute/config/bridge.json --workspace /absolute/workspace
```

Merge the following entry into your development OpenClaw configuration:

```json
{
  "plugins": {
    "enabled": true,
    "allow": ["dsh-bridge"],
    "load": { "paths": ["/absolute/path/to/CoNest"] },
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

The post-policy hook supplies finalized tool denials; it does not store conversation content.
See [authorization](#authorization) for admission, revocation and recovery boundaries.
Restart the Gateway after replacing the Connector package. Component reload only updates managed components.


## Authorization



This release adds capability-level policy to the existing private-pipe call grants. It is a step toward personal-use hardening, not complete organization governance or an untrusted-plugin sandbox.

The development native tools are `bridge_capabilities`, `bridge_invoke`, `knowledge_search`, `knowledge_verify`, `dsh_grep`, `dsh_glob`, `dsh_read`, and nine `dsh_mcp__reference_memory__*` tools. All CoNest Connector capability execution, including nested service calls, is checked inside the worker. Discovery filters the same policy that invocation enforces. A component can remain ready even when the caller cannot use one of its capabilities.

## Policy configuration

`capabilityPolicy` belongs in the separate CoNest Connector configuration:

```json
{
  "capabilityPolicy": {
    "defaults": { "allow": ["knowledge_search", "knowledge_verify", "source_verify"] },
    "agents": {
      "researcher": { "allow": ["knowledge_search", "source_verify"] },
      "restricted": { "deny": ["knowledge_search", "knowledge_verify", "source_verify"] }
    },
    "operator": { "allow": ["knowledge_search", "knowledge_verify", "source_verify"] },
    "requesters": [],
    "requireRequester": false
  }
}
```

For a standalone policy file, omit the outer `capabilityPolicy` property. Apply it with `policy set FILE`; see [the example](../examples/capability-policy.json). Existing configurations with no policy retain the worker ceiling; configuring a memory file adds default memory read/write permissions only when no explicit permission array exists. Use explicit allowlists to prevent a future installation from automatically becoming accessible.

Rules accept `allow` and `deny` arrays of capability names or `*` patterns. Omitted `allow` imposes no additional allowlist; `allow: []` denies everything. Unknown fields and malformed patterns are rejected. Rules intersect: a matching Agent or requester rule cannot override a default denial or grant a capability outside the default allowlist. Every nested dependency call must also be allowed; allowing only a verifier does not implicitly authorize search.

The layers are:

| Caller | Effective constraints |
| --- | --- |
| OpenClaw Agent | Worker defaults + matching Agent rule + requester rules + host-derived ceiling + worker/task permissions |
| Local operator CLI | Worker defaults + operator rule + worker permissions |
| Nested component | The same immutable call constraints, plus its declared component dependency and input/output schemas |

`status` is an operator inventory and can include capabilities denied to the caller; `catalog` is the filtered callable surface. A denied nested dependency may only be detected when the component attempts that call because manifests declare component dependencies, not an exact per-operation call graph.

## Requester identity

Requester rules use an exact `{channel, accountId, senderId}` tuple supplied by OpenClaw, never model arguments. Example:

```json
{
  "defaults": { "allow": ["knowledge_search", "source_verify"] },
  "requesters": [
    {
      "channel": "telegram",
      "accountId": "work",
      "senderId": "123456",
      "allow": ["knowledge_search", "source_verify"]
    }
  ],
  "requireRequester": true
}
```

A nonempty requester list is closed: Agents with an incomplete identity or no matching tuple are denied. All matching rows intersect. Do not assume the same sender ID identifies the same user on a different channel or account. `requireRequester: true` with an empty list requires a complete identity but does not introduce a membership list. With no requester rules and the flag unset, CLI-originated Agent turns may use the defaults and Agent rule without a channel sender.

The operator CLI has a separate principal and does not impersonate a channel sender. Operator requests cannot inject principal or policy fields. Local operators can administer the policy itself, so these rules are not a security boundary against the OS account owner. Actual channel-specific identity transport remains to be qualified with a real channel; the tuple rules and grant binding are covered by deterministic tests.

## OpenClaw policy integration

Use the public hook permission in the OpenClaw plugin entry:

```json
{
  "enabled": true,
  "hooks": { "allowConversationAccess": true },
  "config": { "configFile": "/absolute/config/bridge.json" }
}
```

The post-policy `before_prompt_build` hook checks the finalized availability of the registered direct CoNest tools while OpenClaw's ephemeral authority is active. It stores only additional denials for the owning run. It does not retain the authority object or use its fingerprint as a bearer token. Negative restrictions can accumulate but cannot widen during a run; run completion and expiry remove the snapshot. A run with no valid snapshot is refused rather than silently using a broader fallback. The hook ignores conversation content, but its host permission is broad and must be explicitly reviewed when deploying.

The adapter also intersects explicit global/Agent/provider tool denials and convenience-tool allowlists from the public runtime configuration. A direct trusted-operator HTTP invocation has no model turn; it uses these configuration restrictions and worker Agent/requester policy. If model metadata is absent, all configured provider restrictions for that Agent are conservatively intersected. This can deny more than a particular model would.

This does **not** reproduce arbitrary argument-sensitive `before_tool_call` hooks, native approval prompts, or another tool's custom execution-time checks. There is no public general-purpose API here to execute the entire host policy pipeline for a nested service call. Put capability restrictions in `capabilityPolicy`, where they apply to every CoNest Connector entry point. Keep Gateway HTTP bearer credentials private: `/tools/invoke` is a trusted-operator surface, not a channel-user endpoint. Unsupported harnesses without a finalized run snapshot are not qualified.

Known native aliases must be allowed when a generic component needs their underlying service. For example, a host allowlist containing only `bridge_invoke` and `bridge_capabilities` does not authorize nested `knowledge_search`; include that search tool when intended. Native denial of `bridge_invoke` itself still controls that host surface and need not disable an independently admitted convenience tool.

## Revocation and diagnostics

Policy updates are validated and persisted atomically through the live worker. Changed worker policy or permission ceilings revoke unused grants and cancel running and queued tasks. Uncooperative work triggers the existing process watchdog; interrupted work is never replayed. Component-only changes retain version-pinned active work. Invalid policy updates leave the accepted configuration and runtime unchanged.

Grants bind the principal and host capability ceiling as well as task/call, subject, parent run, canonical workspace, generation, and deadline. Tampering with the principal or widening the ceiling invalidates the one-use grant.

Useful errors are `CAPABILITY_DENIED`, `INVALID_POLICY`, `INVALID_PRINCIPAL`, `AUTHORIZATION_MISMATCH`, `POLICY_CHANGED`, and `HOST_POLICY_UNAVAILABLE`. `status.policyDenials` counts worker authorization denials; it is not a durable audit log. The pinned OpenClaw `/tools/invoke` endpoint currently translates worker-thrown denials to HTTP 500, while tools excluded by native policy return 404. E2E assertions check the worker denial counter to distinguish policy refusal from unrelated failures.

## Upgrade and remaining work

Stop the old Connector worker and restart the plugin service when replacing the package. Clients and workers must use the same protocol version. Review external manifests' `bridgeVersion` ranges; retained bundles are not silently rewritten.

See [installation and verification](installation.md). The worker environment allowlist reduces accidental credential inheritance; trusted code can still read files available to its OS account. Per-component OS isolation and organization admission governance remain separate work.

## Shared memory service

Studio automatic hooks use separately authorized `memory_recall` and `memory_remember` capabilities. These service entries are denied at model-facing discovery/invocation surfaces; the nine graph tools follow finalized tool authority. Worker capability policy and `memory:read` / `memory:write` govern the service calls. Incognito sessions skip automatic hooks and cannot access either memory entry path. See [the memory design](components.md#built-in-services) for ownership, cancellation and failure semantics.

## Host guidance

Optional `plugins.entries.dsh-bridge.config.capabilityGuidance: true` contributes fixed guidance through `before_prompt_build.appendContext`. It defaults off and requires the existing `hooks.allowConversationAccess: true` permission and both generic tools in the finalized authority. Authority is checked before and after reading it and is not retained. Missing/expired authority never establishes a new policy snapshot. Policy snapshots continue to narrow rather than widen within a run.

Host integration finding: although the general hook type exposes system-context fields, OpenClaw 2026.9.2's authorized post-policy pass forwards only `prependContext` and `appendContext`. An initial system-field attempt failed the real Gateway test. The implementation uses the supported ordinary-context field; it does not weaken the permission gate to gain system-prompt access.

The text explains discovery, schemas, generation refresh, and respecting denials. It does not include component descriptions, names from installed third-party packages, files, user messages, or catalog results. No catalog RPC or component execution happens in the prompt hook. OpenClaw still owns model scheduling, transcript/session storage, and cancellation. This is static connector guidance, not a dynamic DSH prompt-provider bridge.


## Context providers

### Explicit opt-in

Install the inspected example into the running development runtime using its existing configuration:

```sh
node dist/cli.js --config /absolute/config/bridge.json components install /absolute/checkout/examples/workspace-context/component.json
```

Then merge the following into the existing OpenClaw plugin entry, retaining `configFile` and other settings:

```json
{
  "hooks": { "allowConversationAccess": true },
  "config": {
    "configFile": "/absolute/config/bridge.json",
    "contextProvider": {
      "capability": "workspace_context",
      "provider": "workspace-context",
      "timeoutMs": 1000,
      "maxChars": 2000
    }
  }
}
```

Restart the Connector/plugin service after changing host integration settings. Removing `contextProvider` disables automatic collection. Installing the component alone does not enable collection; the default configuration performs no context-provider work. This opt-in authorizes automatic component execution and sharing the first 1000 UTF-16 code units of the current prepared task prompt. That prompt can contain host-provided task metadata; it is not guaranteed to be a verbatim user message. No `messages` history array or full host API is passed to the component.

### Contract and limits

One explicitly selected capability must declare `contextProvider: "workspace-v1"` and `workspace:read` in its manifest. The current authorized catalog must bind it to the selected component ID. The marker declares an interface; it does not prove code purity or provide an OS sandbox. Components are trusted executable code under the existing installation/integrity model. Inspect them before opting in.

| Boundary | Behavior |
| --- | --- |
| Component arguments | `{ task: string, maxChars: integer }`, task limited to 1000 UTF-16 code units |
| Component result | Exactly `{ text: string }`; empty, malformed or oversized results are omitted |
| Text budget | Default 2000, configurable 128–4000 code units; encoded JSON envelope limited to `maxChars + 512`, plus a fixed warning prefix |
| Deadline | Default 1000 ms, configurable 50–2000 ms for catalog, execution and final revalidation together |
| Load | At most four outstanding collections per adapter registration; no waiting queue; timed-out transports retain their slot until they settle |
| Host permission | Finalized `knowledge_search`, `bridge_capabilities` and `bridge_invoke` must all be available; the hook workspace must exactly match the canonical configured workspace |
| Worker permission | Current agent/requester policy, host denials, declared dependency permissions and one-use invocation grants remain enforced |
| Output destination | OpenClaw's authorized `before_prompt_build.appendContext`, not the system prompt |

The native search tool's finalized availability supplies the host sandbox/filesystem gate because prompt hooks do not provide a separate `fsPolicy`. An exact workspace match adds a conservative restriction: otherwise usable nested-workspace arrangements may receive no context. There is no fallback that widens the workspace or changes agent/requester identity.

The example selects at most three longest literal terms from the task and calls the real DSH `knowledge_search` dependency, returning at most eight source excerpts within the text budget. It is a deliberately small retrieval example, not semantic search, language-aware segmentation or a relevance-quality guarantee. It never calls a model.

### Lifetime, freshness and failure

Collection binds a unique internal call to the host run and shared call scopes. Host authority is checked at each boundary and polled every 25 ms while awaiting work, since this host prompt hook provides an active-authority check rather than an abort signal. Run end/error, an owning `session_end` event, service stop, cleanup and the contribution deadline abort its signal. Session IDs select session cleanup, not keys that may be reused after reset. The worker also receives the deadline, enabling its existing cancellation and uncooperative-worker watchdog. A blocked worker may be terminated, interrupting other component tasks; native OpenClaw tools remain independent. JavaScript/event-loop scheduling means the deadline is not a hard real-time guarantee.

Every collection discovers the current authorized provider, invokes its exact generation, then re-reads the authorized catalog. A changed generation, disabled/uninstalled provider, lost dependency, policy denial, expired authority or malformed response produces no contribution. Results are never cached or automatically retried. Timed-out catalog/startup completion is checked before any later invocation, so it cannot start a stale component call. Optional collection failure omits context and lets the host task proceed; raw component errors and task/source text are not logged by this adapter.

Freshness is checked immediately before returning the contribution, not atomically with model submission. A subsequent management change cannot retract content already returned to OpenClaw. Previous contributions may remain in host-owned session history; this feature does not purge transcripts. Fresh-session tests distinguish new contributions from previously delivered content.

Source text is JSON encoded and labeled untrusted data. This prevents source strings from fabricating our envelope delimiters but does **not** eliminate model prompt injection. Do not treat retrieved text as instructions, proof of factual truth or new execution authority.

The authenticated `/plugins/conest-connector` page and `/conest` report shared counters for contributed, empty, denied, unavailable, stale, timeout, cancelled, invalid, busy and failed outcomes. Active prompt construction and outstanding transport counts are separate: a timed-out background transport may still be settling. Only counts, a fixed outcome, an allowlisted diagnostic code and timing are stored; neither payloads nor identities are recorded. Optional context progress is excluded from ordinary user-facing progress snapshots. Counters reset with the shared runtime owner, are not an audit log, and do not prove model consumption of returned text.

### Verification

```sh
pnpm test
CONEST_REPORT_PROFILE=context-provider node scripts/test-e2e.mjs --context-provider --capability-guidance
CONEST_REPORT_PROFILE=context-provider-default node scripts/test-e2e.mjs
CONEST_REPORT_PROFILE=context-provider-default node scripts/test-openclaw.mjs
```

Unit/process tests cover exact data boundaries, identity/tool/workspace gates, output validation, timed-out late work, concurrency, run cancellation, stale generations, real DSH retrieval, dependency disable/recovery, requester denial and in-flight upgrade/policy revocation. Gateway tests use a local deterministic model transport and actual OpenClaw/DSH execution, including context arriving before model tool calls and fresh-session checks after enable/disable, revocation/restoration and uninstall. They do not spend provider credits or measure real-model retrieval quality.

No session/history service, arbitrary multi-provider pipeline, prompt-authoring DSH service adapter or market UI is implemented. A new release still needs versioning and separate artifact qualification.
