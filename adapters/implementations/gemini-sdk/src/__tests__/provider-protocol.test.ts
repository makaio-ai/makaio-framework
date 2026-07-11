import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parseExtensionDescriptor } from '@makaio/contracts';
import { adapterDefinition } from '../definition.js';
import { geminiSdkPackage } from '../package.js';

describe('Gemini SDK provider protocols', () => {
  it('keeps descriptor closure and SDK-native protocol metadata exact', async () => {
    const descriptor = parseExtensionDescriptor(
      JSON.parse(await readFile(new URL('../../descriptor.json', import.meta.url), 'utf8')),
    );

    expect(descriptor.dependencies).toEqual(geminiSdkPackage.dependencies);
    expect(descriptor.contributions?.adapters?.[0]).toEqual(geminiSdkPackage.adapters?.[0]?.manifest);
    expect(adapterDefinition.providers.map(({ protocol }) => protocol)).toEqual([undefined]);
    expect(adapterDefinition.protocol).toBeUndefined();
    expect(geminiSdkPackage.adapters?.[0]?.manifest.protocols).toEqual([]);
    expect(geminiSdkPackage.adapters?.[0]?.manifest.defaultProvider).toBe('google');
  });

  it('declares the Google provider identity used by the SDK-native adapter', async () => {
    const descriptor = parseExtensionDescriptor(
      JSON.parse(await readFile(new URL('../../../../../providers/google/descriptor.json', import.meta.url), 'utf8')),
    );

    expect(descriptor.contributions?.providers?.[0]).toMatchObject({ id: 'google', name: 'Google AI' });
  });
});
