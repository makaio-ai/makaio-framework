import { describe, expect, it } from 'vitest';
import { CredentialChangeSequenceSchema } from '../change-sequence.js';

describe('CredentialChangeSequenceSchema', () => {
  it('accepts safe non-negative integers', () => {
    expect(CredentialChangeSequenceSchema.safeParse(0).success).toBe(true);
    expect(CredentialChangeSequenceSchema.safeParse(Number.MAX_SAFE_INTEGER).success).toBe(true);
  });

  it('rejects values outside the safe integer range', () => {
    expect(CredentialChangeSequenceSchema.safeParse(-1).success).toBe(false);
    expect(CredentialChangeSequenceSchema.safeParse(Number.MAX_SAFE_INTEGER + 1).success).toBe(false);
  });
});
