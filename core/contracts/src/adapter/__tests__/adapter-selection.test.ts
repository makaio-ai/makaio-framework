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

  it('accepts selection with adapterId and its machine, and no name', () => {
    const parsed = AdapterSelectionSchema.parse({
      kind: 'adapter',
      adapterId: 'adapter-uuid-123',
      machineId: 'machine-a',
    });

    expect(parsed.adapterId).toBe('adapter-uuid-123');
    expect(parsed.machineId).toBe('machine-a');
    expect(parsed.adapterName).toBeUndefined();
  });

  it('accepts selection with adapterName, adapterId and its machine', () => {
    const parsed = AdapterSelectionSchema.parse({
      kind: 'adapter',
      adapterName: 'anthropic-sdk',
      adapterId: 'adapter-uuid-123',
      machineId: 'machine-a',
    });

    expect(parsed.adapterName).toBe('anthropic-sdk');
    expect(parsed.adapterId).toBe('adapter-uuid-123');
    expect(parsed.machineId).toBe('machine-a');
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

  it('trims surrounding whitespace from valid adapterName, adapterId and machineId', () => {
    const parsed = AdapterSelectionSchema.parse({
      kind: 'adapter',
      adapterName: '  anthropic-sdk  ',
      adapterId: '  adapter-uuid-123  ',
      machineId: '  machine-a  ',
    });

    expect(parsed.adapterName).toBe('anthropic-sdk');
    expect(parsed.adapterId).toBe('adapter-uuid-123');
    expect(parsed.machineId).toBe('machine-a');
  });

  /**
   * Case 213 — naming an instance requires naming its machine.
   *
   * Asserted **at contract level and not through the bus**: the test bus does not
   * validate payloads, so a suite that drove this through a request would report
   * a refusal the schema never made. Every backend and every caller sees this
   * schema, which is what makes leniency impossible rather than unlikely.
   */
  describe('the machine a named instance belongs to (case 213)', () => {
    it('rejects an adapterId with no machineId', () => {
      expect(() =>
        AdapterSelectionSchema.parse({
          kind: 'adapter',
          adapterName: 'anthropic-sdk',
          adapterId: 'adapter-uuid-123',
        }),
      ).toThrow("AdapterSelection requires 'machineId' when 'adapterId' is supplied");
    });

    it('rejects an adapterId whose machineId is present but blank', () => {
      // An empty machine is not a machine: `min(1)` after trimming is what keeps
      // the refinement from being satisfiable by a value no runtime can act under.
      expect(() =>
        AdapterSelectionSchema.parse({
          kind: 'adapter',
          adapterName: 'anthropic-sdk',
          adapterId: 'adapter-uuid-123',
          machineId: '   ',
        }),
      ).toThrow();
    });

    it('accepts adapterName alone, which resolves against the resolving runtime own machine', () => {
      // The other half of the refinement, and the reason it is a conditional rather
      // than a required field: a selection that names no instance needs no machine,
      // because resolution derives the instance for the runtime's own identity and
      // every ownership act names that same one.
      const parsed = AdapterSelectionSchema.parse({ kind: 'adapter', adapterName: 'anthropic-sdk' });

      expect(parsed.machineId).toBeUndefined();
      expect(parsed.adapterId).toBeUndefined();
    });

    it('rejects a machineId with no adapterId instead of accepting one nothing reads', () => {
      // The symmetric half of the rule. Resolution reads `machineId` only on the
      // branch a named instance takes; with no instance named it derives one for
      // the resolving runtime's own machine and never looks at this field. So the
      // shape was accepted and silently ignored, which leaves a caller believing
      // its machine was honoured — and a caller holding that belief while naming
      // an instance is the mis-key the other refinement refuses.
      expect(() =>
        AdapterSelectionSchema.parse({
          kind: 'adapter',
          adapterName: 'anthropic-sdk',
          machineId: 'machine-a',
        }),
      ).toThrow("AdapterSelection requires 'adapterId' when 'machineId' is supplied");
    });
  });
});
