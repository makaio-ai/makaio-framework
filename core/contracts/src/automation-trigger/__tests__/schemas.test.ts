import { describe, expect, it } from 'vitest';
import { AutomationTriggerBindingSchema, AutomationTriggerKindSchema } from '../schemas.js';

describe('AutomationTriggerKindSchema', () => {
  it('accepts canonical dot-separated kinds', () => {
    expect(AutomationTriggerKindSchema.parse('makaio.clients-core.profile-changed')).toBe(
      'makaio.clients-core.profile-changed',
    );
    expect(AutomationTriggerKindSchema.parse('coderabbit.review-posted')).toBe('coderabbit.review-posted');
    expect(AutomationTriggerKindSchema.parse('factory.jira-assignment')).toBe('factory.jira-assignment');
    expect(AutomationTriggerKindSchema.parse('my-ext.some_event')).toBe('my-ext.some_event');
  });

  it('accepts npm-scoped owners with dot-separated local names', () => {
    expect(AutomationTriggerKindSchema.parse('@acme/review.review-posted')).toBe('@acme/review.review-posted');
    expect(AutomationTriggerKindSchema.parse('@acme.inc/review_tools.review-posted')).toBe(
      '@acme.inc/review_tools.review-posted',
    );
    expect(AutomationTriggerKindSchema.parse('@acme_inc/review.tools.review-posted')).toBe(
      '@acme_inc/review.tools.review-posted',
    );
    expect(AutomationTriggerKindSchema.parse('@-acme/review.review-posted')).toBe('@-acme/review.review-posted');
    expect(AutomationTriggerKindSchema.parse('@acme/-review.review-posted')).toBe('@acme/-review.review-posted');
  });

  it('rejects colon-separated aliases', () => {
    expect(AutomationTriggerKindSchema.safeParse('factory:jira-assignment').success).toBe(false);
    expect(AutomationTriggerKindSchema.safeParse('makaio:clients-core').success).toBe(false);
  });

  it('rejects scoped owners without a local name', () => {
    expect(AutomationTriggerKindSchema.safeParse('@acme/review').success).toBe(false);
  });

  it('rejects empty local-name segments', () => {
    expect(AutomationTriggerKindSchema.safeParse('@acme/review..event').success).toBe(false);
  });

  it('rejects strings with no dot separator', () => {
    expect(AutomationTriggerKindSchema.safeParse('noDot').success).toBe(false);
    expect(AutomationTriggerKindSchema.safeParse('nodot').success).toBe(false);
  });

  it('rejects uppercase in the first segment', () => {
    expect(AutomationTriggerKindSchema.safeParse('Factory.event').success).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(AutomationTriggerKindSchema.safeParse('').success).toBe(false);
  });

  it('rejects kinds ending with a dot', () => {
    expect(AutomationTriggerKindSchema.safeParse('ext.event.').success).toBe(false);
  });
});

describe('AutomationTriggerBindingSchema', () => {
  it('parses a valid binding', () => {
    const binding = AutomationTriggerBindingSchema.parse({
      kind: 'factory.jira-assignment',
      params: { projectKey: 'SHOP' },
    });
    expect(binding.kind).toBe('factory.jira-assignment');
    expect(binding.params).toEqual({ projectKey: 'SHOP' });
  });

  it('rejects a colon-separated kind', () => {
    expect(AutomationTriggerBindingSchema.safeParse({ kind: 'factory:jira-assignment', params: {} }).success).toBe(
      false,
    );
  });

  it('accepts an empty params map', () => {
    const binding = AutomationTriggerBindingSchema.parse({
      kind: 'ext.event',
      params: {},
    });
    expect(binding.params).toEqual({});
  });

  it('rejects non-JSON values in params', () => {
    expect(
      AutomationTriggerBindingSchema.safeParse({
        kind: 'ext.event',
        params: { fn: () => undefined },
      }).success,
    ).toBe(false);
  });
});
