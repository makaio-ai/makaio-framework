import type { ExtensionOperatorConfigEntry } from '@makaio/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { readAllocationScopeSetting } from '../allocation-scope-source.js';
import { decideAllocationScope } from '../scope-decision.js';

describe('worker allocation scope', () => {
  const source = 'operator snapshot';
  const snapshot = new Map<string, ExtensionOperatorConfigEntry>([
    ['example.active', { kind: 'config', source, config: { allocationScope: 'review-workers' } }],
    ['example.other', { kind: 'config', source, config: { allocationScope: 'other-workers' } }],
    ['example.empty', { kind: 'config', source, config: {} }],
    ['example.invalid', { kind: 'config', source, config: { allocationScope: 'Review Workers' } }],
    ['example.blank', { kind: 'config', source, config: { allocationScope: '' } }],
    ['example.spaces', { kind: 'config', source, config: { allocationScope: ' ' } }],
    ['example.null', { kind: 'config', source, config: { allocationScope: null } }],
    ['example.failed', { kind: 'failure', source, reason: 'invalid-json', detail: 'Private entry content' }],
  ]);

  it.each([
    [undefined, { kind: 'absent' }],
    ['example.unknown', { kind: 'absent' }],
    ['example.empty', { kind: 'absent' }],
    ['example.invalid', { kind: 'invalid', reason: 'value-malformed' }],
    ['example.blank', { kind: 'invalid', reason: 'value-malformed' }],
    ['example.spaces', { kind: 'invalid', reason: 'value-malformed' }],
    ['example.null', { kind: 'invalid', reason: 'value-malformed' }],
    ['example.failed', { kind: 'invalid', reason: 'entry-unusable' }],
    ['example.active', { kind: 'present', value: 'review-workers' }],
  ] as const)('reads only the designated operator entry %s', (extension, expected) => {
    expect(readAllocationScopeSetting(snapshot, extension)).toEqual(expected);
  });

  it('uses the operator scope even when extension schema resolution changes it', () => {
    const operatorConfig = { allocationScope: 'operator-scope' };
    const extensionSchema = z.strictObject({ allocationScope: z.string().transform(() => 'resolved-scope') });
    const resolvedConfig = extensionSchema.parse(operatorConfig);
    const operatorSnapshot = new Map<string, ExtensionOperatorConfigEntry>([
      ['example.active', { kind: 'config', config: operatorConfig, source }],
    ]);
    expect(resolvedConfig.allocationScope).toBe('resolved-scope');
    expect(readAllocationScopeSetting(operatorSnapshot, 'example.active')).toEqual({
      kind: 'present',
      value: 'operator-scope',
    });
  });

  const present = readAllocationScopeSetting(snapshot, 'example.active');

  it.each([
    [{ kind: 'absent' }, 'review-workers', 'setting-missing'],
    [{ kind: 'invalid', reason: 'entry-unusable' }, 'review-workers', 'setting-invalid'],
    [readAllocationScopeSetting(snapshot, 'example.invalid'), undefined, 'setting-invalid'],
    [present, undefined, 'binding-missing'],
    [present, 'other-workers', 'binding-mismatch'],
    [present, 'INVALID', 'binding-mismatch'],
  ] as const)('returns the explicit reason for a blocked provider', (setting, binding, reason) => {
    expect(decideAllocationScope(setting, binding)).toEqual({ kind: 'blocked', reason });
  });

  it('mints an immutable scope when the setting matches the binding', () => {
    const decision = decideAllocationScope(present, 'review-workers');
    expect(decision).toEqual({ kind: 'bound', scope: { value: 'review-workers' } });
    if (decision.kind !== 'bound') throw new Error('Scope must be bound');
    expect(Object.isFrozen(decision.scope)).toBe(true);
  });
});
