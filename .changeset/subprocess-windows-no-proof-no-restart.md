---
"@makaio/framework": minor
"@makaio/runtime-node": minor
---

Only a positive proof of quiescence counts as safe, and the absence of evidence never does. This changes what Windows reports and does after a crash.

**Behaviour change (Windows, `@makaio/subprocess`):** Windows has no process group to probe. A supervised child whose tree the owner owns and that ends without a stop (a crash, an unexpected exit) is no longer treated as having left nothing behind: no `taskkill` ran, so its descendants may still run, for example a helper with redirected stdio. `ProcessLifecycle` therefore withholds the automatic restart of such an end (`restart: { kind: 'withheld', reason: 'descendants-may-run' }`, with a warning), whatever the `restartPolicy`. On Windows nothing restarts automatically after a crash while the lifecycle owns the tree (`terminateTree`, the default); an explicit `start()` stays allowed. POSIX behaviour is unchanged: its process group still yields a real quiescence proof. `@makaio/runtime-node`: a `bus-websocket` extension with `restartPolicy` therefore stays down on Windows after a crash until it is started again explicitly.

- `TreeQuiescenceGap` replaces `unsupported-platform` with `no-termination` (no tree termination reached the tree: a crash, or `taskkill` found no process). `mayHaveLeftProcesses` treats every `unproven` tree as possibly alive and `describeTransportEnd` names it. A `taskkill` that succeeded for the whole tree is reported as `quiescent`; a refused or unfinished one stays `signal-error` / `poll-timeout`.
- `ProcessLifecycleOptions` gains the internal `stopHost` option, passed to every run's transport, so tests can simulate the Windows platform on a POSIX host.
- Follow-up: Windows Job Objects (FACT-463) would make the tree addressable and provable and lift the restriction.

**Behaviour change (native probe driver):** a provider that exits before its deadline on Windows is reported with `cleanup: { kind: 'incomplete', reason: 'tree-not-addressable' }` instead of `complete`, since the exited root can no longer provide tree evidence. `yarn test:agent-clients` reports that reason as a warning (new `warnings` in the `runProbe` result) and does not fail the scenario, so the tool stays usable on Windows; every other incomplete cleanup still fails it. The classification lives in one place, `classifyCleanup`.
