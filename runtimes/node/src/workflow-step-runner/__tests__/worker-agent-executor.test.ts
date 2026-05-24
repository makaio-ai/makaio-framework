import { describe, it, expect } from 'vitest';
import { AgentSubjects, AdapterSubjects, WorkflowSubjects, type StepRunConfig } from '@makaio/contracts';
import { bootWorkerBus } from '../worker-boot.js';
import { runWorkerAgentStep } from '../worker-agent-executor.js';

/**
 * Create a minimal StepRunConfig for an agent step.
 * @param overrides - Fields to override on the agent step definition.
 * @returns A valid StepRunConfig for testing.
 */
function makeAgentConfig(overrides: { adapter?: string; role?: string; prompt?: string } = {}): StepRunConfig {
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
    resolvedInputs: {},
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
    const config = makeAgentConfig({ adapter: 'test-adapter', prompt: 'Hello agent' });
    const controller = new AbortController();

    // Register a mock handler for adapter.startAgent
    handle.bus.on(AdapterSubjects.startAgent, (ctx) => {
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
      });
    });

    // Register startAgent handler
    handle.bus.on(AdapterSubjects.startAgent, (ctx) => {
      expect(ctx.payload.adapterId).toBe('resolved-adapter');
      expect(ctx.payload.model).toBe('opus');
      expect(ctx.payload.harnessId).toBe('reviewer-harness');

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
});
