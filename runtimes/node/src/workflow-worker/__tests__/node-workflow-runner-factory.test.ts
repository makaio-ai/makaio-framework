import { describe, expect, it } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { ExecutionAttemptAuthority } from '@makaio/subsystem-workflow-engine';
import { createNodeWorkflowRunnerPackageOptions } from '../node-workflow-runner-factory.js';
import {
  createInMemoryAttemptRepository,
  workflowRunResultOutcomeCodec,
} from '@makaio/subsystem-workflow-engine/testing';

/**
 * Repository fixture for construction gate tests.
 *
 * These tests verify that the factory enforces the construction gate;
 * they do not exercise repository behavior.
 */
const stubRepository = createInMemoryAttemptRepository(workflowRunResultOutcomeCodec);

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

    expect(options.executionAttemptRepository).toBeUndefined();
    expect(options.workflowRunner).toBeDefined();
  });

  it('no runner mode boots without a repository', () => {
    const options = createNodeWorkflowRunnerPackageOptions(baseParams);

    expect(options.executionAttemptRepository).toBeUndefined();
    expect(options.workflowRunner).toBeUndefined();
  });

  it('piscina mode boots without a repository', () => {
    const options = createNodeWorkflowRunnerPackageOptions({
      ...baseParams,
      workflowRunner: { mode: 'piscina' },
    });

    expect(options.executionAttemptRepository).toBeUndefined();
    expect(options.workflowRunner).toBeDefined();
  });

  // ─────────────────────────────────────────────────────────
  // Gate 2: Worker mode fails fast without a repository
  // ─────────────────────────────────────────────────────────

  it('worker mode fails fast without an ExecutionAttemptRepository', () => {
    expect(() =>
      createNodeWorkflowRunnerPackageOptions({
        ...baseParams,
        workflowRunner: { mode: 'worker' },
        bus: MakaioBus,
      }),
    ).toThrow('ExecutionAttemptRepository');
  });

  // ─────────────────────────────────────────────────────────
  // Gate 3: Factory composition boots with the injected repository
  // ─────────────────────────────────────────────────────────

  it('worker mode succeeds when an ExecutionAttemptRepository is provided', () => {
    const options = createNodeWorkflowRunnerPackageOptions({
      ...baseParams,
      workflowRunner: { mode: 'worker' },
      bus: MakaioBus,
      executionAttemptRepository: stubRepository,
    });

    expect(options.executionAttemptRepository).toBe(stubRepository);
    expect(options.executionAttemptAuthority).toBeInstanceOf(ExecutionAttemptAuthority);
    expect(options.workflowRunner).toBeDefined();
  });
});
