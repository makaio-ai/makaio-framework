import { describe, expect, it, vi } from 'vitest';
import { createBusInstance, MakaioBus } from '@makaio/bus-core';
import { WorkflowRunContextSchema, type ExecutionAttemptInstruction } from '@makaio/contracts';
import {
  ExecutionAttemptAuthority,
  parseWorkflowAttemptInstruction,
  workflowAttemptOutcomeCodec,
  WorkflowStorageNamespace,
  WorkflowStorageSubjects,
} from '@makaio/subsystem-workflow-engine';
import { createNodeWorkflowRunnerPackageOptions } from '../node-workflow-runner-factory.js';
import { createInMemoryAttemptRepository } from '@makaio/subsystem-workflow-engine/testing';
import { makeWorkerConfig } from './fixtures.js';

/**
 * Repository fixture for construction gate tests.
 *
 * These tests verify that the factory enforces the construction gate;
 * they do not exercise repository behavior.
 */
const stubRepository = createInMemoryAttemptRepository(workflowAttemptOutcomeCodec);

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
      executionAttemptBootstrapTimeoutMs: 60_000,
    });

    expect(options.executionAttemptRepository).toBe(stubRepository);
    expect(options.executionAttemptAuthority).toBeInstanceOf(ExecutionAttemptAuthority);
    expect(options.workflowRunner).toBeDefined();
  });

  it('requires a bootstrap budget even when a repository is supplied without Worker mode', () => {
    expect(() =>
      createNodeWorkflowRunnerPackageOptions({ ...baseParams, executionAttemptRepository: stubRepository }),
    ).toThrow('executionAttemptBootstrapTimeoutMs');
  });

  it('freezes an explicit bootstrap budget in a repository-backed non-Worker mode', async () => {
    const options = createNodeWorkflowRunnerPackageOptions({
      ...baseParams,
      executionAttemptRepository: stubRepository,
      executionAttemptBootstrapTimeoutMs: 4_000,
    });
    const authority = options.executionAttemptAuthority;
    expect(authority).toBeDefined();
    const instruction: ExecutionAttemptInstruction = {
      id: 'budget-test',
      revision: '1',
      workload: { kind: 'test', version: '1', input: {} },
      preservation: { required: [] },
    };
    const record = await authority!.createAttempt('budget-owner', instruction);
    expect(Date.parse(record.bootstrapDeadlineAt!) - Date.parse(record.createdAt)).toBe(4_000);
  });

  it('freezes portable path-backed owner input through the host-local storage subject before dispatch', async () => {
    const bus = createBusInstance();
    bus.registerNamespace(WorkflowStorageNamespace);
    const repository = createInMemoryAttemptRepository(workflowAttemptOutcomeCodec);
    const config = makeWorkerConfig({ source: { kind: 'path', path: '/host/private/workflow.ts' } });
    const runContext = WorkflowRunContextSchema.parse({
      ...config,
      source: { kind: 'path', path: 'workflow.ts' },
      materializationSpec: {
        kind: 'local-directory',
        workspaceId: 'workflow-source',
        rootDigest: 'revision-1',
        sourcePath: 'workflow.ts',
      },
      inputs: { question: 'original' },
      createdAt: 1,
    });
    const off = bus.on(WorkflowStorageSubjects.getRunContext, (ctx) => {
      expect(ctx.payload.executionId).toBe(config.executionId);
      expect(repository.attempts.size).toBe(0);
      ctx.setResult({ runContext });
    });
    let captured: ExecutionAttemptInstruction | undefined;
    const options = createNodeWorkflowRunnerPackageOptions({
      ...baseParams,
      bus,
      executionAttemptRepository: repository,
      executionAttemptBootstrapTimeoutMs: 60_000,
      workflowRunner: {
        mode: 'worker',
        dispatch: async (request) => {
          runContext.inputs = { question: 'changed after creation' };
          captured = repository.attempts.get(request.executionAttemptId)?.instruction;
          throw new Error('dispatch unavailable');
        },
      },
    });
    try {
      await expect(options.workflowRunner!.run(config, new AbortController().signal)).rejects.toThrow(
        'dispatch unavailable',
      );
      expect(captured).toBeDefined();
      expect(parseWorkflowAttemptInstruction(captured!)).toMatchObject({
        source: { kind: 'path', path: 'workflow.ts' },
        inputs: { question: 'original' },
      });
    } finally {
      off();
    }
  });

  it('cancels a pending owner-context bus read without creating an Attempt or dispatching', async () => {
    const bus = createBusInstance();
    bus.registerNamespace(WorkflowStorageNamespace);
    const repository = createInMemoryAttemptRepository(workflowAttemptOutcomeCodec);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const off = bus.on(WorkflowStorageSubjects.getRunContext, async (ctx) => {
      entered.resolve();
      await release.promise;
      ctx.setResult({ runContext: null });
    });
    const dispatch = vi.fn();
    const options = createNodeWorkflowRunnerPackageOptions({
      ...baseParams,
      bus,
      executionAttemptRepository: repository,
      executionAttemptBootstrapTimeoutMs: 60_000,
      workflowRunner: { mode: 'worker', dispatch },
    });
    const controller = new AbortController();
    try {
      const result = options.workflowRunner!.run(
        makeWorkerConfig({ source: { kind: 'path', path: '/host/workflow.ts' } }),
        controller.signal,
      );
      const rejected = expect(result).rejects.toThrow('owner-read-cancelled');
      await entered.promise;
      controller.abort(new Error('owner-read-cancelled'));
      // Rejection must not wait for the storage handler to return.
      await rejected;
      expect(repository.attempts.size).toBe(0);
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      off();
    }
  });
});
