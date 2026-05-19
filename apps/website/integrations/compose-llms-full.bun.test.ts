import { describe, expect, it } from 'bun:test';
import { composeLlmsFull, stripSystemBanner } from './compose-llms-full';

describe('composeLlmsFull', () => {
  it('strips generated set system banners', () => {
    expect(stripSystemBanner('<SYSTEM>Generated set</SYSTEM>\n\n# Page\n\nBody')).toBe('# Page\n\nBody');
  });

  it('builds a curated full document from guides, packages, and SDKs', () => {
    const files = new Map([
      ['_llms-txt/guides.txt', '<SYSTEM>Guides</SYSTEM>\n\n# Getting Started'],
      ['_llms-txt/packages.txt', '<SYSTEM>Packages</SYSTEM>\n\n# @makaio/bus-core'],
      ['_llms-txt/sdks.txt', '<SYSTEM>SDKs</SYSTEM>\n\n# TypeScript SDK'],
    ]);

    const content = composeLlmsFull((relativePath) => files.get(relativePath) ?? '');

    expect(content).toContain('curated full developer documentation');
    expect(content).toContain('# Guides\n\n# Getting Started');
    expect(content).toContain('# Packages\n\n# @makaio/bus-core');
    expect(content).toContain('# SDKs\n\n# TypeScript SDK');
    expect(content).not.toContain('<SYSTEM>Guides</SYSTEM>');
  });

  it('does not duplicate a set heading that already exists in the set content', () => {
    const files = new Map([
      ['_llms-txt/guides.txt', '# Getting Started'],
      ['_llms-txt/packages.txt', '# @makaio/bus-core'],
      ['_llms-txt/sdks.txt', '# SDKs\n\n# TypeScript SDK'],
    ]);

    const content = composeLlmsFull((relativePath) => files.get(relativePath) ?? '');

    expect(content.match(/^# SDKs$/gm)).toHaveLength(1);
  });
});
