---
"@makaio/framework": minor
"@makaio/contracts": minor
"@makaio/kernel": minor
"@makaio/runtime-node": minor
"@makaio/services-core": minor
---

Add a worker-local credential port scoped to an authenticated booking, its exact purpose and target pairs, and the active resolver generation. The worker aborts in-flight model requests on withdrawal, checks authorization again immediately before delivery, and refuses replies that reflect the request credential.

Runtime boot shares the coordinator's resolver with the journal. The published `@makaio/framework/services/journal` entry point also supports standalone journals through its existing four-argument `createWriteJournal` call.
