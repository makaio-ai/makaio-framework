import { describe, it, expect } from 'vitest';
import { AdapterSelectionSchema } from '../schemas/agent-resolution.js';

describe('AdapterSelectionSchema', () => {
  it('accepts selection with adapterName only', () => {
    const parsed = AdapterSelectionSchema.parse({
      kind: 'adapter',
      adapterName: 'anthropic-sdk',
    });

    expect(parsed.adapterName).toBe('anthropic-sdk');
    expect(parsed.adapterId).toBeUndefined();
  });

  it('accepts selection with adapterId only', () => {
    const parsed = AdapterSelectionSchema.parse({
      kind: 'adapter',
      adapterId: 'adapter-uuid-123',
    });

    expect(parsed.adapterId).toBe('adapter-uuid-123');
    expect(parsed.adapterName).toBeUndefined();
  });

  it('accepts selection with both adapterName and adapterId', () => {
    const parsed = AdapterSelectionSchema.parse({
      kind: 'adapter',
      adapterName: 'anthropic-sdk',
      adapterId: 'adapter-uuid-123',
    });

    expect(parsed.adapterName).toBe('anthropic-sdk');
    expect(parsed.adapterId).toBe('adapter-uuid-123');
  });

  it('rejects selection with neither adapterName nor adapterId', () => {
    expect(() =>
      AdapterSelectionSchema.parse({
        kind: 'adapter',
      }),
    ).toThrow("AdapterSelection requires at least one of 'adapterName' or 'adapterId'");
  });

  it('rejects selection with empty-string adapterName and no adapterId', () => {
    expect(() =>
      AdapterSelectionSchema.parse({
        kind: 'adapter',
        adapterName: '',
      }),
    ).toThrow();
  });

  it('rejects selection with empty-string adapterId and no adapterName', () => {
    expect(() =>
      AdapterSelectionSchema.parse({
        kind: 'adapter',
        adapterId: '',
      }),
    ).toThrow();
  });

  it('rejects selection with both fields empty-string', () => {
    expect(() =>
      AdapterSelectionSchema.parse({
        kind: 'adapter',
        adapterName: '',
        adapterId: '',
      }),
    ).toThrow();
  });

  it('rejects selection with whitespace-only adapterName and no adapterId', () => {
    expect(() =>
      AdapterSelectionSchema.parse({
        kind: 'adapter',
        adapterName: '   ',
      }),
    ).toThrow();
  });

  it('rejects selection with whitespace-only adapterId and no adapterName', () => {
    expect(() =>
      AdapterSelectionSchema.parse({
        kind: 'adapter',
        adapterId: '   ',
      }),
    ).toThrow();
  });

  it('trims surrounding whitespace from valid adapterName and adapterId', () => {
    const parsed = AdapterSelectionSchema.parse({
      kind: 'adapter',
      adapterName: '  anthropic-sdk  ',
      adapterId: '  adapter-uuid-123  ',
    });

    expect(parsed.adapterName).toBe('anthropic-sdk');
    expect(parsed.adapterId).toBe('adapter-uuid-123');
  });
});
