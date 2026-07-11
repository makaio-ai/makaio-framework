import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parseExtensionDescriptor } from '@makaio/contracts';
import { adapterDefinition } from '../definition.js';
import { githubCopilotSdkPackage } from '../package.js';

describe('GitHub Copilot SDK provider protocols', () => {
  it('keeps descriptor closure and SDK-native protocol metadata exact', async () => {
    const descriptor = parseExtensionDescriptor(
      JSON.parse(await readFile(new URL('../../descriptor.json', import.meta.url), 'utf8')),
    );

    expect(descriptor.dependencies).toEqual(githubCopilotSdkPackage.dependencies);
    expect(descriptor.contributions?.adapters?.[0]).toEqual(githubCopilotSdkPackage.adapters?.[0]?.manifest);
    expect(adapterDefinition.providers.map(({ protocol }) => protocol)).toEqual([undefined]);
    expect(adapterDefinition.protocol).toBeUndefined();
    expect(githubCopilotSdkPackage.adapters?.[0]?.manifest.protocols).toEqual([]);
  });
});
