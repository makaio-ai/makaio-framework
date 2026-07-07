import { describe, it, expect } from 'vitest';
import {
  EXTRACTION_EXCLUSION_KEY,
  buildExtractionExclusionMetadata,
  isExtractionExcluded,
} from '../extraction-exclusion.js';

describe('Extraction exclusion metadata contract', () => {
  it('exposes a namespaced key with makaio: prefix', () => {
    expect(EXTRACTION_EXCLUSION_KEY).toBe('makaio:extraction-excluded');
    expect(EXTRACTION_EXCLUSION_KEY).toMatch(/^makaio:/);
  });

  describe('buildExtractionExclusionMetadata', () => {
    it('returns a record with the exclusion key set to true', () => {
      const meta = buildExtractionExclusionMetadata();
      expect(meta).toEqual({ [EXTRACTION_EXCLUSION_KEY]: true });
    });

    it('is spreadable into an existing metadata record', () => {
      const existing = { 'custom:key': 'value' };
      const merged = { ...existing, ...buildExtractionExclusionMetadata() };
      expect(merged).toEqual({
        'custom:key': 'value',
        [EXTRACTION_EXCLUSION_KEY]: true,
      });
    });
  });

  describe('isExtractionExcluded', () => {
    it('returns true when the key is present and true', () => {
      expect(isExtractionExcluded({ [EXTRACTION_EXCLUSION_KEY]: true })).toBe(true);
    });

    it('returns false when the key is absent', () => {
      expect(isExtractionExcluded({ 'other:key': 'value' })).toBe(false);
    });

    it('returns false for undefined metadata', () => {
      expect(isExtractionExcluded(undefined)).toBe(false);
    });

    it('returns false for null metadata', () => {
      expect(isExtractionExcluded(null)).toBe(false);
    });

    it('returns false when the key is present but not true', () => {
      expect(isExtractionExcluded({ [EXTRACTION_EXCLUSION_KEY]: false })).toBe(false);
      expect(isExtractionExcluded({ [EXTRACTION_EXCLUSION_KEY]: 'true' })).toBe(false);
      expect(isExtractionExcluded({ [EXTRACTION_EXCLUSION_KEY]: 1 })).toBe(false);
    });
  });
});
