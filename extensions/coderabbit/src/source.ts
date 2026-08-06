import type { IMakaioBus } from '@makaio/bus-core';
import type {
  FetchFindingsParams,
  IReviewSource,
  ReviewRequestContext,
  ReviewSourceRateLimit,
  ReviewSourceSnapshot,
} from '@makaio/contracts';
import { VCSSubjects } from '@makaio/contracts';
import { codeRabbitProcessor } from './processor.js';

/**
 * Reviewer family carried by every CodeRabbit finding.
 *
 * Shared with the CodeRabbit automation trigger so the source that produces
 * findings and the trigger that observes them cannot disagree about the family.
 */
export const CODERABBIT_REVIEWER = 'coderabbit';

/**
 * CodeRabbit review source — fetches CodeRabbit findings from any VCS provider.
 *
 * Decoupled from GitHub-specific APIs; uses VCS bus subjects for portability
 * across GitHub, GitLab, and other VCS providers.
 */
export class CodeRabbitSource implements IReviewSource {
  public readonly id = 'coderabbit';
  public readonly displayName = 'CodeRabbit';
  public readonly capabilityId = 'review-source' as const;
  public readonly reviewer = CODERABBIT_REVIEWER;
  public readonly preferredProcessorKey = 'makaio/coderabbit';

  /**
   * Source capability flags.
   *
   * `canTrigger` is `false` because triggering CodeRabbit requires posting an
   * issue comment (`@coderabbitai review`), which is not yet modelled as a bus
   * subject. Add a `vcs.issueComments.post` subject and flip this flag when
   * that subject exists.
   */
  public readonly capabilities = {
    canTrigger: false,
    canFetch: true,
    isPush: false,
  } as const;

  /**
   * Create a new VCS-agnostic CodeRabbit source.
   * @param bus - The application bus for VCS subject requests.
   */
  public constructor(private readonly bus: IMakaioBus) {}

  /**
   * Fetches a snapshot of CodeRabbit review comments and reviews for a PR.
   *
   * Requests both inline review comments and the PR detail (with full review
   * bodies) in parallel, then filters each collection to CodeRabbit bot authors.
   * @param params - The fetch parameters including VCS routing context.
   * @returns A snapshot filtered to CodeRabbit bot comments and reviews.
   * @throws Error if the target has no PR number.
   */
  public async fetchSnapshot(params: FetchFindingsParams & ReviewRequestContext): Promise<ReviewSourceSnapshot> {
    if (params.target.prNumber === undefined) {
      throw new Error('CodeRabbit source requires a PR number');
    }

    const { repoPath } = params;

    const [commentsResult, prResult] = await Promise.all([
      this.bus.request(VCSSubjects.comments.list, { repoPath, prNumber: params.target.prNumber }),
      this.bus.request(VCSSubjects.pr.get, { repoPath, prNumber: params.target.prNumber }),
    ]);

    return {
      sourceId: this.id,
      reviewer: this.reviewer,
      target: params.target,
      comments: commentsResult.comments.filter((c) => codeRabbitProcessor.botAuthors.includes(c.author)),
      reviews: (prResult.pullRequest?.reviews ?? []).filter((r) => codeRabbitProcessor.botAuthors.includes(r.author)),
    };
  }

  /**
   * Returns the rate limit for CodeRabbit API requests.
   *
   * Rate limit is parsed from HTML comments by the processor. The source does
   * not own rate limit state directly.
   * @returns Null — CodeRabbit rate limits are not tracked at the source level.
   */
  public getRateLimit(): ReviewSourceRateLimit | null {
    return null;
  }
}
