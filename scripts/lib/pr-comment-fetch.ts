import { execSync } from 'node:child_process';
import type { Octokit } from '@octokit/rest';
import type {
  CommentEntry,
  FetchReviewEntriesOptions,
  GraphQLIssueComment,
  GraphQLPullRequestResponse,
  GraphQLReview,
  GraphQLReviewThread,
  PrCoordinates,
  ReviewPageCursors,
} from './pr-comment-types.js';

/** Combined GraphQL query for review threads, review bodies, and issue comments. */
// prettier-ignore
export const PR_REVIEW_QUERY = `query($owner:String!,$repo:String!,$pullNumber:Int!,$threadCursor:String,$reviewCursor:String,$commentCursor:String){
  repository(owner:$owner,name:$repo){pullRequest(number:$pullNumber){
    reviewThreads(first:100,after:$threadCursor){pageInfo{hasNextPage endCursor}nodes{isResolved isOutdated
      comments(first:100){nodes{path line startLine originalLine originalStartLine author{login}body createdAt databaseId replyTo{databaseId}}}}}
    reviews(first:100,after:$reviewCursor){pageInfo{hasNextPage endCursor}nodes{databaseId state body submittedAt author{login}}}
    comments(first:100,after:$commentCursor){pageInfo{hasNextPage endCursor}nodes{databaseId author{login}body createdAt}}
  }}}`;

/**
 * Parse a GitHub PR URL into owner, repo, and pull number.
 * @param url - Full GitHub PR URL (e.g. `https://github.com/owner/repo/pull/123`)
 * @returns Parsed coordinates
 * @throws If the URL does not match the expected GitHub PR pattern
 */
export function parsePrUrl(url: string): PrCoordinates {
  const match = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!match) {
    throw new Error(`Invalid PR URL: ${url}`);
  }
  return { owner: match[1], repo: match[2], pullNumber: Number(match[3]) };
}

/**
 * Resolve a GitHub auth token via the `gh` CLI.
 * @returns Auth token string
 * @throws If the `gh` CLI is not authenticated
 */
export function getGhToken(): string {
  try {
    return execSync('gh auth token', { encoding: 'utf-8' }).trim();
  } catch {
    throw new Error('Could not resolve GitHub token. Run `gh auth login` first.');
  }
}

/**
 * Build a stable storage key for a pull request.
 * @param coords - Parsed pull request coordinates
 * @returns Stable key for the PR
 */
export function pullRequestStateKey(coords: PrCoordinates): string {
  return `${coords.owner}/${coords.repo}#${coords.pullNumber}`;
}

/**
 * Fetch one combined GraphQL page of review threads, review bodies, and issue comments.
 * @param octokit - Authenticated Octokit instance
 * @param coords - PR coordinates
 * @param cursors - Pagination cursors for the request
 * @returns One combined response page
 */
async function fetchReviewPage(
  octokit: Octokit,
  coords: PrCoordinates,
  cursors: ReviewPageCursors,
): Promise<GraphQLPullRequestResponse> {
  return octokit.graphql(PR_REVIEW_QUERY, {
    owner: coords.owner,
    repo: coords.repo,
    pullNumber: coords.pullNumber,
    threadCursor: cursors.threadCursor,
    reviewCursor: cursors.reviewCursor,
    commentCursor: cursors.commentCursor,
  });
}

/**
 * Add inline thread comments from a GraphQL page into the unified entry list.
 * @param entries - Target output list
 * @param threads - Review threads from the current page
 * @param options - Filter options for resolved and outdated comments
 */
function appendThreadEntries(
  entries: CommentEntry[],
  threads: GraphQLReviewThread[],
  options: FetchReviewEntriesOptions,
): void {
  for (const thread of threads) {
    if (thread.isResolved && !options.includeResolved) {
      continue;
    }
    if (thread.isOutdated && !options.includeOutdated) {
      continue;
    }

    for (const comment of thread.comments.nodes) {
      entries.push({
        id: `file:${comment.databaseId}`,
        kind: 'file',
        path: comment.path,
        line: comment.line ?? comment.originalLine ?? 0,
        startLine: comment.startLine ?? comment.originalStartLine ?? null,
        author: comment.author?.login ?? 'unknown',
        body: comment.body,
        createdAt: comment.createdAt,
        inReplyToId: comment.replyTo?.databaseId ?? null,
      });
    }
  }
}

/**
 * Add PR-level review bodies from a GraphQL page into the unified entry list.
 * @param entries - Target output list
 * @param reviews - PR reviews from the current page
 */
function appendReviewBodyEntries(entries: CommentEntry[], reviews: GraphQLReview[]): void {
  for (const review of reviews) {
    if (!review.body?.trim() || !review.submittedAt) {
      continue;
    }

    entries.push({
      id: review.databaseId === null ? `review:${review.submittedAt}` : `review:${review.databaseId}`,
      kind: 'review',
      author: review.author?.login ?? 'unknown',
      body: review.body,
      createdAt: review.submittedAt,
      state: review.state,
    });
  }
}

/**
 * Add PR timeline issue comments from a GraphQL page into the unified entry list.
 * @param entries - Target output list
 * @param comments - Issue comments from the current page
 */
function appendIssueCommentEntries(entries: CommentEntry[], comments: GraphQLIssueComment[]): void {
  for (const comment of comments) {
    if (!comment.body?.trim()) {
      continue;
    }

    entries.push({
      id: `comment:${comment.databaseId}`,
      kind: 'comment',
      author: comment.author?.login ?? 'unknown',
      body: comment.body,
      createdAt: comment.createdAt,
    });
  }
}

/**
 * Fetch review comments, PR review bodies, and issue comments using GraphQL pagination.
 * @param octokit - Authenticated Octokit instance
 * @param coords - PR coordinates
 * @param options - Filter options for resolved and outdated comments
 * @returns Combined review entries sorted by creation time
 */
export async function fetchReviewEntries(
  octokit: Octokit,
  coords: PrCoordinates,
  options: FetchReviewEntriesOptions,
): Promise<CommentEntry[]> {
  const entries: CommentEntry[] = [];
  const cursors: ReviewPageCursors = { threadCursor: null, reviewCursor: null, commentCursor: null };
  let hasMoreThreads = true;
  let hasMoreReviews = true;
  let hasMoreComments = true;

  while (hasMoreThreads || hasMoreReviews || hasMoreComments) {
    const response = await fetchReviewPage(octokit, coords, cursors);

    if (hasMoreThreads) {
      appendThreadEntries(entries, response.repository.pullRequest.reviewThreads.nodes, options);
    }
    if (hasMoreReviews) {
      appendReviewBodyEntries(entries, response.repository.pullRequest.reviews.nodes);
    }
    if (hasMoreComments) {
      appendIssueCommentEntries(entries, response.repository.pullRequest.comments.nodes);
    }

    const threadPageInfo = response.repository.pullRequest.reviewThreads.pageInfo;
    hasMoreThreads = threadPageInfo.hasNextPage;
    cursors.threadCursor = threadPageInfo.endCursor;

    const reviewPageInfo = response.repository.pullRequest.reviews.pageInfo;
    hasMoreReviews = reviewPageInfo.hasNextPage;
    cursors.reviewCursor = reviewPageInfo.endCursor;

    const commentPageInfo = response.repository.pullRequest.comments.pageInfo;
    hasMoreComments = commentPageInfo.hasNextPage;
    cursors.commentCursor = commentPageInfo.endCursor;
  }

  return entries.sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());
}
