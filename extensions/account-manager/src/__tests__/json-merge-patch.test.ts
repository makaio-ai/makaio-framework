import { describe, expect, it } from 'vitest';
import { applyJsonMergePatch, jsonValuesEqual } from '../utils/json-merge-patch.js';

describe('json merge patch helpers', () => {
  it('replaces non-plain target objects instead of recursively merging into them', () => {
    const patched = applyJsonMergePatch(
      { value: new Date('2026-01-01T00:00:00.000Z') },
      { value: { status: 'updated' } },
    );

    expect(patched).toEqual({ value: { status: 'updated' } });
  });

  it('does not compare distinct non-plain objects as equal', () => {
    expect(jsonValuesEqual(new Date('2026-01-01T00:00:00.000Z'), new Date('2026-01-02T00:00:00.000Z'))).toBe(false);
  });

  it('still recurses into plain records', () => {
    expect(jsonValuesEqual({ nested: { value: 1 } }, { nested: { value: 1 } })).toBe(true);
  });
});
