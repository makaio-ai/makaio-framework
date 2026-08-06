import { describe, expect, it } from 'vitest';
import { ReviewSchemas } from '../schemas.js';

const FindingsArrivedSchema = ReviewSchemas['findings.arrived'];

const target = { repository: 'makaio-ai/makaio', prNumber: 42 } as const;

describe("ReviewSchemas['findings.arrived']", () => {
  it('parses a per-source findings envelope', () => {
    const parsed = FindingsArrivedSchema.parse({
      target,
      sourceId: 'coderabbit',
      reviewer: 'coderabbit',
      created: 3,
      updated: 0,
    });

    expect(parsed).toEqual({
      target,
      sourceId: 'coderabbit',
      reviewer: 'coderabbit',
      created: 3,
      updated: 0,
    });
  });

  it('rejects the former aggregate shape that carried no source identity', () => {
    const result = FindingsArrivedSchema.safeParse({ target, created: 3, updated: 1 });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toEqual(
      expect.arrayContaining(['sourceId', 'reviewer']),
    );
  });

  it('rejects blank source identity so subscribers can always attribute a change', () => {
    const result = FindingsArrivedSchema.safeParse({
      target,
      sourceId: '',
      reviewer: '',
      created: 1,
      updated: 0,
    });

    expect(result.success).toBe(false);
  });

  it('rejects fractional and negative counts', () => {
    expect(
      FindingsArrivedSchema.safeParse({
        target,
        sourceId: 'coderabbit',
        reviewer: 'coderabbit',
        created: 1.5,
        updated: 0,
      }).success,
    ).toBe(false);

    expect(
      FindingsArrivedSchema.safeParse({
        target,
        sourceId: 'coderabbit',
        reviewer: 'coderabbit',
        created: 0,
        updated: -1,
      }).success,
    ).toBe(false);
  });
});
