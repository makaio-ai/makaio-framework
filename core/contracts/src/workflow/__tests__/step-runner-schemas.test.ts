import { describe, expect, it } from 'vitest';
import {
  StepCancelPayloadSchema,
  StepRunConfigSchema,
  StepRunResultSchema,
  StepTelemetrySchema,
  WorkflowStepTypeSchema,
  WorkflowRunnerStepTypeSchema,
  StepRunnerBusAuthSchema,
  StepRunnerPlatformDefaultsSchema,
  createStepCancelSubject,
} from '../step-runner.js';
import type { IStepRunner, StepRunConfig, StepRunResult } from '../step-runner.js';

// ─────────────────────────────────────────────────────────────
// StepType
// ─────────────────────────────────────────────────────────────

describe('WorkflowStepTypeSchema', () => {
  it('accepts valid step types', () => {
    expect(WorkflowStepTypeSchema.parse('agent')).toBe('agent');
    expect(WorkflowStepTypeSchema.parse('shell')).toBe('shell');
    expect(WorkflowStepTypeSchema.parse('gate')).toBe('gate');
  });

  it('accepts bus-request as a workflow lifecycle step type', () => {
    expect(WorkflowStepTypeSchema.parse('bus-request')).toBe('bus-request');
  });

  it('rejects unknown step types', () => {
    expect(() => WorkflowStepTypeSchema.parse('lambda')).toThrow();
    expect(() => WorkflowStepTypeSchema.parse('')).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────
// StepTelemetry
// ─────────────────────────────────────────────────────────────

describe('StepTelemetrySchema', () => {
  it('accepts minimal telemetry (duration only)', () => {
    const result = StepTelemetrySchema.parse({ duration: 4500 });
    expect(result.duration).toBe(4500);
    expect(result.tokenUsage).toBeUndefined();
    expect(result.estimatedCost).toBeUndefined();
    expect(result.toolCalls).toBeUndefined();
  });

  it('accepts full telemetry with token usage', () => {
    const result = StepTelemetrySchema.parse({
      duration: 45000,
      tokenUsage: { input: 12400, output: 3200, cached: 8100 },
      estimatedCost: 0.12,
      toolCalls: 8,
    });
    expect(result.duration).toBe(45000);
    expect(result.tokenUsage?.input).toBe(12400);
    expect(result.tokenUsage?.cached).toBe(8100);
    expect(result.estimatedCost).toBe(0.12);
    expect(result.toolCalls).toBe(8);
  });

  it('accepts token usage without cached field', () => {
    const result = StepTelemetrySchema.parse({
      duration: 1000,
      tokenUsage: { input: 500, output: 200 },
    });
    expect(result.tokenUsage?.cached).toBeUndefined();
  });

  it('rejects negative duration', () => {
    expect(() => StepTelemetrySchema.parse({ duration: -1 })).toThrow();
  });

  it('rejects missing duration', () => {
    expect(() => StepTelemetrySchema.parse({})).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────
// StepRunConfig
// ─────────────────────────────────────────────────────────────

describe('StepRunConfigSchema', () => {
  const minimalConfig = {
    stepId: 'checkout-branch',
    executionId: 'wfx-abc123',
    workflowId: 'requirements-analysis',
    coordinatorSessionId: 'sess-coord-1',
    stepType: 'shell',
    stepDefinition: {
      id: 'checkout-branch',
      type: 'shell',
      command: ['git', 'checkout', '-b', 'req/42'],
    },
    resolvedInputs: {},
    platformDefaults: { cwd: '/workspace/project' },
    cancelSubject: 'workflow.wfx-abc123.step.checkout-branch.cancel',
  };

  it('accepts minimal shell step config', () => {
    const result = StepRunConfigSchema.parse(minimalConfig);
    expect(result.stepId).toBe('checkout-branch');
    expect(result.executionId).toBe('wfx-abc123');
    expect(result.workflowId).toBe('requirements-analysis');
    expect(result.stepType).toBe('shell');
  });

  it('accepts agent step config with resolved inputs', () => {
    const result = StepRunConfigSchema.parse({
      ...minimalConfig,
      stepType: 'agent',
      stepDefinition: {
        id: 'analyze',
        type: 'agent',
        prompt: 'Analyze the requirements for {{inputs.project}}',
      },
      resolvedInputs: {
        project: 'ranking-voucher-service',
        issueNumber: 42,
      },
    });
    expect(result.stepType).toBe('agent');
    expect(result.resolvedInputs).toEqual({
      project: 'ranking-voucher-service',
      issueNumber: 42,
    });
  });

  it('accepts optional busUrl and busAuth', () => {
    const result = StepRunConfigSchema.parse({
      ...minimalConfig,
      busUrl: 'ws://localhost:3100',
      busAuth: { kind: 'hmac', secret: 'hmac-secret' },
    });
    expect(result.busUrl).toBe('ws://localhost:3100');
    expect(result.busAuth).toEqual({ kind: 'hmac', secret: 'hmac-secret' });
  });

  it('rejects missing stepId', () => {
    const { stepId: _, ...noStepId } = minimalConfig;
    expect(() => StepRunConfigSchema.parse(noStepId)).toThrow();
  });

  it('rejects missing executionId', () => {
    const { executionId: _, ...noExecId } = minimalConfig;
    expect(() => StepRunConfigSchema.parse(noExecId)).toThrow();
  });

  it('rejects invalid stepType', () => {
    expect(() => StepRunConfigSchema.parse({ ...minimalConfig, stepType: 'invalid' })).toThrow();
  });

  it('rejects mismatched stepType and stepDefinition type', () => {
    expect(() =>
      StepRunConfigSchema.parse({
        ...minimalConfig,
        stepType: 'agent',
        stepDefinition: {
          id: 'checkout-branch',
          type: 'shell',
          command: ['git', 'status'],
        },
      }),
    ).toThrow();
  });

  it('rejects gate definitions even when stepType is runner-executable', () => {
    expect(() =>
      StepRunConfigSchema.parse({
        ...minimalConfig,
        stepType: 'agent',
        stepDefinition: {
          id: 'approval',
          type: 'gate',
          prompt: 'Approve?',
          autoAction: 'reject',
          timeoutMs: null,
        },
      }),
    ).toThrow();
  });

  it('rejects for-each definitions even when stepType is runner-executable', () => {
    expect(() =>
      StepRunConfigSchema.parse({
        ...minimalConfig,
        stepType: 'shell',
        stepDefinition: {
          id: 'process-items',
          type: 'for-each',
          collection: 'inputs.items',
          steps: [{ id: 'child', type: 'shell', command: ['echo', '{{ item }}'] }],
        },
      }),
    ).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────
// StepRunResult
// ─────────────────────────────────────────────────────────────

describe('StepRunResultSchema', () => {
  it('accepts completed result with output and telemetry', () => {
    const result = StepRunResultSchema.parse({
      status: 'completed',
      output: { verdict: 'approved', findings: [] },
      telemetry: { duration: 45000, estimatedCost: 0.12 },
    });
    expect(result.status).toBe('completed');
    expect(result.output).toEqual({ verdict: 'approved', findings: [] });
    expect(result.telemetry.duration).toBe(45000);
  });

  it('accepts failed result with error', () => {
    const result = StepRunResultSchema.parse({
      status: 'failed',
      error: 'Agent timed out after 300s',
      telemetry: { duration: 300000 },
    });
    expect(result.status).toBe('failed');
    expect(result.error).toBe('Agent timed out after 300s');
    expect(result.output).toBeUndefined();
  });

  it('accepts string output (shell stdout)', () => {
    const result = StepRunResultSchema.parse({
      status: 'completed',
      output: 'Already on branch req/42\n',
      telemetry: { duration: 2100 },
    });
    expect(result.output).toBe('Already on branch req/42\n');
  });

  it('accepts null output (gate step, no payload)', () => {
    const result = StepRunResultSchema.parse({
      status: 'completed',
      output: null,
      telemetry: { duration: 86400000 },
    });
    expect(result.output).toBeNull();
  });

  it('rejects missing status', () => {
    expect(() =>
      StepRunResultSchema.parse({
        output: 'something',
        telemetry: { duration: 100 },
      }),
    ).toThrow();
  });

  it('rejects invalid status value', () => {
    expect(() =>
      StepRunResultSchema.parse({
        status: 'running',
        telemetry: { duration: 100 },
      }),
    ).toThrow();
  });

  it('rejects missing telemetry', () => {
    expect(() =>
      StepRunResultSchema.parse({
        status: 'completed',
        output: 'ok',
      }),
    ).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────
// WorkflowRunnerStepTypeSchema (runner-only, excludes gate)
// ─────────────────────────────────────────────────────────────

describe('WorkflowRunnerStepTypeSchema', () => {
  it('accepts agent', () => {
    expect(WorkflowRunnerStepTypeSchema.parse('agent')).toBe('agent');
  });

  it('accepts shell', () => {
    expect(WorkflowRunnerStepTypeSchema.parse('shell')).toBe('shell');
  });

  it('rejects gate (gates are not runner-executable)', () => {
    expect(() => WorkflowRunnerStepTypeSchema.parse('gate')).toThrow();
  });

  it('rejects bus-request as a runner-executable step type', () => {
    expect(() => WorkflowRunnerStepTypeSchema.parse('bus-request')).toThrow();
  });

  it('rejects unknown types', () => {
    expect(() => WorkflowRunnerStepTypeSchema.parse('lambda')).toThrow();
    expect(() => WorkflowRunnerStepTypeSchema.parse('')).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────
// StepRunnerBusAuthSchema
// ─────────────────────────────────────────────────────────────

describe('StepRunnerBusAuthSchema', () => {
  it('accepts none auth', () => {
    const result = StepRunnerBusAuthSchema.parse({ kind: 'none' });
    expect(result.kind).toBe('none');
  });

  it('accepts hmac auth with secret', () => {
    const result = StepRunnerBusAuthSchema.parse({ kind: 'hmac', secret: 'my-secret-key' });
    expect(result.kind).toBe('hmac');
    if (result.kind === 'hmac') {
      expect(result.secret).toBe('my-secret-key');
    }
  });

  it('rejects hmac without secret', () => {
    expect(() => StepRunnerBusAuthSchema.parse({ kind: 'hmac' })).toThrow();
  });

  it('rejects unknown auth types', () => {
    expect(() => StepRunnerBusAuthSchema.parse({ kind: 'oauth' })).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────
// StepRunnerPlatformDefaultsSchema
// ─────────────────────────────────────────────────────────────

describe('StepRunnerPlatformDefaultsSchema', () => {
  it('accepts cwd only', () => {
    const result = StepRunnerPlatformDefaultsSchema.parse({ cwd: '/workspace/project' });
    expect(result.cwd).toBe('/workspace/project');
    expect(result.env).toBeUndefined();
  });

  it('accepts cwd with env', () => {
    const result = StepRunnerPlatformDefaultsSchema.parse({
      cwd: '/workspace/project',
      env: { NODE_ENV: 'production', CI: 'true' },
    });
    expect(result.cwd).toBe('/workspace/project');
    expect(result.env).toEqual({ NODE_ENV: 'production', CI: 'true' });
  });

  it('rejects missing cwd', () => {
    expect(() => StepRunnerPlatformDefaultsSchema.parse({})).toThrow();
    expect(() => StepRunnerPlatformDefaultsSchema.parse({ env: { A: 'B' } })).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────
// Step cancellation contract
// ─────────────────────────────────────────────────────────────

describe('StepCancelPayloadSchema / createStepCancelSubject', () => {
  it('accepts valid cancellation payloads', () => {
    const result = StepCancelPayloadSchema.parse({
      executionId: 'wfx-abc123',
      stepId: 'checkout-branch',
      reason: 'user_cancelled',
    });

    expect(result).toEqual({
      executionId: 'wfx-abc123',
      stepId: 'checkout-branch',
      reason: 'user_cancelled',
    });
  });

  it('builds a workflow subject definition from a fully qualified subject', () => {
    const subject = createStepCancelSubject('workflow.wfx-abc123.step.checkout-branch.cancel');

    expect(subject.$meta.namespace).toBe('workflow');
    expect(subject.subject).toBe('wfx-abc123.step.checkout-branch.cancel');
  });

  it('rejects malformed fully qualified subjects', () => {
    expect(() => createStepCancelSubject('workflow')).toThrow();
    expect(() => createStepCancelSubject('.invalid')).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────
// StepRunConfigSchema (tightened — runner-only step types)
// ─────────────────────────────────────────────────────────────

describe('StepRunConfigSchema (tightened)', () => {
  const agentConfig = {
    stepId: 'analyze-requirements',
    executionId: 'wfx-abc123',
    workflowId: 'requirements-analysis',
    coordinatorSessionId: 'sess-coord-1',
    stepType: 'agent',
    stepDefinition: {
      id: 'analyze-requirements',
      type: 'agent',
      prompt: 'Analyze the requirements for {{inputs.project}}',
    },
    resolvedInputs: { project: 'ranking-voucher-service' },
    busUrl: 'ws://localhost:3100',
    busAuth: { kind: 'hmac', secret: 'workflow-secret' },
    platformDefaults: { cwd: '/workspace/project' },
    cancelSubject: 'workflow.wfx-abc123.step.analyze-requirements.cancel',
  };

  const shellConfig = {
    stepId: 'checkout-branch',
    executionId: 'wfx-abc123',
    workflowId: 'requirements-analysis',
    coordinatorSessionId: 'sess-coord-1',
    stepType: 'shell',
    stepDefinition: {
      id: 'checkout-branch',
      type: 'shell',
      command: ['git', 'checkout', '-b', 'req/42'],
    },
    resolvedInputs: {},
    platformDefaults: { cwd: '/workspace/project', env: { GIT_AUTHOR_NAME: 'Bot' } },
    cancelSubject: 'workflow.wfx-abc123.step.checkout-branch.cancel',
  };

  it('accepts agent runner config with bus auth and platform defaults', () => {
    const result = StepRunConfigSchema.parse(agentConfig);
    expect(result.stepType).toBe('agent');
    expect(result.coordinatorSessionId).toBe('sess-coord-1');
    expect(result.busAuth).toEqual({ kind: 'hmac', secret: 'workflow-secret' });
    expect(result.platformDefaults).toEqual({ cwd: '/workspace/project' });
    expect(result.cancelSubject).toBe('workflow.wfx-abc123.step.analyze-requirements.cancel');
  });

  it('accepts shell runner config with platform defaults and env', () => {
    const result = StepRunConfigSchema.parse(shellConfig);
    expect(result.stepType).toBe('shell');
    expect(result.platformDefaults).toEqual({
      cwd: '/workspace/project',
      env: { GIT_AUTHOR_NAME: 'Bot' },
    });
  });

  it('rejects gate step type in runner config', () => {
    expect(() =>
      StepRunConfigSchema.parse({
        ...agentConfig,
        stepType: 'gate',
        stepDefinition: {
          id: 'approval',
          type: 'gate',
          prompt: 'Approve?',
          autoAction: 'reject',
          timeoutMs: null,
        },
      }),
    ).toThrow();
  });

  it('defaults busAuth to none when omitted', () => {
    const result = StepRunConfigSchema.parse(shellConfig);
    expect(result.busAuth).toEqual({ kind: 'none' });
  });

  it('accepts config without optional busUrl', () => {
    const { busUrl: _, ...noBusUrl } = agentConfig;
    const result = StepRunConfigSchema.parse(noBusUrl);
    expect(result.busUrl).toBeUndefined();
  });

  it('requires coordinatorSessionId', () => {
    const { coordinatorSessionId: _, ...noCoord } = agentConfig;
    expect(() => StepRunConfigSchema.parse(noCoord)).toThrow();
  });

  it('requires cancelSubject', () => {
    const { cancelSubject: _, ...noCancel } = agentConfig;
    expect(() => StepRunConfigSchema.parse(noCancel)).toThrow();
  });

  it('requires platformDefaults', () => {
    const { platformDefaults: _, ...noPlatform } = agentConfig;
    expect(() => StepRunConfigSchema.parse(noPlatform)).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────
// IStepRunner interface (type-level contract assertions)
// ─────────────────────────────────────────────────────────────

describe('IStepRunner interface', () => {
  it('requires managesWorkflowLifecycle boolean property', () => {
    // Type-level assertion: a compliant implementation must have this property
    const runner: IStepRunner = {
      managesWorkflowLifecycle: false,
      run: async (_config: StepRunConfig, _signal: AbortSignal): Promise<StepRunResult> => {
        return { status: 'completed', telemetry: { duration: 0 } };
      },
    };
    expect(runner.managesWorkflowLifecycle).toBe(false);
  });

  it('run accepts AbortSignal as second parameter', () => {
    const controller = new AbortController();
    const runner: IStepRunner = {
      managesWorkflowLifecycle: false,
      run: async (_config: StepRunConfig, signal: AbortSignal): Promise<StepRunResult> => {
        expect(signal).toBe(controller.signal);
        return { status: 'completed', telemetry: { duration: 0 } };
      },
    };
    // Execute to confirm signal is passed through
    return expect(
      runner.run(
        StepRunConfigSchema.parse({
          stepId: 'test',
          executionId: 'wfx-1',
          workflowId: 'wf-1',
          coordinatorSessionId: 'sess-1',
          stepType: 'shell',
          stepDefinition: { id: 'test', type: 'shell', command: ['echo', 'hi'] },
          resolvedInputs: {},
          platformDefaults: { cwd: '/tmp' },
          cancelSubject: 'workflow.wfx-1.step.test.cancel',
        }),
        controller.signal,
      ),
    ).resolves.toEqual({ status: 'completed', telemetry: { duration: 0 } });
  });

  it('supports optional forceKill method', () => {
    const runner: IStepRunner = {
      managesWorkflowLifecycle: true,
      run: async () => ({ status: 'completed', telemetry: { duration: 0 } }),
      forceKill: async (_executionId: string, _stepId: string) => {},
    };
    expect(runner.forceKill).toBeDefined();
  });

  it('supports optional dispose method', () => {
    const runner: IStepRunner = {
      managesWorkflowLifecycle: false,
      run: async () => ({ status: 'completed', telemetry: { duration: 0 } }),
      dispose: async () => {},
    };
    expect(runner.dispose).toBeDefined();
  });
});
