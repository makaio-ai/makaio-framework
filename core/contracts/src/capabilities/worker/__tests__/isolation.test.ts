import { describe, expect, it } from 'vitest';
import * as rootBarrel from '../../../index.js';
import * as capabilitiesBarrel from '../../index.js';
import * as workerBarrel from '../index.js';
import { ISOLATION_LEVELS, type IsolationLevel, IsolationLevelSchema, holdsAtLeast } from '../isolation.js';

describe('step isolation levels', () => {
  it('orders the levels from process over user to machine', () => {
    expect(ISOLATION_LEVELS).toEqual(['process', 'user', 'machine']);
    expect(IsolationLevelSchema.options).toEqual([...ISOLATION_LEVELS]);
  });

  it('holds a requirement at the same or a weaker level and no stronger one', () => {
    for (const [declaredRank, declared] of ISOLATION_LEVELS.entries()) {
      for (const [requiredRank, required] of ISOLATION_LEVELS.entries()) {
        expect(holdsAtLeast(declared, required)).toBe(declaredRank >= requiredRank);
      }
    }
    expect(holdsAtLeast('machine', 'process')).toBe(true);
    expect(holdsAtLeast('process', 'user')).toBe(false);
  });

  it('parses every level of the scale', () => {
    for (const level of ISOLATION_LEVELS) {
      expect(IsolationLevelSchema.parse(level)).toBe(level);
    }
  });

  it('refuses a value that is not a level', () => {
    expect(IsolationLevelSchema.safeParse('container').success).toBe(false);
  });

  it('holds nothing for a value outside the scale that reached it unparsed', () => {
    // A level that was read from stored or received data without parsing it.
    const unparsed: string = 'container';
    const unknown = unparsed as IsolationLevel;
    expect(holdsAtLeast(unknown, 'process')).toBe(false);
    expect(holdsAtLeast('machine', unknown)).toBe(false);
    expect(holdsAtLeast(unknown, unknown)).toBe(false);
  });

  it('is exported as the same objects from the worker entry, the capabilities entry and the package root', () => {
    for (const barrel of [workerBarrel, capabilitiesBarrel, rootBarrel]) {
      expect(barrel.ISOLATION_LEVELS).toBe(ISOLATION_LEVELS);
      expect(barrel.IsolationLevelSchema).toBe(IsolationLevelSchema);
      expect(barrel.holdsAtLeast).toBe(holdsAtLeast);
    }
  });

  it('is reachable through the package specifier', async () => {
    const contracts = await import('@makaio/contracts');
    expect(contracts.ISOLATION_LEVELS).toEqual(['process', 'user', 'machine']);
    expect(contracts.IsolationLevelSchema.parse('user')).toBe('user');
    expect(contracts.holdsAtLeast('machine', 'user')).toBe(true);
  });
});
