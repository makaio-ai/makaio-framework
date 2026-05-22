import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import type { RelayCronFired } from '../../relay-connection/relay-cron-schemas.js';
import { RelaySubjects } from '../../relay-connection/namespace.js';
import { WorkflowSubjects } from '../namespace.js';
import { RelayCronFiredHandler } from '../relay-cron-fired-handler.js';

/**
 * Build a valid RelayCronFired payload for tests.
 * @param overrides - Optional field overrides
 * @returns Complete RelayCronFired payload
 */
function buildPayload(overrides: Partial<RelayCronFired> = {}): RelayCronFired {
  return {
    workflowId: 'wf-test',
    projectId: 'project-1',
    firedAt: Date.now(),
    scheduleId: 'sched-1',
    schedule: '0 * * * *',
    ...overrides,
  };
}

describe('RelayCronFiredHandler', () => {
  let handler: RelayCronFiredHandler;
  let startCleanup: () => void;

  beforeEach(() => {
    handler = new RelayCronFiredHandler(MakaioBus);
  });

  afterEach(() => {
    handler.destroy();
    startCleanup?.();
  });

  // ─── Lifecycle ──────────────────────────────────────────────

  it('init is idempotent — second call is a no-op', () => {
    handler.init();
    handler.init(); // should not throw or double-subscribe
    handler.destroy();
  });

  it('destroy is idempotent — safe to call when not initialized', () => {
    handler.destroy(); // should not throw
  });

  it('can re-init after destroy', () => {
    handler.init();
    handler.destroy();
    handler.init(); // should not throw
    handler.destroy();
  });

  // ─── Payload forwarding ─────────────────────────────────────

  it('forwards relay.cron.fired payload to WorkflowSubjects.start', async () => {
    const received: Array<{ workflowId: string; triggerPayload?: Record<string, unknown> }> = [];

    startCleanup = MakaioBus.on(WorkflowSubjects.start, (ctx) => {
      received.push(ctx.payload);
      ctx.setResult({ executionId: 'exec-1' });
    });

    handler.init();

    const payload = buildPayload({ workflowId: 'wf-deploy', scheduleId: 'sched-42' });
    await MakaioBus.emit(RelaySubjects.cron.fired, payload);

    // Give the fire-and-forget request time to settle.
    await vi.waitFor(() => expect(received).toHaveLength(1));

    expect(received[0].workflowId).toBe('wf-deploy');
    expect(received[0].triggerPayload).toMatchObject({
      workflowId: 'wf-deploy',
      scheduleId: 'sched-42',
    });
  });

  it('includes full cron payload in triggerPayload', async () => {
    const received: Array<Record<string, unknown>> = [];

    startCleanup = MakaioBus.on(WorkflowSubjects.start, (ctx) => {
      received.push(ctx.payload.triggerPayload as Record<string, unknown>);
      ctx.setResult({ executionId: 'exec-1' });
    });

    handler.init();

    const payload = buildPayload({
      workflowId: 'wf-full',
      projectId: 'proj-abc',
      firedAt: 1700000000000,
      scheduleId: 'sched-99',
      schedule: '30 9 * * 1-5',
      timezone: 'America/New_York',
    });
    await MakaioBus.emit(RelaySubjects.cron.fired, payload);

    await vi.waitFor(() => expect(received).toHaveLength(1));

    expect(received[0]).toMatchObject({
      workflowId: 'wf-full',
      projectId: 'proj-abc',
      firedAt: 1700000000000,
      scheduleId: 'sched-99',
      schedule: '30 9 * * 1-5',
      timezone: 'America/New_York',
    });
  });

  // ─── Error handling ─────────────────────────────────────────

  it('logs error when WorkflowSubjects.start fails (does not throw)', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // No handler registered for WorkflowSubjects.start — will fail.
    handler.init();

    const payload = buildPayload({ workflowId: 'wf-fail', scheduleId: 'sched-err' });
    await MakaioBus.emit(RelaySubjects.cron.fired, payload);

    await vi.waitFor(() => expect(consoleSpy).toHaveBeenCalled());

    const message = consoleSpy.mock.calls[0][0] as string;
    expect(message).toContain('wf-fail');
    expect(message).toContain('sched-err');

    consoleSpy.mockRestore();
  });

  // ─── Subscription cleanup ──────────────────────────────────

  it('does not fire after destroy', async () => {
    const received: unknown[] = [];

    startCleanup = MakaioBus.on(WorkflowSubjects.start, (ctx) => {
      received.push(ctx.payload);
      ctx.setResult({ executionId: 'exec-1' });
    });

    handler.init();
    handler.destroy();

    await MakaioBus.emit(RelaySubjects.cron.fired, buildPayload());

    // Allow any in-flight microtasks to settle.
    await new Promise((r) => setTimeout(r, 50));
    expect(received).toHaveLength(0);
  });
});
