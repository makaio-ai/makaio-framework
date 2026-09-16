import { describe, expect, it } from 'vitest';
import { ClientSubjects } from '@makaio/subsystem-client';
import { normalizeClaudeCodeHook } from '../hook-normalizer.js';
import type { ClaudeCodeNormalizedEvent } from '../hook-normalizer.js';
import type { RawClientHookPayload } from '@makaio/subsystem-client';
import {
  CLAUDE_CODE_HOOK_SESSION_START,
  CLAUDE_CODE_HOOK_USER_PROMPT_SUBMIT,
  CLAUDE_CODE_HOOK_PRE_TOOL_USE,
  CLAUDE_CODE_HOOK_POST_TOOL_USE,
  CLAUDE_CODE_HOOK_STOP,
  CLAUDE_CODE_HOOK_SUBAGENT_START,
  CLAUDE_CODE_HOOK_SUBAGENT_STOP,
  CLAUDE_CODE_HOOK_PRE_COMPACT,
  CLAUDE_CODE_HOOK_NOTIFICATION,
  CLAUDE_CODE_HOOK_MCP_SERVER_START,
} from '../schemas.js';

const RECEIVED_AT = 1_713_795_200_000;
const SESSION_ID = 'sess-abc123';
const TRANSCRIPT_PATH = '/home/user/.claude/projects/demo/sess-abc123.jsonl';
const CWD = '/home/user/projects/demo';

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

/**
 * Assert that the normalizer produced exactly one event and return it.
 * @param results - Array returned by `normalizeClaudeCodeHook`
 * @returns The single normalized event
 */
function expectSingle(results: ClaudeCodeNormalizedEvent[]): ClaudeCodeNormalizedEvent {
  expect(results).toHaveLength(1);
  return results[0]!;
}

describe('normalizeClaudeCodeHook', () => {
  describe('SessionStart', () => {
    it('normalizes to client.session.started with base fields', () => {
      const result = expectSingle(
        normalizeClaudeCodeHook(makeRaw(CLAUDE_CODE_HOOK_SESSION_START, { session_id: SESSION_ID })),
      );

      expect(result.subject).toBe(ClientSubjects.session.started);
      expect(result.payload.clientId).toBe('claude-code');
      expect(result.payload.source).toBe('native-hook');
      expect(result.payload.observedAt).toBe(RECEIVED_AT);
      expect(result.payload.adapterSessionId).toBe(SESSION_ID);
    });

    it('leaves adapterSessionId undefined when session_id is absent', () => {
      const result = expectSingle(normalizeClaudeCodeHook(makeRaw(CLAUDE_CODE_HOOK_SESSION_START)));

      expect(result.subject).toBe(ClientSubjects.session.started);
      expect(result.payload.adapterSessionId).toBeUndefined();
    });

    it('extracts transcriptPath and cwd from the hook payload', () => {
      const result = expectSingle(
        normalizeClaudeCodeHook(
          makeRaw(CLAUDE_CODE_HOOK_SESSION_START, {
            session_id: SESSION_ID,
            transcript_path: TRANSCRIPT_PATH,
            cwd: CWD,
          }),
        ),
      );

      expect(result.subject).toBe(ClientSubjects.session.started);
      const payload = (result as Extract<ClaudeCodeNormalizedEvent, { subject: typeof ClientSubjects.session.started }>)
        .payload;
      expect(payload.transcriptPath).toBe(TRANSCRIPT_PATH);
      expect(payload.cwd).toBe(CWD);
    });

    it('omits transcriptPath and cwd entirely when absent from the payload', () => {
      const result = expectSingle(
        normalizeClaudeCodeHook(makeRaw(CLAUDE_CODE_HOOK_SESSION_START, { session_id: SESSION_ID })),
      );

      // Exact-optional: the keys must be absent, not present with undefined values.
      expect(Object.keys(result.payload)).not.toContain('transcriptPath');
      expect(Object.keys(result.payload)).not.toContain('cwd');
    });

    it('maps source:"startup" to startMode:"fresh"', () => {
      const result = expectSingle(
        normalizeClaudeCodeHook(makeRaw(CLAUDE_CODE_HOOK_SESSION_START, { session_id: SESSION_ID, source: 'startup' })),
      );

      const payload = (result as Extract<ClaudeCodeNormalizedEvent, { subject: typeof ClientSubjects.session.started }>)
        .payload;
      expect(payload.startMode).toBe('fresh');
    });

    it('maps source:"resume" to startMode:"resume"', () => {
      const result = expectSingle(
        normalizeClaudeCodeHook(makeRaw(CLAUDE_CODE_HOOK_SESSION_START, { session_id: SESSION_ID, source: 'resume' })),
      );

      const payload = (result as Extract<ClaudeCodeNormalizedEvent, { subject: typeof ClientSubjects.session.started }>)
        .payload;
      expect(payload.startMode).toBe('resume');
    });

    it('maps source:"clear" to startMode:"clear"', () => {
      const result = expectSingle(
        normalizeClaudeCodeHook(makeRaw(CLAUDE_CODE_HOOK_SESSION_START, { session_id: SESSION_ID, source: 'clear' })),
      );

      const payload = (result as Extract<ClaudeCodeNormalizedEvent, { subject: typeof ClientSubjects.session.started }>)
        .payload;
      expect(payload.startMode).toBe('clear');
    });

    it('maps source:"compact" to startMode:"compact"', () => {
      const result = expectSingle(
        normalizeClaudeCodeHook(makeRaw(CLAUDE_CODE_HOOK_SESSION_START, { session_id: SESSION_ID, source: 'compact' })),
      );

      const payload = (result as Extract<ClaudeCodeNormalizedEvent, { subject: typeof ClientSubjects.session.started }>)
        .payload;
      expect(payload.startMode).toBe('compact');
    });

    it('omits startMode when source is absent', () => {
      const result = expectSingle(
        normalizeClaudeCodeHook(makeRaw(CLAUDE_CODE_HOOK_SESSION_START, { session_id: SESSION_ID })),
      );

      expect(Object.keys(result.payload)).not.toContain('startMode');
    });

    it('omits startMode for unknown source values (forward-compatible)', () => {
      const result = expectSingle(
        normalizeClaudeCodeHook(
          makeRaw(CLAUDE_CODE_HOOK_SESSION_START, { session_id: SESSION_ID, source: 'future-value' }),
        ),
      );

      expect(Object.keys(result.payload)).not.toContain('startMode');
    });

    it('omits startMode when source is non-string', () => {
      const result = expectSingle(
        normalizeClaudeCodeHook(makeRaw(CLAUDE_CODE_HOOK_SESSION_START, { session_id: SESSION_ID, source: 42 })),
      );

      expect(Object.keys(result.payload)).not.toContain('startMode');
    });
  });

  describe('UserPromptSubmit', () => {
    it('yields exactly [turn.started, userPrompt.submitted] in that order', () => {
      const results = normalizeClaudeCodeHook(
        makeRaw(CLAUDE_CODE_HOOK_USER_PROMPT_SUBMIT, {
          session_id: SESSION_ID,
          prompt: 'What is the meaning of life?',
        }),
      );

      expect(results).toHaveLength(2);
      expect(results[0]!.subject).toBe(ClientSubjects.session.turn.started);
      expect(results[1]!.subject).toBe(ClientSubjects.session.userPrompt.submitted);

      for (const result of results) {
        expect(result.payload.clientId).toBe('claude-code');
        expect(result.payload.adapterSessionId).toBe(SESSION_ID);
      }
      expect((results[1]!.payload as { prompt?: string }).prompt).toBe('What is the meaning of life?');
    });

    it('leaves prompt undefined when absent from payload', () => {
      const results = normalizeClaudeCodeHook(makeRaw(CLAUDE_CODE_HOOK_USER_PROMPT_SUBMIT, { session_id: SESSION_ID }));

      expect(results).toHaveLength(2);
      expect(results[1]!.subject).toBe(ClientSubjects.session.userPrompt.submitted);
      expect((results[1]!.payload as { prompt?: string }).prompt).toBeUndefined();
    });
  });

  describe('PreToolUse', () => {
    it('normalizes to client.session.tool.pre with tool name and call ID', () => {
      const result = expectSingle(
        normalizeClaudeCodeHook(
          makeRaw(CLAUDE_CODE_HOOK_PRE_TOOL_USE, { session_id: SESSION_ID, tool_name: 'bash', tool_use_id: 'tu-001' }),
        ),
      );

      expect(result.subject).toBe(ClientSubjects.session.tool.pre);
      expect(result.payload).toMatchObject({ toolName: 'bash', toolCallId: 'tu-001' });
    });

    it('leaves toolName and toolCallId undefined when absent', () => {
      const result = expectSingle(
        normalizeClaudeCodeHook(makeRaw(CLAUDE_CODE_HOOK_PRE_TOOL_USE, { session_id: SESSION_ID })),
      );

      expect(result.subject).toBe(ClientSubjects.session.tool.pre);
      const prePayload = (
        result as Extract<ClaudeCodeNormalizedEvent, { subject: typeof ClientSubjects.session.tool.pre }>
      ).payload;
      expect(prePayload.toolName).toBeUndefined();
      expect(prePayload.toolCallId).toBeUndefined();
    });
  });

  describe('PostToolUse', () => {
    it('normalizes to client.session.tool.post with success=true when exit_code is 0', () => {
      const result = expectSingle(
        normalizeClaudeCodeHook(
          makeRaw(CLAUDE_CODE_HOOK_POST_TOOL_USE, {
            session_id: SESSION_ID,
            tool_name: 'bash',
            tool_use_id: 'tu-001',
            exit_code: 0,
          }),
        ),
      );

      expect(result.subject).toBe(ClientSubjects.session.tool.post);
      const postPayload = (
        result as Extract<ClaudeCodeNormalizedEvent, { subject: typeof ClientSubjects.session.tool.post }>
      ).payload;
      expect(postPayload.toolName).toBe('bash');
      expect(postPayload.toolCallId).toBe('tu-001');
      expect(postPayload.success).toBe(true);
    });

    it('normalizes to client.session.tool.post with success=false when exit_code is non-zero', () => {
      const result = expectSingle(
        normalizeClaudeCodeHook(
          makeRaw(CLAUDE_CODE_HOOK_POST_TOOL_USE, { session_id: SESSION_ID, tool_name: 'bash', exit_code: 1 }),
        ),
      );

      const postPayload = (
        result as Extract<ClaudeCodeNormalizedEvent, { subject: typeof ClientSubjects.session.tool.post }>
      ).payload;
      expect(postPayload.success).toBe(false);
    });

    it('leaves success undefined when exit_code is absent', () => {
      const result = expectSingle(
        normalizeClaudeCodeHook(makeRaw(CLAUDE_CODE_HOOK_POST_TOOL_USE, { session_id: SESSION_ID, tool_name: 'bash' })),
      );

      const postPayload = (
        result as Extract<ClaudeCodeNormalizedEvent, { subject: typeof ClientSubjects.session.tool.post }>
      ).payload;
      expect(postPayload.success).toBeUndefined();
    });
  });

  describe('Stop', () => {
    it('normalizes Stop to client.session.turn.completed', () => {
      const result = expectSingle(normalizeClaudeCodeHook(makeRaw(CLAUDE_CODE_HOOK_STOP, { session_id: SESSION_ID })));

      expect(result.subject).toBe(ClientSubjects.session.turn.completed);
      expect(result.payload.adapterSessionId).toBe(SESSION_ID);
    });

    it('carries transcriptPath when transcript_path is present', () => {
      const result = expectSingle(
        normalizeClaudeCodeHook(
          makeRaw(CLAUDE_CODE_HOOK_STOP, { session_id: SESSION_ID, transcript_path: TRANSCRIPT_PATH }),
        ),
      );

      expect(result.subject).toBe(ClientSubjects.session.turn.completed);
      const payload = (
        result as Extract<ClaudeCodeNormalizedEvent, { subject: typeof ClientSubjects.session.turn.completed }>
      ).payload;
      expect(payload.transcriptPath).toBe(TRANSCRIPT_PATH);
    });

    it('omits transcriptPath entirely when transcript_path is absent', () => {
      const result = expectSingle(normalizeClaudeCodeHook(makeRaw(CLAUDE_CODE_HOOK_STOP, { session_id: SESSION_ID })));

      // Exact-optional: the key must be absent, not present with an undefined value.
      expect(Object.keys(result.payload)).not.toContain('transcriptPath');
    });

    it('omits transcriptPath when transcript_path is an empty string', () => {
      const result = expectSingle(
        normalizeClaudeCodeHook(makeRaw(CLAUDE_CODE_HOOK_STOP, { session_id: SESSION_ID, transcript_path: '' })),
      );

      expect(Object.keys(result.payload)).not.toContain('transcriptPath');
    });
  });

  describe('SubagentStart', () => {
    it('normalizes to client.session.subagent.started with agentId and adapterSessionId', () => {
      const result = expectSingle(
        normalizeClaudeCodeHook(
          makeRaw(CLAUDE_CODE_HOOK_SUBAGENT_START, {
            session_id: SESSION_ID,
            agent_id: 'agent-001',
            agent_type: 'coding',
          }),
        ),
      );

      expect(result.subject).toBe(ClientSubjects.session.subagent.started);
      const payload = (
        result as Extract<ClaudeCodeNormalizedEvent, { subject: typeof ClientSubjects.session.subagent.started }>
      ).payload;
      expect(payload.clientId).toBe('claude-code');
      expect(payload.source).toBe('native-hook');
      expect(payload.observedAt).toBe(RECEIVED_AT);
      expect(payload.agentId).toBe('agent-001');
      expect(payload.agentType).toBe('coding');
      expect(payload.adapterSessionId).toBe(SESSION_ID);
    });

    it('carries adapterSessionId as the parent session id', () => {
      const result = expectSingle(
        normalizeClaudeCodeHook(
          makeRaw(CLAUDE_CODE_HOOK_SUBAGENT_START, { session_id: SESSION_ID, agent_id: 'agent-001' }),
        ),
      );

      expect(result.payload.adapterSessionId).toBe(SESSION_ID);
    });

    it('omits agentType when absent from payload', () => {
      const result = expectSingle(
        normalizeClaudeCodeHook(
          makeRaw(CLAUDE_CODE_HOOK_SUBAGENT_START, { session_id: SESSION_ID, agent_id: 'agent-001' }),
        ),
      );

      expect(Object.keys(result.payload)).not.toContain('agentType');
    });

    it('returns an empty array when agent_id is absent', () => {
      const results = normalizeClaudeCodeHook(makeRaw(CLAUDE_CODE_HOOK_SUBAGENT_START, { session_id: SESSION_ID }));

      expect(results).toEqual([]);
    });
  });

  describe('SubagentStop', () => {
    it('normalizes to client.session.subagent.completed with agentId and agentTranscriptPath', () => {
      const result = expectSingle(
        normalizeClaudeCodeHook(
          makeRaw(CLAUDE_CODE_HOOK_SUBAGENT_STOP, {
            session_id: SESSION_ID,
            agent_id: 'agent-001',
            agent_type: 'coding',
            agent_transcript_path: '/home/.claude/agents/agent-001.jsonl',
          }),
        ),
      );

      expect(result.subject).toBe(ClientSubjects.session.subagent.completed);
      const payload = (
        result as Extract<ClaudeCodeNormalizedEvent, { subject: typeof ClientSubjects.session.subagent.completed }>
      ).payload;
      expect(payload.agentId).toBe('agent-001');
      expect(payload.agentType).toBe('coding');
      expect(payload.adapterSessionId).toBe(SESSION_ID);
      expect(payload.agentTranscriptPath).toBe('/home/.claude/agents/agent-001.jsonl');
    });

    it('omits agentTranscriptPath when agent_transcript_path is absent', () => {
      const result = expectSingle(
        normalizeClaudeCodeHook(
          makeRaw(CLAUDE_CODE_HOOK_SUBAGENT_STOP, { session_id: SESSION_ID, agent_id: 'agent-001' }),
        ),
      );

      expect(Object.keys(result.payload)).not.toContain('agentTranscriptPath');
    });

    it('returns an empty array when agent_id is absent', () => {
      const results = normalizeClaudeCodeHook(makeRaw(CLAUDE_CODE_HOOK_SUBAGENT_STOP, { session_id: SESSION_ID }));

      expect(results).toEqual([]);
    });
  });

  describe('PreCompact', () => {
    it('normalizes to client.session.compaction.pre with trigger and transcriptPath', () => {
      const result = expectSingle(
        normalizeClaudeCodeHook(
          makeRaw(CLAUDE_CODE_HOOK_PRE_COMPACT, {
            session_id: SESSION_ID,
            trigger: 'manual',
            transcript_path: TRANSCRIPT_PATH,
          }),
        ),
      );

      expect(result.subject).toBe(ClientSubjects.session.compaction.pre);
      const payload = (
        result as Extract<ClaudeCodeNormalizedEvent, { subject: typeof ClientSubjects.session.compaction.pre }>
      ).payload;
      expect(payload.clientId).toBe('claude-code');
      expect(payload.adapterSessionId).toBe(SESSION_ID);
      expect(payload.trigger).toBe('manual');
      expect(payload.transcriptPath).toBe(TRANSCRIPT_PATH);
    });

    it('maps trigger:"auto" correctly', () => {
      const result = expectSingle(
        normalizeClaudeCodeHook(makeRaw(CLAUDE_CODE_HOOK_PRE_COMPACT, { session_id: SESSION_ID, trigger: 'auto' })),
      );

      const payload = (
        result as Extract<ClaudeCodeNormalizedEvent, { subject: typeof ClientSubjects.session.compaction.pre }>
      ).payload;
      expect(payload.trigger).toBe('auto');
    });

    it('omits trigger when absent from payload', () => {
      const result = expectSingle(normalizeClaudeCodeHook(makeRaw(CLAUDE_CODE_HOOK_PRE_COMPACT, {})));

      expect(Object.keys(result.payload)).not.toContain('trigger');
    });

    it('omits trigger for unknown values (forward-compatible)', () => {
      const result = expectSingle(
        normalizeClaudeCodeHook(makeRaw(CLAUDE_CODE_HOOK_PRE_COMPACT, { trigger: 'future-value' })),
      );

      expect(Object.keys(result.payload)).not.toContain('trigger');
    });

    it('omits transcriptPath when absent from payload', () => {
      const result = expectSingle(
        normalizeClaudeCodeHook(makeRaw(CLAUDE_CODE_HOOK_PRE_COMPACT, { session_id: SESSION_ID })),
      );

      expect(Object.keys(result.payload)).not.toContain('transcriptPath');
    });
  });

  describe('Claude-specific raw events', () => {
    it('returns an empty array for Notification', () => {
      const results = normalizeClaudeCodeHook(
        makeRaw(CLAUDE_CODE_HOOK_NOTIFICATION, { session_id: SESSION_ID, message: 'Task complete' }),
      );

      expect(results).toEqual([]);
    });

    it('returns an empty array for MCPServerStart', () => {
      const results = normalizeClaudeCodeHook(makeRaw(CLAUDE_CODE_HOOK_MCP_SERVER_START, { server: 'my-mcp' }));

      expect(results).toEqual([]);
    });

    it('returns an empty array for unknown events', () => {
      const results = normalizeClaudeCodeHook(makeRaw('SomeFutureEvent', { data: 'x' }));

      expect(results).toEqual([]);
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
        const results = normalizeClaudeCodeHook(makeRaw(eventName));
        expect(results.length, `${eventName} should normalize`).toBeGreaterThan(0);
        for (const result of results) {
          expect(result.payload.clientId).toBe('claude-code');
          expect(result.payload.source).toBe('native-hook');
          expect(result.payload.observedAt).toBe(RECEIVED_AT);
        }
      }
    });

    it('forwards bridge metadata when present', () => {
      const metadata = { pid: 12_345, invocationId: 'inv-claude' };
      const result = expectSingle(
        normalizeClaudeCodeHook(makeRaw(CLAUDE_CODE_HOOK_SESSION_START, { session_id: SESSION_ID }, metadata)),
      );

      expect(result.payload.metadata).toEqual(metadata);
    });
  });
});
