import { describe, expect, it } from 'vitest';
import { hasChangesetFile } from './changeset-required.js';

describe('hasChangesetFile', () => {
  it('detects root-level changeset files', () => {
    expect(hasChangesetFile(['framework/packages/kernel/src/index.ts', '.changeset/release-note.md'])).toBe(true);
  });

  it('ignores framework-nested changeset paths because the release slate lives at the repository root', () => {
    expect(hasChangesetFile(['framework/.changeset/release-note.md'])).toBe(false);
  });

  it('ignores non-markdown files under the changeset directory', () => {
    expect(hasChangesetFile(['.changeset/config.json'])).toBe(false);
  });

  it('ignores nested markdown files under the changeset directory', () => {
    expect(hasChangesetFile(['.changeset/archive/release-note.md'])).toBe(false);
  });
});
