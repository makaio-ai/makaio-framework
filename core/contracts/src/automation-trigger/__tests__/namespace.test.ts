import { describe, expect, it } from 'vitest';
import { FrameworkContractNamespaces } from '../../namespace-catalog.js';
import { AutomationTriggerSchemas, AutomationTriggerSubjects } from '../namespace.js';

describe('AutomationTrigger namespace', () => {
  it('registers subjects under the automation-triggers namespace', () => {
    expect(AutomationTriggerSubjects.list.$meta.namespace).toBe('automation-triggers');
    expect(AutomationTriggerSubjects.changed.$meta.namespace).toBe('automation-triggers');
  });

  it('exposes flat subject strings for list and changed', () => {
    expect(AutomationTriggerSubjects.list.subject).toBe('list');
    expect(AutomationTriggerSubjects.changed.subject).toBe('changed');
  });

  describe('list RPC contract', () => {
    it('accepts an empty list request', () => {
      expect(AutomationTriggerSchemas.list.request.safeParse({}).success).toBe(true);
    });

    it('accepts a list response with an empty triggers array', () => {
      expect(AutomationTriggerSchemas.list.response.safeParse({ triggers: [] }).success).toBe(true);
    });

    it('rejects a list response without a triggers field', () => {
      expect(AutomationTriggerSchemas.list.response.safeParse({}).success).toBe(false);
    });
  });

  describe('changed event contract', () => {
    it('accepts a registered changed event', () => {
      expect(
        AutomationTriggerSchemas.changed.safeParse({
          owner: 'my-extension',
          revision: 1,
          kinds: ['my-extension.assignment'],
          reason: 'registered',
        }).success,
      ).toBe(true);
    });

    it('accepts a deregistered changed event', () => {
      expect(
        AutomationTriggerSchemas.changed.safeParse({
          owner: 'my-extension',
          revision: 2,
          kinds: ['my-extension.assignment'],
          reason: 'deregistered',
        }).success,
      ).toBe(true);
    });

    it('rejects a changed event with empty owner', () => {
      expect(
        AutomationTriggerSchemas.changed.safeParse({
          owner: '',
          revision: 0,
          kinds: ['ext.assignment'],
          reason: 'registered',
        }).success,
      ).toBe(false);
    });

    it('rejects a changed event with an unknown reason', () => {
      expect(
        AutomationTriggerSchemas.changed.safeParse({
          owner: 'ext',
          revision: 0,
          kinds: ['ext.assignment'],
          reason: 'updated',
        }).success,
      ).toBe(false);
    });

    it('rejects a changed event with a negative revision', () => {
      expect(
        AutomationTriggerSchemas.changed.safeParse({
          owner: 'ext',
          revision: -1,
          kinds: ['ext.assignment'],
          reason: 'registered',
        }).success,
      ).toBe(false);
    });

    it('rejects a changed event without exact affected kinds', () => {
      expect(
        AutomationTriggerSchemas.changed.safeParse({
          owner: 'ext',
          revision: 1,
          kinds: [],
          reason: 'registered',
        }).success,
      ).toBe(false);
    });
  });

  it('is a member of FrameworkContractNamespaces', () => {
    const names = FrameworkContractNamespaces.map((ns) => ns.name);
    expect(names).toContain('automation-triggers');
  });
});
