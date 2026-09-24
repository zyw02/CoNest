# Cordis Loader feasibility

This is an executable design experiment for CoNest Runtime, not a replacement for the current production runtime. Run `pnpm run test:loader` from the Connector directory. It loads the installed DSH-vendored Cordis 4.0.1 and Loader 1.0.2, without changing either upstream source tree, enabling file-watch HMR, or invoking a model.

The test runner records actual package-entry hashes, TAP output, and results under `reports/loader-feasibility/`. A failed run exits nonzero; an earlier successful report is not evidence that a later run passed. Test plugins own real event listeners and a loopback listening socket; fixtures assert exactly-once resource disposal at teardown. These are not broad DSH plugin compatibility tests.

## Observed behavior

| Scenario | Native Loader behavior |
| --- | --- |
| Unchanged entry | Reuses the entry and plugin instance. |
| A provider changes, B consumes A, C is unrelated | B reacts; C retains instance, cache, listener, and listening socket/port. |
| Config update and dependency disable/recovery | Reconciles related lifecycle state without rebuilding C. |
| Candidate import fails | The accepted instance is preserved. |
| Candidate activation fails during direct replacement | Restores the prior implementation, but may create a new instance. This is not rollback of in-memory state. |
| An application call is waiting during direct replacement | Old resources can be disposed before that call completes. Loader does not own application-call admission or draining. |
| Candidate uses separate entry IDs and service isolation labels | Accepted and candidate dependency graphs can coexist; failed candidate activation need not replace accepted instances. |
| Old calls finish before old versioned entries are removed | Old work completes against old providers; new calls can use the new providers; C stays shared. |
| Async resource cleanup | Entry removal waits for the cleanup to settle. |
| Missing service dependency | Settlement can succeed with a pending fiber. Publication needs an explicit readiness check. |
| Duplicate entry IDs | Rejected before updating accepted entries. |
| A resource cleanup throws | The error is logged and other cleanup proceeds; removal can still resolve successfully. Settlement alone does not certify successful cleanup. |

## Interpretation

Reuse Loader for entry reconciliation, imports, service isolation, and component lifecycle. Do not replace the production runtime with a direct `loader.root.update(newConfig)` call: that would weaken the existing in-flight call and failed-update guarantees.

The isolated-revision tests manually sequence selection of the new consumer and retirement of the old entries. They demonstrate the underlying Loader mechanism, not a complete version router, lease manager, transaction coordinator, or permission system. The production guarantees are described in the [component reference](../../../docs/components.md#component-contract-and-lifecycle).

Only declared, correctly scoped services and Cordis-owned effects participate in the experiment's isolation and cleanup. Shared external state, global event listeners, `ctx.root` access, module singleton state, and irreversible external actions require separate analysis. Namespace isolation is not an OS sandbox or general transaction rollback.
