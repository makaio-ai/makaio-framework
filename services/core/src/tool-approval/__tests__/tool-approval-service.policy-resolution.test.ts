/**
 * ToolApprovalService policy resolution cascade tests.
 *
 * Tests the persona → profile → harness → system default cascade.
 * Following the lessons-learned: tests use real bus handlers, not mocks.
 *
 * Persona/profile policy resolution is now delegated to the host-tier
 * `approval.resolveEnrichedPolicy` RPC — tests stub that subject instead of
 * directly registering PersonaStorageSubjects / ProfileStorageSubjects handlers.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { AgentSubjects, ApprovalSubjects } from '@makaio/contracts';
import { ToolApprovalService } from '../tool-approval-service.js';
import {
  createToolApprovePayload,
  registerDefaultHarnessHandler,
  registerAgentStub,
  registerApprovalRequestHandler,
} from './test-utils.js';

describe('ToolApprovalService - Policy Resolution', () => {
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

  it('should use persona approvalPolicy when set', async () => {
    registerAgentStub(cleanups, { personaId: 'persona-1' });

    // Stub the host-tier RPC: persona has full-access policy.
    cleanups.push(
      MakaioBus.on(ApprovalSubjects.resolveEnrichedPolicy, (ctx) => {
        ctx.setResult({ action: 'allow' });
      }),
    );

    const result = await MakaioBus.request(AgentSubjects.toolApprove, createToolApprovePayload());
    expect(result.action).toBe('allow');
  });

  it('should use profile approvalPolicy when no persona override', async () => {
    registerAgentStub(cleanups, { profileId: 'profile-1' });

    // Stub the host-tier RPC: profile has reject policy.
    cleanups.push(
      MakaioBus.on(ApprovalSubjects.resolveEnrichedPolicy, (ctx) => {
        ctx.setResult({ action: 'deny' });
      }),
    );

    const result = await MakaioBus.request(AgentSubjects.toolApprove, createToolApprovePayload());
    expect(result.action).toBe('deny');
    if (result.action === 'deny') {
      expect(result.message).toBeDefined();
    }
  });

  it('should use harness approvalPolicy when no persona or profile override', async () => {
    registerAgentStub(cleanups);

    // No resolveEnrichedPolicy handler — service falls back to harness.
    // The default harness handler (in beforeEach) returns 'always-ask'.
    const approval = registerApprovalRequestHandler(cleanups);

    const result = await MakaioBus.request(AgentSubjects.toolApprove, createToolApprovePayload());
    expect(approval.called).toBe(true);
    expect(result.action).toBe('allow');
  });

  it('should use system default (always-ask) when no harness', async () => {
    registerAgentStub(cleanups);

    // Remove the default harness handler to simulate no harness service
    service.destroy();
    cleanups.forEach((fn) => fn());
    cleanups.length = 0;

    // Re-init service without harness handler
    service = new ToolApprovalService(MakaioBus);

    // Register agent handler again
    registerAgentStub(cleanups);

    // Register approval handler for always-ask
    const approval = registerApprovalRequestHandler(cleanups);

    await service.init();

    const result = await MakaioBus.request(AgentSubjects.toolApprove, createToolApprovePayload());
    expect(approval.called).toBe(true);
    expect(result.action).toBe('allow');
  });

  it('should prioritize persona over profile when both are set', async () => {
    registerAgentStub(cleanups, { personaId: 'persona-1', profileId: 'profile-1' });

    // Stub the host-tier RPC: persona wins with full-access (handler
    // in approval-enricher-handler would resolve persona first).
    cleanups.push(
      MakaioBus.on(ApprovalSubjects.resolveEnrichedPolicy, (ctx) => {
        // Simulates the host-tier handler preferring persona over profile.
        ctx.setResult({ action: 'allow' });
      }),
    );

    const result = await MakaioBus.request(AgentSubjects.toolApprove, createToolApprovePayload());
    expect(result.action).toBe('allow'); // Persona wins
  });

  it('propagates personaName and profileName from enriched policy RPC to the approval request', async () => {
    registerAgentStub(cleanups, { personaId: 'persona-1', profileId: 'profile-1' });
    const approval = registerApprovalRequestHandler(cleanups, { capturePayload: true });

    cleanups.push(
      MakaioBus.on(ApprovalSubjects.resolveEnrichedPolicy, (ctx) => {
        ctx.setResult({ action: 'ask', personaName: 'Strict Librarian', profileName: 'flash-reader' });
      }),
    );

    await MakaioBus.request(AgentSubjects.toolApprove, createToolApprovePayload());

    expect(approval.called).toBe(true);
    expect(approval.payload).toMatchObject({
      personaName: 'Strict Librarian',
      profileName: 'flash-reader',
    });
  });

  it('omits personaName and profileName when enriched policy RPC does not return them', async () => {
    registerAgentStub(cleanups, { personaId: 'persona-1' });
    const approval = registerApprovalRequestHandler(cleanups, { capturePayload: true });

    cleanups.push(
      MakaioBus.on(ApprovalSubjects.resolveEnrichedPolicy, (ctx) => {
        ctx.setResult({ action: 'ask' });
      }),
    );

    await MakaioBus.request(AgentSubjects.toolApprove, createToolApprovePayload());

    expect(approval.called).toBe(true);
    const payload = approval.payload as Record<string, unknown>;
    expect(payload.personaName).toBeUndefined();
    expect(payload.profileName).toBeUndefined();
  });

  it('logs and falls back to always-ask when enriched policy resolution throws', async () => {
    registerAgentStub(cleanups, { personaId: 'persona-1' });
    const approval = registerApprovalRequestHandler(cleanups);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    cleanups.push(
      MakaioBus.on(ApprovalSubjects.resolveEnrichedPolicy, () => {
        throw new Error('policy backend unavailable');
      }),
    );

    const result = await MakaioBus.request(AgentSubjects.toolApprove, createToolApprovePayload());

    expect(approval.called).toBe(true);
    expect(result.action).toBe('allow');
    expect(errorSpy).toHaveBeenCalledWith(
      '[ToolApprovalService] approval.resolveEnrichedPolicy failed; falling back to fail-closed',
      expect.objectContaining({
        toolName: 'bash',
        personaId: 'persona-1',
        profileId: undefined,
      }),
    );
  });
});
