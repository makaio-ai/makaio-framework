---
"@makaio/framework": minor
"@makaio/runtime-node": minor
---

Add a local process launcher with a worker-selected environment allowlist, owner home and temporary paths, and process-group shutdown evidence. The Node worker can launch a code step entry point through this launcher and accept its validated JSON-RPC output. Cancellation and process exit are reported alongside the output decision.

The launcher starts with the explicit allowlist, including when Node coverage is enabled in the worker. By default an abort sends a forceful group stop while the leader is still owned. The proof covers the group. A descendant in another session requires a stronger execution site. The launcher creates step directories and the worker manages their retention.

Successful code steps submit an explicit JSON output. Invalid UTF-8, uncorrelated frames, and conflicting results fail the step. Child-reported failure text is replaced with a fixed diagnostic.

The local launcher uses the worker's OS user and does not provide filesystem, process metadata, or network isolation. Use a site with stronger containment if worker credentials would otherwise be reachable. If a group member survives the leader, the launcher reports an unproven stop. A validated result is returned only after successful process exit within the deadline; acknowledgment delivery is independent of acceptance.

The portable launcher returns a handle with byte streams and evidence scoped to a process group, user, or machine. Local path setup is part of the local factory. A code step reports a result only after the execution site proves quiescence. Worker composition must keep unrelated file descriptors from being inherited.

The native diagnostic types are named `LocalLaunchGroupFacts` and `LocalLaunchedProcess`. The local execution site refuses Windows before starting a process because it cannot prove the required containment there.

The local site uses forceful-first shutdown. The native launcher defaults to a graceful signal with escalation. Invalid owner identities are refused, and cancelled results identify whether owner shutdown or the launch request triggered cancellation.
