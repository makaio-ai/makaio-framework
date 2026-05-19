import { describe, expect, it } from 'bun:test';
import { generateChangesetContent, generateChangesetFilename } from './generate-changeset-content.js';

describe('generateChangesetContent', () => {
  it('produces valid changeset markdown for a single package', () => {
    const result = generateChangesetContent([
      { packageName: '@makaio/framework', bump: 'minor', summaries: ['Add widget lifecycle hooks.'] },
    ]);

    expect(result).toBe(
      ['---', '"@makaio/framework": minor', '---', '', '- Add widget lifecycle hooks.', ''].join('\n'),
    );
  });

  it('produces per-package sections for multiple packages', () => {
    const result = generateChangesetContent([
      { packageName: '@makaio/framework', bump: 'minor', summaries: ['Add lifecycle hooks.', 'New boot sequence.'] },
      { packageName: '@makaio/contracts', bump: 'patch', summaries: ['Add DetachedTransport type.'] },
    ]);

    expect(result).toBe(
      [
        '---',
        '"@makaio/framework": minor',
        '"@makaio/contracts": patch',
        '---',
        '',
        '**@makaio/framework**',
        '- Add lifecycle hooks.',
        '- New boot sequence.',
        '',
        '**@makaio/contracts**',
        '- Add DetachedTransport type.',
        '',
      ].join('\n'),
    );
  });

  it('handles a single package with patch bump', () => {
    const result = generateChangesetContent([
      { packageName: '@makaio/adapter-openai-node', bump: 'patch', summaries: ['Fix streaming edge case.'] },
    ]);

    expect(result).toContain('"@makaio/adapter-openai-node": patch');
    expect(result).toContain('- Fix streaming edge case.');
  });

  it('handles major bumps', () => {
    const result = generateChangesetContent([
      { packageName: '@makaio/framework', bump: 'major', summaries: ['Breaking: remove deprecated API.'] },
    ]);

    expect(result).toContain('"@makaio/framework": major');
  });

  it('produces fallback when summaries are empty', () => {
    const result = generateChangesetContent([{ packageName: '@makaio/framework', bump: 'patch', summaries: [] }]);

    expect(result).toContain('No summary provided.');
  });

  it('handles multiple bullets for a single package', () => {
    const result = generateChangesetContent([
      { packageName: '@makaio/framework', bump: 'minor', summaries: ['First.', 'Second.', 'Third.'] },
    ]);

    expect(result).toContain('- First.\n- Second.\n- Third.');
  });
});

describe('generateChangesetFilename', () => {
  it('produces a hyphenated lowercase .md filename', () => {
    const name = generateChangesetFilename();
    expect(name).toMatch(/^[a-z]+(-[a-z]+)+\.md$/);
  });

  it('produces different names on successive calls', () => {
    const names = new Set(Array.from({ length: 20 }, () => generateChangesetFilename()));
    expect(names.size).toBeGreaterThan(1);
  });
});
