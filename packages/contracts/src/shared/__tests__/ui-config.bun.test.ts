import { describe, expect, it } from 'bun:test';
import { FieldOverrideSchema } from '../ui-config.js';

function expectIssuePath(issues: ReadonlyArray<{ path: PropertyKey[] }>, expectedSegment: string) {
  expect(issues.some((issue) => issue.path.includes(expectedSegment))).toBe(true);
}

describe('FieldOverrideSchema', () => {
  it('rejects non-positive slider steps', () => {
    const parsed = FieldOverrideSchema.safeParse({ widget: 'slider', step: 0 });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expectIssuePath(parsed.error.issues, 'step');
    }
  });

  it('rejects a minimum greater than the maximum', () => {
    const parsed = FieldOverrideSchema.safeParse({ widget: 'slider', min: 10, max: 5 });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expectIssuePath(parsed.error.issues, 'min');
    }
  });

  it('rejects non-finite numeric overrides', () => {
    const parsed = FieldOverrideSchema.safeParse({
      widget: 'slider',
      min: Number.NEGATIVE_INFINITY,
      max: Number.POSITIVE_INFINITY,
      step: Number.NaN,
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expectIssuePath(parsed.error.issues, 'min');
      expectIssuePath(parsed.error.issues, 'max');
      expectIssuePath(parsed.error.issues, 'step');
    }
  });

  it('accepts a valid numeric override range', () => {
    const parsed = FieldOverrideSchema.safeParse({ widget: 'slider', min: 5, max: 10, step: 1 });

    expect(parsed.success).toBe(true);
  });

  it('accepts equal min and max values', () => {
    const parsed = FieldOverrideSchema.safeParse({ widget: 'slider', min: 5, max: 5, step: 1 });

    expect(parsed.success).toBe(true);
  });
});
