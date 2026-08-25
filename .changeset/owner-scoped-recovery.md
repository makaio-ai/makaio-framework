---
'@makaio/adapter-anthropic-sdk': major
'@makaio/adapter-claude-agent-sdk': major
'@makaio/adapter-claude-code-cli': major
'@makaio/adapter-claude-code-tmux': major
'@makaio/adapter-codex-app-server': major
'@makaio/adapter-cursor-sdk': major
'@makaio/adapter-gemini-sdk': major
'@makaio/adapter-github-copilot-sdk': major
'@makaio/adapter-openai-node': major
'@makaio/adapter-pi-sdk': major
'@makaio/adapter-qwen-acp': major
'@makaio/contracts': major
'@makaio/framework': major
---

Make adapter runtime ownership explicit and fence recovery by the exact runtime incarnation.

Every live adapter identity now includes `{ adapterId, adapterName, machineId,
ownerInstanceId }`. Adapter lifecycle announcements, agent probes, starts, stops,
session movements, ownership reservations and recovery settlements carry that full
identity, so a same-machine peer cannot answer for or mutate an adapter incarnation
it does not own. Live-identity misses delegate to other runtime processes, and
claimless teardown still targets the owner recorded on the agent row when no runtime
instance row has been published yet.

Recovery is now one durable, fenced attempt for both keyed and keyless starts. The
reservation transaction records a unique attempt ID and the exact preimage; one
terminal storage operation then either commits the recovered binding or restores
that preimage. Stale attempts cannot settle newer work, response-loss rollback stays
exact, and connector-only cleanup cannot overwrite the terminal recovery state.

**BREAKING:** adapter constructors and their convenience factories require runtime
configuration containing `machineId` and `ownerInstanceId`. Adapter lifecycle and
owner-targeted request contracts require `ownerInstanceId`, `adapter.getAgent` is
owner-scoped, and recovery reservation/finalization contracts require the matching
attempt and full runtime binding.
