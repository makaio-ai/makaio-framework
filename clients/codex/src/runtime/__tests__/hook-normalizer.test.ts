import { describe, expect, it } from 'vitest';
import { ClientSubjects } from '@makaio/subsystem-client';
import { normalizeCodexHook } from '../hook-normalizer.js';
import type { RawClientHookPayload } from '../schemas.js';

/**
 * Build a minimal raw hook payload for test scenarios.
 * @param eventName - Codex hook event name
 * @param payload - Optional raw event payload fields
 * @param metadata - Optional bridge metadata
 * @returns Well-formed raw hook payload
 */
function makeRaw(
  eventName: string,
  payload: Record<string, unknown> = {},
  metadata?: Record<string, unknown>,
): RawClientHookPayload {
  return {
    eventName,
    receivedAt: 1_713_795_200_000,
    payload,
    metadata,
  };
}

describe('normalizeCodexHook', () => {
  describe('return type — array', () => {
    it('returns an array for every call', () => {
      expect(Array.isArray(normalizeCodexHook(makeRaw('SessionStart')))).toBe(true);
    });

    it('returns an empty array for unknown events', () => {
      expect(normalizeCodexHook(makeRaw('some_future_event'))).toHaveLength(0);
    });

    it('returns a single event for most known hooks', () => {
      expect(normalizeCodexHook(makeRaw('SessionStart'))).toHaveLength(1);
      expect(normalizeCodexHook(makeRaw('Stop'))).toHaveLength(1);
      expect(normalizeCodexHook(makeRaw('PreToolUse'))).toHaveLength(1);
      expect(normalizeCodexHook(makeRaw('PostToolUse'))).toHaveLength(1);
    });

    it('returns two events for UserPromptSubmit (turn.started then userPrompt.submitted)', () => {
      const result = normalizeCodexHook(makeRaw('UserPromptSubmit'));
      expect(result).toHaveLength(2);
      expect(result[0].subject).toBe(ClientSubjects.session.turn.started);
      expect(result[1].subject).toBe(ClientSubjects.session.userPrompt.submitted);
    });
  });

  describe('known events — correct subject mapping', () => {
    it('maps SessionStart to client.session.started', () => {
      const result = normalizeCodexHook(makeRaw('SessionStart'));

      expect(result).toHaveLength(1);
      expect(result[0].subject).toBe(ClientSubjects.session.started);
    });

    it('maps UserPromptSubmit to turn.started + userPrompt.submitted', () => {
      const result = normalizeCodexHook(makeRaw('UserPromptSubmit'));

      expect(result).toHaveLength(2);
      expect(result[0].subject).toBe(ClientSubjects.session.turn.started);
      expect(result[1].subject).toBe(ClientSubjects.session.userPrompt.submitted);
    });

    it('maps Stop to client.session.turn.completed', () => {
      const result = normalizeCodexHook(makeRaw('Stop'));

      expect(result).toHaveLength(1);
      expect(result[0].subject).toBe(ClientSubjects.session.turn.completed);
    });

    it('maps PreToolUse to client.session.tool.pre', () => {
      const result = normalizeCodexHook(makeRaw('PreToolUse'));

      expect(result).toHaveLength(1);
      expect(result[0].subject).toBe(ClientSubjects.session.tool.pre);
    });

    it('maps PostToolUse to client.session.tool.post', () => {
      const result = normalizeCodexHook(makeRaw('PostToolUse'));

      expect(result).toHaveLength(1);
      expect(result[0].subject).toBe(ClientSubjects.session.tool.post);
    });

    it('maps SubagentStart to client.session.subagent.started', () => {
      const result = normalizeCodexHook(makeRaw('SubagentStart', { agent_id: 'agent-1', session_id: 'parent-1' }));

      expect(result).toHaveLength(1);
      expect(result[0].subject).toBe(ClientSubjects.session.subagent.started);
    });

    it('maps SubagentStop to client.session.subagent.completed', () => {
      const result = normalizeCodexHook(makeRaw('SubagentStop', { agent_id: 'agent-1', session_id: 'parent-1' }));

      expect(result).toHaveLength(1);
      expect(result[0].subject).toBe(ClientSubjects.session.subagent.completed);
    });

    it('maps PreCompact to client.session.compaction.pre', () => {
      const result = normalizeCodexHook(makeRaw('PreCompact'));

      expect(result).toHaveLength(1);
      expect(result[0].subject).toBe(ClientSubjects.session.compaction.pre);
    });

    it('returns empty array for PostCompact (raw-only, no global subject)', () => {
      expect(normalizeCodexHook(makeRaw('PostCompact'))).toHaveLength(0);
    });
  });

  describe('unknown events — ignored globally', () => {
    it('returns empty array for an unrecognized event name', () => {
      expect(normalizeCodexHook(makeRaw('some_future_event'))).toHaveLength(0);
    });

    it('returns empty array for an empty event name', () => {
      expect(normalizeCodexHook(makeRaw(''))).toHaveLength(0);
    });

    it('returns empty array for old snake_case Codex hook names', () => {
      expect(normalizeCodexHook(makeRaw('pre_tool_call'))).toHaveLength(0);
      expect(normalizeCodexHook(makeRaw('post_tool_call'))).toHaveLength(0);
      expect(normalizeCodexHook(makeRaw('agent_turn_complete'))).toHaveLength(0);
    });
  });

  describe('base payload fields', () => {
    it('sets clientId to "codex" for all known events', () => {
      const result = normalizeCodexHook(makeRaw('SessionStart'));

      expect(result[0].payload.clientId).toBe('codex');
    });

    it('sets source to "native-hook" for all known events', () => {
      const result = normalizeCodexHook(makeRaw('SessionStart'));

      expect(result[0].payload.source).toBe('native-hook');
    });

    it('carries receivedAt as observedAt', () => {
      const raw = makeRaw('SessionStart');
      const result = normalizeCodexHook(raw);

      expect(result[0].payload.observedAt).toBe(raw.receivedAt);
    });
  });

  describe('metadata pass-through', () => {
    it('forwards bridge metadata when present', () => {
      const metadata = { pid: 42_000, invocationId: 'inv-1' };
      const result = normalizeCodexHook(makeRaw('SessionStart', {}, metadata));

      expect(result[0].payload.metadata).toEqual(metadata);
    });

    it('passes through undefined metadata when absent', () => {
      const result = normalizeCodexHook(makeRaw('SessionStart', {}));

      expect(result[0].payload.metadata).toBeUndefined();
    });
  });

  describe('session identifier flow', () => {
    it('extracts session_id as adapterSessionId', () => {
      const result = normalizeCodexHook(makeRaw('SessionStart', { session_id: 'sess-abc' }));

      expect(result[0].payload.adapterSessionId).toBe('sess-abc');
    });

    it('falls back to thread_id when session_id is absent', () => {
      const result = normalizeCodexHook(makeRaw('Stop', { thread_id: 'thread-xyz' }));

      expect(result[0].payload.adapterSessionId).toBe('thread-xyz');
    });

    it('prefers session_id over thread_id when both are present', () => {
      const result = normalizeCodexHook(makeRaw('SessionStart', { session_id: 'sess-1', thread_id: 'thread-1' }));

      expect(result[0].payload.adapterSessionId).toBe('sess-1');
    });

    it('leaves adapterSessionId undefined when neither field is present', () => {
      const result = normalizeCodexHook(makeRaw('SessionStart', {}));

      expect(result[0].payload.adapterSessionId).toBeUndefined();
    });

    it('treats empty-string session_id as absent', () => {
      const result = normalizeCodexHook(makeRaw('SessionStart', { session_id: '' }));

      expect(result[0].payload.adapterSessionId).toBeUndefined();
    });

    it('falls back to thread_id when session_id is an empty string', () => {
      const result = normalizeCodexHook(makeRaw('SessionStart', { session_id: '', thread_id: 'thread-xyz' }));

      expect(result[0].payload.adapterSessionId).toBe('thread-xyz');
    });

    it('treats empty-string thread_id as absent', () => {
      const result = normalizeCodexHook(makeRaw('SessionStart', { thread_id: '' }));

      expect(result[0].payload.adapterSessionId).toBeUndefined();
    });
  });

  describe('SessionStart — startMode mapping', () => {
    it.each([
      ['startup', 'fresh'],
      ['resume', 'resume'],
      ['clear', 'clear'],
      ['compact', 'compact'],
    ] as const)('maps source %s to startMode %s', (source, expected) => {
      const result = normalizeCodexHook(makeRaw('SessionStart', { source }));

      expect(result).toHaveLength(1);
      expect(result[0].payload).toMatchObject({ startMode: expected });
    });

    it('leaves startMode absent when source is absent', () => {
      const result = normalizeCodexHook(makeRaw('SessionStart', {}));

      expect(result[0].payload).not.toHaveProperty('startMode');
    });

    it('leaves startMode absent for an unrecognized source value', () => {
      const result = normalizeCodexHook(makeRaw('SessionStart', { source: 'new_future_mode' }));

      expect(result[0].payload).not.toHaveProperty('startMode');
    });

    it('passes startMode through alongside machineId', () => {
      const result = normalizeCodexHook(makeRaw('SessionStart', { source: 'startup' }), 'machine-1');

      expect(result[0].payload).toMatchObject({ startMode: 'fresh', machineId: 'machine-1' });
    });
  });

  describe('SessionStart — transcriptPath', () => {
    it('carries transcript_path through as transcriptPath', () => {
      const result = normalizeCodexHook(
        makeRaw('SessionStart', { session_id: 'sess-1', transcript_path: '/rollouts/sess-1.jsonl' }),
      );

      expect(result[0].payload).toMatchObject({ transcriptPath: '/rollouts/sess-1.jsonl' });
    });

    it('leaves transcriptPath absent when Codex reports null', () => {
      const result = normalizeCodexHook(makeRaw('SessionStart', { session_id: 'sess-1', transcript_path: null }));

      expect(result[0].payload).not.toHaveProperty('transcriptPath');
    });

    it('leaves transcriptPath absent when the field is missing', () => {
      const result = normalizeCodexHook(makeRaw('SessionStart', { session_id: 'sess-1' }));

      expect(result[0].payload).not.toHaveProperty('transcriptPath');
    });
  });

  describe('UserPromptSubmit — two-event emission', () => {
    it('emits turn.started payload with base fields', () => {
      const result = normalizeCodexHook(makeRaw('UserPromptSubmit', { session_id: 'sess-2' }));

      expect(result[0].payload).toMatchObject({
        clientId: 'codex',
        source: 'native-hook',
        adapterSessionId: 'sess-2',
      });
    });

    it('extracts prompt text from userPrompt.submitted payload', () => {
      const result = normalizeCodexHook(makeRaw('UserPromptSubmit', { prompt: 'Write a fizzbuzz function' }));

      expect(result[1].payload).toMatchObject({ prompt: 'Write a fizzbuzz function' });
    });

    it('leaves prompt undefined when absent', () => {
      const result = normalizeCodexHook(makeRaw('UserPromptSubmit', {}));

      expect((result[1].payload as { prompt?: string }).prompt).toBeUndefined();
    });

    it('treats empty string prompt as absent', () => {
      const result = normalizeCodexHook(makeRaw('UserPromptSubmit', { prompt: '' }));

      expect((result[1].payload as { prompt?: string }).prompt).toBeUndefined();
    });
  });

  describe('PreToolUse — tool fields', () => {
    it('extracts tool_name and tool_use_id', () => {
      const result = normalizeCodexHook(makeRaw('PreToolUse', { tool_name: 'bash', tool_use_id: 'call-123' }));

      expect(result[0].payload).toMatchObject({ toolName: 'bash', toolCallId: 'call-123' });
    });

    it('leaves toolName and toolCallId undefined when absent', () => {
      const result = normalizeCodexHook(makeRaw('PreToolUse', {}));
      const payload = result[0].payload as { toolName?: string; toolCallId?: string };

      expect(payload.toolName).toBeUndefined();
      expect(payload.toolCallId).toBeUndefined();
    });

    it('treats empty-string tool_name as absent', () => {
      const result = normalizeCodexHook(makeRaw('PreToolUse', { tool_name: '' }));
      const payload = result[0].payload as { toolName?: string };

      expect(payload.toolName).toBeUndefined();
    });

    it('treats empty-string tool_use_id as absent', () => {
      const result = normalizeCodexHook(makeRaw('PreToolUse', { tool_use_id: '' }));
      const payload = result[0].payload as { toolCallId?: string };

      expect(payload.toolCallId).toBeUndefined();
    });
  });

  describe('PostToolUse — tool fields', () => {
    it('extracts tool_name and tool_use_id without guessing success from tool_response', () => {
      const result = normalizeCodexHook(
        makeRaw('PostToolUse', { tool_name: 'bash', tool_use_id: 'call-456', tool_response: { output: 'ok' } }),
      );

      expect(result[0].payload).toMatchObject({
        toolName: 'bash',
        toolCallId: 'call-456',
      });
      expect((result[0].payload as { success?: boolean }).success).toBeUndefined();
    });

    it('treats empty-string tool_name as absent in PostToolUse', () => {
      const result = normalizeCodexHook(makeRaw('PostToolUse', { tool_name: '' }));
      const payload = result[0].payload as { toolName?: string };

      expect(payload.toolName).toBeUndefined();
    });

    it('treats empty-string tool_use_id as absent in PostToolUse', () => {
      const result = normalizeCodexHook(makeRaw('PostToolUse', { tool_use_id: '' }));
      const payload = result[0].payload as { toolCallId?: string };

      expect(payload.toolCallId).toBeUndefined();
    });
  });

  describe('SubagentStart — subagent identity and parent session', () => {
    it('returns empty array when agent_id is absent', () => {
      expect(normalizeCodexHook(makeRaw('SubagentStart', { session_id: 'parent-1' }))).toHaveLength(0);
    });

    it('returns empty array when agent_id is an empty string', () => {
      expect(normalizeCodexHook(makeRaw('SubagentStart', { agent_id: '', session_id: 'parent-1' }))).toHaveLength(0);
    });

    it('extracts agentId from agent_id field', () => {
      const result = normalizeCodexHook(makeRaw('SubagentStart', { agent_id: 'sub-42', session_id: 'parent-1' }));

      expect(result[0].payload).toMatchObject({ agentId: 'sub-42' });
    });

    it('places session_id into adapterSessionId (parent session id)', () => {
      const result = normalizeCodexHook(makeRaw('SubagentStart', { agent_id: 'sub-42', session_id: 'parent-session' }));
      const payload = result[0].payload as { adapterSessionId?: string };

      expect(payload.adapterSessionId).toBe('parent-session');
    });

    it('extracts optional agentType', () => {
      const result = normalizeCodexHook(
        makeRaw('SubagentStart', { agent_id: 'sub-42', agent_type: 'researcher', session_id: 'parent-1' }),
      );

      expect(result[0].payload).toMatchObject({ agentType: 'researcher' });
    });

    it('omits agentType when absent', () => {
      const result = normalizeCodexHook(makeRaw('SubagentStart', { agent_id: 'sub-42', session_id: 'parent-1' }));
      const payload = result[0].payload as { agentType?: string };

      expect(payload.agentType).toBeUndefined();
    });

    it('extracts turn_id as turnId', () => {
      const result = normalizeCodexHook(
        makeRaw('SubagentStart', { agent_id: 'sub-42', session_id: 'parent-1', turn_id: 'turn-abc' }),
      );
      const payload = result[0].payload as { turnId?: string };

      expect(payload.turnId).toBe('turn-abc');
    });

    it('omits turnId when turn_id is absent', () => {
      const result = normalizeCodexHook(makeRaw('SubagentStart', { agent_id: 'sub-42', session_id: 'parent-1' }));
      const payload = result[0].payload as { turnId?: string };

      expect(payload.turnId).toBeUndefined();
    });
  });

  describe('SubagentStop — subagent identity and transcript path', () => {
    it('returns empty array when agent_id is absent', () => {
      expect(normalizeCodexHook(makeRaw('SubagentStop', { session_id: 'parent-1' }))).toHaveLength(0);
    });

    it('extracts agentId and adapterSessionId (parent session id)', () => {
      const result = normalizeCodexHook(makeRaw('SubagentStop', { agent_id: 'sub-42', session_id: 'parent-1' }));
      const payload = result[0].payload as {
        agentId: string;
        adapterSessionId?: string;
      };

      expect(payload.agentId).toBe('sub-42');
      expect(payload.adapterSessionId).toBe('parent-1');
    });

    it('extracts agent_transcript_path as agentTranscriptPath', () => {
      const result = normalizeCodexHook(
        makeRaw('SubagentStop', {
          agent_id: 'sub-42',
          session_id: 'parent-1',
          agent_transcript_path: '/home/.codex/subagent.jsonl',
        }),
      );

      expect(result[0].payload).toMatchObject({ agentTranscriptPath: '/home/.codex/subagent.jsonl' });
    });

    it('omits agentTranscriptPath when absent', () => {
      const result = normalizeCodexHook(makeRaw('SubagentStop', { agent_id: 'sub-42', session_id: 'parent-1' }));
      const payload = result[0].payload as { agentTranscriptPath?: string };

      expect(payload.agentTranscriptPath).toBeUndefined();
    });

    it('extracts turn_id as turnId', () => {
      const result = normalizeCodexHook(
        makeRaw('SubagentStop', { agent_id: 'sub-42', session_id: 'parent-1', turn_id: 'turn-xyz' }),
      );
      const payload = result[0].payload as { turnId?: string };

      expect(payload.turnId).toBe('turn-xyz');
    });

    it('omits turnId when turn_id is absent', () => {
      const result = normalizeCodexHook(makeRaw('SubagentStop', { agent_id: 'sub-42', session_id: 'parent-1' }));
      const payload = result[0].payload as { turnId?: string };

      expect(payload.turnId).toBeUndefined();
    });
  });

  describe('PreCompact — trigger and transcript path', () => {
    it('produces a compaction.pre event', () => {
      const result = normalizeCodexHook(makeRaw('PreCompact'));

      expect(result).toHaveLength(1);
      expect(result[0].subject).toBe(ClientSubjects.session.compaction.pre);
    });

    it('extracts manual trigger', () => {
      const result = normalizeCodexHook(makeRaw('PreCompact', { trigger: 'manual' }));
      const payload = result[0].payload as { trigger?: string };

      expect(payload.trigger).toBe('manual');
    });

    it('extracts auto trigger', () => {
      const result = normalizeCodexHook(makeRaw('PreCompact', { trigger: 'auto' }));
      const payload = result[0].payload as { trigger?: string };

      expect(payload.trigger).toBe('auto');
    });

    it('drops unknown trigger values', () => {
      const result = normalizeCodexHook(makeRaw('PreCompact', { trigger: 'scheduled' }));
      const payload = result[0].payload as { trigger?: string };

      expect(payload.trigger).toBeUndefined();
    });

    it('extracts transcript_path', () => {
      const result = normalizeCodexHook(makeRaw('PreCompact', { transcript_path: '/home/.codex/session.jsonl' }));
      const payload = result[0].payload as { transcriptPath?: string };

      expect(payload.transcriptPath).toBe('/home/.codex/session.jsonl');
    });

    it('omits transcriptPath when absent', () => {
      const result = normalizeCodexHook(makeRaw('PreCompact', {}));
      const payload = result[0].payload as { transcriptPath?: string };

      expect(payload.transcriptPath).toBeUndefined();
    });
  });

  describe('PostCompact — raw-only', () => {
    it('returns empty array for PostCompact', () => {
      expect(normalizeCodexHook(makeRaw('PostCompact'))).toHaveLength(0);
    });
  });
});
