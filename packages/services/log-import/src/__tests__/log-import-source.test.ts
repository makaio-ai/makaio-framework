import { describe, expect, it } from 'vitest';
import { classifyLogImporterSource } from '../log-import-source.js';

describe('classifyLogImporterSource', () => {
  it('classifies adapter-backed registrations as adapter sources', () => {
    expect(classifyLogImporterSource({ hasAdapterContribution: true })).toBe('adapter');
  });

  it('classifies extension-only registrations as extension sources', () => {
    expect(classifyLogImporterSource({ hasAdapterContribution: false })).toBe('extension');
  });
});
