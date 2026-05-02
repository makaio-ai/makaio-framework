/**
 * Shared test utilities for ToolApprovalService tests.
 */
import { MakaioBus } from '@makaio/bus-core';
import { ApprovalSubjects, HarnessSubjects, type ApprovalPolicy } from '@makaio/contracts';
import { AgentStorageSubjects, SessionStorageSubjects } from '../../session/index.js';

// Test constants
export const TEST_AGENT_ID = 'test-agent-1';
export const TEST_SESSION_ID = 'test-session-1';
export const TEST_ADAPTER_ID = 'test-adapter-1';
export const TEST_ADAPTER_NAME = 'test-adapter';
export const TEST_ADAPTER_SESSION_ID = 'test-adapter-session-1';

/**
 * Options for configuring the default approval request handler behavior.
 */
export interface ApprovalRequestHandlerOptions {
  action?: 'allow' | 'deny';
  capturePayload?: boolean;
  throws?: boolean;
}

/**
 * Captured state returned by {@link registerApprovalRequestHandler} for assertions.
 */
export interface ApprovalRequestHandlerState {
  called: boolean;
  payload?: unknown;
}

/**
 * Create a standard toolApprove request payload.
 * @param overrides - Optional overrides for any field
 */
export function createToolApprovePayload(
  overrides?: Partial<{
    agentId: string;
    adapterId: string;
    adapterName: string;
    sessionId: string;
    adapterSessionId: string;
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
  }>,
) {
  return {
    agentId: TEST_AGENT_ID,
    adapterId: TEST_ADAPTER_ID,
    adapterName: TEST_ADAPTER_NAME,
    sessionId: TEST_SESSION_ID,
    adapterSessionId: TEST_ADAPTER_SESSION_ID,
    toolCallId: 'tool-call-1',
    toolName: 'bash',
    ...overrides,
  };
}

/**
 * Register a default harness handler that returns 'always-ask'.
 * @returns Cleanup function
 */
export function registerDefaultHarnessHandler(): () => void {
  return MakaioBus.on(HarnessSubjects.resolve, (ctx) => {
    ctx.setResult({
      id: 'default-harness',
      name: 'default',
      description: 'Default test harness',
      adapterName: TEST_ADAPTER_NAME,
      approvalPolicy: 'always-ask',
      nativeTools: { enabled: [], disabled: [] },
      registryTools: { enabled: [], disabled: [] },
      isDefault: true,
      enabled: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
}

/**
 * Register a stub agent for AgentStorageSubjects.listBySession.
 *
 * Covers the most common test pattern: a single lead agent with optional
 * identity field overrides. Tests needing an empty agent list should
 * register inline.
 * @param cleanups - Array to collect cleanup functions
 * @param overrides - Optional field overrides for the stub agent
 */
export function registerAgentStub(
  cleanups: Array<() => void>,
  overrides: Partial<{
    agentId: string;
    adapterId: string;
    adapterName: string;
    sessionId: string;
    adapterSessionId: string;
    cwd: string;
    personaId: string;
    profileId: string;
    harnessId: string;
  }> = {},
): void {
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
            ...overrides,
          },
        ],
      });
    }),
  );
}

/**
 * Register a standard ApprovalSubjects.request handler for test scenarios.
 * @param cleanups - Array to collect cleanup functions
 * @param options - Optional behavior/capture configuration
 * @returns Mutable capture state for assertions
 */
export function registerApprovalRequestHandler(
  cleanups: Array<() => void>,
  options: ApprovalRequestHandlerOptions = {},
): ApprovalRequestHandlerState {
  const state: ApprovalRequestHandlerState = { called: false };

  cleanups.push(
    MakaioBus.on(ApprovalSubjects.request, (ctx) => {
      state.called = true;
      if (options.capturePayload) {
        state.payload = ctx.payload;
      }
      if (options.throws) {
        throw new Error('approval transport unavailable');
      }
      ctx.setResult({ action: options.action ?? 'allow' });
    }),
  );

  return state;
}

/**
 * Register a SessionStorageSubjects.get handler for test scenarios.
 *
 * Responds with a minimal session stub bearing the specified `approvalPolicyOverride`.
 * Pass `null` or omit `approvalPolicyOverride` to simulate a session with no override.
 * @param cleanups - Array to collect cleanup functions
 * @param approvalPolicyOverride - Override policy to return (null = no override)
 * @param sessionId - Session ID that this handler matches (defaults to TEST_SESSION_ID)
 */
export function registerSessionStorageHandler(
  cleanups: Array<() => void>,
  approvalPolicyOverride: ApprovalPolicy | null = null,
  sessionId: string = TEST_SESSION_ID,
): void {
  cleanups.push(
    MakaioBus.on(
      SessionStorageSubjects.get,
      (ctx) => {
        ctx.setResult({
          session: {
            sessionId,
            createdAt: Date.now(),
            lastActivityAt: Date.now(),
            agents: [],
            status: 'active',
            approvalPolicyOverride,
          },
        });
      },
      { filter: { sessionId } },
    ),
  );
}
