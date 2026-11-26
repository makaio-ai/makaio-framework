---
"@makaio/contracts": major
"@makaio/framework": major
"@makaio/runtime-node": minor
"@makaio/services-core": minor
"@makaio/bus-core": minor
"@makaio/storage-drizzle": minor
---

Ordered workers submit results using `makaio:job-runs.outcome.submit`. The result uses `jobRunId` and accepts an optional JSON `submission` for every terminal status. This changes the existing job-run outcome and close schemas. The independent execution outcome subject retains its existing schema.

Ordered dispatch hosts register the outcome receiver when configured with a committed order source. Extensions can contribute a generation-bound outcome handler. The order owner persists the first reply and terminal transition through its locked order adapter.

Malformed authenticated submissions receive the final `outcome-invalid` refusal. When a run proof is refused, the worker sender stops retrying and reports `receipt-unconfirmed` separately from other authority refusals.

Result closes require a JSON answer. No-result closes omit the answer. The ordered sender retries an unavailable receiver within the existing delivery budget, and exclusive request handlers cannot register with a filter.
