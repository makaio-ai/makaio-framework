import type { IMakaioBus } from '@makaio/bus-core';
import type { CapabilityService } from '@makaio/services-core/capability';
import { BaseService } from '@makaio/service-base';
import {
  CapabilitySubjects,
  ReviewSubjects,
  REVIEW_SOURCE_CAPABILITY_ID,
  REVIEWER_PROCESSOR_CAPABILITY_ID,
} from '@makaio/contracts';
import type {
  IReviewSource,
  IReviewerProcessor,
  ReviewFinding,
  ReviewSourceSnapshot,
  FindingTarget,
  ReviewSourceRateLimit,
} from '@makaio/contracts';
import { ReviewStorageSubjects } from './storage/namespace.js';

/**
 * Resolves the best processor for a given reviewer family and optional
 * preferred processor key.
 *
 * Selection strategy (AD-13, priority-based with deterministic override):
 * 1. If `preferredKey` matches a registered processor, return that processor.
 * 2. Otherwise, return the processor with the highest `priority` (default 0).
 * 3. Ties are broken deterministically by processorKey lexicographic order.
 * @param processors - All registered processors for the reviewer family
 * @param preferredKey - Optional preferred processor key from the source
 * @returns The resolved processor, or null when none are registered
 */
function resolveProcessor(
  processors: IReviewerProcessor[],
  preferredKey: string | undefined,
): IReviewerProcessor | null {
  if (processors.length === 0) return null;

  if (preferredKey !== undefined) {
    const preferred = processors.find((p) => p.processorKey === preferredKey);
    if (preferred !== undefined) return preferred;
  }

  // Safe: array is non-empty after the guard above.
  const [first, ...rest] = processors;
  return rest.reduce<IReviewerProcessor>((best, candidate) => {
    const bestPriority = best.priority ?? 0;
    const candidatePriority = candidate.priority ?? 0;
    if (candidatePriority > bestPriority) return candidate;
    if (candidatePriority === bestPriority && candidate.processorKey < best.processorKey) return candidate;
    return best;
  }, first);
}

/**
 * Extracts normalized findings from a snapshot using the given processor.
 * @param snapshot - Raw data snapshot from a source
 * @param processor - Processor to transform raw data into findings
 * @returns All findings extracted from the snapshot
 */
function extractFindings(snapshot: ReviewSourceSnapshot, processor: IReviewerProcessor): ReviewFinding[] {
  const findings: ReviewFinding[] = [];

  findings.push(
    ...processor.processComments({
      sourceId: snapshot.sourceId,
      target: snapshot.target,
      comments: snapshot.comments,
    }),
  );

  findings.push(
    ...processor.processReviewBody({
      sourceId: snapshot.sourceId,
      target: snapshot.target,
      reviews: snapshot.reviews,
    }),
  );

  if (snapshot.issueComments !== undefined && processor.processIssueComments !== undefined) {
    findings.push(
      ...processor.processIssueComments({
        sourceId: snapshot.sourceId,
        target: snapshot.target,
        issueComments: snapshot.issueComments,
      }),
    );
  }

  if (snapshot.cliOutput !== undefined && processor.processCliOutput !== undefined) {
    findings.push(
      ...processor.processCliOutput({
        sourceId: snapshot.sourceId,
        target: snapshot.target,
        cliOutput: snapshot.cliOutput,
      }),
    );
  }

  return findings;
}

/**
 * Return whether a stored finding belongs to the requested target scope.
 *
 * Optional target fields behave as filters: callers that provide only a
 * repository/PR can update any finding in that PR, while callers that include
 * branch or headSha get isolation for that narrower scope.
 * @param finding - Stored finding to check
 * @param target - Requested target scope
 * @returns True when the finding belongs to the requested target
 */
function findingMatchesTarget(finding: ReviewFinding, target: FindingTarget): boolean {
  return (
    finding.target.repository === target.repository &&
    (target.prNumber === undefined || finding.target.prNumber === target.prNumber) &&
    (target.branch === undefined || finding.target.branch === target.branch) &&
    (target.headSha === undefined || finding.target.headSha === target.headSha)
  );
}

/**
 * Build a status update with lifecycle metadata that belongs only to the new
 * status.
 * @param existing - Stored finding before the transition
 * @param status - New lifecycle status
 * @param now - Transition timestamp
 * @param reason - Optional dismissal or deferral reason
 * @param addressedBy - Optional address metadata
 * @returns Finding updated for the requested lifecycle state
 */
function transitionFindingStatus(
  existing: ReviewFinding,
  status: ReviewFinding['status'],
  now: number,
  reason?: string,
  addressedBy?: string,
): ReviewFinding {
  const base: ReviewFinding = {
    ...existing,
    status,
    updatedAt: now,
    dismissedReason: null,
    addressedBy: null,
    addressedAt: null,
    verifiedAt: null,
  };

  if (status === 'addressed') {
    return { ...base, addressedBy: addressedBy ?? null, addressedAt: now };
  }

  if (status === 'verified') {
    return { ...base, verifiedAt: now };
  }

  if (status === 'dismissed' || status === 'deferred') {
    return { ...base, dismissedReason: reason ?? null };
  }

  return base;
}

/**
 * Service that manages review findings.
 *
 * Maintains typed registries of IReviewSource and IReviewerProcessor
 * providers discovered via CapabilityService. Handles the full fetch
 * lifecycle: snapshot fetch → processor selection → finding extraction
 * → reconciliation → persistence.
 *
 * Reconciliation rules:
 * - Findings absent from new snapshot that were `open` → `verified` (addressed)
 * - Findings present in new snapshot that were `verified`/`addressed` → `open` (re-raised)
 * - New findings not previously stored → persisted as `open`
 */
export class ReviewFindingsService extends BaseService {
  private readonly sources = new Map<string, IReviewSource>();
  private readonly processors = new Map<string, IReviewerProcessor[]>();

  /**
   * Constructs the ReviewFindingsService.
   * @param bus - The Makaio bus for event handling
   * @param capabilityService - The capability service for provider discovery
   */
  public constructor(
    bus: IMakaioBus,
    private readonly capabilityService: CapabilityService,
  ) {
    super(bus);
  }

  /**
   * Initialize the service.
   *
   * Loads existing providers from CapabilityService, then listens for
   * future capability registrations. Registers handlers for all review.*
   * bus subjects.
   */
  protected onInit(): void {
    this.loadExistingProviders();
    this.registerCapabilityListeners();
    this.registerReviewHandlers();
  }

  /**
   * Load providers already registered before this service started.
   */
  private loadExistingProviders(): void {
    const existingSources = this.capabilityService.getProviders(REVIEW_SOURCE_CAPABILITY_ID) as IReviewSource[];
    for (const source of existingSources) {
      this.sources.set(source.id, source);
    }

    const existingProcessors = this.capabilityService.getProviders(
      REVIEWER_PROCESSOR_CAPABILITY_ID,
    ) as IReviewerProcessor[];
    for (const processor of existingProcessors) {
      this.addProcessor(processor);
    }
  }

  /**
   * Listen for capability register/unregister events for sources and processors.
   */
  private registerCapabilityListeners(): void {
    this.registerHandler(CapabilitySubjects.register, (ctx) => {
      const { capabilityId } = ctx.payload;
      // provider is typed as unknown at the Zod boundary; type safety is
      // enforced by the registration helpers (registerReviewSource /
      // registerReviewerProcessor), not by Zod.
      const provider = ctx.payload.provider as { id: string };

      if (capabilityId === REVIEW_SOURCE_CAPABILITY_ID) {
        this.sources.set(provider.id, provider as IReviewSource);
      } else if (capabilityId === REVIEWER_PROCESSOR_CAPABILITY_ID) {
        this.addProcessor(provider as IReviewerProcessor);
      }
    });

    this.registerHandler(CapabilitySubjects.unregister, (ctx) => {
      const { capabilityId, providerId } = ctx.payload;

      if (capabilityId === REVIEW_SOURCE_CAPABILITY_ID) {
        this.sources.delete(providerId);
      } else if (capabilityId === REVIEWER_PROCESSOR_CAPABILITY_ID) {
        this.removeProcessor(providerId);
      }
    });
  }

  /**
   * Add a processor to the reviewer-keyed registry.
   * @param processor - The processor to register
   */
  private addProcessor(processor: IReviewerProcessor): void {
    const bucket = this.processors.get(processor.reviewer) ?? [];
    const existing = bucket.findIndex((p) => p.id === processor.id);
    if (existing >= 0) {
      bucket[existing] = processor;
    } else {
      bucket.push(processor);
    }
    this.processors.set(processor.reviewer, bucket);
  }

  /**
   * Remove a processor by its provider ID.
   * @param providerId - The provider ID to remove
   */
  private removeProcessor(providerId: string): void {
    for (const [reviewer, bucket] of this.processors) {
      const filtered = bucket.filter((p) => p.id !== providerId);
      if (filtered.length === 0) {
        this.processors.delete(reviewer);
      } else if (filtered.length !== bucket.length) {
        this.processors.set(reviewer, filtered);
      }
    }
  }

  /**
   * Register bus handlers for review.* subjects.
   */
  private registerReviewHandlers(): void {
    // List stored findings
    this.registerHandler(ReviewSubjects.findings.list, async (ctx) => {
      const { target, status } = ctx.payload;
      const result = await this.bus.request(ReviewStorageSubjects.findings.list, {
        target,
        status,
      });
      ctx.setResult({ findings: result.findings });
    });

    // Fetch findings from external sources and reconcile
    this.registerHandler(ReviewSubjects.findings.fetch, async (ctx) => {
      const { target, repoPath } = ctx.payload;
      const { created, updated } = await this.fetchAndReconcile(target, repoPath);
      const { findings } = await this.bus.request(ReviewStorageSubjects.findings.list, {
        target,
      });
      ctx.setResult({ findings, created, updated });
    });

    // Trigger a review on a source
    this.registerHandler(ReviewSubjects.start, async (ctx) => {
      const { target, repoPath, sourceId } = ctx.payload;
      const result = await this.triggerReview(target, repoPath, sourceId);
      ctx.setResult(result);
    });

    // Submit an agent-produced finding
    this.registerHandler(ReviewSubjects.findings.submit, async (ctx) => {
      const now = Date.now();
      const input = ctx.payload.finding;
      const finding: ReviewFinding = {
        ...input,
        status: 'open',
        createdAt: input.createdAt ?? now,
        updatedAt: input.updatedAt ?? now,
        dismissedReason: null,
        verifiedAt: null,
        addressedAt: null,
        addressedBy: null,
      };

      await this.bus.request(ReviewStorageSubjects.findings.upsert, { finding });
      ctx.setResult({ finding });
    });

    // Update finding lifecycle status
    this.registerHandler(ReviewSubjects.finding.updateStatus, async (ctx) => {
      const { findingId, target, status, reason, addressedBy } = ctx.payload;
      const { finding: existing } = await this.bus.request(ReviewStorageSubjects.findings.get, {
        id: findingId,
      });

      if (existing === null) {
        throw new Error(`Finding not found: ${findingId}`);
      }

      if (!findingMatchesTarget(existing, target)) {
        throw new Error(`Finding ${findingId} does not belong to requested target`);
      }

      const previousStatus = existing.status;
      const now = Date.now();
      const updated = transitionFindingStatus(existing, status, now, reason, addressedBy);

      await this.bus.request(ReviewStorageSubjects.findings.upsert, { finding: updated });

      await this.bus.emit(ReviewSubjects.finding.statusChanged, {
        finding: updated,
        previousStatus,
      });

      ctx.setResult({ success: true, finding: updated });
    });

    // List available sources
    this.registerHandler(ReviewSubjects.source.list, (ctx) => {
      const rateLimits: ReviewSourceRateLimit[] = [...this.sources.values()]
        .map((s) => s.getRateLimit?.() ?? null)
        .filter((rl): rl is ReviewSourceRateLimit => rl !== null);

      const sources = [...this.sources.values()].map((source) => {
        const bucket = this.processors.get(source.reviewer) ?? [];
        const resolved = resolveProcessor(bucket, source.preferredProcessorKey);
        const allKeys = bucket.map((p) => p.processorKey);
        const shadowedProcessors = resolved !== null ? allKeys.filter((k) => k !== resolved.processorKey) : allKeys;

        return {
          sourceId: source.id,
          reviewer: source.reviewer,
          displayName: source.displayName,
          capabilities: source.capabilities,
          processorKey: resolved?.processorKey ?? null,
          shadowedProcessors,
        };
      });

      ctx.setResult({ sources, rateLimits });
    });
  }

  /**
   * Fetch snapshots from all (or one) sources, extract findings, reconcile,
   * and persist differences.
   * @param target - The PR/branch target to fetch for
   * @param repoPath - Local filesystem path for VCS provider routing
   * @param sourceId - Optional specific source; all sources when omitted
   * @returns Counts of created and updated findings
   */
  private async fetchAndReconcile(
    target: FindingTarget,
    repoPath: string,
    sourceId?: string,
  ): Promise<{ created: number; updated: number }> {
    const sourcesToFetch =
      sourceId !== undefined
        ? [this.sources.get(sourceId)].filter((s): s is IReviewSource => s !== undefined)
        : [...this.sources.values()].filter((s) => s.capabilities.canFetch);

    const { findings: existing } = await this.bus.request(ReviewStorageSubjects.findings.list, {
      target,
    });

    let created = 0;
    let updated = 0;

    for (const source of sourcesToFetch) {
      if (source.fetchSnapshot === undefined) continue;

      const snapshot = await source.fetchSnapshot({ target, repoPath });
      const bucket = this.processors.get(source.reviewer) ?? [];
      const processor = resolveProcessor(bucket, source.preferredProcessorKey);
      if (processor === null) {
        console.warn(`[review] No processor found for reviewer: ${source.reviewer}`);
        continue;
      }

      const fresh = extractFindings(snapshot, processor);
      const sourceExisting = existing.filter((finding) => finding.sourceId === source.id);
      const { c, u } = await this.reconcile(sourceExisting, fresh);
      created += c;
      updated += u;
    }

    if (created > 0 || updated > 0) {
      await this.bus.emit(ReviewSubjects.findings.arrived, {
        target,
        created,
        updated,
      });
    }

    return { created, updated };
  }

  /**
   * Reconcile existing stored findings against a fresh set from a source.
   *
   * Rules:
   * - New IDs not in storage → upsert as-is (open).
   * - Existing open findings whose IDs are absent from fresh → mark `verified`.
   * - Existing verified/addressed findings whose IDs appear in fresh as open → re-open.
   * - Existing open findings whose fresh counterpart reports `verified` → mark `verified`.
   * - User-owned statuses (`dismissed`, `deferred`) are never overridden by fresh data.
   * @param existing - Currently stored findings for this target
   * @param fresh - Freshly extracted findings from the source
   * @returns Counts of created and updated records
   */
  private async reconcile(existing: ReviewFinding[], fresh: ReviewFinding[]): Promise<{ c: number; u: number }> {
    const existingById = new Map(existing.map((f) => [f.id, f]));
    const freshById = new Map(fresh.map((f) => [f.id, f]));
    const now = Date.now();
    const toUpsert: ReviewFinding[] = [];

    // New findings not previously stored
    for (const finding of fresh) {
      if (!existingById.has(finding.id)) {
        toUpsert.push(finding);
      }
    }

    // Existing findings that need status transitions
    for (const storedFinding of existingById.values()) {
      const freshFinding = freshById.get(storedFinding.id);
      const inFresh = freshFinding !== undefined;

      if (!inFresh && storedFinding.status === 'open') {
        // Finding resolved externally → mark verified
        toUpsert.push({
          ...storedFinding,
          status: 'verified',
          verifiedAt: now,
          updatedAt: now,
        });
      } else if (
        freshFinding !== undefined &&
        freshFinding.status === 'open' &&
        (storedFinding.status === 'verified' || storedFinding.status === 'addressed')
      ) {
        // Finding re-raised → re-open
        toUpsert.push({
          ...freshFinding,
          status: 'open',
          verifiedAt: null,
          addressedAt: null,
          addressedBy: null,
          createdAt: storedFinding.createdAt,
          updatedAt: now,
        });
      } else if (freshFinding !== undefined && storedFinding.status === 'open' && freshFinding.status === 'verified') {
        // Source reports resolved (e.g., isResolved on the VCS comment) → verify
        toUpsert.push({
          ...storedFinding,
          status: 'verified',
          verifiedAt: freshFinding.verifiedAt ?? now,
          updatedAt: now,
        });
      }
    }

    if (toUpsert.length > 0) {
      await this.bus.request(ReviewStorageSubjects.findings.upsertBatch, {
        findings: toUpsert,
      });
    }

    const createdIds = new Set(fresh.map((f) => f.id).filter((id) => !existingById.has(id)));
    return {
      c: createdIds.size,
      u: toUpsert.length - createdIds.size,
    };
  }

  /**
   * Trigger a review on a specific source (or the first triggerable source).
   *
   * Checks rate limits before triggering.
   * @param target - The PR/branch target to trigger for
   * @param repoPath - Local filesystem path for VCS provider routing
   * @param sourceId - Optional specific source to trigger
   * @returns Trigger result including rate limit state
   */
  private async triggerReview(
    target: FindingTarget,
    repoPath: string,
    sourceId?: string,
  ): Promise<{
    triggered: boolean;
    estimatedDelayMs?: number;
    rateLimit: ReviewSourceRateLimit | null;
  }> {
    const source =
      sourceId !== undefined
        ? this.sources.get(sourceId)
        : [...this.sources.values()].find((s) => s.capabilities.canTrigger && s.trigger !== undefined);

    if (source === undefined || source.trigger === undefined) {
      return { triggered: false, rateLimit: null };
    }

    const rateLimit = source.getRateLimit?.() ?? null;
    if (rateLimit !== null && rateLimit.remaining === 0) {
      return { triggered: false, rateLimit };
    }

    const result = await source.trigger({ target, repoPath });

    if (result.triggered) {
      await this.bus.emit(ReviewSubjects.started, {
        target,
        sourceId: source.id,
      });
    }

    return result;
  }

  /**
   * Clear provider registries on destroy.
   */
  protected onDestroy(): void {
    this.sources.clear();
    this.processors.clear();
  }
}
