import { describe, expect, it } from 'bun:test';
import { buildChangedFilesDiffArgs, hasChangesetFile } from './changeset-required.js';

describe('buildChangedFilesDiffArgs', () => {
  it('excludes deleted paths from the changeset-required file inventory', () => {
    expect(buildChangedFilesDiffArgs('origin/develop', 'HEAD')).toEqual([
      'diff',
      '--name-only',
      '--diff-filter=d',
      'origin/develop...HEAD',
    ]);
  });
});

describe('hasChangesetFile', () => {
  it('detects changeset files in prefixed diffs', () => {
    expect(
      hasChangesetFile(['framework/packages/kernel/src/index.ts', 'framework/.changeset/release-note.md'], 'framework'),
    ).toBe(true);
  });

  it('detects root-level changeset files', () => {
    expect(hasChangesetFile(['packages/kernel/src/index.ts', '.changeset/release-note.md'])).toBe(true);
  });

  it('ignores non-markdown files under the changeset directory', () => {
    expect(hasChangesetFile(['framework/.changeset/config.json'], 'framework')).toBe(false);
  });

  it('ignores nested markdown files under the changeset directory', () => {
    expect(hasChangesetFile(['framework/.changeset/archive/release-note.md'], 'framework')).toBe(false);
  });
});
