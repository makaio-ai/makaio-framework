import { describe, expect, it } from 'vitest';
import { createNoopStrategyDeps } from '../client-binary-noop-strategy-deps.js';

describe('createNoopStrategyDeps', () => {
  it('returns async rejections for unimplemented dependencies', async () => {
    const deps = createNoopStrategyDeps();
    const cases: Array<readonly [name: string, call: () => Promise<unknown>]> = [
      ['fetchText', () => deps.fetchText('https://example.com/latest.txt')],
      ['fetchJson', () => deps.fetchJson('https://example.com/manifest.json')],
      ['downloadFile', () => deps.downloadFile('https://example.com/client.tgz', '/tmp/client.tgz')],
      ['exec', () => deps.exec('echo', ['ok'])],
      ['extractArchive', () => deps.extractArchive('/tmp/client.tgz', '/tmp/client', 'tar.gz')],
      ['deleteFile', () => deps.deleteFile('/tmp/client.tgz')],
      ['computeChecksum', () => deps.computeChecksum('/tmp/client.tgz')],
      ['removeDirectory', () => deps.removeDirectory('/tmp/makaio-missing')],
    ];

    for (const [name, call] of cases) {
      const rejection = call();
      await expect(rejection).rejects.toThrow(`StrategyDependencies.${name} is not implemented`);
    }
  });
});
