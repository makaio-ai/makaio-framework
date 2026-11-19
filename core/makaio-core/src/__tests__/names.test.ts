import { describe, expect, it } from 'vitest';
import {
  ContributionNameSchema,
  ExtensionNameSchema,
  isOwnNameOrContribution,
  localContributionName,
} from '../types/names.js';

describe('localContributionName', () => {
  it('returns the local part for a plain owner', () => {
    expect(localContributionName('acme', 'acme.widgets')).toBe('widgets');
  });

  it('treats an owner that contains dots as one owner', () => {
    expect(localContributionName('makaio.clients-core', 'makaio.clients-core.profile-changed')).toBe('profile-changed');
  });

  it('treats an npm-scoped owner as one owner', () => {
    expect(localContributionName('@acme/review', '@acme/review.review-posted')).toBe('review-posted');
  });

  it('returns undefined when the name equals the owner', () => {
    expect(localContributionName('acme', 'acme')).toBeUndefined();
  });

  it('returns undefined when the local part is empty', () => {
    expect(localContributionName('acme', 'acme.')).toBeUndefined();
  });

  it('returns undefined for a prefix-matching variant of the owner', () => {
    expect(localContributionName('@acme/rev', '@acme/review.x')).toBeUndefined();
    expect(localContributionName('acme', 'acmex.widgets')).toBeUndefined();
  });

  it('returns undefined for an empty owner', () => {
    expect(localContributionName('', '.x')).toBeUndefined();
    expect(localContributionName('', 'x')).toBeUndefined();
  });

  it('keeps dots inside the local part', () => {
    expect(localContributionName('acme', 'acme.widgets.large')).toBe('widgets.large');
  });
});

describe('isOwnNameOrContribution', () => {
  it('accepts the owner name itself', () => {
    expect(isOwnNameOrContribution('acme', 'acme')).toBe(true);
  });

  it('accepts a contribution the owner owns', () => {
    expect(isOwnNameOrContribution('acme', 'acme.widgets')).toBe(true);
    expect(isOwnNameOrContribution('@acme/review', '@acme/review.review-posted')).toBe(true);
  });

  it('rejects an empty local part', () => {
    expect(isOwnNameOrContribution('acme', 'acme.')).toBe(false);
  });

  it('rejects a foreign or prefix-matching owner', () => {
    expect(isOwnNameOrContribution('@acme/rev', '@acme/review')).toBe(false);
    expect(isOwnNameOrContribution('@acme/rev', '@acme/review.x')).toBe(false);
  });
});

describe('ContributionNameSchema', () => {
  it.each(['a.b', 'makaio.clients-core.x', '@acme/review.x'])('accepts %j', (value) => {
    expect(ContributionNameSchema.safeParse(value).success).toBe(true);
  });

  it.each(['', 'a', '.a', 'a.'])('rejects %j', (value) => {
    expect(ContributionNameSchema.safeParse(value).success).toBe(false);
  });
});

describe('ExtensionNameSchema', () => {
  it.each(['gateway', 'makaio.clients-core', '@acme/review', '@acme/tools.v2'])('accepts %j', (value) => {
    expect(ExtensionNameSchema.safeParse(value).success).toBe(true);
  });

  it.each(['', '.', '..', 'foo/bar', 'a\\b', '@acme/..', '@a/b/c'])('rejects %j', (value) => {
    expect(ExtensionNameSchema.safeParse(value).success).toBe(false);
  });
});
