---
title: Usage Granularity & Cost Provenance
description: What each adapter truthfully measures, where monetary cost comes from, and how downstream analytics must aggregate usage signals without double counting.
---

Every adapter emits `agent.usage` through `AIAgent.trackUsage()`, but the upstream SDKs and
protocols report usage at very different granularities. An adapter only reports what its
upstream truthfully exposes — it never subdivides an aggregate into synthetic per-call events
and never inflates a gauge into a running total. Downstream analytics must therefore know the
granularity and cost provenance of each signal before summing anything.

---

## Granularity Classes

| Class | Meaning |
|-------|---------|
| **Provider API call** | One `agent.usage` event per concrete provider HTTP request. The finest granularity; events can be summed freely. |
| **Message/turn aggregate** | One event per completed assistant message or prompt turn. May cover several internal model calls that the SDK does not expose individually. |
| **Terminal query aggregate** | One event per terminal query result, potentially covering multiple model turns (agentic tool loops). Emitted even when the query ends in an error or interruption — the adapters drain the stream for the terminal result within a bounded timeout (`TERMINAL_RESULT_DRAIN_TIMEOUT_MS`). |
| **Statusline gauge + cumulative snapshot** | Two independent signals from a scraped client statusline: a latest-request token gauge (deduplicated, emitted as `agent.usage`) and cumulative session totals (emitted only as `client.session.usage.snapshot`, never as `agent.usage`). |

---

## Measurement Matrix

Verified against the adapter sources; see the per-adapter READMEs for details.

| Adapter | Truthful granularity | Monetary cost | Exact provider call ID (`llmCallId`) |
|---------|----------------------|---------------|--------------------------------------|
| `openai-node` | Provider API call (stream usage chunk) | No provider-reported amount | Yes — runtime-generated per request |
| `anthropic-sdk` | Provider API call (`message_start`/`message_delta` merge) | No provider-reported amount | Yes — runtime-generated per request |
| `claude-agent-sdk` / `claude-code-cli` | Terminal query aggregate, potentially covering multiple model turns | Provider-reported aggregate (`total_cost_usd` on the result message) | No |
| `claude-code-tmux` | Latest-request token gauge from the statusline; cumulative session totals go to `client.session.usage.snapshot` only | Excluded from `agent.usage` (`cost.total_cost_usd` is a cumulative session total); surfaced only via the session usage snapshot | No |
| `codex-app-server` | Provider token-usage notification (`tokenUsage.last` — the latest model request per update) | No | Not exposed by the protocol |
| `cursor-sdk` | Completed message/turn | Optional SDK amount (defaults to `0` when the SDK omits it) | Not exposed by the SDK |
| `gemini-sdk` | Completed session/turn (`session.finished` with `usageMetadata`) | No | Not exposed by the SDK |
| `github-copilot-sdk` | Assistant usage event (sub-turn; one per `assistant.usage` event) | No | Not exposed by the SDK |
| `pi-sdk` | Usage event after a completed assistant message | Provider-reported amount (`usage.cost.total`) | Not exposed by the SDK |
| `qwen-acp` | Consolidated prompt-turn usage (running `_meta.usage` totals accumulated last-wins, flushed once per turn, including error paths) | No | Not exposed by the ACP prompt payload |

---

## `llmCallId` Policy

`llmCallId` on `agent.usage` identifies exactly one concrete provider API request. Two rules
follow from that definition:

- **Never synthesized for aggregates.** Adapters that report turn aggregates, terminal query
  aggregates, statusline gauges, or protocol notifications without a concrete provider request
  leave `llmCallId` unset. A fabricated ID would falsely promise per-call granularity.
- **Runtime-generated, not provider-returned.** `openai-node` and `anthropic-sdk` generate a
  fresh UUID per provider request in their session layer, attach it to the emitted usage event,
  and (when `requestCorrelationHeaders: "factory-v1"` is enabled) project it to the
  `x-factory-llm-call-id` request header so gateway-side records and `agent.usage` events can
  be joined on the same ID.

`executionId` and `frameId` follow a fallback rule in `AgentEventBridge.trackUsage()`: when the
normalized usage does not carry them, they are filled from the request correlation of the
currently acknowledged `MessageHandle`. Provider-supplied values always take precedence.

---

## `agent.usage` vs. `client.session.usage.snapshot`

- **`agent.usage`** carries delta metrics: tokens attributable to one provider call, message,
  turn, or terminal query. Only signals that represent *new* consumption belong here.
- **`client.session.usage.snapshot`** carries observed cumulative state of a client session
  (source: `statusline`), including cumulative token totals and `totalCost` with
  `costProvenance: 'client-reported'`.

The Claude Code Tmux adapter is the canonical example of the split: the statusline's
`current_usage` token gauge is deduplicated and emitted as `agent.usage`, while the cumulative
session totals and `cost.total_cost_usd` flow exclusively into the session usage snapshot.
Summing snapshots, or adding a snapshot's cost onto `agent.usage` costs, double counts.

---

## Cost Provenance

`agent.usage.costProvenance` distinguishes `provider-reported`, `client-reported`, and
`estimated` monetary amounts; `client.session.usage.snapshot` carries the same enum and
requires `totalCost`, `costCurrency`, and `costProvenance` to be supplied together.

Current behavior worth knowing:

- No adapter tags `costProvenance` on `agent.usage` today. The Claude Agent SDK/CLI adapters
  and `pi-sdk` emit provider-reported amounts as a bare `cost` field; `cursor-sdk` forwards
  the SDK's optional amount (defaulting to `0`).
- The OTel telemetry collector treats an untagged (or `estimated`) `cost` as an estimate
  (`llm.cost.estimated`), so untagged provider-reported amounts are currently conservative in
  telemetry.
- The Claude Code statusline snapshot sets `costProvenance: 'client-reported'` — the amount is
  computed by the client, not returned by the provider billing API.

---

## Consequences for Downstream Analytics

1. **Do not sum across granularity classes.** A terminal query aggregate already contains the
   tokens of every model turn inside it; adding per-turn signals from another source for the
   same session counts them twice.
2. **Do not sum cumulative signals.** Statusline session totals and
   `client.session.usage.snapshot` values are gauges/snapshots — take the latest value per
   session, never the sum.
3. **Join on `llmCallId` only where it exists.** Per-call reconciliation against gateway
   records is possible for `openai-node` and `anthropic-sdk` exclusively. For all other
   adapters, correlate at turn/session level via `executionId`, `frameId`, `messageId`, and
   `sessionId`.
4. **Treat cost fields by provenance.** Provider-reported aggregates (Claude Agent SDK/CLI,
   Pi) cover potentially multiple model calls; client-reported snapshot costs are cumulative
   per session. Neither can be attributed to individual provider calls.
