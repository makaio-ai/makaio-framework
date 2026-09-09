import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
// Load the real contribution during collection; these assertions check its contract, not CLI startup latency.
import promptCli from '../src/cli.js';

const extensionRoot = path.resolve(import.meta.dirname, '..');

describe('Prompt Extension Contract', () => {
  it('has a valid descriptor.json', async () => {
    const raw = await readFile(path.join(extensionRoot, 'descriptor.json'), 'utf-8');
    const descriptor = JSON.parse(raw) as Record<string, unknown>;
    expect(descriptor['name']).toBe('prompt');
    expect(descriptor['displayName']).toBeDefined();
    expect(descriptor['version']).toBeDefined();
    expect((descriptor['makaio'] as Record<string, unknown>)?.['framework']).toBeDefined();
    expect((descriptor['entrypoints'] as Record<string, unknown>)?.['cli']).toBeDefined();
    expect((descriptor['cli'] as { subcommands?: Array<{ name: string }> }).subcommands).toEqual([
      expect.objectContaining({ name: 'send' }),
    ]);
  });

  it('CLI entrypoint exports a valid CliContribution', () => {
    const contribution = promptCli;
    expect(contribution).toBeDefined();
    expect(contribution.name).toBe('prompt');
    expect(contribution.description).toBeDefined();
    expect(contribution.subcommands).toBeDefined();
    expect(Array.isArray(contribution.subcommands)).toBe(true);
    expect(contribution.subcommands.length).toBeGreaterThan(0);
  });

  it('subcommand has a Zod schema with model field', () => {
    const contribution = promptCli;
    const subcommand = contribution.subcommands[0];
    expect(subcommand).toBeDefined();
    expect(subcommand?.schema).toBeDefined();
    const result = subcommand?.schema.safeParse({ model: 'sonnet' });
    expect(result?.success).toBe(true);
  });

  it('subcommand schema accepts omitted model (optional)', () => {
    const contribution = promptCli;
    const subcommand = contribution.subcommands[0];
    const result = subcommand?.schema.safeParse({});
    expect(result?.success).toBe(true);
  });

  it('subcommand schema normalizes comma and quoted-space tool lists', () => {
    const contribution = promptCli;
    const subcommand = contribution.subcommands[0];

    const result = subcommand?.schema.safeParse({
      model: 'sonnet',
      allowedTools: 'Read,Edit Bash',
      disallowedTools: 'Delete',
    });

    expect(result?.success).toBe(true);
    expect(result?.data).toMatchObject({
      allowedTools: ['Read', 'Edit', 'Bash'],
      disallowedTools: ['Delete'],
    });
  });
});
