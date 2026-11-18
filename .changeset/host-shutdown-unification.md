---
"@makaio/runtime-node": minor
"@makaio/runtime-bun": major
"@makaio/cli": minor
"@makaio/kernel": minor
"@makaio/extension-workflow": minor
"@makaio/subsystem-mcp-http-server": minor
---

Put every host on the host shutdown coordinator that `makaio serve` already used, so
none of them ends in the middle of its teardown or ignores a signal that arrives while
the runtime boots.

`@makaio/runtime-node` adds a runtime lifecycle handle, `createRuntimeLifecycle()`,
whose `stop()` works in any phase: during the boot it cancels it and awaits its
rollback, afterwards it shuts the runtime down. Its `stopBudgetMs()` is the boot's
cancellation bound during the boot and `runtime.stopBudgetMs()` afterwards, and
`shutdownStep()` is the teardown stage that carries both into `installHostShutdown`.
`bootUnderShutdown()` boots under a host shutdown and tells a boot a signal interrupted
from one that failed. `hostSignalPolicy()` and `HangupPolicy` (moved out of the CLI's
`serve`) pick the signals a host stops on, and `localStep` / `resourceStep` are exported.
`installHostShutdown` gains `onRequest` and `release()`. `serve` now uses the handle
instead of its own boot and shutdown glue; the stage that stopped the runtime is named
`runtime` in the report of a teardown that ran out of its window (it was `runtime boot`
and `runtime shutdown`).

`@makaio/runtime-bun` removes `createGracefulShutdown`, which used `process.once`, had no
boot cancellation and no `SIGHUP`, and let a second signal kill the host in the middle of
the teardown. It is replaced by `installBunHostShutdown`, built on the coordinator and the
lifecycle handle: `SIGINT`, `SIGTERM` and `SIGHUP` shut the host down (there is no
ignore-hangup option; a daemon whose terminal or session ended has nothing left to serve,
and the shutdown is what stops the detached extension children), a signal during the boot
cancels it, later signals join the shutdown, and every stage runs inside its own window.
The runtime's `stopBudgetMs` bound is unchanged. The server, relay and GitHub App
entrypoints and the generated bundled server entry use it.

Desktop hosts: Electron and Electrobun share `installDesktopHostShutdown` (host-shared):
`SIGINT`, `SIGTERM` and `SIGHUP` shut them down, a quit during the boot (Electron's
`before-quit`, the Electrobun tray and app-shutdown triggers stay host-specific) cancels
it, and every stage runs inside its own window. Electron previously had no signal
handling and no deadline; Electrobun installed its handlers only after the window, tray
and shortcut setup and had no `SIGHUP` handling and no deadline.

CLI commands with their own runtime (`provideBus`, e.g. `makaio workflow ...`):
`ProvideBusContext` gains `signal` (the invocation signal, to pass to the boot) and
`onStopBudget` (the provider reports how long stopping what it started takes). The
command's signal listeners now stay installed until the command has finished and its
embedded runtime is disposed, so a further signal joins the shutdown instead of taking
the default action (a second Ctrl-C no longer force-kills it mid-dispose). The shutdown
is bounded stage by stage: the handler gets one wind-down window to return after the abort,
and the embedded runtime is then stopped inside the bound the provider reports, by the
shutdown itself when the handler never returned; a stage that does not finish is named and
the command ends with status 1. The workflow extension's `bootEmbeddedWorkflowRuntime`
boots under the lifecycle handle and cancels a boot a signal interrupts.

`startMcpClientBridge` takes a `signal`, and an `mcp-stdio` extension's start observes
the host's cancellation: the handshake and the first tool listing end with the signal's
reason, and the subprocess is closed like on any other failed start.
