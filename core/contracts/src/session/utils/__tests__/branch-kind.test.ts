import { describe, expect, it } from 'vitest';

import { BranchKindSchema } from '../../schemas/primitives.js';
import { getBranchBehavior, isInViewBranch, isMergeable, isNavigatingBranch } from '../branch-kind.js';

describe('isInViewBranch', () => {
  it('returns true for branch', () => {
    expect(isInViewBranch('branch')).toBe(true);
  });

  it('returns true for subagent', () => {
    expect(isInViewBranch('subagent')).toBe(true);
  });

  it('returns true for coordinator', () => {
    expect(isInViewBranch('coordinator')).toBe(true);
  });

  it('returns false for fork', () => {
    expect(isInViewBranch('fork')).toBe(false);
  });

  it('returns false for compress', () => {
    expect(isInViewBranch('compress')).toBe(false);
  });

  it('returns false for rewrite', () => {
    expect(isInViewBranch('rewrite')).toBe(false);
  });

  it('returns true for aside', () => {
    expect(isInViewBranch('aside')).toBe(true);
  });

  it('returns false for null', () => {
    expect(isInViewBranch(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isInViewBranch(undefined)).toBe(false);
  });
});

describe('isNavigatingBranch', () => {
  it('returns true for fork', () => {
    expect(isNavigatingBranch('fork')).toBe(true);
  });

  it('returns true for compress', () => {
    expect(isNavigatingBranch('compress')).toBe(true);
  });

  it('returns true for rewrite', () => {
    expect(isNavigatingBranch('rewrite')).toBe(true);
  });

  it('returns true for null (legacy)', () => {
    expect(isNavigatingBranch(null)).toBe(true);
  });

  it('returns true for undefined (legacy)', () => {
    expect(isNavigatingBranch(undefined)).toBe(true);
  });

  it('returns false for branch', () => {
    expect(isNavigatingBranch('branch')).toBe(false);
  });

  it('returns false for subagent', () => {
    expect(isNavigatingBranch('subagent')).toBe(false);
  });

  it('returns false for coordinator', () => {
    expect(isNavigatingBranch('coordinator')).toBe(false);
  });

  it('returns false for aside', () => {
    expect(isNavigatingBranch('aside')).toBe(false);
  });
});

describe('isMergeable', () => {
  it('returns true for branch', () => {
    expect(isMergeable('branch')).toBe(true);
  });

  it('returns true for subagent', () => {
    expect(isMergeable('subagent')).toBe(true);
  });

  it('returns false for compress', () => {
    expect(isMergeable('compress')).toBe(false);
  });

  it('returns false for fork', () => {
    expect(isMergeable('fork')).toBe(false);
  });

  it('returns false for coordinator', () => {
    expect(isMergeable('coordinator')).toBe(false);
  });

  it('returns false for rewrite', () => {
    expect(isMergeable('rewrite')).toBe(false);
  });

  it('returns false for null', () => {
    expect(isMergeable(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isMergeable(undefined)).toBe(false);
  });

  it('returns false for aside', () => {
    expect(isMergeable('aside')).toBe(false);
  });
});

describe('getBranchBehavior', () => {
  it('returns correct descriptor for branch', () => {
    expect(getBranchBehavior('branch')).toEqual({
      label: 'branch',
      staysInView: true,
      navigatesToChild: false,
      canMergeBack: true,
    });
  });

  it('returns correct descriptor for subagent', () => {
    expect(getBranchBehavior('subagent')).toEqual({
      label: 'subagent',
      staysInView: true,
      navigatesToChild: false,
      canMergeBack: true,
    });
  });

  it('returns correct descriptor for fork', () => {
    expect(getBranchBehavior('fork')).toEqual({
      label: 'fork',
      staysInView: false,
      navigatesToChild: true,
      canMergeBack: false,
    });
  });

  it('returns correct descriptor for compress', () => {
    expect(getBranchBehavior('compress')).toEqual({
      label: 'compress',
      staysInView: false,
      navigatesToChild: true,
      canMergeBack: false,
    });
  });

  it('returns correct descriptor for rewrite', () => {
    expect(getBranchBehavior('rewrite')).toEqual({
      label: 'rewrite',
      staysInView: false,
      navigatesToChild: true,
      canMergeBack: false,
    });
  });

  it('returns correct descriptor for coordinator', () => {
    expect(getBranchBehavior('coordinator')).toEqual({
      label: 'coordinator',
      staysInView: true,
      navigatesToChild: false,
      canMergeBack: false,
    });
  });

  it('returns correct descriptor for aside', () => {
    expect(getBranchBehavior('aside')).toEqual({
      label: 'aside',
      staysInView: true,
      navigatesToChild: false,
      canMergeBack: false,
    });
  });
});

describe('mutual exhaustiveness invariant', () => {
  it('every BranchKind is either in-view or navigating (never neither)', () => {
    for (const kind of BranchKindSchema.options) {
      const inView = isInViewBranch(kind);
      const navigating = isNavigatingBranch(kind);
      expect(inView || navigating, `BranchKind '${kind}' is neither in-view nor navigating`).toBe(true);
    }
  });

  it('no BranchKind is both in-view and navigating', () => {
    for (const kind of BranchKindSchema.options) {
      const inView = isInViewBranch(kind);
      const navigating = isNavigatingBranch(kind);
      expect(inView && navigating, `BranchKind '${kind}' is both in-view and navigating`).toBe(false);
    }
  });
});
