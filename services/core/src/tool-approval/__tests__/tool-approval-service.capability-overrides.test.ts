/**
 * ToolApprovalService capability-based approval override tests.
 *
 * Tests the most-restrictive-wins rule applied when a harness provides
 * `capabilityOverrides` and `toolCapabilityMap`. Following the lessons-learned:
 * tests use real bus handlers, not mocks.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import {
  AgentSubjects,
  ApprovalSubjects,
  HarnessSubjects,
  type ApprovalPolicy,
  type ToolCapability,
} from '@makaio/contracts';
import { ToolApprovalService } from '../tool-approval-service.js';
import { TEST_ADAPTER_NAME, createToolApprovePayload, registerAgentStub } from './test-utils.js';

/**
 * Default tool-to-capability map shared across tests.
 * Mirrors a realistic harness configuration.
 */
const DEFAULT_TOOL_CAPABILITY_MAP: Record<string, ToolCapability[]> = {
  bash: ['shell.execute', 'file.read', 'file.write', 'file.delete', 'network.request', 'process.manage'],
  patch: ['file.write'],
  read: ['file.read'],
};

/**
 * Register a harness handler that exposes `toolCapabilityMap` and optional `capabilityOverrides`.
 * Replaces `registerDefaultHarnessHandler` for capability-override tests so the harness
 * always carries the capability data the service needs.
 * @param cleanups - Array to collect cleanup functions
 * @param overrides - Harness configuration overrides
 */
function registerCapabilityHarness(
  cleanups: Array<() => void>,
  overrides: {
    approvalPolicy?: ApprovalPolicy;
    capabilityOverrides?: Record<string, ApprovalPolicy>;
    toolCapabilityMap?: Record<string, ToolCapability[]>;
  },
): void {
  cleanups.push(
    MakaioBus.on(HarnessSubjects.resolve, (ctx) => {
      ctx.setResult({
        id: 'cap-harness',
        name: 'capability-test',
        adapterName: TEST_ADAPTER_NAME,
        approvalPolicy: overrides.approvalPolicy ?? 'always-ask',
        capabilityOverrides: overrides.capabilityOverrides,
        toolCapabilityMap: overrides.toolCapabilityMap ?? DEFAULT_TOOL_CAPABILITY_MAP,
        nativeTools: { enabled: ['bash', 'patch', 'read'], disabled: [] },
        registryTools: { enabled: [], disabled: [] },
        isDefault: true,
        enabled: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }),
  );
}

describe('ToolApprovalService - Capability Overrides', () => {
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

  it('should allow when harness has no capabilityOverrides and base policy is full-access', async () => {
    registerAgentStub(cleanups);
    registerCapabilityHarness(cleanups, {
      approvalPolicy: 'full-access',
      // No capabilityOverrides — capability override path is skipped
    });

    const result = await MakaioBus.request(AgentSubjects.toolApprove, createToolApprovePayload({ toolName: 'bash' }));

    expect(result.action).toBe('allow');
  });

  it('should request approval when capability override tightens policy above base', async () => {
    // Base: full-access, but shell.execute override: always-ask
    // bash has shell.execute → effective policy: always-ask
    registerAgentStub(cleanups);
    registerCapabilityHarness(cleanups, {
      approvalPolicy: 'full-access',
      capabilityOverrides: { 'shell.execute': 'always-ask' },
    });

    let approvalCalled = false;
    cleanups.push(
      MakaioBus.on(ApprovalSubjects.request, (ctx) => {
        approvalCalled = true;
        ctx.setResult({ action: 'allow' });
      }),
    );

    const result = await MakaioBus.request(AgentSubjects.toolApprove, createToolApprovePayload({ toolName: 'bash' }));

    expect(approvalCalled).toBe(true);
    expect(result.action).toBe('allow');
  });

  it('should request approval when capability override matches base policy', async () => {
    // Base: always-ask, override file.read: always-ask — no net change, dialog still shown
    registerAgentStub(cleanups);
    registerCapabilityHarness(cleanups, {
      approvalPolicy: 'always-ask',
      capabilityOverrides: { 'file.read': 'always-ask' },
    });

    let approvalCalled = false;
    cleanups.push(
      MakaioBus.on(ApprovalSubjects.request, (ctx) => {
        approvalCalled = true;
        ctx.setResult({ action: 'allow' });
      }),
    );

    const result = await MakaioBus.request(AgentSubjects.toolApprove, createToolApprovePayload({ toolName: 'read' }));

    expect(approvalCalled).toBe(true);
    expect(result.action).toBe('allow');
  });

  it('should not loosen base policy when capability override is less restrictive', async () => {
    // Base: always-ask, override file.read: full-access — base wins, dialog shown
    registerAgentStub(cleanups);
    registerCapabilityHarness(cleanups, {
      approvalPolicy: 'always-ask',
      capabilityOverrides: { 'file.read': 'full-access' },
    });

    let approvalCalled = false;
    cleanups.push(
      MakaioBus.on(ApprovalSubjects.request, (ctx) => {
        approvalCalled = true;
        ctx.setResult({ action: 'allow' });
      }),
    );

    const result = await MakaioBus.request(AgentSubjects.toolApprove, createToolApprovePayload({ toolName: 'read' }));

    // Capability override (full-access) is less restrictive than base (always-ask),
    // so always-ask remains the effective policy and approval request must fire.
    expect(approvalCalled).toBe(true);
    expect(result.action).toBe('allow');
  });

  it('should apply the most-restrictive policy when multiple capabilities match', async () => {
    // Base: full-access
    // bash capabilities: shell.execute, file.read, file.write, file.delete, network.request, process.manage
    // overrides: file.read → full-access, shell.execute → reject
    // most-restrictive wins: reject
    registerAgentStub(cleanups);
    registerCapabilityHarness(cleanups, {
      approvalPolicy: 'full-access',
      capabilityOverrides: {
        'file.read': 'full-access',
        'shell.execute': 'reject',
      },
    });

    const result = await MakaioBus.request(AgentSubjects.toolApprove, createToolApprovePayload({ toolName: 'bash' }));

    expect(result.action).toBe('deny');
    if (result.action === 'deny') {
      expect(result.message).toBeDefined();
    }
  });

  it('should fall back to base policy when tool has no capability mapping', async () => {
    // Base: full-access, override shell.execute: reject, but tool unknown-tool has no mapping
    // → base policy full-access applies unchanged
    registerAgentStub(cleanups);
    registerCapabilityHarness(cleanups, {
      approvalPolicy: 'full-access',
      capabilityOverrides: { 'shell.execute': 'reject' },
    });

    const result = await MakaioBus.request(
      AgentSubjects.toolApprove,
      createToolApprovePayload({ toolName: 'unknown-tool' }),
    );

    expect(result.action).toBe('allow');
  });
});
