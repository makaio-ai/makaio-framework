import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { MakaioBus } from '@makaio/bus-core';
import type { StepRunConfig, WorkflowResolvedRole } from '@makaio/contracts';
import { createLocalLauncher, type Launcher } from '@makaio/subprocess';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentStepFailureCases } from '../../../../../core/contracts/src/workflow/__tests__/agent-step-runner-cases.js';
import { closeHttpServer, listenOnLoopback } from '../../__tests__/http-test-helpers.js';
import { MODEL_MESSAGE_LIMIT_BYTES } from '../agent-step/protocol.js';
import { createProcessStepRunner, type ProcessStepRunnerOptions } from '../process-step-runner.js';

const agentCommand = {
  command: process.execPath,
  args: [
    '--import',
    import.meta.resolve('tsx'),
    fileURLToPath(new URL('../agent-step/agent-step-entry.ts', import.meta.url)),
  ],
};
const step: Extract<StepRunConfig, { stepType: 'agent-step' }> = {
  stepId: 'review',
  stepType: 'agent-step',
  stepDefinition: {
    id: 'review',
    type: 'agent-step',
    role: 'reviewer',
    prompt: 'Review',
    completion: 'turn',
    outputSchema: { type: 'object', required: ['approved'] },
  },
  resolvedPrompt: 'Review',
  data: { executionId: 'execution-1', workflowId: 'workflow-1', inputs: {}, config: {}, previousSteps: {} },
  platformDefaults: { cwd: '.' },
};
const defaultRole = { adapterName: 'text-model', model: 'role-selected-model' };
const call = MakaioBus.own('root');

describe('process step agent policy', () => {
  let workspace: string;
  let launcher: Launcher;
  let upstream: Server;
  let received: string[];
  let credentials: number;
  let options: ProcessStepRunnerOptions;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'agent-process-test-'));
    ({ launcher } = createLocalLauncher({
      workspaceRoot: workspace,
      stepHomeRoot: join(workspace, 'steps'),
      runtimeHomeRoot: join(workspace, 'runtime'),
    }));
    received = [];
    credentials = 0;
    upstream = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) if (Buffer.isBuffer(chunk)) chunks.push(chunk);
      received.push(Buffer.concat(chunks).toString());
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ text: JSON.stringify({ approved: true, explanation: 'x'.repeat(20_000) }) }));
    });
    const port = await listenOnLoopback(upstream);
    options = {
      launcher,
      workspace,
      call,
      codeCommand: agentCommand,
      agentCommand,
      timeoutMs: 10_000,
      resolveRole: async () => defaultRole,
      model: {
        adapterName: 'text-model',
        ownerInstanceId: 'worker-instance',
        target: { name: 'test-model', url: new URL(`http://127.0.0.1:${port}`) },
        credentialSource: {
          request: async () => {
            credentials += 1;
            return { kind: 'issued', credential: 'synthetic-authorization' };
          },
        },
      },
    };
  });

  afterEach(async () => {
    await launcher.closeAll();
    await closeHttpServer(upstream);
    await rm(workspace, { recursive: true, force: true });
  });

  it.each([
    { providerConfigId: 'another-configuration' },
    { providerContext: { state: 'unresolved' } },
    { adapterConfig: { frequencyPenalty: 0.5 } },
    { reasoningEffort: 'high' },
    { harnessId: 'other-harness' },
    { contextMode: 'fork' },
  ] satisfies Partial<WorkflowResolvedRole>[])('refuses unsupported role options %o before authorizing the model', async (override) => {
    const runner = createProcessStepRunner({
      ...options,
      resolveRole: async () => ({ ...defaultRole, ...override }),
    });
    await expect(runner.run(step, new AbortController().signal)).resolves.toMatchObject({
      status: 'failed',
      error: 'agentCapabilitiesUnsupported',
    });
    expect(credentials).toBe(0);
    expect(received).toEqual([]);
  });

  it('applies the node turn and empty tool allowlist before admitting role defaults', async () => {
    const runner = createProcessStepRunner({
      ...options,
      resolveRole: async () => ({ ...defaultRole, completion: 'tool', tools: ['search'] }),
    });
    const invocation = { ...step, stepDefinition: { ...step.stepDefinition, allowedTools: [] } };
    await expect(runner.run(invocation, new AbortController().signal)).resolves.toMatchObject({
      status: 'completed',
      output: { approved: true },
    });
    expect(credentials).toBe(1);
    expect(received).toHaveLength(1);
  });

  it('accepts a request and reply beyond 16 KiB within the existing wire budget', async () => {
    const launch = vi.spyOn(launcher, 'launch');
    const runner = createProcessStepRunner({
      ...options,
      resolveRole: async () => {
        await delay(10);
        return { ...defaultRole, systemPrompt: 'policy 💡'.repeat(1_500) };
      },
    });
    const request = {
      ...step,
      resolvedPrompt: 'review 💡'.repeat(1_500),
      stepDefinition: {
        ...step.stepDefinition,
        outputSchema: { ...step.stepDefinition.outputSchema, description: 'schema 💡'.repeat(1_500) },
      },
    };
    await expect(runner.run(request, new AbortController().signal)).resolves.toMatchObject({
      status: 'completed',
      output: { approved: true, explanation: 'x'.repeat(20_000) },
    });
    expect(launch.mock.calls[0]?.[0].timeoutMs).toBeLessThan(options.timeoutMs);
    expect(received).toHaveLength(1);
    expect(received[0]).toContain('policy 💡');
    expect(received[0]).toContain('review 💡');
    expect(received[0]).toContain('schema 💡');
  });

  it('returns a typed refusal when the prompt and schema exceed the wire budget together', async () => {
    const runner = createProcessStepRunner({
      ...options,
      agentCommand: { command: process.execPath, args: ['-e', 'process.exit(1)'] },
    });
    const request = {
      ...step,
      resolvedPrompt: 'x'.repeat(MODEL_MESSAGE_LIMIT_BYTES - 256),
      stepDefinition: {
        ...step.stepDefinition,
        outputSchema: { ...step.stepDefinition.outputSchema, description: '💡'.repeat(64) },
      },
    };
    await expect(runner.run(request, new AbortController().signal)).resolves.toMatchObject({
      status: 'failed',
      error: 'promptTooLarge',
    });
    expect(credentials).toBe(0);
  });

  it('returns cancellation when the signal aborts during model lease setup', async () => {
    const controller = new AbortController();
    const model = options.model;
    if (model === undefined) throw new Error('Expected test model');
    const target = {
      name: model.target.name,
      get url(): URL {
        controller.abort();
        return model.target.url;
      },
    };
    const runner = createProcessStepRunner({ ...options, model: { ...model, target } });
    await expect(runner.run(step, controller.signal)).resolves.toMatchObject({ status: 'cancelled' });
    expect(credentials).toBe(0);
  });

  it('returns cancellation when an in-flight role lookup is aborted', async () => {
    const controller = new AbortController();
    const resolving = Promise.withResolvers<AbortSignal>();
    const role = Promise.withResolvers<WorkflowResolvedRole>();
    const runner = createProcessStepRunner({
      ...options,
      resolveRole: async (_call, _role, signal) => {
        resolving.resolve(signal);
        return role.promise;
      },
    });
    const result = runner.run(step, controller.signal);
    const roleSignal = await resolving.promise;
    controller.abort();
    await expect(result).resolves.toMatchObject({ status: 'cancelled' });
    expect(roleSignal.reason).toBe(controller.signal.reason);
    role.reject(new Error('Role lookup cancelled'));
    expect(credentials).toBe(0);
  });

  it.each(agentStepFailureCases)('reports $error before authorizing the model', async ({ scenario, error }) => {
    const deadline = scenario === 'deadline';
    const resolving = Promise.withResolvers<AbortSignal>();
    const runner = createProcessStepRunner({
      ...options,
      resolveRole: async (_call, _role, signal) => {
        resolving.resolve(signal);
        if (deadline) await delay(50);
        return undefined;
      },
    });
    const request = deadline ? { ...step, stepDefinition: { ...step.stepDefinition, timeoutMs: 10 } } : step;
    await expect(runner.run(request, new AbortController().signal)).resolves.toMatchObject({
      status: 'failed',
      error,
    });
    expect((await resolving.promise).aborted).toBe(deadline);
    expect(credentials).toBe(0);
  });
});
