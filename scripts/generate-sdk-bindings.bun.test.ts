import { describe, expect, it } from 'bun:test';
import { findGeneratedFileDrift, parseSdkCodegenArgs } from './generate-sdk-bindings.js';

describe('parseSdkCodegenArgs', () => {
  it('enables check mode with --check', () => {
    expect(parseSdkCodegenArgs(['--check'])).toEqual({ check: true });
  });

  it('uses write mode by default', () => {
    expect(parseSdkCodegenArgs([])).toEqual({ check: false });
  });
});

describe('findGeneratedFileDrift', () => {
  it('reports generated files whose committed content differs', async () => {
    const drift = await findGeneratedFileDrift(
      [
        { path: '/repo/sdks/manifest/makaio-bus-protocol.json', content: '{ "version": 2 }\n' },
        { path: '/repo/sdks/python/src/makaio/generated/subjects.py', content: 'EXPECTED\n' },
      ],
      async (filePath) => (filePath.endsWith('subjects.py') ? 'STALE\n' : '{ "version": 2 }\n'),
    );

    expect(drift).toEqual(['/repo/sdks/python/src/makaio/generated/subjects.py']);
  });
});
