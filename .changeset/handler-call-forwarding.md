---
"@makaio/framework": patch
"@makaio/adapter-pi-sdk": patch
"@makaio/kernel": patch
"@makaio/storage-handlers": patch
"@makaio/tools-core": patch
"@makaio/ui-hooks": patch
---

Forward the received call when a handler sends on the bus for its caller, so
the follow-up send keeps the principal of the request or event that caused it.
Work an observer or the service does for itself starts its own context with
the fitting purpose.

- The Drizzle CRUD handlers pass the request's call to the events they emit
  after a write or delete. The check that a deleted row is gone reads through
  the handler's database instead of a bus request, so a requester who may
  delete but not read still gets `{ deleted: true }`, and subscribers receive
  the `deleted` event under the requester's call.
- `emitEvent` in the tool helpers emits under the tool execution's call.
- A toast warning action forwards the interaction's call to the client wiring
  request it triggers.
- The Pi SDK session sends its turn events under the turn's call; provider
  signals reported outside a message turn use an observer context that the
  connector supplies from its own bus.
- `useBusQuery` reads for the view: the initial load runs under
  `own('shared-work')`, a manual refetch under `own('root')` and a refetch
  after a subscribed event under `own('observer')`, never under the event
  sender's call.
