import { describe, expect, it } from 'bun:test';
import { fetchCiCheckEntries, type PrCommentCiClient } from './pr-comment-ci.js';

const COORDS = {
  owner: 'makaio-ai',
  repo: 'makaio',
  pullNumber: 655,
};

describe('fetchCiCheckEntries', () => {
  it('paginates workflow names, bounds failed-step lookups, and preserves deterministic timestamps', async () => {
    const requestedWorkflowPages: number[] = [];
    let activeJobLookups = 0;
    let maxActiveJobLookups = 0;

    const client = {
      pulls: {
        async get() {
          return {
            data: {
              head: {
                ref: 'sync',
                sha: 'abc123',
              },
            },
          };
        },
      },
      actions: {
        async listWorkflowRunsForRepo(options) {
          requestedWorkflowPages.push(options.page);
          if (options.page === 1) {
            return {
              data: {
                workflow_runs: Array.from({ length: 100 }, (_, index) => ({
                  id: index + 1,
                  name: `Workflow ${index + 1}`,
                })),
              },
            };
          }
          return {
            data: {
              workflow_runs: [{ id: 101, name: 'Late workflow' }],
            },
          };
        },
        async getJobForWorkflowRun(options) {
          activeJobLookups++;
          maxActiveJobLookups = Math.max(maxActiveJobLookups, activeJobLookups);
          await Promise.resolve();
          activeJobLookups--;

          return {
            data: {
              steps: [{ name: `failed ${options.job_id}`, conclusion: 'failure' }],
            },
          };
        },
      },
      checks: {
        async listForRef(options) {
          return {
            data: {
              check_runs:
                options.page === 1
                  ? Array.from({ length: 11 }, (_, index) => ({
                      id: index + 1,
                      name: `Job ${index + 1}`,
                      conclusion: 'failure',
                      html_url: `https://github.com/makaio-ai/makaio-framework/actions/runs/101/job/${index + 1}`,
                      details_url: null,
                      app: null,
                      completed_at: null,
                      started_at: null,
                      created_at: `2026-05-06T00:00:${String(index).padStart(2, '0')}Z`,
                    }))
                  : [],
            },
          };
        },
      },
    } satisfies PrCommentCiClient;

    const entries = await fetchCiCheckEntries(client, COORDS);

    expect(requestedWorkflowPages).toEqual([1, 2]);
    expect(maxActiveJobLookups).toBe(10);
    expect(entries).toHaveLength(11);
    expect(entries[0]).toMatchObject({
      workflowName: 'Late workflow',
      failedStep: 'failed 1',
      createdAt: '2026-05-06T00:00:00Z',
    });
  });
});
