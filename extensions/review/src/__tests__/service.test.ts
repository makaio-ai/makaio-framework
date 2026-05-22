import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { CapabilityService } from '@makaio/services-core/capability';
import {
  CapabilitySubjects,
  REVIEW_SOURCE_CAPABILITY_ID,
  REVIEWER_PROCESSOR_CAPABILITY_ID,
  ReviewSubjects,
} from '@makaio/contracts';
import type {
  FindingTarget,
  IReviewerProcessor,
  IReviewSource,
  ReviewFinding,
  ReviewSourceSnapshot,
  VCSReviewComment,
} from '@makaio/contracts';
import { ReviewFindingsService } from '../service.js';
import { ReviewStorageSubjects } from '../storage/namespace.js';

const TARGET: FindingTarget = { repository: 'owner/repo', prNumber: 42 };
const NOW = 1_700_000_000_000;

interface Harness {
  bus: IMakaioBus;
  capabilityService: CapabilityService;
  service: ReviewFindingsService;
  store: Map<string, ReviewFinding>;
  cleanup: () => void;
}

/**
 * Create a valid review finding fixture.
 * @param overrides - Fields to override on the default finding
 * @returns Review finding fixture
 */
function makeFinding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    id: 'source-a:inline:1',
    target: TARGET,
    sourceId: 'source-a',
    reviewer: 'alpha',
    origin: 'inline',
    threadId: null,
    severity: 'minor',
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
    ...overrides,
  };
}

/**
 * Build an inline VCS review comment fixture for processor tests.
 * @param id - Comment ID
 * @param overrides - Fields to override on the default comment
 * @returns VCS review comment fixture
 */
function makeComment(id: number, overrides: Partial<VCSReviewComment> = {}): VCSReviewComment {
  return {
    id,
    author: 'reviewer[bot]',
    body: `Finding ${id}`,
    path: 'src/file.ts',
    line: id,
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    inReplyToId: null,
    threadId: null,
    isResolved: false,
    ...overrides,
  };
}

/**
 * Create a fetch-only review source fixture.
 * @param id - Source ID
 * @param reviewer - Reviewer family
 * @param comments - Comments returned by fetchSnapshot
 * @returns Review source fixture
 */
function makeSource(id: string, reviewer: string, comments: VCSReviewComment[]): IReviewSource {
  return {
    id,
    displayName: id,
    capabilityId: 'review-source',
    reviewer,
    capabilities: { canTrigger: false, canFetch: true, isPush: false },
    async fetchSnapshot(params): Promise<ReviewSourceSnapshot> {
      return {
        sourceId: id,
        reviewer,
        target: params.target,
        comments,
        reviews: [],
      };
    },
  };
}

/**
 * Create a processor that maps each comment to a deterministic finding.
 * @param reviewer - Reviewer family handled by the processor
 * @returns Reviewer processor fixture
 */
function makeProcessor(reviewer: string): IReviewerProcessor {
  return {
    id: `${reviewer}-processor`,
    displayName: `${reviewer} processor`,
    capabilityId: 'reviewer-processor',
    reviewer,
    processorKey: `test/${reviewer}`,
    botAuthors: ['reviewer[bot]'],
    processComments(params): ReviewFinding[] {
      return params.comments.map((comment) =>
        makeFinding({
          id: `${params.sourceId}:inline:${comment.id}`,
          target: params.target,
          sourceId: params.sourceId,
          reviewer,
          message: comment.body,
          startLine: comment.line,
          endLine: comment.line,
          rawCommentId: comment.id,
          status: comment.isResolved ? 'verified' : 'open',
          verifiedAt: comment.isResolved ? NOW : null,
        }),
      );
    },
    processReviewBody() {
      return [];
    },
  };
}

/**
 * Compare a finding target against a query target.
 * @param finding - Stored finding
 * @param target - Query target
 * @returns Whether the finding belongs to the target
 */
function matchesTarget(finding: ReviewFinding, target: FindingTarget): boolean {
  return (
    finding.target.repository === target.repository &&
    (target.prNumber === undefined || finding.target.prNumber === target.prNumber) &&
    (target.branch === undefined || finding.target.branch === target.branch) &&
    (target.headSha === undefined || finding.target.headSha === target.headSha)
  );
}

/**
 * Register in-memory storage handlers for ReviewFindingsService tests.
 * @param bus - Bus instance
 * @param store - Mutable finding store
 * @returns Cleanup function
 */
function registerInMemoryStorage(bus: IMakaioBus, store: Map<string, ReviewFinding>): () => void {
  const cleanups = [
    bus.on(ReviewStorageSubjects.findings.list, (ctx) => {
      const { target, status } = ctx.payload;
      const findings = [...store.values()].filter(
        (finding) => matchesTarget(finding, target) && (status === undefined || finding.status === status),
      );
      ctx.setResult({ findings });
    }),
    bus.on(ReviewStorageSubjects.findings.upsertBatch, (ctx) => {
      for (const finding of ctx.payload.findings) {
        store.set(finding.id, finding);
      }
      ctx.setResult({ upserted: ctx.payload.findings.length });
    }),
    bus.on(ReviewStorageSubjects.findings.upsert, (ctx) => {
      store.set(ctx.payload.finding.id, ctx.payload.finding);
      ctx.setResult({ id: ctx.payload.finding.id });
    }),
    bus.on(ReviewStorageSubjects.findings.get, (ctx) => {
      ctx.setResult({ finding: store.get(ctx.payload.id) ?? null });
    }),
  ];

  return () => cleanups.forEach((cleanup) => cleanup());
}

describe('ReviewFindingsService', () => {
  let harness: Harness;

  beforeEach(async () => {
    const bus = createBusInstance();
    const capabilityService = new CapabilityService(bus);
    const service = new ReviewFindingsService(bus, capabilityService);
    const store = new Map<string, ReviewFinding>();
    const cleanupStorage = registerInMemoryStorage(bus, store);

    await capabilityService.init();
    await service.init();

    harness = {
      bus,
      capabilityService,
      service,
      store,
      cleanup: cleanupStorage,
    };
  });

  afterEach(() => {
    harness.service.destroy();
    harness.capabilityService.destroy();
    harness.cleanup();
  });

  it('reconciles only findings owned by the fetched source', async () => {
    harness.store.set('source-a:inline:1', makeFinding({ id: 'source-a:inline:1', sourceId: 'source-a' }));
    harness.store.set(
      'source-b:inline:1',
      makeFinding({
        id: 'source-b:inline:1',
        sourceId: 'source-b',
        reviewer: 'beta',
        message: 'Other source finding',
      }),
    );

    await harness.bus.emit(CapabilitySubjects.register, {
      capabilityId: REVIEW_SOURCE_CAPABILITY_ID,
      provider: makeSource('source-a', 'alpha', [makeComment(1)]),
    });
    await harness.bus.emit(CapabilitySubjects.register, {
      capabilityId: REVIEWER_PROCESSOR_CAPABILITY_ID,
      provider: makeProcessor('alpha'),
    });

    const result = await harness.bus.request(ReviewSubjects.findings.fetch, {
      target: TARGET,
      repoPath: '/repo',
    });

    expect(result.updated).toBe(0);
    expect(harness.store.get('source-a:inline:1')?.status).toBe('open');
    expect(harness.store.get('source-b:inline:1')?.status).toBe('open');
  });

  it('updates an existing open finding when the fresh source marks the same ID verified', async () => {
    harness.store.set('source-a:inline:1', makeFinding({ id: 'source-a:inline:1', sourceId: 'source-a' }));

    await harness.bus.emit(CapabilitySubjects.register, {
      capabilityId: REVIEW_SOURCE_CAPABILITY_ID,
      provider: makeSource('source-a', 'alpha', [makeComment(1, { isResolved: true })]),
    });
    await harness.bus.emit(CapabilitySubjects.register, {
      capabilityId: REVIEWER_PROCESSOR_CAPABILITY_ID,
      provider: makeProcessor('alpha'),
    });

    const result = await harness.bus.request(ReviewSubjects.findings.fetch, {
      target: TARGET,
      repoPath: '/repo',
    });

    expect(result.updated).toBe(1);
    const updated = harness.store.get('source-a:inline:1')!;
    expect(updated).toMatchObject({
      status: 'verified',
      verifiedAt: NOW,
    });
    expect(updated.updatedAt).toBeGreaterThanOrEqual(NOW);
  });

  it('keeps an existing verified finding verified when the fresh source still reports it verified', async () => {
    harness.store.set(
      'source-a:inline:1',
      makeFinding({
        id: 'source-a:inline:1',
        sourceId: 'source-a',
        status: 'verified',
        verifiedAt: NOW - 1000,
      }),
    );

    await harness.bus.emit(CapabilitySubjects.register, {
      capabilityId: REVIEW_SOURCE_CAPABILITY_ID,
      provider: makeSource('source-a', 'alpha', [makeComment(1, { isResolved: true })]),
    });
    await harness.bus.emit(CapabilitySubjects.register, {
      capabilityId: REVIEWER_PROCESSOR_CAPABILITY_ID,
      provider: makeProcessor('alpha'),
    });

    const result = await harness.bus.request(ReviewSubjects.findings.fetch, {
      target: TARGET,
      repoPath: '/repo',
    });

    expect(result.updated).toBe(0);
    expect(harness.store.get('source-a:inline:1')).toMatchObject({
      status: 'verified',
      verifiedAt: NOW - 1000,
    });
  });

  it('preserves user-dismissed status when the source re-fetches the same finding as open', async () => {
    harness.store.set(
      'source-a:inline:1',
      makeFinding({
        id: 'source-a:inline:1',
        sourceId: 'source-a',
        status: 'dismissed',
        dismissedReason: 'false positive',
      }),
    );

    await harness.bus.emit(CapabilitySubjects.register, {
      capabilityId: REVIEW_SOURCE_CAPABILITY_ID,
      provider: makeSource('source-a', 'alpha', [makeComment(1)]),
    });
    await harness.bus.emit(CapabilitySubjects.register, {
      capabilityId: REVIEWER_PROCESSOR_CAPABILITY_ID,
      provider: makeProcessor('alpha'),
    });

    const result = await harness.bus.request(ReviewSubjects.findings.fetch, {
      target: TARGET,
      repoPath: '/repo',
    });

    expect(result.updated).toBe(0);
    expect(harness.store.get('source-a:inline:1')).toMatchObject({
      status: 'dismissed',
      dismissedReason: 'false positive',
    });
  });

  it('rejects status updates for findings outside the requested target', async () => {
    harness.store.set(
      'finding-1',
      makeFinding({
        id: 'finding-1',
        target: { repository: 'owner/repo', prNumber: 42, headSha: 'head-a' },
      }),
    );

    await expect(
      harness.bus.request(ReviewSubjects.finding.updateStatus, {
        findingId: 'finding-1',
        target: { repository: 'owner/repo', prNumber: 42, headSha: 'head-b' },
        status: 'dismissed',
      }),
    ).rejects.toThrow('Finding finding-1 does not belong to requested target');

    expect(harness.store.get('finding-1')?.status).toBe('open');
  });

  it('submits agent-produced findings as open lifecycle entries', async () => {
    const staleInput = makeFinding({
      id: 'agent:finding:1',
      status: 'dismissed',
      dismissedReason: 'stale input',
    });
    const result = await harness.bus.request(ReviewSubjects.findings.submit, {
      finding: {
        id: staleInput.id,
        target: staleInput.target,
        sourceId: staleInput.sourceId,
        reviewer: staleInput.reviewer,
        origin: staleInput.origin,
        threadId: staleInput.threadId,
        severity: staleInput.severity,
        file: staleInput.file,
        startLine: staleInput.startLine,
        endLine: staleInput.endLine,
        message: staleInput.message,
        agentPrompt: staleInput.agentPrompt,
        suggestedChanges: staleInput.suggestedChanges,
        status: staleInput.status,
        dismissedReason: staleInput.dismissedReason,
        rawCommentId: staleInput.rawCommentId,
      },
    });

    expect(result.finding.status).toBe('open');
    expect(result.finding.dismissedReason).toBeNull();
    expect(result.finding.addressedBy).toBeNull();
    expect(result.finding.addressedAt).toBeNull();
    expect(result.finding.verifiedAt).toBeNull();
    expect(harness.store.get('agent:finding:1')).toEqual(result.finding);
  });

  it('keeps lifecycle metadata scoped to the current finding status', async () => {
    harness.store.set(
      'finding-1',
      makeFinding({
        id: 'finding-1',
        status: 'dismissed',
        dismissedReason: 'not relevant',
        addressedBy: 'abc123',
        addressedAt: NOW,
        verifiedAt: NOW,
      }),
    );

    const addressed = await harness.bus.request(ReviewSubjects.finding.updateStatus, {
      findingId: 'finding-1',
      target: TARGET,
      status: 'addressed',
      addressedBy: 'fix-commit',
    });

    expect(addressed.finding.status).toBe('addressed');
    expect(addressed.finding.addressedBy).toBe('fix-commit');
    expect(addressed.finding.addressedAt).toEqual(expect.any(Number));
    expect(addressed.finding.dismissedReason).toBeNull();
    expect(addressed.finding.verifiedAt).toBeNull();

    const reopened = await harness.bus.request(ReviewSubjects.finding.updateStatus, {
      findingId: 'finding-1',
      target: TARGET,
      status: 'open',
    });

    expect(reopened.finding.status).toBe('open');
    expect(reopened.finding.addressedBy).toBeNull();
    expect(reopened.finding.addressedAt).toBeNull();
    expect(reopened.finding.dismissedReason).toBeNull();
    expect(reopened.finding.verifiedAt).toBeNull();
  });
});
