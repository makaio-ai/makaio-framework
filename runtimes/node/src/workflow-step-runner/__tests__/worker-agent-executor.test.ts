import { describe, it, expect } from 'vitest';
import { SubagentSubjects, WorkflowSubjects, type StepRunConfig } from '@makaio/contracts';
import { bootWorkerBus } from '../worker-boot.js';
import { runWorkerAgentStep } from '../worker-agent-executor.js';

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

  it('spawns subagent and returns completed result on success', async () => {
    const handle = await bootWorkerBus({ busAuth: { kind: 'none' } });
    const config = makeAgentConfig({
      adapter: 'test-adapter',
      prompt: 'Hello {{ inputs.name }}',
      resolvedInputs: { inputs: { name: 'agent' }, steps: {}, trigger: {} },
    });
    const controller = new AbortController();

    handle.bus.on(SubagentSubjects.spawn, (ctx) => {
      expect(ctx.payload.parentSessionId).toBe('test-session');
      expect(ctx.payload.config.task).toBe('Hello agent');
      expect(ctx.payload.config.adapterName).toBe('test-adapter');
      ctx.setResult({
        subagentId: 'subagent-42',
        status: 'spawning',
      });
    });
    handle.bus.on(SubagentSubjects.await, (ctx) => {
      expect(ctx.payload.subagentId).toBe('subagent-42');
      ctx.setResult({ status: 'completed', result: 'Task completed successfully' });
    });

    const result = await runWorkerAgentStep(handle, config, controller.signal);

    expect(result.status).toBe('completed');
    expect(result.output).toBe('Task completed successfully');
    expect(result.telemetry.duration).toBeGreaterThan(0);

    await handle.close();
  });

  it('preserves JSON object step results in prompt expression context', async () => {
    const handle = await bootWorkerBus({ busAuth: { kind: 'none' } });
    const config = makeAgentConfig({
      adapter: 'test-adapter',
      prompt: 'Use {{ steps.fetch.result.id }}',
      resolvedInputs: {
        inputs: {},
        trigger: {},
        steps: {
          fetch: { status: 'completed', result: { id: 'json-id' } },
        },
      },
    });
    const controller = new AbortController();

    handle.bus.on(SubagentSubjects.spawn, (ctx) => {
      expect(ctx.payload.config.task).toBe('Use json-id');
      ctx.setResult({ subagentId: 'subagent-json', status: 'spawning' });
    });
    handle.bus.on(SubagentSubjects.await, (ctx) => {
      ctx.setResult({ status: 'completed', result: 'Done' });
    });

    const result = await runWorkerAgentStep(handle, config, controller.signal);

    expect(result.status).toBe('completed');
    await handle.close();
  });

  it('returns failed result when subagent system is unavailable', async () => {
    const handle = await bootWorkerBus({ busAuth: { kind: 'none' } });
    const config = makeAgentConfig({ adapter: 'broken-adapter' });
    const controller = new AbortController();

    const result = await runWorkerAgentStep(handle, config, controller.signal);

    expect(result.status).toBe('failed');
    expect(result.error).toBe('Subagent system not available');
    expect(result.telemetry.duration).toBeGreaterThan(0);

    await handle.close();
  });

  it('returns failed result when subagent await returns an error status', async () => {
    const handle = await bootWorkerBus({ busAuth: { kind: 'none' } });
    const config = makeAgentConfig({ adapter: 'test-adapter' });
    const controller = new AbortController();

    handle.bus.on(SubagentSubjects.spawn, (ctx) => {
      ctx.setResult({ subagentId: 'subagent-err', status: 'spawning' });
    });
    handle.bus.on(SubagentSubjects.await, (ctx) => {
      ctx.setResult({ status: 'failed', error: 'Model rate limited' });
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

    handle.bus.on(SubagentSubjects.spawn, (ctx) => {
      expect(ctx.payload.config.adapterName).toBe('resolved-adapter');
      expect(ctx.payload.config.model).toBe('opus');
      expect(ctx.payload.config.harnessId).toBe('reviewer-harness');
      expect(ctx.payload.config.providerContext?.providerConfigId).toBe('provider-1');
      expect(ctx.payload.config.contextMode).toBe('fresh');
      ctx.setResult({ subagentId: 'subagent-resolved', status: 'spawning' });
    });
    handle.bus.on(SubagentSubjects.await, (ctx) => {
      ctx.setResult({ status: 'completed', result: 'Review done' });
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
    expect(result.error).toBe('Subagent system not available');

    await handle.close();
  });

  it('respects abort signal for cancellation', async () => {
    const handle = await bootWorkerBus({ busAuth: { kind: 'none' } });
    const config = makeAgentConfig({ adapter: 'slow-adapter' });
    const controller = new AbortController();

    handle.bus.on(SubagentSubjects.spawn, (ctx) => {
      ctx.setResult({ subagentId: 'subagent-slow', status: 'spawning' });
    });
    handle.bus.on(SubagentSubjects.await, async (ctx) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      ctx.setResult({ status: 'failed', error: 'cancelled' });
    });
    let killed = false;
    handle.bus.on(SubagentSubjects.kill, (ctx) => {
      killed = true;
      ctx.setResult({ killed: true });
    });

    // Abort shortly after starting
    const resultPromise = runWorkerAgentStep(handle, config, controller.signal);
    setTimeout(() => controller.abort(), 20);

    const result = await resultPromise;

    expect(result.status).toBe('failed');
    expect(result.telemetry.duration).toBeGreaterThan(0);
    expect(killed).toBe(true);

    await handle.close();
  });
});
