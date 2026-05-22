import { describe, expect, it } from 'vitest';
import {
  StepRunConfigSchema,
  StepRunResultSchema,
  StepTelemetrySchema,
  WorkflowStepTypeSchema,
} from '../step-runner.js';

// ─────────────────────────────────────────────────────────────
// StepType
// ─────────────────────────────────────────────────────────────

describe('WorkflowStepTypeSchema', () => {
  it('accepts valid step types', () => {
    expect(WorkflowStepTypeSchema.parse('agent')).toBe('agent');
    expect(WorkflowStepTypeSchema.parse('shell')).toBe('shell');
    expect(WorkflowStepTypeSchema.parse('gate')).toBe('gate');
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
    stepType: 'shell',
    stepDefinition: {
      id: 'checkout-branch',
      type: 'shell',
      command: ['git', 'checkout', '-b', 'req/42'],
    },
    resolvedInputs: {},
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
      busAuth: { token: 'hmac-secret' },
    });
    expect(result.busUrl).toBe('ws://localhost:3100');
    expect(result.busAuth).toEqual({ token: 'hmac-secret' });
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
