import { describe, expect, it } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { ReviewSubjects, type FindingTarget, type ReviewFinding } from '@makaio/contracts';
import {
  CODERABBIT_REVIEW_POSTED_TRIGGER_KIND,
  CodeRabbitReviewPostedEventSchema,
  createCodeRabbitReviewPostedTrigger,
} from '../automation-trigger.js';

const TARGET: FindingTarget = { repository: 'owner/repo', prNumber: 7 };
const OTHER_TARGET: FindingTarget = { repository: 'other/repo', prNumber: 7 };
const NOW = 1_700_000_000_000;

/**
 * Builds a stored open finding fixture.
 * @param id - Finding identity.
 * @param severity - Impact level.
 * @param sourceId - Owning review source.
 * @returns Review finding fixture.
 */
function makeFinding(id: string, severity: ReviewFinding['severity'], sourceId = 'coderabbit'): ReviewFinding {
  return {
    id,
    target: TARGET,
    sourceId,
    reviewer: sourceId,
    origin: 'inline',
    threadId: null,
    severity,
    file: 'src/file.ts',
    startLine: 1,
    endLine: 1,
    message: 'Finding',
    agentPrompt: null,
    suggestedChanges: [],
    status: 'open',
    addressedBy: null,
    addressedAt: null,
    verifiedAt: null,
    dismissedReason: null,
    createdAt: NOW,
    updatedAt: NOW,
    rawCommentId: 1,
  };
}

/**
 * Serves stored findings over the real review `findings.list` subject.
 * @param bus - Bus to register the handler on.
 * @param findings - Findings returned for any open-status query.
 * @returns Cleanup that removes the handler.
 */
function serveOpenFindings(bus: IMakaioBus, findings: readonly ReviewFinding[]): () => void {
  return bus.on(ReviewSubjects.findings.list, (ctx) => {
    const { status } = ctx.payload;
    ctx.setResult({ findings: findings.filter((finding) => status === undefined || finding.status === status) });
  });
}

/**
 * Activates the trigger and collects every emitted, schema-validated payload.
 * @param bus - Bus the trigger observes.
 * @param repository - Repository parameter for the binding.
 * @returns Collected events and a detach function.
 */
async function activate(
  bus: IMakaioBus,
  repository: string,
): Promise<{
  readonly events: Array<{ payload: unknown; correlationId?: string }>;
  readonly detach: () => Promise<void>;
}> {
  const trigger = createCodeRabbitReviewPostedTrigger(bus);
  expect(trigger.kind).toBe(CODERABBIT_REVIEW_POSTED_TRIGGER_KIND);

  const events: Array<{ payload: unknown; correlationId?: string }> = [];
  const controller = new AbortController();
  const cleanup = await trigger.activate(
    {
      bindingKey: `${CODERABBIT_REVIEW_POSTED_TRIGGER_KIND}:{"repository":"${repository}"}`,
      signal: controller.signal,
      emit: async (payload, metadata) => {
        // Mirrors the runtime: payloads are validated against the live event
        // schema before they reach listeners.
        events.push({ payload: CodeRabbitReviewPostedEventSchema.parse(payload), ...metadata });
        await Promise.resolve();
      },
    },
    trigger.paramsSchema.parse({ repository }),
  );

  return {
    events,
    detach: async () => {
      controller.abort();
      await cleanup();
    },
  };
}

/**
 * Lets the trigger's detached emit pipeline settle.
 * @returns Resolves after the pending microtask queue drains.
 */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('coderabbit.review-posted automation trigger', () => {
  it('emits a severity summary of the open CodeRabbit findings on the observed repository', async () => {
    const bus = createBusInstance();
    const stopServing = serveOpenFindings(bus, [
      makeFinding('coderabbit:1', 'major'),
      makeFinding('coderabbit:2', 'nitpick'),
      makeFinding('coderabbit:3', 'nitpick'),
      makeFinding('other:1', 'critical', 'other-source'),
    ]);
    const { events, detach } = await activate(bus, TARGET.repository);

    await bus.emit(ReviewSubjects.findings.arrived, {
      target: TARGET,
      sourceId: 'coderabbit',
      reviewer: 'coderabbit',
      created: 2,
      updated: 1,
    });
    await settle();

    expect(events).toEqual([
      {
        payload: {
          target: TARGET,
          sourceId: 'coderabbit',
          created: 2,
          updated: 1,
          severityCounts: { critical: 0, major: 1, minor: 0, nitpick: 2 },
          highestSeverity: 'major',
        },
      },
    ]);

    await detach();
    stopServing();
  });

  it('reports no severity when the source has no open findings left', async () => {
    const bus = createBusInstance();
    const stopServing = serveOpenFindings(bus, []);
    const { events, detach } = await activate(bus, TARGET.repository);

    await bus.emit(ReviewSubjects.findings.arrived, {
      target: TARGET,
      sourceId: 'coderabbit',
      reviewer: 'coderabbit',
      created: 0,
      updated: 3,
    });
    await settle();

    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      highestSeverity: null,
      severityCounts: { critical: 0, major: 0, minor: 0, nitpick: 0 },
    });

    await detach();
    stopServing();
  });

  it('ignores other reviewer families and other repositories', async () => {
    const bus = createBusInstance();
    const stopServing = serveOpenFindings(bus, [makeFinding('coderabbit:1', 'critical')]);
    const { events, detach } = await activate(bus, TARGET.repository);

    await bus.emit(ReviewSubjects.findings.arrived, {
      target: TARGET,
      sourceId: 'copilot',
      reviewer: 'copilot',
      created: 1,
      updated: 0,
    });
    await bus.emit(ReviewSubjects.findings.arrived, {
      target: OTHER_TARGET,
      sourceId: 'coderabbit',
      reviewer: 'coderabbit',
      created: 1,
      updated: 0,
    });
    await settle();

    expect(events).toEqual([]);

    await detach();
    stopServing();
  });

  it('stops observing arrivals after the binding is detached', async () => {
    const bus = createBusInstance();
    const stopServing = serveOpenFindings(bus, [makeFinding('coderabbit:1', 'minor')]);
    const { events, detach } = await activate(bus, TARGET.repository);

    await detach();
    await bus.emit(ReviewSubjects.findings.arrived, {
      target: TARGET,
      sourceId: 'coderabbit',
      reviewer: 'coderabbit',
      created: 1,
      updated: 0,
    });
    await settle();

    expect(events).toEqual([]);

    stopServing();
  });

  it('completes the emission within the arrival emit rather than after it', async () => {
    const bus = createBusInstance();
    const stopServing = serveOpenFindings(bus, [makeFinding('coderabbit:1', 'major')]);
    const { events, detach } = await activate(bus, TARGET.repository);

    // No `settle()` here, deliberately: the arrival's awaited emit is the bus
    // completion barrier, and the derived event must already have been emitted by
    // the time it resolves. A handler that only fired the lookup off would still
    // be mid-request at this point and leave `events` empty — which is how an
    // activation disposed right afterwards used to lose the event entirely.
    await bus.emit(ReviewSubjects.findings.arrived, {
      target: TARGET,
      sourceId: 'coderabbit',
      reviewer: 'coderabbit',
      created: 1,
      updated: 0,
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({ highestSeverity: 'major' });

    await detach();
    stopServing();
  });

  it('emits nothing when the activation is disposed while the findings lookup is in flight', async () => {
    const bus = createBusInstance();
    const lookupEntered = Promise.withResolvers<void>();
    const releaseLookup = Promise.withResolvers<void>();

    const stopServing = bus.on(ReviewSubjects.findings.list, async (ctx) => {
      lookupEntered.resolve();
      await releaseLookup.promise;
      ctx.setResult({ findings: [makeFinding('coderabbit:1', 'critical')] });
    });

    const { events, detach } = await activate(bus, TARGET.repository);

    const arriving = bus.emit(ReviewSubjects.findings.arrived, {
      target: TARGET,
      sourceId: 'coderabbit',
      reviewer: 'coderabbit',
      created: 1,
      updated: 0,
    });

    await lookupEntered.promise;
    // Retire the activation while the lookup is still pending.
    await detach();
    releaseLookup.resolve();

    // The arrival's emit must still resolve cleanly: a handler failure would
    // otherwise be reported against the review service's own announcement.
    await expect(arriving).resolves.toBeUndefined();
    await settle();

    expect(events).toEqual([]);

    stopServing();
  });

  it('keeps the arrival emit successful when the findings lookup fails', async () => {
    const bus = createBusInstance();
    const stopServing = bus.on(ReviewSubjects.findings.list, () => {
      throw new Error('findings storage unavailable');
    });
    const { events, detach } = await activate(bus, TARGET.repository);

    await expect(
      bus.emit(ReviewSubjects.findings.arrived, {
        target: TARGET,
        sourceId: 'coderabbit',
        reviewer: 'coderabbit',
        created: 1,
        updated: 0,
      }),
    ).resolves.toBeUndefined();

    expect(events).toEqual([]);

    await detach();
    stopServing();
  });

  it('rejects a binding without a repository parameter', () => {
    const trigger = createCodeRabbitReviewPostedTrigger(createBusInstance());

    expect(trigger.paramsSchema.safeParse({}).success).toBe(false);
    expect(trigger.paramsSchema.safeParse({ repository: '' }).success).toBe(false);
  });
});
