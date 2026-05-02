/**
 * Tests for tool handling
 *
 * Tests tool approval request/response transformations.
 */

import { describe, it, expect } from 'vitest';
import {
  toGlobalToolApproval,
  toGlobalFileApproval,
  fromGlobalToolApproval,
  type ToolApprovalContext,
} from '../tool-handling.js';
import type { AgentToolApproveRequest, AgentToolApproveResponse } from '@makaio/contracts';

const mockContext: ToolApprovalContext = {
  adapterId: 'test-adapter',
  adapterName: 'codex-app-server',
  agentId: 'test-agent',
  adapterSessionId: 'test-thread-id',
  sessionId: 'test-session-id',
};

describe('tool-handling', () => {
  describe('toGlobalToolApproval', () => {
    it('should transform command execution approval request', () => {
      const params = {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-1',
        reason: 'Command requires network access',
        proposedExecpolicyAmendment: null,
      };

      const result = toGlobalToolApproval(params, mockContext);

      const expected: AgentToolApproveRequest = {
        adapterId: 'test-adapter',
        adapterName: 'codex-app-server',
        agentId: 'test-agent',
        adapterSessionId: 'test-thread-id',
        sessionId: 'test-session-id',
        toolCallId: 'item-1',
        toolName: 'bash',
        reasoning: 'Command requires network access',
        args: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'item-1',
          reason: 'Command requires network access',
          proposedExecpolicyAmendment: null,
        },
      };

      expect(result).toEqual(expected);
    });

    it('should include all params in args for context', () => {
      const params = {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-1',
        reason: null,
        proposedExecpolicyAmendment: null,
      };

      const result = toGlobalToolApproval(params, mockContext);

      expect(result.args).toEqual({
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-1',
        reason: null,
        proposedExecpolicyAmendment: null,
      });
    });
  });

  describe('toGlobalFileApproval', () => {
    it('should transform file change approval request', () => {
      const params = {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-1',
        reason: 'Requesting write access to project directory',
        grantRoot: null,
      };

      const result = toGlobalFileApproval(params, mockContext);

      const expected: AgentToolApproveRequest = {
        adapterId: 'test-adapter',
        adapterName: 'codex-app-server',
        agentId: 'test-agent',
        adapterSessionId: 'test-thread-id',
        sessionId: 'test-session-id',
        toolCallId: 'item-1',
        toolName: 'patch',
        reasoning: 'Requesting write access to project directory',
        args: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'item-1',
          reason: 'Requesting write access to project directory',
          grantRoot: null,
        },
      };

      expect(result).toEqual(expected);
    });

    it('should include grantRoot in args when present', () => {
      const params = {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-1',
        reason: null,
        grantRoot: '/home/user/project',
      };

      const result = toGlobalFileApproval(params, mockContext);

      expect(result.args?.grantRoot).toBe('/home/user/project');
    });
  });

  describe('fromGlobalToolApproval', () => {
    it('should transform allow action to accept decision', () => {
      const response: AgentToolApproveResponse = {
        action: 'allow',
      };

      const result = fromGlobalToolApproval(response);

      expect(result).toEqual({
        decision: 'accept',
      });
    });

    it('should transform allow with permissions to accept decision', () => {
      const response: AgentToolApproveResponse = {
        action: 'allow',
        updatedPermissions: ['always-allow-bash'],
      };

      const result = fromGlobalToolApproval(response);

      expect(result).toEqual({
        decision: 'accept',
      });
    });

    it('should transform deny action to decline decision with message', () => {
      const response: AgentToolApproveResponse = {
        action: 'deny',
        message: 'Command not allowed',
      };

      const result = fromGlobalToolApproval(response);

      expect(result).toEqual({
        decision: 'decline',
        message: 'Command not allowed',
      });
    });

    it('should convert empty message to undefined when deny', () => {
      const response: AgentToolApproveResponse = {
        action: 'deny',
        message: '',
      };

      const result = fromGlobalToolApproval(response);

      expect(result).toEqual({
        decision: 'decline',
        message: undefined,
      });
    });

    it('should handle deny with shouldAbort flag', () => {
      const response: AgentToolApproveResponse = {
        action: 'deny',
        message: 'Critical security violation',
        shouldAbort: true,
      };

      const result = fromGlobalToolApproval(response);

      expect(result).toEqual({
        decision: 'decline',
        message: 'Critical security violation',
      });
      // Note: The shouldAbort flag is not mapped to the app-server response format
      // The app-server uses the decision value directly
    });
  });
});
