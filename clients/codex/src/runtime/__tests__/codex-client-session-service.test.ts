import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { ClientSubjects, type RawClientHookPayload } from '@makaio/subsystem-client';
import type { ClientRuntimeStarted } from '@makaio/contracts/client';
import { CodexClientSubjects } from '../namespace.js';
import { CodexClientSessionService, MANAGED_SESSION_CAP } from '../codex-client-session-service.js';

type CapturedClientSessionSubject =
  | typeof ClientSubjects.session.started
  | typeof ClientSubjects.session.userPrompt.submitted
  | typeof ClientSubjects.session.turn.started
  | typeof ClientSubjects.session.turn.completed
  | typeof ClientSubjects.session.tool.pre
  | typeof ClientSubjects.session.tool.post
  | typeof ClientSubjects.session.subagent.started
  | typeof ClientSubjects.session.subagent.completed
  | typeof ClientSubjects.session.compaction.pre;

/**
 * Capture payloads emitted on one or more client session subjects.
 * @param bus - Test bus instance
 * @param subjects - Client session subjects to observe
 * @returns Captured payloads and a cleanup function
 */
function capturePayloads(
  bus: IMakaioBus,
  ...subjects: CapturedClientSessionSubject[]
): { received: unknown[]; cleanup: () => void } {
  const received: unknown[] = [];
  const cleanups = subjects.map((subject) =>
    bus.on(subject, (ctx: { payload: unknown }) => {
      received.push(ctx.payload);
    }),
  );
  return {
    received,
    cleanup: () => {
      cleanups.forEach((cleanup) => cleanup());
    },
  };
}

/**
 * Emit a raw hook event on the test bus and wait for the emission to settle.
 * @param bus - Test bus instance
 * @param eventName - Codex-native hook event name
 * @param payload - Raw payload forwarded by the ingress bridge
 * @param metadata - Optional bridge metadata
 */
async function emitRawHook(
  bus: IMakaioBus,
  eventName: string,
  payload: RawClientHookPayload['payload'] = {},
  metadata?: RawClientHookPayload['metadata'],
): Promise<void> {
  await bus.emit(CodexClientSubjects.hook.received, {
    eventName,
    receivedAt: 1_713_795_200_000,
    payload,
    metadata,
  });
}

describe('CodexClientSessionService', () => {
  let bus: IMakaioBus;
  let service: CodexClientSessionService;

  beforeEach(async () => {
    bus = createBusInstance();
    service = new CodexClientSessionService(bus);
    await service.init();
  });

  afterEach(async () => {
    await service.destroy();
  });

  it('initializes without errors', () => {
    expect(service.initialized).toBe(true);
  });

  describe('known event normalization', () => {
    it('emits client.session.started for SessionStart', async () => {
      const { received, cleanup } = capturePayloads(bus, ClientSubjects.session.started);

      await emitRawHook(bus, 'SessionStart', { session_id: 'sess-1' });
      cleanup();

      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        clientId: 'codex',
        source: 'native-hook',
        adapterSessionId: 'sess-1',
      });
    });

    it('stamps caller-supplied machineId onto client.session.started payloads', async () => {
      // Tear down the default service and create one with a machineId.
      await service.destroy();
      service = new CodexClientSessionService(bus, undefined, 'machine-codex-99');
      await service.init();

      const { received, cleanup } = capturePayloads(bus, ClientSubjects.session.started);

      await emitRawHook(bus, 'SessionStart', { session_id: 'sess-machine' });
      cleanup();

      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        clientId: 'codex',
        adapterSessionId: 'sess-machine',
        machineId: 'machine-codex-99',
      });
    });

    it('emits client.session.userPrompt.submitted for UserPromptSubmit', async () => {
      const { received, cleanup } = capturePayloads(bus, ClientSubjects.session.userPrompt.submitted);

      await emitRawHook(bus, 'UserPromptSubmit', {
        session_id: 'sess-2',
        prompt: 'Refactor this file',
      });
      cleanup();

      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        clientId: 'codex',
        source: 'native-hook',
        adapterSessionId: 'sess-2',
        prompt: 'Refactor this file',
      });
    });

    it('emits client.session.turn.completed for Stop', async () => {
      const { received, cleanup } = capturePayloads(bus, ClientSubjects.session.turn.completed);

      await emitRawHook(bus, 'Stop', { session_id: 'sess-4' });
      cleanup();

      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ clientId: 'codex', source: 'native-hook' });
    });

    it('emits client.session.tool.pre for PreToolUse', async () => {
      const { received, cleanup } = capturePayloads(bus, ClientSubjects.session.tool.pre);

      await emitRawHook(bus, 'PreToolUse', {
        session_id: 'sess-5',
        tool_name: 'bash',
        tool_use_id: 'call-1',
      });
      cleanup();

      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        clientId: 'codex',
        source: 'native-hook',
        toolName: 'bash',
        toolCallId: 'call-1',
      });
    });

    it('emits client.session.tool.post for PostToolUse', async () => {
      const { received, cleanup } = capturePayloads(bus, ClientSubjects.session.tool.post);

      await emitRawHook(bus, 'PostToolUse', {
        session_id: 'sess-6',
        tool_name: 'bash',
        tool_use_id: 'call-2',
        tool_response: { output: 'ok' },
      });
      cleanup();

      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        clientId: 'codex',
        source: 'native-hook',
        toolName: 'bash',
        toolCallId: 'call-2',
      });
    });

    it('emits turn.started before userPrompt.submitted for UserPromptSubmit', async () => {
      // ORDER is a documented invariant — verified via a shared ordered log so
      // any future reordering is caught regardless of per-subject array lengths.
      const orderedLog: Array<{ subject: string; payload: unknown }> = [];
      const unsubTurnStarted = bus.on(ClientSubjects.session.turn.started, (ctx: { payload: unknown }) => {
        orderedLog.push({ subject: 'turn.started', payload: ctx.payload });
      });
      const unsubPrompt = bus.on(ClientSubjects.session.userPrompt.submitted, (ctx: { payload: unknown }) => {
        orderedLog.push({ subject: 'userPrompt.submitted', payload: ctx.payload });
      });

      await emitRawHook(bus, 'UserPromptSubmit', { session_id: 'sess-ups', prompt: 'hello' });
      unsubTurnStarted();
      unsubPrompt();

      expect(orderedLog.map((e) => e.subject)).toEqual(['turn.started', 'userPrompt.submitted']);
      expect(orderedLog[0]?.payload).toMatchObject({ clientId: 'codex', adapterSessionId: 'sess-ups' });
      expect(orderedLog[1]?.payload).toMatchObject({ clientId: 'codex', prompt: 'hello' });
    });

    it('emits client.session.subagent.started for SubagentStart with agentId', async () => {
      const { received, cleanup } = capturePayloads(bus, ClientSubjects.session.subagent.started);

      await emitRawHook(bus, 'SubagentStart', {
        agent_id: 'sub-agent-77',
        agent_type: 'coder',
        session_id: 'parent-sess-1',
      });
      cleanup();

      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        clientId: 'codex',
        source: 'native-hook',
        agentId: 'sub-agent-77',
        agentType: 'coder',
        adapterSessionId: 'parent-sess-1',
      });
    });

    it('does not emit subagent.started when agent_id is absent', async () => {
      const { received, cleanup } = capturePayloads(bus, ClientSubjects.session.subagent.started);

      await emitRawHook(bus, 'SubagentStart', { session_id: 'parent-sess-1' });
      cleanup();

      expect(received).toHaveLength(0);
    });

    it('does not emit subagent.completed when agent_id is absent', async () => {
      const { received, cleanup } = capturePayloads(bus, ClientSubjects.session.subagent.completed);

      await emitRawHook(bus, 'SubagentStop', {
        session_id: 'parent-sess-1',
        agent_transcript_path: '/home/.codex/sub.jsonl',
      });
      cleanup();

      expect(received).toHaveLength(0);
    });

    it('emits client.session.subagent.completed for SubagentStop with agentId', async () => {
      const { received, cleanup } = capturePayloads(bus, ClientSubjects.session.subagent.completed);

      await emitRawHook(bus, 'SubagentStop', {
        agent_id: 'sub-agent-77',
        session_id: 'parent-sess-1',
        agent_transcript_path: '/home/.codex/sub.jsonl',
      });
      cleanup();

      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        clientId: 'codex',
        agentId: 'sub-agent-77',
        adapterSessionId: 'parent-sess-1',
        agentTranscriptPath: '/home/.codex/sub.jsonl',
      });
    });

    it('emits client.session.compaction.pre for PreCompact', async () => {
      const { received, cleanup } = capturePayloads(bus, ClientSubjects.session.compaction.pre);

      await emitRawHook(bus, 'PreCompact', {
        session_id: 'sess-compact',
        trigger: 'auto',
        transcript_path: '/home/.codex/session.jsonl',
      });
      cleanup();

      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        clientId: 'codex',
        source: 'native-hook',
        trigger: 'auto',
        transcriptPath: '/home/.codex/session.jsonl',
      });
    });

    it('does not emit any client.session.* event for PostCompact (raw-only)', async () => {
      const { received, cleanup } = capturePayloads(
        bus,
        ClientSubjects.session.started,
        ClientSubjects.session.userPrompt.submitted,
        ClientSubjects.session.turn.started,
        ClientSubjects.session.turn.completed,
        ClientSubjects.session.tool.pre,
        ClientSubjects.session.tool.post,
        ClientSubjects.session.subagent.started,
        ClientSubjects.session.subagent.completed,
        ClientSubjects.session.compaction.pre,
      );

      await emitRawHook(bus, 'PostCompact', { session_id: 'sess-post-compact' });
      cleanup();

      expect(received).toHaveLength(0);
    });
  });

  describe('unknown event handling', () => {
    it('does not emit any client.session.* event for unknown hook names', async () => {
      const { received, cleanup } = capturePayloads(
        bus,
        ClientSubjects.session.started,
        ClientSubjects.session.userPrompt.submitted,
        ClientSubjects.session.turn.started,
        ClientSubjects.session.turn.completed,
        ClientSubjects.session.tool.pre,
        ClientSubjects.session.tool.post,
        ClientSubjects.session.subagent.started,
        ClientSubjects.session.subagent.completed,
        ClientSubjects.session.compaction.pre,
      );

      await emitRawHook(bus, 'some_future_codex_event');
      await emitRawHook(bus, 'pre_tool_call'); // Old snake_case Codex event — must be ignored
      await emitRawHook(bus, 'unknown_lifecycle_event');

      cleanup();

      expect(received).toHaveLength(0);
    });
  });

  describe('metadata pass-through', () => {
    it('forwards bridge metadata to the normalized payload', async () => {
      const { received, cleanup } = capturePayloads(bus, ClientSubjects.session.started);

      const metadata = { pid: 99_999, invocationId: 'inv-abc' };
      await emitRawHook(bus, 'SessionStart', {}, metadata);
      cleanup();

      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ metadata });
    });
  });

  describe('session identifier flow', () => {
    it('propagates session_id through normalization', async () => {
      const { received, cleanup } = capturePayloads(bus, ClientSubjects.session.started);

      await emitRawHook(bus, 'SessionStart', { session_id: 'sess-flow-1' });
      cleanup();

      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ adapterSessionId: 'sess-flow-1' });
    });

    it('falls back to thread_id when session_id is absent', async () => {
      const { received, cleanup } = capturePayloads(bus, ClientSubjects.session.turn.completed);

      await emitRawHook(bus, 'Stop', { thread_id: 'thread-flow-2' });
      cleanup();

      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ adapterSessionId: 'thread-flow-2' });
    });
  });

  describe('lifecycle', () => {
    it('stops forwarding events after destroy()', async () => {
      const { received, cleanup } = capturePayloads(bus, ClientSubjects.session.started);

      await service.destroy();

      await emitRawHook(bus, 'SessionStart');
      cleanup();

      expect(received).toHaveLength(0);
    });
  });

  describe('adapter-managed session gate', () => {
    /**
     * Emits a `client.runtime.started` event on the test bus with sensible
     * defaults for the adapter-managed session gate tests.
     * @param overrides - Partial payload merged over the defaults
     */
    function emitRuntimeStarted(overrides: Partial<ClientRuntimeStarted> = {}): Promise<void> {
      const { source: overrideSource, adapterSessionId: overrideAdapterSessionId, ...rest } = overrides;
      const source = overrideSource ?? { layer: 'adapter', producer: 'codex-app-server' };
      const adapterSessionId = source.layer === 'adapter' ? (overrideAdapterSessionId ?? 'sess-1') : undefined;
      return bus.emit(ClientSubjects.runtime.started, {
        clientRuntimeId: 'rt-default',
        clientId: 'codex',
        status: 'started',
        observedAt: 1_713_795_200_000,
        ...rest,
        source,
        ...(adapterSessionId !== undefined ? { adapterSessionId } : {}),
      });
    }

    it('suppresses client.session.started when adapterSessionId belongs to an adapter-managed runtime', async () => {
      await emitRuntimeStarted({ clientRuntimeId: 'rt-001' });

      const { received, cleanup } = capturePayloads(bus, ClientSubjects.session.started);

      await emitRawHook(bus, 'SessionStart', { session_id: 'sess-1' });
      cleanup();

      expect(received).toHaveLength(0);
    });

    it('emits client.session.started when adapterSessionId is not in the managed set', async () => {
      await emitRuntimeStarted({ clientRuntimeId: 'rt-002', adapterSessionId: 'other-session' });

      const { received, cleanup } = capturePayloads(bus, ClientSubjects.session.started);

      await emitRawHook(bus, 'SessionStart', { session_id: 'sess-1' });
      cleanup();

      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ clientId: 'codex', source: 'native-hook', adapterSessionId: 'sess-1' });
    });

    it('emits client.session.started when SessionStart hook has no adapterSessionId', async () => {
      await emitRuntimeStarted({ clientRuntimeId: 'rt-003', adapterSessionId: 'some-managed-session' });

      const { received, cleanup } = capturePayloads(bus, ClientSubjects.session.started);

      await emitRawHook(bus, 'SessionStart', {});
      cleanup();

      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ clientId: 'codex', source: 'native-hook' });
      expect(received[0]).toMatchObject({ adapterSessionId: undefined });
    });

    it('fail-open: emits client.session.started when runtime.started was never observed', async () => {
      const { received, cleanup } = capturePayloads(bus, ClientSubjects.session.started);

      await emitRawHook(bus, 'SessionStart', { session_id: 'sess-1' });
      cleanup();

      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ adapterSessionId: 'sess-1' });
    });

    it('does not suppress hook events for non-adapter runtime.started sources', async () => {
      await emitRuntimeStarted({
        clientRuntimeId: 'rt-004',
        source: { layer: 'supervisor', producer: 'test-supervisor' },
        supervisorSessionId: 'sup-session-abc',
      });

      const { received, cleanup } = capturePayloads(bus, ClientSubjects.session.started);

      await emitRawHook(bus, 'SessionStart', { session_id: 'sess-1' });
      cleanup();

      expect(received).toHaveLength(1);
    });

    it('does not suppress client.session.started when runtime.started arrives from a different clientId', async () => {
      await emitRuntimeStarted({ clientRuntimeId: 'rt-claude-001', clientId: 'claude-code' });

      const { received, cleanup } = capturePayloads(bus, ClientSubjects.session.started);

      await emitRawHook(bus, 'SessionStart', { session_id: 'sess-1' });
      cleanup();

      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ clientId: 'codex', source: 'native-hook', adapterSessionId: 'sess-1' });
    });

    it('suppresses all normalized client.session events for adapter-managed sessions', async () => {
      await emitRuntimeStarted({ clientRuntimeId: 'rt-005' });

      const { received, cleanup } = capturePayloads(
        bus,
        ClientSubjects.session.userPrompt.submitted,
        ClientSubjects.session.turn.completed,
        ClientSubjects.session.tool.pre,
        ClientSubjects.session.tool.post,
      );

      await emitRawHook(bus, 'UserPromptSubmit', { session_id: 'sess-1', prompt: 'hello' });
      await emitRawHook(bus, 'Stop', { session_id: 'sess-1' });
      await emitRawHook(bus, 'PreToolUse', { session_id: 'sess-1', tool_name: 'bash', tool_use_id: 'c-1' });
      await emitRawHook(bus, 'PostToolUse', {
        session_id: 'sess-1',
        tool_name: 'bash',
        tool_use_id: 'c-1',
        tool_response: { output: 'ok' },
      });

      cleanup();

      expect(received).toHaveLength(0);
    });

    it('evicts the oldest adapter-managed session when the cap is exceeded', async () => {
      for (let index = 0; index <= MANAGED_SESSION_CAP; index++) {
        await emitRuntimeStarted({
          clientRuntimeId: `rt-${index}`,
          adapterSessionId: `managed-session-${index}`,
        });
      }

      const { received, cleanup } = capturePayloads(bus, ClientSubjects.session.started);

      await emitRawHook(bus, 'SessionStart', { session_id: 'managed-session-0' });
      await emitRawHook(bus, 'SessionStart', { session_id: 'managed-session-1' });
      cleanup();

      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ adapterSessionId: 'managed-session-0' });
    });

    it('suppresses adapter-emitted subjects for managed sessions but forwards hook-only subjects', async () => {
      // Adapter emits: started, turn.started, turn.completed, userPrompt.submitted, tool.pre, tool.post
      // Hook-only (no adapter equivalent): subagent.started, subagent.completed, compaction.pre
      await emitRuntimeStarted({ clientRuntimeId: 'rt-gate-selective' });

      const { received: suppressedReceived, cleanup: suppressedCleanup } = capturePayloads(
        bus,
        ClientSubjects.session.started,
        ClientSubjects.session.turn.started,
        ClientSubjects.session.turn.completed,
        ClientSubjects.session.userPrompt.submitted,
        ClientSubjects.session.tool.pre,
        ClientSubjects.session.tool.post,
      );
      const { received: forwardedReceived, cleanup: forwardedCleanup } = capturePayloads(
        bus,
        ClientSubjects.session.subagent.started,
        ClientSubjects.session.subagent.completed,
        ClientSubjects.session.compaction.pre,
      );

      await emitRawHook(bus, 'SessionStart', { session_id: 'sess-1' });
      await emitRawHook(bus, 'UserPromptSubmit', { session_id: 'sess-1', prompt: 'hi' });
      await emitRawHook(bus, 'Stop', { session_id: 'sess-1' });
      await emitRawHook(bus, 'SubagentStart', {
        session_id: 'sess-1',
        agent_id: 'sub-gate-1',
        agent_type: 'coder',
      });
      await emitRawHook(bus, 'SubagentStop', {
        session_id: 'sess-1',
        agent_id: 'sub-gate-1',
        agent_transcript_path: '/home/.codex/sub.jsonl',
      });
      await emitRawHook(bus, 'PreCompact', {
        session_id: 'sess-1',
        trigger: 'auto',
        transcript_path: '/home/.codex/session.jsonl',
      });

      suppressedCleanup();
      forwardedCleanup();

      // Adapter-emitted subjects suppressed (started + turn.started + userPrompt.submitted + turn.completed)
      expect(suppressedReceived).toHaveLength(0);
      // Hook-only subjects forwarded (subagent.started + subagent.completed + compaction.pre)
      expect(forwardedReceived).toHaveLength(3);
    });

    it('forwards session.started with startMode compact for a managed session (compaction signal has no adapter counterpart)', async () => {
      await emitRuntimeStarted({ clientRuntimeId: 'rt-compact' });

      const { received, cleanup } = capturePayloads(bus, ClientSubjects.session.started);

      await emitRawHook(bus, 'SessionStart', { session_id: 'sess-1', source: 'compact' });
      cleanup();

      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ adapterSessionId: 'sess-1', startMode: 'compact' });
    });

    it('forwards session.started with startMode clear for a managed session (clear restart has no adapter counterpart)', async () => {
      await emitRuntimeStarted({ clientRuntimeId: 'rt-clear' });

      const { received, cleanup } = capturePayloads(bus, ClientSubjects.session.started);

      await emitRawHook(bus, 'SessionStart', { session_id: 'sess-1', source: 'clear' });
      cleanup();

      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ adapterSessionId: 'sess-1', startMode: 'clear' });
    });

    it('suppresses session.started with source startup for a managed session (adapter owns the initial start)', async () => {
      await emitRuntimeStarted({ clientRuntimeId: 'rt-startup' });

      const { received, cleanup } = capturePayloads(bus, ClientSubjects.session.started);

      await emitRawHook(bus, 'SessionStart', { session_id: 'sess-1', source: 'startup' });
      cleanup();

      expect(received).toHaveLength(0);
    });
  });

  describe('fork lineage enrichment', () => {
    const CHILD = '0199b0d1-1111-7000-8000-000000000001';
    const PARENT = '0199b0d1-2222-7000-8000-000000000002';
    let dir: string;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'codex-service-fork-'));
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    /**
     * Write a synthetic rollout file whose own metadata record optionally
     * names a fork source, matching the shape Codex writes on disk.
     * @param threadId - Thread id of the rollout owner
     * @param forkedFromId - Parent thread id, omitted for a root thread
     * @returns Absolute path of the written rollout file
     */
    async function writeRollout(threadId: string, forkedFromId?: string): Promise<string> {
      const path = join(dir, `${threadId}.jsonl`);
      const meta = JSON.stringify({
        timestamp: '2026-09-16T23:09:48.711Z',
        type: 'session_meta',
        payload: {
          session_id: threadId,
          id: threadId,
          ...(forkedFromId !== undefined && { forked_from_id: forkedFromId }),
          cwd: '/workspace',
          originator: 'codex_cli_rs',
          cli_version: '0.144.1',
        },
      });
      await writeFile(path, `${meta}\n`, 'utf8');
      return path;
    }

    it('upgrades a startup session whose rollout names a fork source to startMode fork', async () => {
      const transcriptPath = await writeRollout(CHILD, PARENT);
      const { received, cleanup } = capturePayloads(bus, ClientSubjects.session.started);

      await emitRawHook(bus, 'SessionStart', {
        session_id: CHILD,
        source: 'startup',
        transcript_path: transcriptPath,
      });
      cleanup();

      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        adapterSessionId: CHILD,
        startMode: 'fork',
        parentAdapterSessionId: PARENT,
        transcriptPath,
      });
    });

    it('keeps startMode fresh when the rollout names no fork source', async () => {
      const transcriptPath = await writeRollout(CHILD);
      const { received, cleanup } = capturePayloads(bus, ClientSubjects.session.started);

      await emitRawHook(bus, 'SessionStart', {
        session_id: CHILD,
        source: 'startup',
        transcript_path: transcriptPath,
      });
      cleanup();

      expect(received[0]).toMatchObject({ startMode: 'fresh' });
      expect(received[0]).not.toHaveProperty('parentAdapterSessionId');
    });

    it("does not sniff a resume: the rollout is the thread's own file, already registered", async () => {
      // A resumed fork child still shows its original fork source; upgrading it
      // would re-register instead of letting ingestion rebind by session id.
      const transcriptPath = await writeRollout(CHILD, PARENT);
      const { received, cleanup } = capturePayloads(bus, ClientSubjects.session.started);

      await emitRawHook(bus, 'SessionStart', {
        session_id: CHILD,
        source: 'resume',
        transcript_path: transcriptPath,
      });
      cleanup();

      expect(received[0]).toMatchObject({ startMode: 'resume' });
      expect(received[0]).not.toHaveProperty('parentAdapterSessionId');
    });

    it('fails open when transcript_path is null', async () => {
      const { received, cleanup } = capturePayloads(bus, ClientSubjects.session.started);

      await emitRawHook(bus, 'SessionStart', { session_id: CHILD, source: 'startup', transcript_path: null });
      cleanup();

      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ startMode: 'fresh' });
      expect(received[0]).not.toHaveProperty('transcriptPath');
      expect(received[0]).not.toHaveProperty('parentAdapterSessionId');
    });

    it('fails open when the rollout file does not exist', async () => {
      const { received, cleanup } = capturePayloads(bus, ClientSubjects.session.started);

      await emitRawHook(bus, 'SessionStart', {
        session_id: CHILD,
        source: 'startup',
        transcript_path: join(dir, 'missing.jsonl'),
      });
      cleanup();

      expect(received[0]).toMatchObject({ startMode: 'fresh' });
      expect(received[0]).not.toHaveProperty('parentAdapterSessionId');
    });
  });

  describe('emission isolation', () => {
    it('a throwing turn.started subscriber does not prevent userPrompt.submitted', async () => {
      const promptReceived: unknown[] = [];

      const unsubThrowing = bus.on(ClientSubjects.session.turn.started, () => {
        throw new Error('intentional turn.started error');
      });
      const unsubPrompt = bus.on(ClientSubjects.session.userPrompt.submitted, (ctx: { payload: unknown }) => {
        promptReceived.push(ctx.payload);
      });

      // The service must forward userPrompt.submitted even when the turn.started
      // subscriber throws.  The first error is re-thrown after the loop so callers
      // still observe the failure.
      await expect(emitRawHook(bus, 'UserPromptSubmit', { session_id: 'sess-throw', prompt: 'hello' })).rejects.toThrow(
        'intentional turn.started error',
      );

      unsubThrowing();
      unsubPrompt();

      expect(promptReceived).toHaveLength(1);
      expect(promptReceived[0]).toMatchObject({ clientId: 'codex', prompt: 'hello' });
    });
  });
});
