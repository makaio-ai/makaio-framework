import type { CiCheckEntry, PrCoordinates } from './pr-comment-types.js';

export type { CiCheckEntry };

/** Minimal GitHub API surface needed to collect PR CI check failures. */
export interface PrCommentCiClient {
  /** Pull request endpoints. */
  pulls: {
    /** Fetch a pull request by number. */
    get(options: { owner: string; repo: string; pull_number: number }): Promise<{
      data: {
        head: {
          ref: string;
          sha: string;
        };
        created_at?: string;
        updated_at?: string;
      };
    }>;
  };
  /** GitHub Actions endpoints. */
  actions: {
    /** List workflow runs for a branch. */
    listWorkflowRunsForRepo(options: {
      owner: string;
      repo: string;
      branch: string;
      per_page: number;
      page: number;
    }): Promise<{
      data: {
        workflow_runs: Array<{
          id: number;
          name?: string | null;
        }>;
      };
    }>;
    /** Fetch a workflow job by id. */
    getJobForWorkflowRun(options: { owner: string; repo: string; job_id: number }): Promise<{
      data: {
        steps?: Array<{
          name?: string | null;
          conclusion?: string | null;
        }>;
      };
    }>;
  };
  /** GitHub check run endpoints. */
  checks: {
    /** List check runs for a commit ref. */
    listForRef(options: {
      owner: string;
      repo: string;
      ref: string;
      filter: 'latest';
      per_page: number;
      page: number;
    }): Promise<{
      data: {
        check_runs: Array<{
          id: number;
          name: string;
          conclusion: string | null;
          html_url: string | null;
          details_url: string | null;
          app?: {
            name?: string | null;
          } | null;
          completed_at: string | null;
          started_at: string | null;
          created_at?: string;
        }>;
      };
    }>;
  };
}

/** Conclusions that indicate a check run did not succeed. */
const FAILED_CONCLUSIONS = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'stale']);

/** Maximum GitHub Actions workflow runs fetched per page. */
const WORKFLOW_RUN_PAGE_SIZE = 100;

/** Maximum concurrent job-detail lookups while resolving failed steps. */
const FAILED_STEP_LOOKUP_BATCH_SIZE = 10;

/**
 * Extract the workflow run ID from a GitHub Actions job URL.
 * @param url - Job URL like `https://github.com/.../actions/runs/123/job/456`
 * @returns Run ID string, or null if the URL doesn't match
 */
function extractRunId(url: string): string | null {
  const match = url.match(/\/actions\/runs\/(\d+)/);
  return match ? match[1] : null;
}

/**
 * Build a map from workflow run ID to workflow name for the PR's branch.
 * @param octokit - Authenticated Octokit instance
 * @param coords - PR coordinates
 * @param branch - PR head branch name
 * @returns Map from run ID to workflow name
 */
async function buildWorkflowNameMap(
  octokit: PrCommentCiClient,
  coords: PrCoordinates,
  branch: string,
): Promise<Map<string, string>> {
  const nameMap = new Map<string, string>();
  let page = 1;

  while (true) {
    const { data } = await octokit.actions.listWorkflowRunsForRepo({
      owner: coords.owner,
      repo: coords.repo,
      branch,
      per_page: WORKFLOW_RUN_PAGE_SIZE,
      page,
    });

    for (const run of data.workflow_runs) {
      nameMap.set(String(run.id), run.name ?? 'unknown');
    }

    if (data.workflow_runs.length < WORKFLOW_RUN_PAGE_SIZE) {
      break;
    }
    page++;
  }

  return nameMap;
}

/**
 * Resolve the name of the first failed step in a GitHub Actions job.
 * @param octokit - Authenticated Octokit instance
 * @param coords - PR coordinates
 * @param jobId - GitHub Actions job ID (same as check run ID)
 * @returns Name of the failed step, or null if unavailable
 */
async function resolveFailedStepName(
  octokit: PrCommentCiClient,
  coords: PrCoordinates,
  jobId: number,
): Promise<string | null> {
  try {
    const { data: job } = await octokit.actions.getJobForWorkflowRun({
      owner: coords.owner,
      repo: coords.repo,
      job_id: jobId,
    });

    const failedStep = job.steps?.find((step) => step.conclusion === 'failure');
    return failedStep?.name ?? null;
  } catch {
    return null;
  }
}

/**
 * Fetch CI check runs for the PR's head commit and return non-success entries.
 * @param octokit - Authenticated Octokit instance
 * @param coords - PR coordinates
 * @returns CI check entries for failed/cancelled/timed-out runs
 */
export async function fetchCiCheckEntries(octokit: PrCommentCiClient, coords: PrCoordinates): Promise<CiCheckEntry[]> {
  const { data: pr } = await octokit.pulls.get({
    owner: coords.owner,
    repo: coords.repo,
    pull_number: coords.pullNumber,
  });

  const workflowNames = await buildWorkflowNameMap(octokit, coords, pr.head.ref);

  const entries: CiCheckEntry[] = [];
  let page = 1;

  while (true) {
    const { data } = await octokit.checks.listForRef({
      owner: coords.owner,
      repo: coords.repo,
      ref: pr.head.sha,
      filter: 'latest',
      per_page: 100,
      page,
    });

    const failedRuns = data.check_runs.filter((run) => run.conclusion && FAILED_CONCLUSIONS.has(run.conclusion));

    const stepResults: Array<string | null> = [];
    for (let i = 0; i < failedRuns.length; i += FAILED_STEP_LOOKUP_BATCH_SIZE) {
      const batch = failedRuns.slice(i, i + FAILED_STEP_LOOKUP_BATCH_SIZE);
      stepResults.push(...(await Promise.all(batch.map((run) => resolveFailedStepName(octokit, coords, run.id)))));
    }

    for (let i = 0; i < failedRuns.length; i++) {
      const run = failedRuns[i];
      const detailsUrl = run.html_url ?? run.details_url ?? '';
      const runId = extractRunId(detailsUrl);
      const workflowName = runId ? (workflowNames.get(runId) ?? 'unknown') : (run.app?.name ?? 'unknown');

      entries.push({
        id: `ci:${run.id}`,
        kind: 'ci',
        jobName: run.name,
        conclusion: run.conclusion!,
        workflowName,
        failedStep: stepResults[i],
        detailsUrl,
        createdAt:
          run.completed_at ??
          run.started_at ??
          run.created_at ??
          pr.updated_at ??
          pr.created_at ??
          '1970-01-01T00:00:00.000Z',
      });
    }

    if (data.check_runs.length < 100) {
      break;
    }
    page++;
  }

  return entries;
}
