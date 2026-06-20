import { describe, expect, it } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import { createBusNamespace } from '@makaio/core';
import { AgentSubjects } from '@makaio/contracts';
import { z } from 'zod';
import { createToolApprovalHandler, mergeScopedToolApproval, resolveRequiredSessionId } from '../tool-approval.js';
import type { ScopedToolApprovalRequest } from '../tool-approval.js';
import type { AIAgentConnector } from '../../connector/index.js';

/**
 * Full scoped payload used as a baseline across identity-field tests.
 * All identity fields are present so tests can selectively drop them from context.
 */
const BASE_PAYLOAD: ScopedToolApprovalRequest = {
  adapterId: 'payload-adapter',
  adapterName: 'openai-node',
  adapterSessionId: 'payload-adapter-session',
  agentId: 'payload-agent',
  sessionId: 'payload-makaio-session',
  toolCallId: 'tool-1',
  toolName: 'bash',
  args: { command: 'pwd' },
};

describe('resolveRequiredSessionId', () => {
  it('fails closed when only the scoped payload provides a sessionId', () => {
    expect(() => resolveRequiredSessionId(undefined, 'payload-session', 'test-adapter')).toThrow(
      '[test-adapter] toGlobalToolApproval: sessionId must come from tool approval context',
    );
  });

  it('allows trusted payload fallback only when explicitly enabled', () => {
    expect(resolveRequiredSessionId(undefined, 'payload-session', 'test-adapter', true)).toBe('payload-session');
  });
});

describe('mergeScopedToolApproval', () => {
  it('requires context sessionId by default while still allowing other context overrides', () => {
    expect(() =>
      mergeScopedToolApproval(
        BASE_PAYLOAD,
        {
          agentId: 'context-agent',
          adapterId: 'context-adapter',
          adapterName: 'context-name',
          adapterSessionId: 'context-adapter-session',
          // sessionId intentionally omitted
        },
        'openai-node',
      ),
    ).toThrow('[openai-node] toGlobalToolApproval: sessionId must come from tool approval context');
  });

  it('accepts payload sessionId only for trusted direct-call sites', () => {
    expect(
      mergeScopedToolApproval(
        BASE_PAYLOAD,
        {
          agentId: 'context-agent',
          adapterId: 'context-adapter',
          adapterName: 'context-name',
          adapterSessionId: 'context-adapter-session',
        },
        'openai-node',
        { allowPayloadSessionFallback: true },
      ),
    ).toMatchObject({
      agentId: 'context-agent',
      sessionId: 'payload-makaio-session',
    });
  });

  it('throws on missing agentId when context omits it and allowPayloadIdentityFallback is false', () => {
    expect(() =>
      mergeScopedToolApproval(
        BASE_PAYLOAD,
        {
          sessionId: 'context-session',
          adapterId: 'context-adapter',
          adapterName: 'context-name',
          adapterSessionId: 'context-adapter-session',
          // agentId intentionally omitted
        },
        'test-adapter',
      ),
    ).toThrow('[test-adapter] toGlobalToolApproval: agentId must come from tool approval context');
  });

  it('throws on missing adapterId when context omits it and allowPayloadIdentityFallback is false', () => {
    expect(() =>
      mergeScopedToolApproval(
        BASE_PAYLOAD,
        {
          sessionId: 'context-session',
          agentId: 'context-agent',
          adapterName: 'context-name',
          adapterSessionId: 'context-adapter-session',
          // adapterId intentionally omitted
        },
        'test-adapter',
      ),
    ).toThrow('[test-adapter] toGlobalToolApproval: adapterId must come from tool approval context');
  });

  it('throws on missing adapterName when context omits it and allowPayloadIdentityFallback is false', () => {
    expect(() =>
      mergeScopedToolApproval(
        BASE_PAYLOAD,
        {
          sessionId: 'context-session',
          agentId: 'context-agent',
          adapterId: 'context-adapter',
          adapterSessionId: 'context-adapter-session',
          // adapterName intentionally omitted
        },
        'test-adapter',
      ),
    ).toThrow('[test-adapter] toGlobalToolApproval: adapterName must come from tool approval context');
  });

  it('throws on missing adapterSessionId when context omits it and allowPayloadIdentityFallback is false', () => {
    expect(() =>
      mergeScopedToolApproval(
        BASE_PAYLOAD,
        {
          sessionId: 'context-session',
          agentId: 'context-agent',
          adapterId: 'context-adapter',
          adapterName: 'context-name',
          // adapterSessionId intentionally omitted
        },
        'test-adapter',
      ),
    ).toThrow('[test-adapter] toGlobalToolApproval: adapterSessionId must come from tool approval context');
  });

  it('throws when allowPayloadIdentityFallback is true and context supplies only some identity fields', () => {
    // Supplying agentId but omitting the other three produces a partial context (presentCount = 1),
    // which violates the atomicity invariant — mixed-source identity tuples are not permitted.
    expect(() =>
      mergeScopedToolApproval(
        BASE_PAYLOAD,
        {
          sessionId: 'context-session',
          agentId: 'test-agent',
          // adapterId, adapterName, adapterSessionId intentionally omitted
        },
        'test-adapter',
        { allowPayloadIdentityFallback: true },
      ),
    ).toThrow('context must supply all four identity fields');
  });

  it('uses payload identity fields when allowPayloadIdentityFallback is true and context omits them', () => {
    const result = mergeScopedToolApproval(BASE_PAYLOAD, { sessionId: 'context-session' }, 'test-adapter', {
      allowPayloadIdentityFallback: true,
    });
    expect(result).toMatchObject({
      sessionId: 'context-session',
      agentId: 'payload-agent',
      adapterId: 'payload-adapter',
      adapterName: 'openai-node',
      adapterSessionId: 'payload-adapter-session',
    });
  });

  it('prefers context identity fields over payload when both are present', () => {
    const result = mergeScopedToolApproval(
      BASE_PAYLOAD,
      {
        sessionId: 'context-session',
        agentId: 'context-agent',
        adapterId: 'context-adapter',
        adapterName: 'context-name',
        adapterSessionId: 'context-adapter-session',
      },
      'test-adapter',
      { allowPayloadIdentityFallback: true },
    );
    expect(result).toMatchObject({
      sessionId: 'context-session',
      agentId: 'context-agent',
      adapterId: 'context-adapter',
      adapterName: 'context-name',
      adapterSessionId: 'context-adapter-session',
    });
  });
});

describe('createToolApprovalHandler', () => {
  it('forwards approval requests through the injected global bus', async () => {
    const hostBus = createBusInstance();
    const approvalNamespace = hostBus.registerNamespace(
      createBusNamespace('adapter:test-approval', {
        'tool.approval': {
          request: z.object({ toolName: z.string() }),
          response: z.object({ action: z.literal('allow') }),
        },
      }),
    );
    const connectorBus = hostBus.scoped(approvalNamespace);
    const subject = approvalNamespace.subjects.tool.approval;

    let receivedToolName: string | undefined;
    hostBus.on(AgentSubjects.toolApprove, (ctx) => {
      receivedToolName = ctx.payload.toolName;
      ctx.setResult({ action: 'allow' });
    });

    const cleanup = createToolApprovalHandler(
      subject,
      (payload: { toolName: string }, _context: Record<string, never>) => ({
        adapterId: 'adapter-1',
        adapterName: 'test-adapter',
        adapterSessionId: 'adapter-session-1',
        agentId: 'agent-1',
        sessionId: 'session-1',
        toolCallId: 'tool-call-1',
        toolName: payload.toolName,
        args: {},
      }),
      (response) => response,
    )(connectorBus as unknown as Pick<AIAgentConnector, 'on'>, {}, hostBus);

    try {
      await expect(connectorBus.request(subject, { toolName: 'search_symbols' })).resolves.toEqual({ action: 'allow' });
      expect(receivedToolName).toBe('search_symbols');
    } finally {
      cleanup();
    }
  });
});
