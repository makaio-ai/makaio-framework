import { describe, expect, it } from 'vitest';
import { SpanRecordSchema, ExecutionLinkSchema, ExecutionLinkTypeSchema } from '../span.js';

// ─────────────────────────────────────────────────────────────
// ExecutionLinkType
// ─────────────────────────────────────────────────────────────

describe('ExecutionLinkTypeSchema', () => {
  it('accepts valid link types', () => {
    expect(ExecutionLinkTypeSchema.parse('triggered-by')).toBe('triggered-by');
    expect(ExecutionLinkTypeSchema.parse('feedback-loop')).toBe('feedback-loop');
  });

  it('rejects unknown link types', () => {
    expect(() => ExecutionLinkTypeSchema.parse('parent-child')).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────
// SpanRecord
// ─────────────────────────────────────────────────────────────

describe('SpanRecordSchema', () => {
  const minimalSpan = {
    executionId: 'wfx-abc123',
    stepId: 'checkout-branch',
    stepType: 'shell',
    status: 'completed',
    startedAt: 1716000000000,
    completedAt: 1716000002100,
    durationMs: 2100,
  };

  it('accepts a minimal completed shell span', () => {
    const result = SpanRecordSchema.parse(minimalSpan);
    expect(result.executionId).toBe('wfx-abc123');
    expect(result.stepId).toBe('checkout-branch');
    expect(result.stepType).toBe('shell');
    expect(result.status).toBe('completed');
    expect(result.durationMs).toBe(2100);
  });

  it('accepts a running span without completedAt', () => {
    const result = SpanRecordSchema.parse({
      executionId: 'wfx-abc123',
      stepId: 'analyze',
      stepType: 'agent',
      status: 'running',
      startedAt: 1716000000000,
    });
    expect(result.completedAt).toBeUndefined();
    expect(result.durationMs).toBeUndefined();
  });

  it('accepts a full agent span with telemetry fields', () => {
    const result = SpanRecordSchema.parse({
      ...minimalSpan,
      stepType: 'agent',
      inputTokens: 12400,
      outputTokens: 3200,
      estimatedCost: 0.12,
      toolCallCount: 8,
      input: JSON.stringify({ prompt: 'Analyze requirements' }),
      output: JSON.stringify({ verdict: 'approved' }),
    });
    expect(result.inputTokens).toBe(12400);
    expect(result.outputTokens).toBe(3200);
    expect(result.estimatedCost).toBe(0.12);
    expect(result.toolCallCount).toBe(8);
  });

  it('accepts a skipped span', () => {
    const result = SpanRecordSchema.parse({
      executionId: 'wfx-abc123',
      stepId: 'optional-step',
      stepType: 'shell',
      status: 'skipped',
    });
    expect(result.status).toBe('skipped');
    expect(result.startedAt).toBeUndefined();
  });

  it('accepts a failed span with no telemetry', () => {
    const result = SpanRecordSchema.parse({
      executionId: 'wfx-abc123',
      stepId: 'deploy',
      stepType: 'shell',
      status: 'failed',
      startedAt: 1716000000000,
      completedAt: 1716000005000,
      durationMs: 5000,
    });
    expect(result.status).toBe('failed');
    expect(result.inputTokens).toBeUndefined();
  });

  it('rejects missing executionId', () => {
    const { executionId: _, ...noExecId } = minimalSpan;
    expect(() => SpanRecordSchema.parse(noExecId)).toThrow();
  });

  it('rejects missing stepId', () => {
    const { stepId: _, ...noStepId } = minimalSpan;
    expect(() => SpanRecordSchema.parse(noStepId)).toThrow();
  });

  it('rejects invalid status', () => {
    expect(() => SpanRecordSchema.parse({ ...minimalSpan, status: 'paused' })).toThrow();
  });

  it('rejects invalid stepType', () => {
    expect(() => SpanRecordSchema.parse({ ...minimalSpan, stepType: 'lambda' })).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────
// ExecutionLink
// ─────────────────────────────────────────────────────────────

describe('ExecutionLinkSchema', () => {
  it('accepts a triggered-by link', () => {
    const result = ExecutionLinkSchema.parse({
      sourceExecutionId: 'wfx-abc123',
      targetExecutionId: 'wfx-def456',
      linkType: 'triggered-by',
    });
    expect(result.sourceExecutionId).toBe('wfx-abc123');
    expect(result.targetExecutionId).toBe('wfx-def456');
    expect(result.linkType).toBe('triggered-by');
  });

  it('accepts a feedback-loop link with metadata', () => {
    const result = ExecutionLinkSchema.parse({
      sourceExecutionId: 'wfx-abc123',
      targetExecutionId: 'wfx-ghi789',
      linkType: 'feedback-loop',
      metadata: { reason: 'qa-rejected', targetStation: 'requirements-analysis' },
    });
    expect(result.metadata?.reason).toBe('qa-rejected');
  });

  it('rejects missing sourceExecutionId', () => {
    expect(() =>
      ExecutionLinkSchema.parse({
        targetExecutionId: 'wfx-def456',
        linkType: 'triggered-by',
      }),
    ).toThrow();
  });

  it('rejects invalid link type', () => {
    expect(() =>
      ExecutionLinkSchema.parse({
        sourceExecutionId: 'wfx-abc123',
        targetExecutionId: 'wfx-def456',
        linkType: 'parent-child',
      }),
    ).toThrow();
  });
});
