/**
 * ToolApprovalService edge case tests.
 *
 * Tests missing metadata, tool approval metadata handling, and error scenarios.
 * Following the lessons-learned: tests use real bus handlers, not mocks.
 *
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { MakaioBus } from '@makaio/bus-core';
import { AgentSubjects, HarnessSubjects } from '@makaio/contracts';
import { AgentStorageSubjects } from '../../session/index.js';
import { ToolApprovalService } from '../tool-approval-service.js';
import {
  createToolApprovePayload,
  registerAgentStub,
  registerApprovalRequestHandler,
  registerDefaultHarnessHandler,
} from './test-utils.js';

describe('ToolApprovalService - Edge Cases', () => {
  let service: ToolApprovalService;
  const cleanups: Array<() => void> = [];

  beforeEach(async () => {
    MakaioBus.__resetHandlers?.();
    service = new ToolApprovalService(MakaioBus);
    cleanups.push(registerDefaultHarnessHandler());
    await service.init();
  });

  afterEach(() => {
    service.destroy();
    cleanups.forEach((fn) => fn());
    cleanups.length = 0;
    MakaioBus.__resetHandlers?.();
  });

  describe('missing agent metadata', () => {
    it('uses harness policy when agent metadata is missing', async () => {
      service.destroy();
      cleanups.forEach((fn) => fn());
      cleanups.length = 0;

      cleanups.push(
        MakaioBus.on(HarnessSubjects.resolve, (ctx) => {
          ctx.setResult({
            id: 'default-harness',
            name: 'default',
            description: 'Default test harness',
            adapterName: ctx.payload.adapterName,
            approvalPolicy: 'reject',
            nativeTools: { enabled: [], disabled: [] },
            registryTools: { enabled: [], disabled: [] },
            isDefault: true,
            enabled: true,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          });
        }),
      );
      service = new ToolApprovalService(MakaioBus);
      await service.init();

      cleanups.push(
        MakaioBus.on(AgentStorageSubjects.listBySession, (ctx) => {
          ctx.setResult({ agents: [] });
        }),
      );

      const result = await MakaioBus.request(AgentSubjects.toolApprove, createToolApprovePayload());
      expect(result.action).toBe('deny');
      if (result.action === 'deny') {
        expect(result.message).toBe('Tool use rejected by approval policy');
      }
    });

    it('should gracefully fallback to always-ask when agent not found', async () => {
      // Register handler that returns empty agents list
      cleanups.push(
        MakaioBus.on(AgentStorageSubjects.listBySession, (ctx) => {
          ctx.setResult({
            agents: [],
          });
        }),
      );

      const approval = registerApprovalRequestHandler(cleanups);

      const result = await MakaioBus.request(AgentSubjects.toolApprove, createToolApprovePayload());
      expect(approval.called).toBe(true);
      expect(result.action).toBe('allow');
    });

    it('should fallback to always-ask when persona not found', async () => {
      registerAgentStub(cleanups, { personaId: 'non-existent-persona' });

      const approval = registerApprovalRequestHandler(cleanups);

      const result = await MakaioBus.request(AgentSubjects.toolApprove, createToolApprovePayload());
      expect(approval.called).toBe(true);
      expect(result.action).toBe('allow');
    });

    it('should fallback when profile not found', async () => {
      registerAgentStub(cleanups, { profileId: 'non-existent-profile' });

      const approval = registerApprovalRequestHandler(cleanups);

      const result = await MakaioBus.request(AgentSubjects.toolApprove, createToolApprovePayload());
      expect(approval.called).toBe(true);
      expect(result.action).toBe('allow');
    });
  });

  describe('tool approval metadata', () => {
    it('should include tool name and args in approval payload', async () => {
      registerAgentStub(cleanups);

      const approval = registerApprovalRequestHandler(cleanups, { capturePayload: true });

      await MakaioBus.request(
        AgentSubjects.toolApprove,
        createToolApprovePayload({
          toolName: 'edit_file',
          args: {
            file_path: '/tmp/test.txt',
            content: 'Hello, World!',
          },
        }),
      );

      expect(approval.payload).toMatchObject({
        toolName: 'edit_file',
        args: {
          file_path: '/tmp/test.txt',
          content: 'Hello, World!',
        },
        riskLevel: 'neutral',
      });
      expect((approval.payload as { requestId: string }).requestId).toContain('apr_');
    });

    it('should handle missing tool name gracefully', async () => {
      registerAgentStub(cleanups);

      const approval = registerApprovalRequestHandler(cleanups, { capturePayload: true });

      await MakaioBus.request(
        AgentSubjects.toolApprove,
        createToolApprovePayload({
          toolName: undefined,
        }),
      );

      expect(approval.payload).toMatchObject({
        toolName: undefined,
        toolCallId: 'tool-call-1',
      });
    });

    it('should omit details when args are not provided', async () => {
      registerAgentStub(cleanups);

      const approval = registerApprovalRequestHandler(cleanups, { capturePayload: true });

      await MakaioBus.request(
        AgentSubjects.toolApprove,
        createToolApprovePayload({
          toolName: 'bash',
          args: undefined,
        }),
      );

      expect(approval.payload).toMatchObject({
        toolName: 'bash',
      });
      expect((approval.payload as { args?: Record<string, unknown> }).args).toBeUndefined();
    });
  });
});
