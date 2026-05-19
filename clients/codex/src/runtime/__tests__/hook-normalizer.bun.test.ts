import { describe, expect, it } from 'bun:test';
import { ClientSubjects } from '@makaio/clients-core';
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
  describe('known events — correct subject mapping', () => {
    it('maps SessionStart to client.session.started', () => {
      const result = normalizeCodexHook(makeRaw('SessionStart'));

      expect(result).not.toBeNull();
      expect(result!.subject).toBe(ClientSubjects.session.started);
    });

    it('maps UserPromptSubmit to client.session.userPrompt.submitted', () => {
      const result = normalizeCodexHook(makeRaw('UserPromptSubmit'));

      expect(result).not.toBeNull();
      expect(result!.subject).toBe(ClientSubjects.session.userPrompt.submitted);
    });

    it('maps Stop to client.session.turn.completed', () => {
      const result = normalizeCodexHook(makeRaw('Stop'));

      expect(result).not.toBeNull();
      expect(result!.subject).toBe(ClientSubjects.session.turn.completed);
    });

    it('maps PreToolUse to client.session.tool.pre', () => {
      const result = normalizeCodexHook(makeRaw('PreToolUse'));

      expect(result).not.toBeNull();
      expect(result!.subject).toBe(ClientSubjects.session.tool.pre);
    });

    it('maps PostToolUse to client.session.tool.post', () => {
      const result = normalizeCodexHook(makeRaw('PostToolUse'));

      expect(result).not.toBeNull();
      expect(result!.subject).toBe(ClientSubjects.session.tool.post);
    });
  });

  describe('unknown events — ignored globally', () => {
    it('returns null for an unrecognized event name', () => {
      expect(normalizeCodexHook(makeRaw('some_future_event'))).toBeNull();
    });

    it('returns null for an empty event name', () => {
      expect(normalizeCodexHook(makeRaw(''))).toBeNull();
    });

    it('returns null for old snake_case Codex hook names', () => {
      expect(normalizeCodexHook(makeRaw('pre_tool_call'))).toBeNull();
      expect(normalizeCodexHook(makeRaw('post_tool_call'))).toBeNull();
      expect(normalizeCodexHook(makeRaw('agent_turn_complete'))).toBeNull();
    });
  });

  describe('base payload fields', () => {
    it('sets clientId to "codex" for all known events', () => {
      const result = normalizeCodexHook(makeRaw('SessionStart'));

      expect(result!.payload.clientId).toBe('codex');
    });

    it('sets source to "native-hook" for all known events', () => {
      const result = normalizeCodexHook(makeRaw('SessionStart'));

      expect(result!.payload.source).toBe('native-hook');
    });

    it('carries receivedAt as observedAt', () => {
      const raw = makeRaw('SessionStart');
      const result = normalizeCodexHook(raw);

      expect(result!.payload.observedAt).toBe(raw.receivedAt);
    });
  });

  describe('metadata pass-through', () => {
    it('forwards bridge metadata when present', () => {
      const metadata = { pid: 42_000, invocationId: 'inv-1' };
      const result = normalizeCodexHook(makeRaw('SessionStart', {}, metadata));

      expect(result!.payload.metadata).toEqual(metadata);
    });

    it('passes through undefined metadata when absent', () => {
      const result = normalizeCodexHook(makeRaw('SessionStart', {}));

      expect(result!.payload.metadata).toBeUndefined();
    });
  });

  describe('session identifier flow', () => {
    it('extracts session_id as adapterSessionId', () => {
      const result = normalizeCodexHook(makeRaw('SessionStart', { session_id: 'sess-abc' }));

      expect(result!.payload.adapterSessionId).toBe('sess-abc');
    });

    it('falls back to thread_id when session_id is absent', () => {
      const result = normalizeCodexHook(makeRaw('Stop', { thread_id: 'thread-xyz' }));

      expect(result!.payload.adapterSessionId).toBe('thread-xyz');
    });

    it('prefers session_id over thread_id when both are present', () => {
      const result = normalizeCodexHook(makeRaw('SessionStart', { session_id: 'sess-1', thread_id: 'thread-1' }));

      expect(result!.payload.adapterSessionId).toBe('sess-1');
    });

    it('leaves adapterSessionId undefined when neither field is present', () => {
      const result = normalizeCodexHook(makeRaw('SessionStart', {}));

      expect(result!.payload.adapterSessionId).toBeUndefined();
    });

    it('treats empty-string session_id as absent', () => {
      const result = normalizeCodexHook(makeRaw('SessionStart', { session_id: '' }));

      expect(result!.payload.adapterSessionId).toBeUndefined();
    });

    it('falls back to thread_id when session_id is an empty string', () => {
      const result = normalizeCodexHook(makeRaw('SessionStart', { session_id: '', thread_id: 'thread-xyz' }));

      expect(result!.payload.adapterSessionId).toBe('thread-xyz');
    });

    it('treats empty-string thread_id as absent', () => {
      const result = normalizeCodexHook(makeRaw('SessionStart', { thread_id: '' }));

      expect(result!.payload.adapterSessionId).toBeUndefined();
    });
  });

  describe('UserPromptSubmit — prompt extraction', () => {
    it('extracts prompt text from payload', () => {
      const result = normalizeCodexHook(makeRaw('UserPromptSubmit', { prompt: 'Write a fizzbuzz function' }));

      expect(result!.payload).toMatchObject({ prompt: 'Write a fizzbuzz function' });
    });

    it('leaves prompt undefined when absent', () => {
      const result = normalizeCodexHook(makeRaw('UserPromptSubmit', {}));

      expect((result!.payload as { prompt?: string }).prompt).toBeUndefined();
    });

    it('treats empty string prompt as absent', () => {
      const result = normalizeCodexHook(makeRaw('UserPromptSubmit', { prompt: '' }));

      expect((result!.payload as { prompt?: string }).prompt).toBeUndefined();
    });
  });

  describe('PreToolUse — tool fields', () => {
    it('extracts tool_name and call_id', () => {
      const result = normalizeCodexHook(makeRaw('PreToolUse', { tool_name: 'bash', call_id: 'call-123' }));

      expect(result!.payload).toMatchObject({ toolName: 'bash', toolCallId: 'call-123' });
    });

    it('leaves toolName and toolCallId undefined when absent', () => {
      const result = normalizeCodexHook(makeRaw('PreToolUse', {}));
      const payload = result!.payload as { toolName?: string; toolCallId?: string };

      expect(payload.toolName).toBeUndefined();
      expect(payload.toolCallId).toBeUndefined();
    });

    it('treats empty-string tool_name as absent', () => {
      const result = normalizeCodexHook(makeRaw('PreToolUse', { tool_name: '' }));
      const payload = result!.payload as { toolName?: string };

      expect(payload.toolName).toBeUndefined();
    });

    it('treats empty-string call_id as absent', () => {
      const result = normalizeCodexHook(makeRaw('PreToolUse', { call_id: '' }));
      const payload = result!.payload as { toolCallId?: string };

      expect(payload.toolCallId).toBeUndefined();
    });
  });

  describe('PostToolUse — tool fields + success', () => {
    it('extracts tool_name, call_id, and success flag', () => {
      const result = normalizeCodexHook(
        makeRaw('PostToolUse', { tool_name: 'bash', call_id: 'call-456', success: true }),
      );

      expect(result!.payload).toMatchObject({
        toolName: 'bash',
        toolCallId: 'call-456',
        success: true,
      });
    });

    it('extracts success: false correctly', () => {
      const result = normalizeCodexHook(makeRaw('PostToolUse', { tool_name: 'patch', success: false }));

      expect((result!.payload as { success?: boolean }).success).toBe(false);
    });

    it('leaves success undefined when absent', () => {
      const result = normalizeCodexHook(makeRaw('PostToolUse', {}));

      expect((result!.payload as { success?: boolean }).success).toBeUndefined();
    });

    it('treats empty-string tool_name as absent in PostToolUse', () => {
      const result = normalizeCodexHook(makeRaw('PostToolUse', { tool_name: '' }));
      const payload = result!.payload as { toolName?: string };

      expect(payload.toolName).toBeUndefined();
    });

    it('treats empty-string call_id as absent in PostToolUse', () => {
      const result = normalizeCodexHook(makeRaw('PostToolUse', { call_id: '' }));
      const payload = result!.payload as { toolCallId?: string };

      expect(payload.toolCallId).toBeUndefined();
    });
  });
});
