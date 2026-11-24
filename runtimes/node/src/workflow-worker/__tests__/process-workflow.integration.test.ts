import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WorkflowErrorCode,
  WorkflowSubjects,
  type WorkflowAgentStepNode,
  type WorkflowCodeStepNode,
  type WorkflowParallelNode,
} from '@makaio/contracts';
import { execa } from 'execa';
import { describe, expect, it } from 'vitest';
import { runWorkflowOrchestrator } from '@makaio/subsystem-workflow-engine/workflow-orchestrator';
import { closeHttpServer, listenOnLoopback } from '../../__tests__/http-test-helpers.js';
import { runProcessWorkflow, type ProcessWorkflowRunOptions } from '../process-workflow.js';
import { makeBusWithStorage, makeWorkerConfig } from './fixtures.js';

/**
 * Bind an actual isolated bus and workflow storage for one execution.
 * @param workspace - Local work directory for launched children.
 * @param nodes - Frozen workflow leaf nodes.
 * @returns Options, the worker bus, and its cleanup function.
 */
function makeRun(workspace: string, nodes: Array<WorkflowAgentStepNode | WorkflowCodeStepNode | WorkflowParallelNode>) {
  const [bus, cleanup] = makeBusWithStorage();
  const call = bus.own('root');
  const config = makeWorkerConfig({
    definition: {
      id: 'workflow-1',
      scope: { type: 'global' },
      root: { type: 'sequence', id: 'root', nodes },
    },
  });
  const options = { call, bus, config, workspace, signal: new AbortController().signal };
  return { options, cleanup };
}

const outputSchema = { type: 'object', required: ['approved'], properties: { approved: { type: 'boolean' } } };

describe('process workflow runtime', () => {
  it('records failure when the step runner cannot confirm process closure', async () => {
    const { options, cleanup } = makeRun(process.cwd(), []);
    const definition = options.config.definition;
    if (definition === undefined) throw new Error('Missing workflow fixture');
    const completions: string[] = [];
    const offCompleted = options.bus.on(WorkflowSubjects.execution.completed, (ctx) => {
      completions.push(ctx.payload.executionId);
    });
    try {
      await expect(
        runWorkflowOrchestrator({
          ...options,
          loaded: { definition },
          stepRunner: {
            run: async () => ({ status: 'completed', output: null, telemetry: { duration: 0 } }),
            dispose: async () => {
              throw new Error('Closure not confirmed');
            },
          },
        }),
      ).resolves.toMatchObject({ status: 'failed', error: 'stepRunnerClosureUnconfirmed' });
      expect(completions).toEqual([]);
    } finally {
      offCompleted();
      cleanup();
    }
  });

  it('cancels a pending role lookup when a parallel branch fails', async () => {
    const left: WorkflowAgentStepNode = {
      id: 'left',
      type: 'agent-step',
      role: 'late',
      prompt: 'Review',
      completion: 'turn',
      outputSchema,
    };
    const right: WorkflowAgentStepNode = { ...left, id: 'right', role: 'unavailable' };
    const { options, cleanup } = makeRun(process.cwd(), [
      {
        id: 'parallel',
        type: 'parallel',
        mode: 'fail-fast',
        branches: {
          left: { id: 'left-branch', type: 'sequence', nodes: [left] },
          right: { id: 'right-branch', type: 'sequence', nodes: [right] },
        },
      },
    ]);
    const resolving = Promise.withResolvers<void>();
    const releaseRole = Promise.withResolvers<void>();
    const offRole = options.bus.on(WorkflowSubjects.resolveRole, async (ctx) => {
      if (ctx.payload.roleId === 'late') {
        resolving.resolve();
        await releaseRole.promise;
      } else {
        await resolving.promise;
      }
      ctx.setResult({ adapterName: 'text-model' });
    });
    try {
      await expect(
        runProcessWorkflow({
          ...options,
          model: {
            adapterName: 'text-model',
            ownerInstanceId: 'worker-instance',
            target: { name: 'review-gateway', url: new URL('http://127.0.0.1:1') },
            credentialSource: { request: async () => ({ kind: 'purpose-not-granted' }) },
          },
        }),
      ).resolves.toMatchObject({ status: 'failed' });
    } finally {
      releaseRole.resolve();
      offRole();
      cleanup();
    }
  });

  it.each([
    [{ approved: true }, { status: 'completed' }],
    [{ approved: 'yes' }, { status: 'failed', error: 'invalidOutput' }],
  ])('runs a real agent process and checks structured output against the frozen schema', async (output, expected) => {
    const server = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.headers.authorization !== 'Bearer scoped-model-token') {
        response.writeHead(401).end('{}');
        return;
      }
      response.end(JSON.stringify({ text: JSON.stringify(output) }));
    });
    const { options, cleanup } = makeRun(process.cwd(), [
      { id: 'review', type: 'agent-step', role: 'reviewer', prompt: 'Review', completion: 'turn', outputSchema },
    ]);
    const removeRole = options.bus.on(WorkflowSubjects.resolveRole, (ctx) => {
      expect(ctx.payload.roleId).toBe('reviewer');
      ctx.setResult({ adapterName: 'text-model', model: 'role-selected-model' });
    });
    try {
      const port = await listenOnLoopback(server);
      await expect(
        runProcessWorkflow({
          ...options,
          model: {
            adapterName: 'text-model',
            ownerInstanceId: 'worker-instance',
            target: { name: 'review-gateway', url: new URL(`http://127.0.0.1:${port}`) },
            credentialSource: {
              request: async (call, request) => {
                expect(call).toBe(options.call);
                expect(request).toMatchObject({ purpose: 'model.use', target: 'review-gateway', reason: 'initial' });
                return { kind: 'issued', credential: 'scoped-model-token' };
              },
            },
          },
        }),
      ).resolves.toMatchObject(expected);
    } finally {
      removeRole();
      cleanup();
      await closeHttpServer(server);
    }
  });

  it('requires a structured agent definition before calling the model', async () => {
    const { options, cleanup } = makeRun(process.cwd(), [
      { id: 'review', type: 'agent-step', role: 'reviewer', prompt: 'Review' },
    ]);
    try {
      await expect(runProcessWorkflow(options)).rejects.toMatchObject({
        code: WorkflowErrorCode.AGENT_STEP_UNSUPPORTED,
      });
    } finally {
      cleanup();
    }
  });

  it('uses a prepared Git checkout and fails visibly when the refusal observer fails', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'workflow-process-test-'));
    const node = { id: 'read', type: 'code-step' as const };
    const { options, cleanup } = makeRun(workspace, [node]);
    const sourcePath = 'workflow.mjs';
    const received: string[][] = [];
    try {
      await writeFile(
        join(workspace, sourcePath),
        `export default {
          definition: ${JSON.stringify(options.config.definition)},
          runtimeHandlers: new Map([['read', async (ctx) => ctx.request({ subject: 'example.read', payload: null })]])
        };`,
      );
      await execa('git', ['init'], { cwd: workspace });
      await execa('git', ['add', sourcePath], { cwd: workspace });
      await execa('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'test'], {
        cwd: workspace,
      });
      const revision = (await execa('git', ['rev-parse', 'HEAD'], { cwd: workspace })).stdout;
      const withCheckout: ProcessWorkflowRunOptions = {
        ...options,
        checkout: {
          binding: {
            workflowId: 'workflow-1',
            source: { path: sourcePath },
            sourceRootId: 'workflow-source',
            gitRevision: revision,
            sourceRoots: [{ id: 'workflow-source', path: workspace }],
          },
          preparedSource: { rootId: 'workflow-source', revision },
        },
        onRequestRefused: async (...diagnostic) => {
          received.push(diagnostic);
          throw new Error('Sensitive observer failure');
        },
      };
      await expect(runProcessWorkflow(withCheckout)).resolves.toMatchObject({
        status: 'failed',
        error: 'requestRefusalObserverFailed',
      });
      expect(received).toEqual([['wfx-1', 'read', 'example.read', 'request-not-granted']]);
      await expect(runProcessWorkflow(options)).resolves.toMatchObject({
        status: 'failed',
        error: 'sourceNotPrepared',
      });
    } finally {
      cleanup();
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
