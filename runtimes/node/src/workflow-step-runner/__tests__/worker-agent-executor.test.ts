import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import {
  AgentSubjects,
  AdapterSubjects,
  ToolSubjects,
  WorkflowSubjects,
  type AdapterContribution,
  type StepRunConfig,
} from '@makaio/contracts';
import type { Toolset } from '@makaio/tools-core';
import { bootWorkerBus } from '../worker-boot.js';
import { runWorkerAgentStep } from '../worker-agent-executor.js';
import type { WorkerContributions } from '../worker-contributions.js';

/**
 * Create a minimal StepRunConfig for an agent step.
 * @param overrides - Fields to override on the agent step definition.
 * @returns A valid StepRunConfig for testing.
 */
function makeAgentConfig(
  overrides: {
    adapter?: string;
    role?: string;
    prompt?: string;
    resolvedInputs?: StepRunConfig['resolvedInputs'];
  } = {},
): StepRunConfig {
  return {
    stepId: 'test-agent-step',
    executionId: 'test-exec',
    workflowId: 'test-workflow',
    coordinatorSessionId: 'test-session',
    stepType: 'agent',
    stepDefinition: {
      id: 'test-agent-step',
      type: 'agent',
      prompt: overrides.prompt ?? 'Do something',
      adapter: overrides.adapter ?? 'test-adapter',
      role: overrides.role,
    },
    resolvedInputs: overrides.resolvedInputs ?? {},
    busAuth: { kind: 'none' },
    platformDefaults: { cwd: '/tmp' },
    cancelSubject: 'workflow.cancel.test',
  };
}

describe('runWorkerAgentStep', () => {
  it('returns failed result for non-agent step type', async () => {
    const handle = await bootWorkerBus({ busAuth: { kind: 'none' } });
    const config = { ...makeAgentConfig(), stepType: 'shell' as const };
    const controller = new AbortController();

    const result = await runWorkerAgentStep(handle, config, controller.signal);

    expect(result.status).toBe('failed');
    expect(result.error).toContain('shell');
    expect(result.telemetry.duration).toBe(0);

    await handle.close();
  });

  it('starts adapter agent and returns completed result on success', async () => {
    const handle = await bootWorkerBus({ busAuth: { kind: 'none' } });
    const config = makeAgentConfig({
      adapter: 'test-adapter',
      prompt: 'Hello {{ inputs.name }}',
      resolvedInputs: { inputs: { name: 'agent' }, steps: {}, trigger: {} },
    });
    const controller = new AbortController();

    // Register a mock handler for adapter.startAgent
    handle.bus.on(AdapterSubjects.startAgent, (ctx) => {
      expect(ctx.payload.initialMessage).toBe('Hello agent');
      ctx.setResult({
        success: true,
        agentId: 'agent-42',
        adapterId: 'test-adapter',
        adapterSessionId: 'session-1',
        sessionId: 'makaio-session-1',
      });

      // Simulate agent completion after a short delay
      setTimeout(() => {
        void handle.bus.emit(AgentSubjects.complete, {
          agentId: 'agent-42',
          adapterId: 'test-adapter',
          adapterName: 'test-adapter',
          adapterSessionId: 'session-1',
          messageId: 'msg-1',
          message: 'Task completed successfully',
          outcome: 'completed',
        });
      }, 10);
    });

    const result = await runWorkerAgentStep(handle, config, controller.signal);

    expect(result.status).toBe('completed');
    expect(result.output).toBe('Task completed successfully');
    expect(result.telemetry.duration).toBeGreaterThan(0);

    await handle.close();
  });

  it('returns failed result when adapter startAgent returns failure', async () => {
    const handle = await bootWorkerBus({ busAuth: { kind: 'none' } });
    const config = makeAgentConfig({ adapter: 'broken-adapter' });
    const controller = new AbortController();

    handle.bus.on(AdapterSubjects.startAgent, (ctx) => {
      ctx.setResult({
        success: false,
        message: 'Adapter initialization failed',
      });
    });

    const result = await runWorkerAgentStep(handle, config, controller.signal);

    expect(result.status).toBe('failed');
    expect(result.error).toBe('Adapter initialization failed');
    expect(result.telemetry.duration).toBeGreaterThan(0);

    await handle.close();
  });

  it('returns failed result when agent completes with error outcome', async () => {
    const handle = await bootWorkerBus({ busAuth: { kind: 'none' } });
    const config = makeAgentConfig({ adapter: 'test-adapter' });
    const controller = new AbortController();

    handle.bus.on(AdapterSubjects.startAgent, (ctx) => {
      ctx.setResult({
        success: true,
        agentId: 'agent-err',
        adapterId: 'test-adapter',
        adapterSessionId: 'session-err',
        sessionId: 'makaio-session-err',
      });

      setTimeout(() => {
        void handle.bus.emit(AgentSubjects.complete, {
          agentId: 'agent-err',
          adapterId: 'test-adapter',
          adapterName: 'test-adapter',
          adapterSessionId: 'session-err',
          messageId: 'msg-err',
          outcome: 'error',
          error: 'Model rate limited',
        });
      }, 10);
    });

    const result = await runWorkerAgentStep(handle, config, controller.signal);

    expect(result.status).toBe('failed');
    expect(result.error).toBe('Model rate limited');

    await handle.close();
  });

  it('resolves role via workflow.resolveRole RPC when step has role', async () => {
    const handle = await bootWorkerBus({ busAuth: { kind: 'none' } });
    const config = makeAgentConfig({ role: 'reviewer', prompt: 'Review code' });
    const controller = new AbortController();

    // Register resolveRole handler
    handle.bus.on(WorkflowSubjects.resolveRole, (ctx) => {
      expect(ctx.payload.roleId).toBe('reviewer');
      ctx.setResult({
        adapterName: 'resolved-adapter',
        model: 'opus',
        harnessId: 'reviewer-harness',
        providerContext: {
          providerConfigId: 'provider-1',
          definitionId: 'anthropic-default',
          credentialRefs: {},
        },
      });
    });

    // Register startAgent handler
    handle.bus.on(AdapterSubjects.startAgent, (ctx) => {
      expect(ctx.payload.adapterId).toBe('resolved-adapter');
      expect(ctx.payload.model).toBe('opus');
      expect(ctx.payload.harnessId).toBe('reviewer-harness');
      expect(ctx.payload.providerContext?.providerConfigId).toBe('provider-1');

      ctx.setResult({
        success: true,
        agentId: 'agent-resolved',
        adapterId: 'resolved-adapter',
        adapterSessionId: 'session-resolved',
        sessionId: 'makaio-session-resolved',
      });

      setTimeout(() => {
        void handle.bus.emit(AgentSubjects.complete, {
          agentId: 'agent-resolved',
          adapterId: 'resolved-adapter',
          adapterName: 'resolved-adapter',
          adapterSessionId: 'session-resolved',
          messageId: 'msg-resolved',
          message: 'Review done',
          outcome: 'completed',
        });
      }, 10);
    });

    const result = await runWorkerAgentStep(handle, config, controller.signal);

    expect(result.status).toBe('completed');
    expect(result.output).toBe('Review done');

    await handle.close();
  });

  it('returns failed result when neither role nor adapter is specified', async () => {
    const handle = await bootWorkerBus({ busAuth: { kind: 'none' } });
    const config: StepRunConfig = {
      stepId: 'test-step',
      executionId: 'test-exec',
      workflowId: 'test-workflow',
      coordinatorSessionId: 'test-session',
      stepType: 'agent',
      stepDefinition: {
        id: 'test-step',
        type: 'agent',
        prompt: 'Do something',
        // No adapter, no role
      },
      resolvedInputs: {},
      busAuth: { kind: 'none' },
      platformDefaults: { cwd: '/tmp' },
      cancelSubject: 'workflow.cancel.test',
    };
    const controller = new AbortController();

    const result = await runWorkerAgentStep(handle, config, controller.signal);

    expect(result.status).toBe('failed');
    expect(result.error).toContain('role');
    expect(result.error).toContain('adapter');

    await handle.close();
  });

  it('respects abort signal for cancellation', async () => {
    const handle = await bootWorkerBus({ busAuth: { kind: 'none' } });
    const config = makeAgentConfig({ adapter: 'slow-adapter' });
    const controller = new AbortController();

    handle.bus.on(AdapterSubjects.startAgent, (ctx) => {
      ctx.setResult({
        success: true,
        agentId: 'agent-slow',
        adapterId: 'slow-adapter',
        adapterSessionId: 'session-slow',
        sessionId: 'makaio-session-slow',
      });
      // Agent never completes — will be aborted
    });

    // Abort shortly after starting
    const resultPromise = runWorkerAgentStep(handle, config, controller.signal);
    setTimeout(() => controller.abort(), 20);

    const result = await resultPromise;

    expect(result.status).toBe('failed');
    expect(result.telemetry.duration).toBeGreaterThan(0);

    await handle.close();
  });

  it('boots contribution adapters and executes tools through the worker-local registry', async () => {
    const handle = await bootWorkerBus({ busAuth: { kind: 'none' } });
    const config = makeAgentConfig({ adapter: 'worker-fake-adapter', prompt: 'Call worker tool' });
    const controller = new AbortController();
    const closeAdapter = vi.fn();
    const executeTool = vi.fn(async (input: { value: string }) => ({
      success: true as const,
      data: { source: 'worker-local', value: input.value },
    }));

    const toolset: Toolset = {
      metadata: { name: 'worker-tools', description: 'Worker tools', version: '1.0.0' },
      tools: {
        workerEcho: {
          metadata: { name: 'worker.echo', description: 'Echo from the worker registry' },
          inputSchema: z.object({ value: z.string() }),
          outputSchema: z.object({ source: z.string(), value: z.string() }),
          execute: executeTool,
        },
      },
    };

    const adapterContribution: AdapterContribution = {
      manifest: { name: 'worker-fake-adapter', displayName: 'Worker Fake Adapter', protocols: ['openai'] },
      definition: {
        name: 'worker-fake-adapter',
        displayName: 'Worker Fake Adapter',
        providers: [],
        defaultTimeouts: {
          initialization: 1000,
          acknowledgement: 1000,
          completion: 1000,
          toolApproval: 1000,
          eventWait: 1000,
        },
        createAdapter: async (options?: { globalBus?: typeof handle.bus }) => {
          const bus = options?.globalBus;
          if (!bus) throw new Error('worker adapter did not receive local bus');
          return {
            adapterId: 'worker-fake-adapter',
            name: 'worker-fake-adapter',
            async init() {
              bus.on(AdapterSubjects.startAgent, async (ctx) => {
                const toolResult = await bus.request(ToolSubjects.execute, {
                  toolName: 'worker.echo',
                  input: { value: 'from-agent' },
                  adapterId: 'worker-fake-adapter',
                  adapterName: 'worker-fake-adapter',
                });
                const output =
                  toolResult.success && typeof toolResult.data === 'object' && toolResult.data !== null
                    ? JSON.stringify(toolResult.data)
                    : 'tool failed';

                ctx.setResult({
                  success: true,
                  agentId: 'worker-agent-1',
                  adapterId: 'worker-fake-adapter',
                  adapterSessionId: 'worker-session-1',
                  sessionId: 'worker-makaio-session-1',
                });

                setTimeout(() => {
                  void bus.emit(AgentSubjects.complete, {
                    agentId: 'worker-agent-1',
                    adapterId: 'worker-fake-adapter',
                    adapterName: 'worker-fake-adapter',
                    adapterSessionId: 'worker-session-1',
                    messageId: 'worker-message-1',
                    message: output,
                    outcome: 'completed',
                  });
                }, 0);
              });
            },
            async closeAsync() {
              closeAdapter();
            },
          };
        },
      },
    };

    const result = await runWorkerAgentStep(handle, config, controller.signal, {
      toolsets: [toolset],
      adapters: [adapterContribution],
    } satisfies WorkerContributions);

    expect(result.status).toBe('completed');
    expect(result.output).toBe('{"source":"worker-local","value":"from-agent"}');
    expect(executeTool).toHaveBeenCalledOnce();
    expect(closeAdapter).toHaveBeenCalledOnce();

    await expect(
      handle.bus.request(ToolSubjects.execute, {
        toolName: 'worker.echo',
        input: { value: 'after-close' },
        adapterId: 'worker-fake-adapter',
        adapterName: 'worker-fake-adapter',
      }),
    ).rejects.toThrow();

    await handle.close();
  });
});
