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

  it('accepts rerun-of link type', () => {
    expect(ExecutionLinkTypeSchema.parse('rerun-of')).toBe('rerun-of');
  });
});

// ─────────────────────────────────────────────────────────────
// SpanRecord
// ─────────────────────────────────────────────────────────────

describe('SpanRecordSchema', () => {
  const minimalSpan = {
    executionId: 'wfx-abc123',
    frameId: 'frm-abc123',
    stepId: 'analyze-requirements',
    stepType: 'station',
    status: 'completed',
    startedAt: 1716000000000,
    completedAt: 1716000002100,
    durationMs: 2100,
  };

  it('accepts a minimal completed station span', () => {
    const result = SpanRecordSchema.parse(minimalSpan);
    expect(result.executionId).toBe('wfx-abc123');
    expect(result.frameId).toBe('frm-abc123');
    expect(result.stepId).toBe('analyze-requirements');
    expect(result.stepType).toBe('station');
    expect(result.status).toBe('completed');
    expect(result.durationMs).toBe(2100);
  });

  it('accepts a running span without completedAt', () => {
    const result = SpanRecordSchema.parse({
      executionId: 'wfx-abc123',
      frameId: 'frm-running',
      stepId: 'analyze',
      stepType: 'station',
      status: 'running',
      startedAt: 1716000000000,
    });
    expect(result.completedAt).toBeUndefined();
    expect(result.durationMs).toBeUndefined();
  });

  it('accepts a full station span with LLM telemetry fields', () => {
    const result = SpanRecordSchema.parse({
      ...minimalSpan,
      stepType: 'station',
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

  it('accepts a gate span', () => {
    const result = SpanRecordSchema.parse({
      executionId: 'wfx-abc123',
      frameId: 'frm-gate',
      stepId: 'approval-gate',
      stepType: 'gate',
      status: 'completed',
      startedAt: 1716000000000,
      completedAt: 1716000060000,
      durationMs: 60000,
    });
    expect(result.stepType).toBe('gate');
    expect(result.status).toBe('completed');
  });

  it('accepts a skipped span', () => {
    const result = SpanRecordSchema.parse({
      executionId: 'wfx-abc123',
      frameId: 'frm-skipped',
      stepId: 'optional-station',
      stepType: 'station',
      status: 'skipped',
    });
    expect(result.status).toBe('skipped');
    expect(result.startedAt).toBeUndefined();
  });

  it('accepts a failed span with no telemetry', () => {
    const result = SpanRecordSchema.parse({
      executionId: 'wfx-abc123',
      frameId: 'frm-failed',
      stepId: 'deploy-station',
      stepType: 'station',
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

  it('rejects missing frameId', () => {
    const { frameId: _, ...noFrameId } = minimalSpan;
    expect(() => SpanRecordSchema.parse(noFrameId)).toThrow();
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
    expect(() => SpanRecordSchema.parse({ ...minimalSpan, stepType: 'agent' })).toThrow();
    expect(() => SpanRecordSchema.parse({ ...minimalSpan, stepType: 'shell' })).toThrow();
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

  it('accepts rerun provenance links with mode metadata', () => {
    const result = ExecutionLinkSchema.parse({
      sourceExecutionId: 'wfx-original',
      targetExecutionId: 'wfx-rerun',
      linkType: 'rerun-of',
      metadata: {
        mode: 'snapshot',
        reason: 'validate after fix',
      },
    });

    expect(result).toEqual({
      sourceExecutionId: 'wfx-original',
      targetExecutionId: 'wfx-rerun',
      linkType: 'rerun-of',
      metadata: {
        mode: 'snapshot',
        reason: 'validate after fix',
      },
    });
  });
});
