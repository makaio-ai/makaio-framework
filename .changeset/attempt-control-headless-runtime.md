---
"@makaio/runtime-node": minor
---

Execute durable attempt cancellation in the headless workflow worker. The runtime installs a filtered `execution-attempt.control.deliver` responder before registration, answers with a stable per-revision receipt, propagates one effective cancel signal into workspace preparation and workload invocation, and reports a scoped conclusion over `execution-attempt.control.report` (`achieved` / `unsupported` / `unconfirmed` at the `admission-closed`, `setup-process-group` or `workload` boundary). The process-group facts the setup command's launch records back the `setup-process-group` conclusion. New public exports: `installAttemptControlEndpoint`, its endpoint handle and option types; two static bus grants for the control subjects.
