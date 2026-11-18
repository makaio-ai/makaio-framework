---
"@makaio/framework": major
"@makaio/runtime-node": minor
"@makaio/runtime-bun": minor
"@makaio/cli": minor
"@makaio/subprocess": minor
"@makaio/kernel": major
"@makaio/contracts": minor
"@makaio/utils": minor
---

Make `makaio serve` finish its shutdown once a stop signal has arrived.

`SIGINT` and `SIGTERM` are now handled from before the runtime starts any child
process until the shutdown has finished. A further signal during a slow cleanup
joins the shutdown in progress (and says so in the log) instead of taking the
default action, which ended the host in the middle of the cleanup and left
detached extension children running. A signal during boot cancels the boot
through its own rollback instead of dereferencing a runtime that does not exist
yet.

Every stop is bounded where it runs. `ExtensionCoordinator` stops each extension
inside a window of its own, so one extension that never finishes cannot consume the
time of the others: when the window closes, the extension is logged, named in the
shutdown's `AggregateError` and left behind, and the next one is stopped. An
extension declares its window with the new optional `stopBudgetMs` of its service
(`ExtensionServiceLifecycle`); without one it gets the coordinator's
`defaultStopBudgetMs`, which the runtime derives from `processStopBudgetMs` (one
bounded stop of one child process). A detached extension reports its own window,
its destroy request window (`shutdownTimeoutMs`, or the 60 s bus request default)
plus the bounded stop of its child, from the same values it enforces. The runtime's
own steps (bus transport, database, worker pool and so on) run in windows of their
own as well, in the shutdown and in the rollback of a failed or cancelled boot, so
`MakaioRuntime.stopBudgetMs()` is the sum over the extensions actually started and
those steps. `serve` bounds each of its steps (HTTP close, identity, runtime
shutdown) separately: the runtime's window is its reported bound plus a small
margin, a backstop rather than the limit. A step that does not finish is named in
the log and `serve` exits with status 1 once the rest has been handled. Two
extensions that each own a child ignoring `SIGTERM` therefore no longer trip the
host's exit before the second child is stopped.

`SIGHUP` (terminal hangup) now runs the same shutdown by default; before, the
host died on it without any cleanup and orphaned its detached extension
children. `nohup` alone does not change that for a Node host: Node resets an
inherited ignored `SIGHUP` at startup. New `serve --ignore-hangup`
(`ServeOptions.hangup: 'ignore'`; the default is `'shutdown'`) installs a real
`SIGHUP` listener that logs the first hangup and otherwise does nothing, so the
host keeps running and serving. Use it for a host that must outlive its terminal.

The cancellation reaches the long waits inside an extension's start, not only the
gaps between two starts. `ExtensionCoordinator.startAll({ signal })` hands the
signal to each service's `init({ signal })` (new `ExtensionInitOptions` in
`@makaio/contracts`), and `createProcessLifecycle().start({ signal })` maps it to
the `stop()` abort that already ends a pending readiness wait, so a signal during
the health wait of a detached `bus-websocket` child, the subscribe-sync handshake
of a `bus-stdio` child or the wait for the reply to the `init` request aborts the
start at once and stops the child instead of running the wait out. A start the
signal interrupted ends the whole start with the signal's reason, whatever the
extension's criticality. `mcp-stdio` extensions keep the MCP client's own start.

A boot that a signal cancelled and whose rollback then failed makes `serve` exit
with a failure (the boot rejects with an `AggregateError` of the rollback
failures); a signal that arrives while a failed boot is still releasing the HTTP
server joins the shutdown instead of ending the host. `@makaio/subprocess` adds
`processStopBudgetMs` and the `signal` option of `start()`, and `@makaio/kernel` the
`signal` option of `ExtensionCoordinator.startAll` that the boot cancellation builds on.

`@makaio/runtime-node` adds `installHostShutdown` (with `signals` to stop on,
`ignoredSignals` to survive and a window per step), the `signal` boot option and
`MakaioRuntime.stopBudgetMs()` for hosts that own process signals.
`@makaio/kernel` changes `createShutdownSequence` to take named steps with their
windows and return `{ run, budgetMs }`, and adds `runBoundedShutdownSteps` and
`ExtensionCoordinator.stopBudgetMs()`. `@makaio/utils` adds `boundedWait` and `abortableWait`.

A boot has a bound of its own too. A forward phase that never reaches a checkpoint
(a database that does not open) cannot be interrupted, so the boot reports how long
cancelling it takes through the new `onCancellationBudget` boot option: the grace for
the phase in flight (`processStopBudgetMs`, the unit of one bounded stop) plus the
windows of the rollback steps registered so far, read when the cancellation happens.
`serve` gives its `runtime boot` step that window, so after a stop signal the host
always ends, with status 1 and the boot named when it did not settle. `@makaio/kernel`
exports `shutdownBudgetMs`.

Bounds that wrap work which already bounds itself add headroom
(`outerBoundMs`, `OUTER_BOUND_HEADROOM_MS` in `@makaio/utils`): the coordinator's
window per extension, the runtime's `extensions` step and `serve`'s boot and
shutdown steps, so a stop that uses its own declared window in full is no longer
reported as failed by the wrapper. A window that depends on what work in flight
registers is read again when it closes (`boundedWaitReread`), in
`runBoundedShutdownSteps` and in the host's steps, so cleanup registered by the phase
a cancellation interrupted keeps its time. A created service is owned by its
extension entry from creation (`pendingService`), so its destroy window counts while
`init` runs.

A start that a signal cancelled and whose cleanup failed (a service whose `destroy`
or storage cleanup threw) rejects with an `AggregateError` of the cleanup failures
whose `cause` is the signal's reason, instead of the bare reason, so `serve` no
longer exits 0 over resources left behind; `@makaio/kernel` exports
`cancellationRejection` and `readCancellation` for this shape, which the boot uses
too. `stopBudgetMs` of a service and `defaultStopBudgetMs` of the coordinator must
be non-negative finite numbers (`nonNegativeOption`, moved to `@makaio/utils` from
`@makaio/subprocess`); a service declaring anything else fails its start. A request
for the host shutdown that arrives from an abort listener joins the shutdown in
progress instead of starting a second teardown.

The Bun hosts (`createGracefulShutdown` in `@makaio/runtime-bun`) no longer force-exit
after a fixed 10 s, which killed an extension that settled inside the runtime's own
stop windows. The default deadline is `outerBoundMs(runtime.stopBudgetMs())`, read when
the shutdown starts; `runtime` now needs `stopBudgetMs` as well as `shutdown`, and an
explicit `timeoutMs` below that bound can cut a cleanup short. The GitHub App
entrypoint uses `createGracefulShutdown` instead of its own copy with a hard-coded 10 s.
Persistent signal handlers, boot cancellation and `SIGHUP` for Bun hosts remain
FACT-464. `installHostShutdown` keeps the first numeric window of a step when a later
read of it is `undefined`, instead of falling back to 0.
