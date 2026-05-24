/**
 * Tests for conflict resolution utilities.
 *
 * Exercises parsing of standard and diff3 markers, single and batch resolution,
 * edge cases (empty sides, nested markers), and the quick-check helper.
 */
import { describe, it, expect } from 'vitest';
import {
  parseConflictMarkers,
  hasConflictMarkers,
  resolveConflict,
  resolveAllConflicts,
  type ConflictRegion,
} from '../utils/conflict-resolution.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** Standard two-way conflict */
const STANDARD_CONFLICT = [
  'line before',
  '<<<<<<< HEAD',
  'our change',
  '=======',
  'their change',
  '>>>>>>> feature-branch',
  'line after',
].join('\n');

/** Diff3-style conflict with base section */
const DIFF3_CONFLICT = [
  'line before',
  '<<<<<<< HEAD',
  'our change',
  '||||||| merged common ancestors',
  'original content',
  '=======',
  'their change',
  '>>>>>>> feature-branch',
  'line after',
].join('\n');

/** Multiple conflicts in one file */
const MULTI_CONFLICT = [
  'header',
  '<<<<<<< HEAD',
  'ours-1',
  '=======',
  'theirs-1',
  '>>>>>>> branch-a',
  'middle',
  '<<<<<<< HEAD',
  'ours-2',
  '=======',
  'theirs-2',
  '>>>>>>> branch-b',
  'footer',
].join('\n');

/** Multi-line sides */
const MULTILINE_CONFLICT = [
  '<<<<<<< HEAD',
  'our line 1',
  'our line 2',
  '=======',
  'their line 1',
  'their line 2',
  'their line 3',
  '>>>>>>> feature',
].join('\n');

/** Conflict with empty ours side */
const EMPTY_OURS = ['<<<<<<< HEAD', '=======', 'their content', '>>>>>>> feature'].join('\n');

/** Conflict with empty theirs side */
const EMPTY_THEIRS = ['<<<<<<< HEAD', 'our content', '=======', '>>>>>>> feature'].join('\n');

// ---------------------------------------------------------------------------
// parseConflictMarkers
// ---------------------------------------------------------------------------

describe('parseConflictMarkers', () => {
  it('should parse a standard two-way conflict', () => {
    const regions = parseConflictMarkers(STANDARD_CONFLICT);
    expect(regions).toHaveLength(1);

    const r = regions[0];
    expect(r.startLine).toBe(2);
    expect(r.endLine).toBe(6);
    expect(r.ours).toBe('our change');
    expect(r.theirs).toBe('their change');
    expect(r.base).toBeUndefined();
    expect(r.oursLabel).toBe('HEAD');
    expect(r.theirsLabel).toBe('feature-branch');
    expect(r.baseLabel).toBeUndefined();
  });

  it('should parse a diff3-style conflict with base', () => {
    const regions = parseConflictMarkers(DIFF3_CONFLICT);
    expect(regions).toHaveLength(1);

    const r = regions[0];
    expect(r.ours).toBe('our change');
    expect(r.theirs).toBe('their change');
    expect(r.base).toBe('original content');
    expect(r.baseLabel).toBe('merged common ancestors');
  });

  it('should parse multiple conflicts', () => {
    const regions = parseConflictMarkers(MULTI_CONFLICT);
    expect(regions).toHaveLength(2);

    expect(regions[0].ours).toBe('ours-1');
    expect(regions[0].theirs).toBe('theirs-1');
    expect(regions[0].theirsLabel).toBe('branch-a');

    expect(regions[1].ours).toBe('ours-2');
    expect(regions[1].theirs).toBe('theirs-2');
    expect(regions[1].theirsLabel).toBe('branch-b');
  });

  it('should parse multi-line conflict sides', () => {
    const regions = parseConflictMarkers(MULTILINE_CONFLICT);
    expect(regions).toHaveLength(1);

    const r = regions[0];
    expect(r.ours).toBe('our line 1\nour line 2');
    expect(r.theirs).toBe('their line 1\ntheir line 2\ntheir line 3');
  });

  it('should handle empty ours side', () => {
    const regions = parseConflictMarkers(EMPTY_OURS);
    expect(regions).toHaveLength(1);
    expect(regions[0].ours).toBe('');
    expect(regions[0].theirs).toBe('their content');
  });

  it('should handle empty theirs side', () => {
    const regions = parseConflictMarkers(EMPTY_THEIRS);
    expect(regions).toHaveLength(1);
    expect(regions[0].ours).toBe('our content');
    expect(regions[0].theirs).toBe('');
  });

  it('should return empty array for clean content', () => {
    expect(parseConflictMarkers('no conflicts here')).toEqual([]);
    expect(parseConflictMarkers('')).toEqual([]);
  });

  it('should skip incomplete markers (no closing >>>>>>>)', () => {
    const broken = [
      '<<<<<<< HEAD',
      'something',
      '=======',
      'other',
      // missing >>>>>>> line
    ].join('\n');
    expect(parseConflictMarkers(broken)).toEqual([]);
  });

  it('should skip marker that lacks separator', () => {
    const broken = ['<<<<<<< HEAD', 'something', '>>>>>>> feature'].join('\n');
    // The parser is in 'ours' state; >>>>>>> does not match MARKER_SEPARATOR,
    // so it just accumulates as ours content and never closes.
    expect(parseConflictMarkers(broken)).toEqual([]);
  });

  it('should recover from nested/broken markers', () => {
    // First opener is broken (no separator before second opener)
    const nested = [
      '<<<<<<< first',
      'orphan',
      '<<<<<<< HEAD',
      'real ours',
      '=======',
      'real theirs',
      '>>>>>>> feature',
    ].join('\n');
    const regions = parseConflictMarkers(nested);
    expect(regions).toHaveLength(1);
    expect(regions[0].ours).toBe('real ours');
    expect(regions[0].oursLabel).toBe('HEAD');
  });

  it('should parse conflicts in CRLF content', () => {
    const crlfConflict = [
      'line before',
      '<<<<<<< HEAD',
      'ours',
      '=======',
      'theirs',
      '>>>>>>> feature',
      'line after',
    ].join('\r\n');

    const regions = parseConflictMarkers(crlfConflict);
    expect(regions).toHaveLength(1);
    expect(regions[0].ours).toBe('ours');
    expect(regions[0].theirs).toBe('theirs');
  });
});

// ---------------------------------------------------------------------------
// hasConflictMarkers
// ---------------------------------------------------------------------------

describe('hasConflictMarkers', () => {
  it('should return true for content with conflict markers', () => {
    expect(hasConflictMarkers(STANDARD_CONFLICT)).toBe(true);
    expect(hasConflictMarkers(DIFF3_CONFLICT)).toBe(true);
    expect(hasConflictMarkers(MULTI_CONFLICT)).toBe(true);
  });

  it('should return false for clean content', () => {
    expect(hasConflictMarkers('hello world')).toBe(false);
    expect(hasConflictMarkers('')).toBe(false);
  });

  it('should detect marker even without full conflict', () => {
    // A partial marker still means "has conflict markers"
    expect(hasConflictMarkers('prefix\n<<<<<<< HEAD\ntrailing')).toBe(true);
  });

  it('should detect marker on the first line', () => {
    expect(hasConflictMarkers('<<<<<<< HEAD\nrest of file')).toBe(true);
  });

  it('should not false-positive on similar but non-marker lines', () => {
    expect(hasConflictMarkers('<<<<<< only six')).toBe(false);
    expect(hasConflictMarkers('<<<<<<<no space')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveConflict
// ---------------------------------------------------------------------------

describe('resolveConflict', () => {
  let region: ConflictRegion;

  it('should resolve with ours', () => {
    const regions = parseConflictMarkers(STANDARD_CONFLICT);
    region = regions[0];
    const result = resolveConflict(STANDARD_CONFLICT, region, 'ours');
    expect(result).toBe('line before\nour change\nline after');
  });

  it('should resolve with theirs', () => {
    const regions = parseConflictMarkers(STANDARD_CONFLICT);
    region = regions[0];
    const result = resolveConflict(STANDARD_CONFLICT, region, 'theirs');
    expect(result).toBe('line before\ntheir change\nline after');
  });

  it('should resolve with manual content', () => {
    const regions = parseConflictMarkers(STANDARD_CONFLICT);
    region = regions[0];
    const result = resolveConflict(STANDARD_CONFLICT, region, 'manual', 'custom merge');
    expect(result).toBe('line before\ncustom merge\nline after');
  });

  it('should throw for manual without content', () => {
    const regions = parseConflictMarkers(STANDARD_CONFLICT);
    region = regions[0];
    expect(() => resolveConflict(STANDARD_CONFLICT, region, 'manual')).toThrow('manualContent is required');
  });

  it('should resolve multi-line conflict', () => {
    const regions = parseConflictMarkers(MULTILINE_CONFLICT);
    const result = resolveConflict(MULTILINE_CONFLICT, regions[0], 'ours');
    expect(result).toBe('our line 1\nour line 2');
  });

  it('should resolve empty ours to just theirs', () => {
    const regions = parseConflictMarkers(EMPTY_OURS);
    const result = resolveConflict(EMPTY_OURS, regions[0], 'ours');
    // Ours is empty string, so the entire conflict block is replaced with empty
    // which removes the lines
    const lines = result.split('\n');
    expect(lines).not.toContain('their content');
    expect(lines).not.toContain('<<<<<<< HEAD');
  });

  it('should handle diff3 conflict resolution', () => {
    const regions = parseConflictMarkers(DIFF3_CONFLICT);
    const result = resolveConflict(DIFF3_CONFLICT, regions[0], 'theirs');
    expect(result).toBe('line before\ntheir change\nline after');
  });
});

// ---------------------------------------------------------------------------
// resolveAllConflicts
// ---------------------------------------------------------------------------

describe('resolveAllConflicts', () => {
  it('should resolve all conflicts in one pass', () => {
    const regions = parseConflictMarkers(MULTI_CONFLICT);
    const result = resolveAllConflicts(MULTI_CONFLICT, regions, [
      { regionIndex: 0, resolution: 'ours' },
      { regionIndex: 1, resolution: 'theirs' },
    ]);
    expect(result).toBe('header\nours-1\nmiddle\ntheirs-2\nfooter');
  });

  it('should handle partial resolution (only some conflicts)', () => {
    const regions = parseConflictMarkers(MULTI_CONFLICT);
    const result = resolveAllConflicts(MULTI_CONFLICT, regions, [{ regionIndex: 0, resolution: 'ours' }]);
    // First conflict resolved, second remains
    expect(result).toContain('ours-1');
    expect(result).toContain('<<<<<<< HEAD');
    expect(result).toContain('theirs-2');
  });

  it('should handle manual resolutions in batch', () => {
    const regions = parseConflictMarkers(MULTI_CONFLICT);
    const result = resolveAllConflicts(MULTI_CONFLICT, regions, [
      {
        regionIndex: 0,
        resolution: 'manual',
        manualContent: 'merged-1',
      },
      {
        regionIndex: 1,
        resolution: 'manual',
        manualContent: 'merged-2',
      },
    ]);
    expect(result).toBe('header\nmerged-1\nmiddle\nmerged-2\nfooter');
  });

  it('should throw for out-of-bounds regionIndex', () => {
    const regions = parseConflictMarkers(STANDARD_CONFLICT);
    expect(() => resolveAllConflicts(STANDARD_CONFLICT, regions, [{ regionIndex: 5, resolution: 'ours' }])).toThrow(
      'out of bounds',
    );
  });

  it('should return unchanged content for empty resolutions', () => {
    const regions = parseConflictMarkers(MULTI_CONFLICT);
    const result = resolveAllConflicts(MULTI_CONFLICT, regions, []);
    expect(result).toBe(MULTI_CONFLICT);
  });

  it('should apply resolutions regardless of input order', () => {
    const regions = parseConflictMarkers(MULTI_CONFLICT);
    // Provide resolutions in ascending order (they should be sorted internally)
    const result = resolveAllConflicts(MULTI_CONFLICT, regions, [
      { regionIndex: 1, resolution: 'theirs' },
      { regionIndex: 0, resolution: 'ours' },
    ]);
    expect(result).toBe('header\nours-1\nmiddle\ntheirs-2\nfooter');
  });
});
