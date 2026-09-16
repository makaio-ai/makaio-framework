---
'@makaio/contracts': minor
---

Add three observed-semantics subjects to the client namespace (FACT-293 part 1)

**Contracts (`@makaio/contracts`):**

- `client.session.compaction.pre` — fires BEFORE the client compacts its
  context window. The post-compaction framework signal is `client.session.started`
  with `startMode: 'compact'`; both clients also fire a raw-only `PostCompact`
  hook carrying `trigger`, but its ordering relative to `SessionStart(compact)`
  differs by client (Codex: PostCompact before SessionStart; Claude Code:
  SessionStart before PostCompact). Consumers must treat `client.session.started`
  with `startMode: 'compact'` as authoritative and must not assume a fixed
  ordering with PostCompact. There is deliberately no `compaction.post` subject.
  Three compaction signals describe the full
  lifecycle: `client.session.compaction.pre` (before compaction, from hooks,
  carries `trigger` and `transcriptPath`), `client.session.started` with
  `startMode: 'compact'` (after compaction, from hooks), and `session.compacted`
  via `SessionSubjects.session.compacted` from `@makaio/contracts` (post-hoc, from
  transcript import). Payload schema: `ClientSessionCompactionPreSchema` extends
  the base with optional `trigger` (`'manual' | 'auto'`, observability attribute
  `makaio.session.compaction_trigger`) and optional `transcriptPath`. Exports:
  `CLIENT_SESSION_COMPACTION_TRIGGERS`, `ClientSessionCompactionTriggerSchema`,
  `ClientSessionCompactionTrigger`, `ClientSessionCompactionPreSchema`,
  `ClientSessionCompactionPre`.

- `client.session.subagent.started` — emitted when a client-native subagent
  is observed via hooks. The subagent event belongs to the parent session:
  `adapterSessionId` on the base carries the parent session id (same as every
  other `client.session.*` event), keeping subagent events joinable on
  `adapterSessionId`. Subagent identity is `agentId`. Payload schema:
  `ClientSessionSubagentStartedSchema` extends the base with required `agentId`
  (attr `makaio.agent.id`), optional `agentType` (attr `makaio.agent.type`),
  and optional `turnId` (attr `makaio.turn.id`; Codex populates this from
  `turn_id`, Claude Code does not expose it). Exports:
  `ClientSessionSubagentStartedSchema`, `ClientSessionSubagentStarted`.

- `client.session.subagent.completed` — emitted when a client-native subagent
  completes. Extends `ClientSessionSubagentStartedSchema` with optional
  `agentTranscriptPath` so consumers can trigger targeted log imports.
  Exports: `ClientSessionSubagentCompletedSchema`, `ClientSessionSubagentCompleted`.
