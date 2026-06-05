import { describe, expect, it } from 'vitest';
import { SubjectTelemetryAttributeValueSchema } from '../schemas.js';

describe('SubjectTelemetryAttributeValueSchema', () => {
  it('accepts homogeneous primitive arrays', () => {
    expect(SubjectTelemetryAttributeValueSchema.safeParse(['a', 'b']).success).toBe(true);
    expect(SubjectTelemetryAttributeValueSchema.safeParse([1, 2]).success).toBe(true);
    expect(SubjectTelemetryAttributeValueSchema.safeParse([true, false]).success).toBe(true);
    expect(SubjectTelemetryAttributeValueSchema.safeParse([null, null]).success).toBe(true);
  });

  it('rejects mixed primitive arrays', () => {
    expect(SubjectTelemetryAttributeValueSchema.safeParse(['a', 1]).success).toBe(false);
    expect(SubjectTelemetryAttributeValueSchema.safeParse([1, null]).success).toBe(false);
  });
});
