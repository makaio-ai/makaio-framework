import type { Octokit } from '@octokit/rest';
import type { CiCheckEntry, PrCoordinates } from './pr-comment-types.js';

export type { CiCheckEntry };

/** Conclusions that indicate a check run did not succeed. */
const FAILED_CONCLUSIONS = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'stale']);

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
  octokit: Octokit,
  coords: PrCoordinates,
  branch: string,
): Promise<Map<string, string>> {
  const nameMap = new Map<string, string>();

  const { data } = await octokit.actions.listWorkflowRunsForRepo({
    owner: coords.owner,
    repo: coords.repo,
    branch,
    per_page: 20,
  });

  for (const run of data.workflow_runs) {
    nameMap.set(String(run.id), run.name ?? 'unknown');
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
async function resolveFailedStepName(octokit: Octokit, coords: PrCoordinates, jobId: number): Promise<string | null> {
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
export async function fetchCiCheckEntries(octokit: Octokit, coords: PrCoordinates): Promise<CiCheckEntry[]> {
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

    const stepResults = await Promise.all(failedRuns.map((run) => resolveFailedStepName(octokit, coords, run.id)));

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
        createdAt: run.completed_at ?? run.started_at ?? new Date().toISOString(),
      });
    }

    if (data.check_runs.length < 100) {
      break;
    }
    page++;
  }

  return entries;
}
