/**
 * Tests for tool-handling utilities
 *
 * Verifies tool approval request/response transformations used by the
 * Qwen ACP adapter to bridge the scoped connector bus to the global
 * AgentSubjects.toolApprove bus.
 */

import { describe, it, expect } from 'bun:test';
import { toGlobalToolApproval, fromGlobalToolApproval, type ToolApprovalContext } from '../tool-handling.js';
import type { AgentToolApproveRequest, AgentToolApproveResponse } from '@makaio/contracts';
import type { ScopedToolApprovalRequest } from '@makaio/ai-adapters-core';

const mockContext: ToolApprovalContext = {
  adapterId: 'test-adapter-id',
  adapterName: 'qwen-acp',
  agentId: 'test-agent-id',
  sessionId: 'test-session-id',
  adapterSessionId: 'test-adapter-session-id',
};

/**
 * Minimal valid ScopedToolApprovalRequest with overrideable fields.
 * @param overrides - Fields to override on the base payload
 */
function makePayload(overrides: Partial<ScopedToolApprovalRequest> = {}): ScopedToolApprovalRequest {
  return {
    toolCallId: 'call-base',
    adapterId: 'payload-adapter',
    adapterName: 'payload-name',
    agentId: 'payload-agent',
    adapterSessionId: 'payload-session',
    ...overrides,
  };
}

describe('tool-handling', () => {
  describe('toGlobalToolApproval', () => {
    it('maps toolCallId, toolName, and args from the scoped payload', () => {
      const payload = makePayload({
        toolCallId: 'call-123',
        toolName: 'bash',
        args: { command: 'ls -la' },
      });

      const result = toGlobalToolApproval(payload, mockContext);

      expect(result.toolCallId).toBe('call-123');
      expect(result.toolName).toBe('bash');
      expect(result.args).toEqual({ command: 'ls -la' });
    });

    it('injects agent context fields (adapterId, adapterName, agentId, sessionId, adapterSessionId)', () => {
      const payload = makePayload({ toolCallId: 'call-456' });

      const result: AgentToolApproveRequest = toGlobalToolApproval(payload, mockContext);

      expect(result.adapterId).toBe(mockContext.adapterId);
      expect(result.adapterName).toBe(mockContext.adapterName);
      expect(result.agentId).toBe(mockContext.agentId);
      expect(result.sessionId).toBe(mockContext.sessionId);
      expect(result.adapterSessionId).toBe(mockContext.adapterSessionId);
    });

    it('context fields override payload identity fields', () => {
      const payload = makePayload({
        toolCallId: 'call-789',
        adapterId: 'payload-adapter',
        adapterName: 'payload-name',
        agentId: 'payload-agent',
        adapterSessionId: 'payload-session',
        sessionId: 'payload-session-id',
      });

      const result = toGlobalToolApproval(payload, mockContext);

      expect(result.adapterId).toBe(mockContext.adapterId);
      expect(result.adapterName).toBe(mockContext.adapterName);
      expect(result.agentId).toBe(mockContext.agentId);
      expect(result.adapterSessionId).toBe(mockContext.adapterSessionId);
      // sessionId comes from context per mergeScopedToolApproval contract
      expect(result.sessionId).toBe(mockContext.sessionId);
    });

    it('throws when context lacks sessionId and no payload fallback is allowed', () => {
      const payload = makePayload({ toolCallId: 'call-no-session', sessionId: 'payload-session' });
      // Construct a context that is missing sessionId at runtime to exercise the guard in
      // resolveRequiredSessionId. Object.assign is used so the typed variable keeps its
      // ToolApprovalContext shape while the property is overwritten to undefined at runtime.
      const contextWithoutSession: ToolApprovalContext = { ...mockContext };
      Object.assign(contextWithoutSession, { sessionId: undefined });

      expect(() => toGlobalToolApproval(payload, contextWithoutSession)).toThrow(/sessionId/);
    });

    it('includes optional reasoning field when present in payload', () => {
      const payload = makePayload({
        toolCallId: 'call-reasoning',
        reasoning: 'Model decided to run a command.',
      });

      const result = toGlobalToolApproval(payload, mockContext);

      expect(result.reasoning).toBe('Model decided to run a command.');
    });
  });

  describe('fromGlobalToolApproval', () => {
    it('returns the allow response unchanged (identity transformation)', () => {
      const response: AgentToolApproveResponse = { action: 'allow' };

      const result = fromGlobalToolApproval(response);

      expect(result).toBe(response);
    });

    it('returns an allow response with updatedPermissions unchanged', () => {
      const response: AgentToolApproveResponse = {
        action: 'allow',
        updatedPermissions: ['always-allow-bash'],
      };

      const result = fromGlobalToolApproval(response);

      expect(result).toBe(response);
      expect(result.action).toBe('allow');
    });

    it('returns a deny response unchanged (identity transformation)', () => {
      const response: AgentToolApproveResponse = {
        action: 'deny',
        message: 'Tool execution denied.',
        shouldAbort: false,
      };

      const result = fromGlobalToolApproval(response);

      expect(result).toBe(response);
      expect(result.action).toBe('deny');
    });

    it('preserves shouldAbort flag on deny response', () => {
      const response: AgentToolApproveResponse = {
        action: 'deny',
        message: 'Critical policy violation.',
        shouldAbort: true,
      };

      const result = fromGlobalToolApproval(response);

      expect(result).toEqual({ action: 'deny', message: 'Critical policy violation.', shouldAbort: true });
    });
  });
});
