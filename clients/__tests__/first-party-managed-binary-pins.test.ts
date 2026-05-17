import * as fs from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { clientDefinition as claudeCodeDefinition } from '../claude-code/src/definition.js';
import { clientDefinition as codexDefinition } from '../codex/src/definition.js';

interface ClientDescriptor {
  readonly contributions?: {
    readonly clients?: ReadonlyArray<{
      readonly id?: string;
      readonly binary?: {
        readonly managed?: boolean;
        readonly version?: string;
      };
    }>;
  };
}

async function readDescriptor(pathFromClientsRoot: string): Promise<ClientDescriptor> {
  const url = new URL(`../${pathFromClientsRoot}`, import.meta.url);
  return JSON.parse(await fs.readFile(url, 'utf-8')) as ClientDescriptor;
}

describe('first-party managed binary pins', () => {
  it.each([
    ['claude-code', 'claude-code/descriptor.json', claudeCodeDefinition],
    ['codex', 'codex/descriptor.json', codexDefinition],
  ] as const)('%s descriptor matches the client definition pin', async (clientId, descriptorPath, definition) => {
    const descriptor = await readDescriptor(descriptorPath);
    const contribution = descriptor.contributions?.clients?.find((client) => client.id === clientId);

    expect(definition.runtimeCapabilities.supportsManagedBinary).toBe(true);
    expect(definition.managedInstall?.version).toBeDefined();
    expect(definition.binary?.supportedVersions).toBeDefined();
    expect(contribution?.binary?.version).toBeDefined();
    expect(definition.binary?.supportedVersions).toBe(definition.managedInstall?.version);
    expect(contribution?.binary?.managed).toBe(true);
    expect(contribution?.binary?.version).toBe(definition.managedInstall?.version);
  });
});
