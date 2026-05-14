import { describe, expect, it } from 'vitest';
import { isConfigComment, parseConfigComment, renderConfigComment, resetGenerateCheckbox } from './config-comment.js';
import type { PackageChangeSummary } from './group-changes-by-package.js';

const PACKAGES: PackageChangeSummary[] = [
  { packageName: '@makaio/framework', summaries: ['New subprocess package.', 'Adds StdioTransport.'] },
  { packageName: '@makaio/contracts', summaries: ['Adds DetachedTransportSchema.'] },
  { packageName: '@makaio/adapter-anthropic-sdk', summaries: ['Refactors client.'] },
];

describe('renderConfigComment', () => {
  it('renders a comment with marker, packages, summaries, and generate checkbox', () => {
    const result = renderConfigComment(889, PACKAGES);

    expect(result).toContain('<!-- changeset-config:pr-889 -->');
    expect(result).toContain('# 📦 Changelog');
    expect(result).toContain('## @makaio/adapter-anthropic-sdk');
    expect(result).toContain('## @makaio/contracts');
    expect(result).toContain('## @makaio/framework');
    expect(result).toContain('- [ ] minor');
    expect(result).toContain('- [ ] major');
    expect(result).toContain('- Refactors client.');
    expect(result).toContain('- Adds DetachedTransportSchema.');
    expect(result).toContain('- New subprocess package.');
    expect(result).toContain('- Adds StdioTransport.');
    expect(result).toContain('- [ ] 🚀 Generate Changeset');
  });

  it('sorts packages alphabetically', () => {
    const result = renderConfigComment(1, PACKAGES);
    const adapterIdx = result.indexOf('## @makaio/adapter-anthropic-sdk');
    const contractsIdx = result.indexOf('## @makaio/contracts');
    const frameworkIdx = result.indexOf('## @makaio/framework');
    expect(adapterIdx).toBeLessThan(contractsIdx);
    expect(contractsIdx).toBeLessThan(frameworkIdx);
  });
});

describe('isConfigComment', () => {
  it('returns true for a rendered config comment', () => {
    const comment = renderConfigComment(889, PACKAGES);
    expect(isConfigComment(comment)).toBe(true);
  });

  it('returns false for an unrelated comment', () => {
    expect(isConfigComment('Just a regular comment')).toBe(false);
  });
});

describe('parseConfigComment', () => {
  it('returns null for non-config comments', () => {
    expect(parseConfigComment('not a config comment')).toBeNull();
  });

  it('roundtrips: render → parse recovers packages as patch with summaries', () => {
    const rendered = renderConfigComment(889, PACKAGES);
    const parsed = parseConfigComment(rendered);

    expect(parsed).not.toBeNull();
    expect(parsed!.packages).toEqual([
      { packageName: '@makaio/adapter-anthropic-sdk', bump: 'patch', summaries: ['Refactors client.'] },
      { packageName: '@makaio/contracts', bump: 'patch', summaries: ['Adds DetachedTransportSchema.'] },
      {
        packageName: '@makaio/framework',
        bump: 'patch',
        summaries: ['New subprocess package.', 'Adds StdioTransport.'],
      },
    ]);
    expect(parsed!.generateRequested).toBe(false);
  });

  it('detects minor checkbox', () => {
    const body = renderConfigComment(1, [{ packageName: '@makaio/framework', summaries: ['Change.'] }]).replace(
      '- [ ] minor',
      '- [x] minor',
    );

    const parsed = parseConfigComment(body)!;
    expect(parsed.packages[0].bump).toBe('minor');
  });

  it('detects major checkbox', () => {
    const body = renderConfigComment(1, [{ packageName: '@makaio/framework', summaries: ['Change.'] }]).replace(
      '- [ ] major',
      '- [x] major',
    );

    const parsed = parseConfigComment(body)!;
    expect(parsed.packages[0].bump).toBe('major');
  });

  it('major wins when both minor and major are checked', () => {
    let body = renderConfigComment(1, [{ packageName: '@makaio/framework', summaries: ['Change.'] }]);
    body = body.replace('- [ ] minor', '- [x] minor').replace('- [ ] major', '- [x] major');

    const parsed = parseConfigComment(body)!;
    expect(parsed.packages[0].bump).toBe('major');
  });

  it('detects generate requested', () => {
    const body = renderConfigComment(1, PACKAGES).replace('- [ ] 🚀 Generate Changeset', '- [x] 🚀 Generate Changeset');

    const parsed = parseConfigComment(body)!;
    expect(parsed.generateRequested).toBe(true);
  });

  it('handles mixed bump types across packages', () => {
    let body = renderConfigComment(1, [
      { packageName: '@makaio/contracts', summaries: ['Update types.'] },
      { packageName: '@makaio/framework', summaries: ['Fix boot.'] },
    ]);

    const contractsSection = body.indexOf('## @makaio/contracts');
    const frameworkSection = body.indexOf('## @makaio/framework');

    const contractsMinor = body.indexOf('- [ ] minor', contractsSection);
    const frameworkMajor = body.indexOf('- [ ] major', frameworkSection);

    body = body.slice(0, contractsMinor) + '- [x] minor' + body.slice(contractsMinor + '- [ ] minor'.length);
    body = body.slice(0, frameworkMajor) + '- [x] major' + body.slice(frameworkMajor + '- [ ] major'.length);

    const parsed = parseConfigComment(body)!;
    expect(parsed.packages).toEqual([
      { packageName: '@makaio/contracts', bump: 'minor', summaries: ['Update types.'] },
      { packageName: '@makaio/framework', bump: 'major', summaries: ['Fix boot.'] },
    ]);
  });

  it('parses multiple summary bullets per package', () => {
    const rendered = renderConfigComment(1, [
      { packageName: '@makaio/framework', summaries: ['First change.', 'Second change.', 'Third change.'] },
    ]);

    const parsed = parseConfigComment(rendered)!;
    expect(parsed.packages[0].summaries).toEqual(['First change.', 'Second change.', 'Third change.']);
  });

  it('preserves backtick code spans in summaries', () => {
    const rendered = renderConfigComment(1, [
      { packageName: '@makaio/framework', summaries: ['Adds `DetachedTransport` type.'] },
    ]);

    const parsed = parseConfigComment(rendered)!;
    expect(parsed.packages[0].summaries).toEqual(['Adds `DetachedTransport` type.']);
  });
});

describe('resetGenerateCheckbox', () => {
  it('unchecks the Generate checkbox', () => {
    const body = renderConfigComment(1, PACKAGES).replace('- [ ] 🚀 Generate Changeset', '- [x] 🚀 Generate Changeset');
    const reset = resetGenerateCheckbox(body);

    expect(reset).toContain('- [ ] 🚀 Generate Changeset');
    expect(reset).not.toContain('- [x] 🚀 Generate Changeset');
  });

  it('is a no-op when already unchecked', () => {
    const body = renderConfigComment(1, PACKAGES);
    expect(resetGenerateCheckbox(body)).toBe(body);
  });
});
