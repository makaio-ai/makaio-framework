/**
 * ToolApprovalService per-tool approval override tests.
 *
 * Tests the per-tool override behaviour: a harness can specify an exact
 * approval policy for a named tool (e.g. `{ bash: 'always-ask', read: 'full-access' }`).
 * The override applies at the harness level — persona/profile policies still win.
 * Capability overrides are applied on top of the per-tool result.
 *
 * Following the lessons-learned: tests use real bus handlers, not mocks.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { MakaioBus } from '@makaio/bus-core';
import { AgentSubjects, ApprovalSubjects, HarnessSubjects, type ApprovalPolicy } from '@makaio/contracts';
import { AgentStorageSubjects } from '../../session/index.js';
import { ToolApprovalService } from '../tool-approval-service.js';
import {
  TEST_ADAPTER_NAME,
  TEST_AGENT_ID,
  TEST_ADAPTER_ID,
  TEST_SESSION_ID,
  TEST_ADAPTER_SESSION_ID,
  createToolApprovePayload,
  registerAgentStub,
  registerApprovalRequestHandler,
} from './test-utils.js';

/**
 * Register a harness handler with per-tool approval overrides.
 * @param cleanups - Array to collect cleanup functions
 * @param overrides - Harness configuration overrides
 */
function registerHarnessWithToolOverrides(
  cleanups: Array<() => void>,
  overrides: {
    approvalPolicy?: ApprovalPolicy;
    toolApprovalOverrides?: Record<string, ApprovalPolicy>;
  },
): void {
  cleanups.push(
    MakaioBus.on(HarnessSubjects.resolve, (ctx) => {
      ctx.setResult({
        id: 'tool-override-harness',
        name: 'tool-override-test',
        adapterName: TEST_ADAPTER_NAME,
        approvalPolicy: overrides.approvalPolicy ?? 'always-ask',
        toolApprovalOverrides: overrides.toolApprovalOverrides,
        nativeTools: { enabled: ['bash', 'read'], disabled: [] },
        registryTools: { enabled: [], disabled: [] },
        isDefault: true,
        enabled: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }),
  );
}

describe('ToolApprovalService - Per-Tool Approval Overrides', () => {
  let service: ToolApprovalService;
  const cleanups: Array<() => void> = [];

  beforeEach(async () => {
    MakaioBus.__resetHandlers?.();
    service = new ToolApprovalService(MakaioBus);
    await service.init();
  });

  afterEach(() => {
    service.destroy();
    cleanups.forEach((fn) => fn());
    cleanups.length = 0;
    MakaioBus.__resetHandlers?.();
  });

  it('per-tool override full-access bypasses approval dialog for named tool', async () => {
    registerAgentStub(cleanups);
    registerHarnessWithToolOverrides(cleanups, {
      approvalPolicy: 'always-ask',
      toolApprovalOverrides: { read: 'full-access' },
    });

    const result = await MakaioBus.request(AgentSubjects.toolApprove, createToolApprovePayload({ toolName: 'read' }));

    expect(result.action).toBe('allow');
  });

  it('per-tool override does not affect other tools', async () => {
    registerAgentStub(cleanups);
    registerHarnessWithToolOverrides(cleanups, {
      approvalPolicy: 'always-ask',
      toolApprovalOverrides: { read: 'full-access' },
    });

    const approvalState = registerApprovalRequestHandler(cleanups);

    const result = await MakaioBus.request(AgentSubjects.toolApprove, createToolApprovePayload({ toolName: 'bash' }));

    // bash has no override — harness base 'always-ask' applies
    expect(approvalState.called).toBe(true);
    expect(result.action).toBe('allow');
  });

  it('per-tool override reject denies without prompting', async () => {
    registerAgentStub(cleanups);
    registerHarnessWithToolOverrides(cleanups, {
      approvalPolicy: 'always-ask',
      toolApprovalOverrides: { bash: 'reject' },
    });

    const result = await MakaioBus.request(AgentSubjects.toolApprove, createToolApprovePayload({ toolName: 'bash' }));

    expect(result.action).toBe('deny');
    if (result.action === 'deny') {
      expect(result.message).toBeDefined();
    }
  });

  it('persona policy takes precedence over per-tool harness override', async () => {
    // Harness has full-access for 'bash', but persona sets reject
    cleanups.push(
      MakaioBus.on(AgentStorageSubjects.listBySession, (ctx) => {
        ctx.setResult({
          agents: [
            {
              agentId: TEST_AGENT_ID,
              adapterId: TEST_ADAPTER_ID,
              adapterName: TEST_ADAPTER_NAME,
              sessionId: TEST_SESSION_ID,
              adapterSessionId: TEST_ADAPTER_SESSION_ID,
              role: 'lead',
              status: 'active',
              createdAt: Date.now(),
              lastActivityAt: Date.now(),
              personaId: 'persona-reject',
            },
          ],
        });
      }),
    );

    cleanups.push(
      MakaioBus.on(ApprovalSubjects.resolveEnrichedPolicy, (ctx) => {
        ctx.setResult({ action: 'deny' });
      }),
    );

    registerHarnessWithToolOverrides(cleanups, {
      approvalPolicy: 'always-ask',
      toolApprovalOverrides: { bash: 'full-access' },
    });

    const result = await MakaioBus.request(AgentSubjects.toolApprove, createToolApprovePayload({ toolName: 'bash' }));

    // Persona 'reject' overrides harness per-tool 'full-access'
    expect(result.action).toBe('deny');
  });

  it('falls back to harness base policy when tool has no per-tool override', async () => {
    registerAgentStub(cleanups);
    registerHarnessWithToolOverrides(cleanups, {
      approvalPolicy: 'full-access',
      toolApprovalOverrides: { read: 'always-ask' },
    });

    const result = await MakaioBus.request(AgentSubjects.toolApprove, createToolApprovePayload({ toolName: 'bash' }));

    // bash has no per-tool override, harness base 'full-access' applies
    expect(result.action).toBe('allow');
  });

  it('falls back to harness base policy when toolApprovalOverrides is undefined', async () => {
    registerAgentStub(cleanups);
    registerHarnessWithToolOverrides(cleanups, {
      approvalPolicy: 'full-access',
      // No toolApprovalOverrides
    });

    const result = await MakaioBus.request(AgentSubjects.toolApprove, createToolApprovePayload({ toolName: 'bash' }));

    expect(result.action).toBe('allow');
  });
});
