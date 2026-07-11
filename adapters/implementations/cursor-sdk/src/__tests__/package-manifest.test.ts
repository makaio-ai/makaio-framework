import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parseExtensionDescriptor } from '@makaio/contracts';
import { adapterDefinition } from '../definition.js';
import { cursorSdkPackage } from '../package.js';

/** Read and validate the shipped Cursor descriptor. */
async function readCursorDescriptor() {
  const json: unknown = JSON.parse(await readFile(new URL('../../descriptor.json', import.meta.url), 'utf8'));
  return parseExtensionDescriptor(json);
}

describe('Cursor SDK package metadata', () => {
  it('keeps the shipped descriptor and executable package manifest in parity', async () => {
    const descriptor = await readCursorDescriptor();
    const descriptorAdapter = descriptor.contributions?.adapters?.[0];
    const runtimeAdapter = cursorSdkPackage.adapters?.[0];

    expect(descriptor.dependencies).toEqual(cursorSdkPackage.dependencies);
    expect(descriptorAdapter).toEqual(runtimeAdapter?.manifest);
  });

  it('declares exact provider compatibility without pretending to implement a wire protocol or managed client', () => {
    expect(adapterDefinition.providers.map(({ definitionId }) => definitionId)).toEqual(['cursor']);
    expect(adapterDefinition.providers.map(({ protocol }) => protocol)).toEqual([undefined]);
    expect(adapterDefinition.protocol).toBeUndefined();
    expect(adapterDefinition.clients).toBeUndefined();
    expect(cursorSdkPackage.adapters?.[0]?.manifest.protocols).toEqual([]);
  });
});
