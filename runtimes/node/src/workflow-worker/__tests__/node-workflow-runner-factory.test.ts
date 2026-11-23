import { describe, expect, it } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { createNodeWorkflowRunnerPackageOptions } from '../node-workflow-runner-factory.js';

describe('createNodeWorkflowRunnerPackageOptions construction gates', () => {
  const baseParams = {
    busUrl: 'ws://localhost:1234/bus',
    runtimeModuleDir: '/app/src',
    platformDefaults: { cwd: '/app' },
    makaioHome: '/app/.makaio',
  } as const;

  // ─────────────────────────────────────────────────────────
  // Gate 1: framework-only / in-process boots without a repository
  // ─────────────────────────────────────────────────────────

  it('in-process mode boots without a repository', () => {
    const options = createNodeWorkflowRunnerPackageOptions({
      ...baseParams,
      workflowRunner: { mode: 'in-process' },
      bus: MakaioBus,
    });

    expect(options.workflowRunner).toBeDefined();
  });

  it('no runner mode boots without a repository', () => {
    const options = createNodeWorkflowRunnerPackageOptions(baseParams);

    expect(options.workflowRunner).toBeUndefined();
  });

  it('piscina mode boots without a repository', () => {
    const options = createNodeWorkflowRunnerPackageOptions({
      ...baseParams,
      workflowRunner: { mode: 'piscina' },
    });

    expect(options.workflowRunner).toBeDefined();
  });
});

it('leaves Attempt persistence to the host even when legacy fields are present', () => {
  const input = {
    busUrl: 'ws://localhost:1234/bus',
    runtimeModuleDir: '/app/src',
    platformDefaults: { cwd: '/app' },
    executionAttemptRepository: {},
    executionAttemptBootstrapTimeoutMs: 60_000,
  };

  expect(createNodeWorkflowRunnerPackageOptions(input)).not.toHaveProperty('executionAttemptAuthority');
});
