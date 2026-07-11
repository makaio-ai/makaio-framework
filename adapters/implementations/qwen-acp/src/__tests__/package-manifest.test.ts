import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parseExtensionDescriptor } from '@makaio/contracts';
import { adapterDefinition } from '../definition.js';
import { qwenAcpPackage } from '../package.js';

/** Read and validate the shipped Qwen ACP descriptor. */
async function readQwenDescriptor() {
  const json: unknown = JSON.parse(await readFile(new URL('../../descriptor.json', import.meta.url), 'utf8'));
  return parseExtensionDescriptor(json);
}

describe('Qwen ACP package metadata', () => {
  it('keeps the shipped descriptor and executable package manifest in parity', async () => {
    const descriptor = await readQwenDescriptor();
    expect(descriptor.dependencies).toEqual(qwenAcpPackage.dependencies);
    expect(descriptor.contributions?.adapters).toBeUndefined();
    expect(qwenAcpPackage.adapters).toBeUndefined();
  });

  it('keeps the adapter implementation unavailable until native auth is materializable', () => {
    expect(adapterDefinition.providers).toEqual([]);
    expect(adapterDefinition.clients).toEqual([{ id: 'qwen', version: '^0.1.0' }]);
    expect(adapterDefinition.protocol).toBeUndefined();
    expect(qwenAcpPackage.dependencies).toBeUndefined();
    expect(qwenAcpPackage.adapters).toBeUndefined();
  });
});
