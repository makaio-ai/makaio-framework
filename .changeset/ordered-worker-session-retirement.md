---
'@makaio/framework': minor
'@makaio/runtime-node': minor
'@makaio/runtime-bun': minor
'@makaio/storage-drizzle': minor
'@makaio/bus-transport-websocket': patch
'@makaio/services-core': patch
'@makaio/core': patch
---

Order worker session publication and retirement with committed owner transactions. Closing through the job run capability schedules session retirement automatically. An owner who revokes or closes a run directly can schedule immediate retirement with `retireWorkerRunSessionOnCommit` in the same transaction. Every protected worker message except a heartbeat rechecks the current run before routing. A heartbeat does not refresh the session. At commit, boot removes the route and authentication and allows up to one second for the committing request’s reply to reach the transport. An exchange socket is terminated if its close handshake takes longer than one second. A failed retirement triggers forced teardown. If commit-time retirement cannot be enforced, the host logs `WORKER_RUN_SESSION_RETIREMENT_FAILED`, closes all protected exchange sessions, and refuses new exchanges until the operator restarts the host. Rollback preserves the session.

`ServerTransport.invalidateExchangeSessions` and `ConnectionExchangeAuth.invalidateSession` accept optional run scoping and final-response routing arguments. Exchange policies can supply `ConnectionExchangeSetup.verifyRunSession` to recheck the owner on inbound messages. The exchange auth exposes `hasExchangeSession` and uses its internal `getRunMessageAdmission` for ordered admission. `TransportReceiveContext.requestOrigin` carries the opaque `TransportRequestOrigin` for final-response handoff. Storage exposes `onHostTransactionCommit` for local commit continuations.
