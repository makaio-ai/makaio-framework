import { describe, expect, it } from 'vitest';
import { VariantSchemas } from './schemas.js';

describe('VariantSchemas.requestUpgrade.response', () => {
  const schema = VariantSchemas.requestUpgrade.response;

  it('accepts an accepted upgrade response with optional download size', () => {
    expect(schema.safeParse({ accepted: true, downloadSizeBytes: 1024 }).success).toBe(true);
  });

  it('requires a refusal message when an upgrade request is declined', () => {
    expect(schema.safeParse({ accepted: false }).success).toBe(false);
    expect(schema.safeParse({ accepted: false, message: '' }).success).toBe(false);
    expect(schema.safeParse({ accepted: false, message: 'Already on this variant' }).success).toBe(true);
  });

  it('requires accepted download sizes to be non-negative integers', () => {
    expect(schema.safeParse({ accepted: true, downloadSizeBytes: -1 }).success).toBe(false);
    expect(schema.safeParse({ accepted: true, downloadSizeBytes: 1.5 }).success).toBe(false);
  });
});

describe('VariantSchemas.upgradeProgress', () => {
  it('accepts progress percentages from 0 through 100', () => {
    expect(VariantSchemas.upgradeProgress.safeParse({ status: 'progress', percent: 0 }).success).toBe(true);
    expect(VariantSchemas.upgradeProgress.safeParse({ status: 'progress', percent: 100 }).success).toBe(true);
  });

  it('rejects progress percentages outside 0 through 100', () => {
    expect(VariantSchemas.upgradeProgress.safeParse({ status: 'progress', percent: -1 }).success).toBe(false);
    expect(VariantSchemas.upgradeProgress.safeParse({ status: 'progress', percent: 101 }).success).toBe(false);
  });
});
