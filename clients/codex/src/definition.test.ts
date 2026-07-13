import { describe, expect, it } from 'vitest';
import descriptor from '../descriptor.json' with { type: 'json' };
import { clientDefinition } from './definition.js';

describe('Codex client version contract', () => {
  it('pins detection, managed installation, and descriptor metadata to Codex 0.144.1', () => {
    expect(clientDefinition.binary?.supportedVersions).toBe('0.144.1');
    expect(clientDefinition.managedInstall).toMatchObject({ package: '@openai/codex', version: '0.144.1' });
    expect(descriptor.contributions.clients[0]?.binary).toEqual({
      name: 'codex',
      managed: true,
      version: '0.144.1',
    });
  });
});
