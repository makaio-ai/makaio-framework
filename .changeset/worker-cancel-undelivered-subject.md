---
"@makaio/contracts": minor
---

Add the non-lifecycle Worker subject `worker.control.cancel-undelivered`, an event that reports one bounded cooperative-Cancel delivery pass which produced no stop evidence (`kind`: `unavailable` / `refused` / `invalid-receipt` / `receipt-not-recorded`, plus a free-form `detail`, an `observedAt` instant and the Worker lifecycle identity for correlation). It is a control-delivery diagnostic, never a terminal state: status projections consume `lifecycle.*` subjects only, so an undelivered Cancel can no longer terminalize a live Worker and drop its later canonical outcome the way a fabricated `lifecycle.failed` did. New public exports: `WorkerCancelUndeliveredSchema`, `WorkerCancelUndeliveredKindSchema` and their inferred types.
