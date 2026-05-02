import { BaseService } from '@makaio/service-base';
import { VCSSubjects, ReviewSubjects, VCSPRSubjects } from '@makaio/contracts';
import type { PullRequestState, ReviewFinding } from '@makaio/contracts';
import type { IMakaioBus } from '@makaio/bus-core';
import { LRUCache } from './lru-cache.js';
import {
  computeChecksSummary,
  computeReviewsSummary,
  computeFindingsSummary,
  classifyLabels,
  computeReadiness,
} from './aggregators.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of PR states held in the in-memory cache. */
const CACHE_MAX_SIZE = 64;

/** Cache TTL — entries expire after 2 minutes. */
const CACHE_TTL_MS = 2 * 60 * 1_000;

// ---------------------------------------------------------------------------
// Cache key
// ---------------------------------------------------------------------------

/**
 * Build a stable string key for a `(repoPath, prNumber)` pair.
 * @param repoPath - Local filesystem path to the repository
 * @param prNumber - Pull request number
 * @returns Stable cache key string
 */
function prCacheKey(repoPath: string, prNumber: number): string {
  return `${repoPath}::${prNumber}`;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * VCS:PR aggregation service.
 *
 * Registers bus handlers for `vcs:pr.get`, `vcs:pr.list`, and `vcs:pr.sync`.
 * On each request it fetches raw VCS data in parallel and assembles a rich
 * `PullRequestState`. An in-memory LRU cache avoids redundant fetches during
 * list operations.
 *
 * This service is stateless with respect to persistence — it computes on
 * demand and caches in memory only (AD-2).
 */
export class VCSPRAggregationService extends BaseService {
  private readonly cache = new LRUCache<string, PullRequestState>(CACHE_MAX_SIZE, CACHE_TTL_MS);

  /**
   * @param bus - Bus instance for handler registration and request dispatch
   */
  public constructor(bus: IMakaioBus) {
    super(bus);
  }

  /**
   * Register bus handlers for the VCS:PR subjects.
   */
  protected onInit(): void {
    this.registerHandler(VCSPRSubjects.get, async (ctx) => {
      const { repoPath, prNumber } = ctx.payload;
      const pr = await this.aggregatePR(repoPath, prNumber, false);
      ctx.setResult({ pr });
    });

    this.registerHandler(VCSPRSubjects.list, async (ctx) => {
      const { repoPath, branch } = ctx.payload;
      const prs = await this.aggregateList(repoPath, branch);
      ctx.setResult({ prs });
    });

    this.registerHandler(VCSPRSubjects.sync, async (ctx) => {
      const { repoPath, prNumber } = ctx.payload;
      const pr = await this.aggregatePR(repoPath, prNumber, true);
      ctx.setResult({ pr });
    });
  }

  /**
   * Clear the LRU cache on destroy.
   */
  protected override onDestroy(): void {
    this.cache.clear();
  }

  // -------------------------------------------------------------------------
  // Private aggregation logic
  // -------------------------------------------------------------------------

  /**
   * Fetch and aggregate enriched states for all PRs in a repository.
   *
   * PRs that fail to aggregate individually are silently skipped so a partial
   * response is returned rather than failing the entire list.
   * @param repoPath - Local filesystem path to the repository
   * @param branch - Optional branch filter (empty string means all branches)
   * @returns Array of enriched PR states
   */
  private async aggregateList(repoPath: string, branch?: string): Promise<PullRequestState[]> {
    const { pullRequests } = await this.bus.request(VCSSubjects.pr.list, {
      repoPath,
      branch: branch ?? '',
    });

    const results = await Promise.allSettled(pullRequests.map((pr) => this.aggregatePR(repoPath, pr.number, false)));

    const states: PullRequestState[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled') {
        states.push(result.value);
      }
    }
    return states;
  }

  /**
   * Fetch and aggregate the enriched state for a single PR.
   *
   * The result is cached by `(repoPath, prNumber)`. Pass `forceRefresh = true`
   * to bypass and refresh the cache entry.
   * @param repoPath - Local filesystem path to the repository
   * @param prNumber - Pull request number
   * @param forceRefresh - When `true`, bypass and update the cache entry
   * @returns Enriched PR state
   */
  private async aggregatePR(repoPath: string, prNumber: number, forceRefresh: boolean): Promise<PullRequestState> {
    const key = prCacheKey(repoPath, prNumber);

    if (!forceRefresh) {
      const cached = this.cache.get(key);
      if (cached) return cached;
    }

    // Step 1: Fetch the PR to get the head commit SHA
    const { pullRequest } = await this.bus.request(VCSSubjects.pr.get, { repoPath, prNumber });
    if (!pullRequest) {
      throw new Error(`PR #${prNumber} not found in ${repoPath}`);
    }

    const commitSha = pullRequest.head?.sha ?? '';
    const hasHeadSha = commitSha.length > 0;

    // Step 2: Fetch everything else in parallel
    const [checksResult, statusesResult, findingsResult, repoResult] = await Promise.allSettled([
      hasHeadSha ? this.bus.request(VCSSubjects.checks.get, { repoPath, commitSha }) : Promise.resolve({ checks: [] }),
      hasHeadSha
        ? this.bus.request(VCSSubjects.statuses.get, { repoPath, commitSha })
        : Promise.resolve({ statuses: [] }),
      this.bus.requestOptional(ReviewSubjects.findings.list, {
        target: { repository: repoPath, prNumber, headSha: hasHeadSha ? commitSha : undefined },
      }),
      this.bus.request(VCSSubjects.repository.get, { repoPath }),
    ]);

    // Unwrap parallel results with graceful fallbacks
    const checks = checksResult.status === 'fulfilled' ? checksResult.value.checks : [];
    const statuses = statusesResult.status === 'fulfilled' ? statusesResult.value.statuses : [];
    const findings: ReviewFinding[] =
      findingsResult.status === 'fulfilled' && findingsResult.value.handled ? findingsResult.value.data.findings : [];
    const repoMeta = repoResult.status === 'fulfilled' ? repoResult.value.repository : null;
    const repository = repoMeta ? `${repoMeta.owner}/${repoMeta.repo}` : repoPath;

    // Step 3: Compute derived summaries
    const checksSummary = computeChecksSummary(checks, statuses);
    const reviewsSummary = computeReviewsSummary(pullRequest.reviews);
    const findingsSummary = computeFindingsSummary(findings);
    const labels = classifyLabels(pullRequest.labels);
    const readiness = computeReadiness(pullRequest, checksSummary, reviewsSummary, findingsSummary);

    const state: PullRequestState = {
      repository,
      number: pullRequest.number,
      title: pullRequest.title,
      branch: pullRequest.branch,
      baseBranch: pullRequest.baseBranch,
      author: pullRequest.author,
      url: pullRequest.url,
      state: pullRequest.state,
      draft: pullRequest.draft,
      mergeable: pullRequest.mergeable,
      checks: checksSummary,
      reviews: reviewsSummary,
      findings: findingsSummary,
      labels,
      readiness,
      syncedAt: Date.now(),
      headSha: commitSha,
    };

    this.cache.set(key, state);
    return state;
  }
}
