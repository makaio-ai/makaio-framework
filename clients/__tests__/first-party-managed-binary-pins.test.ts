import * as fs from 'node:fs/promises';
import { satisfies } from 'semver';
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
  ] as const)('%s descriptor matches the managed-install pin', async (clientId, descriptorPath, definition) => {
    const descriptor = await readDescriptor(descriptorPath);
    const contribution = descriptor.contributions?.clients?.find((client) => client.id === clientId);

    expect(definition.runtimeCapabilities.supportsManagedBinary).toBe(true);
    expect(definition.managedInstall?.version).toBeDefined();
    expect(definition.binary?.supportedVersions).toBeDefined();
    expect(contribution?.binary?.version).toBeDefined();
    expect(satisfies(definition.managedInstall!.version, definition.binary!.supportedVersions)).toBe(true);
    expect(contribution?.binary?.managed).toBe(true);
    expect(contribution?.binary?.version).toBe(definition.managedInstall?.version);
  });

  it('accepts Claude Code from the pin up to the next major', () => {
    const supportedVersions = claudeCodeDefinition.binary!.supportedVersions;
    const [major, minor, patch] = claudeCodeDefinition.managedInstall!.version.split('.').map(Number) as [
      number,
      number,
      number,
    ];

    // The floor equals the evidence pin (FACT-88): PostToolUse additionalContext
    // has no changelog version upstream, so the maintainer set the floor to the
    // binary every declared capability was probed against. Older binaries are
    // refused rather than silently dropping appended context.
    expect(satisfies(`${major}.${minor}.${patch}`, supportedVersions)).toBe(true);
    expect(satisfies(`${major}.${minor}.${patch - 1}`, supportedVersions)).toBe(false);
    expect(satisfies(`${major}.${minor}.${patch + 1}`, supportedVersions)).toBe(true);
    expect(satisfies(`${major}.${minor + 1}.0`, supportedVersions)).toBe(true);

    // Across the major boundary the hook surface is no longer the one this
    // client encodes.
    expect(satisfies(`${major}.${minor - 1}.0`, supportedVersions)).toBe(false);
    expect(satisfies(`${major + 1}.0.0`, supportedVersions)).toBe(false);
  });
});
