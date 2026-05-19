import { describe, expect, it } from 'bun:test';
import { ClientSubjects } from '@makaio/clients-core';
import { normalizeClaudeCodeHook } from '../hook-normalizer.js';
import type { ClaudeCodeNormalizedEvent } from '../hook-normalizer.js';
import type { RawClientHookPayload } from '@makaio/clients-core';
import {
  CLAUDE_CODE_HOOK_SESSION_START,
  CLAUDE_CODE_HOOK_USER_PROMPT_SUBMIT,
  CLAUDE_CODE_HOOK_PRE_TOOL_USE,
  CLAUDE_CODE_HOOK_POST_TOOL_USE,
  CLAUDE_CODE_HOOK_STOP,
  CLAUDE_CODE_HOOK_SUBAGENT_STOP,
  CLAUDE_CODE_HOOK_NOTIFICATION,
  CLAUDE_CODE_HOOK_MCP_SERVER_START,
} from '../schemas.js';

const RECEIVED_AT = 1_713_795_200_000;
const SESSION_ID = 'sess-abc123';

/**
 * Build a minimal raw hook payload for test scenarios.
 * @param eventName - Claude Code hook event name
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
    receivedAt: RECEIVED_AT,
    payload,
    metadata,
  };
}

describe('normalizeClaudeCodeHook', () => {
  describe('SessionStart', () => {
    it('normalizes to client.session.started with base fields', () => {
      const result = normalizeClaudeCodeHook(makeRaw(CLAUDE_CODE_HOOK_SESSION_START, { session_id: SESSION_ID }));

      expect(result).not.toBeNull();
      expect(result!.subject).toBe(ClientSubjects.session.started);
      expect(result!.payload.clientId).toBe('claude-code');
      expect(result!.payload.source).toBe('native-hook');
      expect(result!.payload.observedAt).toBe(RECEIVED_AT);
      expect(result!.payload.adapterSessionId).toBe(SESSION_ID);
    });

    it('leaves adapterSessionId undefined when session_id is absent', () => {
      const result = normalizeClaudeCodeHook(makeRaw(CLAUDE_CODE_HOOK_SESSION_START));

      expect(result).not.toBeNull();
      expect(result!.subject).toBe(ClientSubjects.session.started);
      expect(result!.payload.adapterSessionId).toBeUndefined();
    });
  });

  describe('UserPromptSubmit', () => {
    it('normalizes to client.session.userPrompt.submitted with prompt text', () => {
      const result = normalizeClaudeCodeHook(
        makeRaw(CLAUDE_CODE_HOOK_USER_PROMPT_SUBMIT, {
          session_id: SESSION_ID,
          prompt: 'What is the meaning of life?',
        }),
      );

      expect(result).not.toBeNull();
      expect(result!.subject).toBe(ClientSubjects.session.userPrompt.submitted);
      expect(result!.payload.adapterSessionId).toBe(SESSION_ID);
      expect((result!.payload as { prompt?: string }).prompt).toBe('What is the meaning of life?');
    });

    it('leaves prompt undefined when absent from payload', () => {
      const result = normalizeClaudeCodeHook(makeRaw(CLAUDE_CODE_HOOK_USER_PROMPT_SUBMIT, { session_id: SESSION_ID }));

      expect(result).not.toBeNull();
      expect(result!.subject).toBe(ClientSubjects.session.userPrompt.submitted);
      expect((result!.payload as { prompt?: string }).prompt).toBeUndefined();
    });
  });

  describe('PreToolUse', () => {
    it('normalizes to client.session.tool.pre with tool name and call ID', () => {
      const result = normalizeClaudeCodeHook(
        makeRaw(CLAUDE_CODE_HOOK_PRE_TOOL_USE, { session_id: SESSION_ID, tool_name: 'bash', tool_use_id: 'tu-001' }),
      );

      expect(result).not.toBeNull();
      expect(result!.subject).toBe(ClientSubjects.session.tool.pre);
      expect(result!.payload).toMatchObject({ toolName: 'bash', toolCallId: 'tu-001' });
    });

    it('leaves toolName and toolCallId undefined when absent', () => {
      const result = normalizeClaudeCodeHook(makeRaw(CLAUDE_CODE_HOOK_PRE_TOOL_USE, { session_id: SESSION_ID }));

      expect(result).not.toBeNull();
      expect(result!.subject).toBe(ClientSubjects.session.tool.pre);
      const prePre = (result as Extract<ClaudeCodeNormalizedEvent, { subject: typeof ClientSubjects.session.tool.pre }>)
        .payload;
      expect(prePre.toolName).toBeUndefined();
      expect(prePre.toolCallId).toBeUndefined();
    });
  });

  describe('PostToolUse', () => {
    it('normalizes to client.session.tool.post with success=true when exit_code is 0', () => {
      const result = normalizeClaudeCodeHook(
        makeRaw(CLAUDE_CODE_HOOK_POST_TOOL_USE, {
          session_id: SESSION_ID,
          tool_name: 'bash',
          tool_use_id: 'tu-001',
          exit_code: 0,
        }),
      );

      expect(result).not.toBeNull();
      expect(result!.subject).toBe(ClientSubjects.session.tool.post);
      const postPayload = (
        result as Extract<ClaudeCodeNormalizedEvent, { subject: typeof ClientSubjects.session.tool.post }>
      ).payload;
      expect(postPayload.toolName).toBe('bash');
      expect(postPayload.toolCallId).toBe('tu-001');
      expect(postPayload.success).toBe(true);
    });

    it('normalizes to client.session.tool.post with success=false when exit_code is non-zero', () => {
      const result = normalizeClaudeCodeHook(
        makeRaw(CLAUDE_CODE_HOOK_POST_TOOL_USE, { session_id: SESSION_ID, tool_name: 'bash', exit_code: 1 }),
      );

      expect(result).not.toBeNull();
      const postPayload = (
        result as Extract<ClaudeCodeNormalizedEvent, { subject: typeof ClientSubjects.session.tool.post }>
      ).payload;
      expect(postPayload.success).toBe(false);
    });

    it('leaves success undefined when exit_code is absent', () => {
      const result = normalizeClaudeCodeHook(
        makeRaw(CLAUDE_CODE_HOOK_POST_TOOL_USE, { session_id: SESSION_ID, tool_name: 'bash' }),
      );

      expect(result).not.toBeNull();
      const postPayload = (
        result as Extract<ClaudeCodeNormalizedEvent, { subject: typeof ClientSubjects.session.tool.post }>
      ).payload;
      expect(postPayload.success).toBeUndefined();
    });
  });

  describe('Stop', () => {
    it('normalizes Stop to client.session.turn.completed', () => {
      const result = normalizeClaudeCodeHook(makeRaw(CLAUDE_CODE_HOOK_STOP, { session_id: SESSION_ID }));

      expect(result).not.toBeNull();
      expect(result!.subject).toBe(ClientSubjects.session.turn.completed);
      expect(result!.payload.adapterSessionId).toBe(SESSION_ID);
    });
  });

  describe('SubagentStop', () => {
    it('returns null for SubagentStop (subagent lifecycle — raw space only)', () => {
      const result = normalizeClaudeCodeHook(makeRaw(CLAUDE_CODE_HOOK_SUBAGENT_STOP, { session_id: SESSION_ID }));

      expect(result).toBeNull();
    });
  });

  describe('Claude-specific raw events', () => {
    it('returns null for Notification', () => {
      const result = normalizeClaudeCodeHook(
        makeRaw(CLAUDE_CODE_HOOK_NOTIFICATION, { session_id: SESSION_ID, message: 'Task complete' }),
      );

      expect(result).toBeNull();
    });

    it('returns null for MCPServerStart', () => {
      const result = normalizeClaudeCodeHook(makeRaw(CLAUDE_CODE_HOOK_MCP_SERVER_START, { server: 'my-mcp' }));

      expect(result).toBeNull();
    });

    it('returns null for unknown events', () => {
      const result = normalizeClaudeCodeHook(makeRaw('SomeFutureEvent', { data: 'x' }));

      expect(result).toBeNull();
    });
  });

  describe('common base field population', () => {
    it('populates clientId, source, and observedAt on every normalizable event', () => {
      const events = [
        CLAUDE_CODE_HOOK_SESSION_START,
        CLAUDE_CODE_HOOK_USER_PROMPT_SUBMIT,
        CLAUDE_CODE_HOOK_PRE_TOOL_USE,
        CLAUDE_CODE_HOOK_POST_TOOL_USE,
        CLAUDE_CODE_HOOK_STOP,
      ];

      for (const eventName of events) {
        const result = normalizeClaudeCodeHook(makeRaw(eventName));
        expect(result, `${eventName} should normalize`).not.toBeNull();
        expect(result!.payload.clientId).toBe('claude-code');
        expect(result!.payload.source).toBe('native-hook');
        expect(result!.payload.observedAt).toBe(RECEIVED_AT);
      }
    });

    it('forwards bridge metadata when present', () => {
      const metadata = { pid: 12_345, invocationId: 'inv-claude' };
      const result = normalizeClaudeCodeHook(
        makeRaw(CLAUDE_CODE_HOOK_SESSION_START, { session_id: SESSION_ID }, metadata),
      );

      expect(result).not.toBeNull();
      expect(result!.payload.metadata).toEqual(metadata);
    });
  });
});
