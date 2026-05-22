/**
 * ToolApprovalService session-level override tests.
 *
 * Verifies that `approvalPolicyOverride` on the session is the highest-precedence
 * policy layer — sitting above the persona → profile → harness cascade but below
 * the `.makaioignore` absolute deny floor.
 *
 * All tests use real bus handlers (no mocks). Session storage is simulated via
 * a lightweight inline handler that returns a stub session with the desired override.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { AgentSubjects, HarnessSubjects, type AgentToolApproveResponse, type ApprovalPolicy } from '@makaio/contracts';
import type { FileAccessRuleProvider } from '@makaio/tools-core';
import { ToolApprovalService } from '../tool-approval-service.js';
import {
  createToolApprovePayload,
  registerDefaultHarnessHandler,
  registerAgentStub,
  registerApprovalRequestHandler,
  registerSessionStorageHandler,
  type ApprovalRequestHandlerOptions,
  type ApprovalRequestHandlerState,
} from './test-utils.js';

describe('ToolApprovalService - Session Override', () => {
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

  /**
   * Options for {@link runApproveScenario}.
   */
  interface ApproveScenarioOptions {
    /**
     * Policy to pass to `registerSessionStorageHandler`.
     * - `ApprovalPolicy | null`: registers the session handler with that override value.
     * - `undefined` (omitted): skips session handler registration entirely.
     */
    sessionOverride?: ApprovalPolicy | null;
    /** Options forwarded to `registerApprovalRequestHandler`. */
    approvalOptions?: ApprovalRequestHandlerOptions;
    /** Overrides forwarded to `createToolApprovePayload`. */
    payloadOverrides?: Parameters<typeof createToolApprovePayload>[0];
    /** Overrides forwarded to `registerAgentStub`. */
    agentOverrides?: Parameters<typeof registerAgentStub>[1];
  }

  /**
   * Result returned by {@link runApproveScenario}.
   */
  interface ApproveScenarioResult {
    result: AgentToolApproveResponse;
    approval: ApprovalRequestHandlerState;
  }

  /**
   * Arrange-act helper for the common session-override test pattern.
   *
   * Registers `registerAgentStub`, optionally `registerSessionStorageHandler`,
   * and `registerApprovalRequestHandler`, then fires a `toolApprove` bus request.
   * @param options - Scenario configuration
   * @returns The bus response and approval handler state for assertion
   */
  async function runApproveScenario(options: ApproveScenarioOptions = {}): Promise<ApproveScenarioResult> {
    const { sessionOverride, approvalOptions, payloadOverrides, agentOverrides } = options;

    registerAgentStub(cleanups, agentOverrides);

    if (sessionOverride !== undefined) {
      registerSessionStorageHandler(cleanups, sessionOverride);
    }

    const approval = registerApprovalRequestHandler(cleanups, approvalOptions);

    const result = await MakaioBus.request(AgentSubjects.toolApprove, createToolApprovePayload(payloadOverrides));

    return { result, approval };
  }

  it('allows immediately when session override is full-access (cascade skipped)', async () => {
    registerAgentStub(cleanups);
    registerSessionStorageHandler(cleanups, 'full-access');

    let harnessResolveCalls = 0;
    cleanups.push(
      MakaioBus.on(
        HarnessSubjects.resolve,
        (ctx) => {
          harnessResolveCalls += 1;
          ctx.setResult({
            id: 'spy-harness',
            name: 'Spy Harness',
            description: 'Counts harness resolution calls',
            adapterName: 'test-adapter',
            approvalPolicy: 'always-ask',
            nativeTools: { enabled: [], disabled: [] },
            registryTools: { enabled: [], disabled: [] },
            isDefault: true,
            enabled: true,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          });
        },
        { priority: 2 },
      ),
    );

    // If cascade ran and reached always-ask, this handler would be called.
    const approval = registerApprovalRequestHandler(cleanups);

    const result = await MakaioBus.request(AgentSubjects.toolApprove, createToolApprovePayload());

    expect(result.action).toBe('allow');
    expect(approval.called).toBe(false);
    expect(harnessResolveCalls).toBe(0);
  });

  it('denies immediately when session override is reject (cascade skipped)', async () => {
    const { result, approval } = await runApproveScenario({ sessionOverride: 'reject' });

    expect(result.action).toBe('deny');
    if (result.action === 'deny') {
      expect(result.message).toContain('session approval policy override');
      expect(result.shouldAbort).toBe(false);
    }
    expect(approval.called).toBe(false);
  });

  it('runs cascade for enrichment and forces always-ask when override is always-ask', async () => {
    // The default harness returns always-ask, but even if cascade would return
    // full-access, the override must force always-ask and invoke the approval handler.
    const { result, approval } = await runApproveScenario({ sessionOverride: 'always-ask' });

    expect(approval.called).toBe(true);
    expect(result.action).toBe('allow');
  });

  it('forces always-ask even when cascade would return full-access', async () => {
    // Register an approval handler that denies — if always-ask is correctly forced,
    // the approval queue must be reached and this handler must be called.
    const { result, approval } = await runApproveScenario({
      sessionOverride: 'always-ask',
      approvalOptions: { action: 'deny' },
    });

    expect(approval.called).toBe(true);
    expect(result.action).toBe('deny');
    if (result.action === 'deny') {
      expect(result.message).toBe('User denied tool execution');
    }
  });

  it('falls through to existing cascade when session override is null', async () => {
    // Register session with null override — should behave identically to no override.
    const { result, approval } = await runApproveScenario({ sessionOverride: null });

    // Default harness returns always-ask, so approval queue is reached.
    expect(approval.called).toBe(true);
    expect(result.action).toBe('allow');
  });

  it('falls through to existing cascade when no session storage handler is registered', async () => {
    // Intentionally no sessionOverride — skips registerSessionStorageHandler.
    // requestOptional returns handled:false, so override is undefined.
    // (createToolApprovePayload already defaults sessionId to TEST_SESSION_ID)
    const { result, approval } = await runApproveScenario();

    expect(approval.called).toBe(true);
    expect(result.action).toBe('allow');
  });

  // "no sessionId" scenario removed — sessionId is now required by AgentToolApproveSchema,
  // so schema validation rejects payloads without it before the handler runs.

  it('makaioignore deny wins over full-access session override', async () => {
    const testProvider: FileAccessRuleProvider = async () => ({
      isDenied: (p) => p.endsWith('.env'),
    });

    service.destroy();
    service = new ToolApprovalService(MakaioBus, { fileAccessRuleProvider: testProvider });
    await service.init();

    const TEST_CWD = '/home/user/project';
    registerAgentStub(cleanups, { cwd: TEST_CWD });
    registerSessionStorageHandler(cleanups, 'full-access');

    const result = await MakaioBus.request(
      AgentSubjects.toolApprove,
      createToolApprovePayload({
        toolName: 'read_file',
        args: { path: `${TEST_CWD}/.env` },
      }),
    );

    // .makaioignore deny must win even when session override is full-access.
    expect(result.action).toBe('deny');
    if (result.action === 'deny') {
      expect(result.message).toContain('.makaioignore');
    }
  });
});
