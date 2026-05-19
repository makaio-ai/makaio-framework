import { describe, expect, it } from 'bun:test';
import { ClientSchemas, ClientWiringEntrySchema } from '@makaio/contracts/client';

describe('Client wiring schemas', () => {
  it('accepts a valid wiring entry', () => {
    const result = ClientWiringEntrySchema.parse({
      group: 'session-events',
      name: 'PreToolUse',
      installed: true,
      command: 'makaio hook received codex PreToolUse',
    });

    expect(result.name).toBe('PreToolUse');
  });

  it('rejects empty wiring entry identifiers and commands', () => {
    expect(
      ClientWiringEntrySchema.safeParse({
        group: '',
        name: 'PreToolUse',
        installed: true,
        command: 'makaio hook received codex PreToolUse',
      }).success,
    ).toBe(false);
    expect(
      ClientWiringEntrySchema.safeParse({
        group: 'session-events',
        name: '',
        installed: true,
        command: 'makaio hook received codex PreToolUse',
      }).success,
    ).toBe(false);
    expect(
      ClientWiringEntrySchema.safeParse({
        group: 'session-events',
        name: 'PreToolUse',
        installed: true,
        command: '',
      }).success,
    ).toBe(false);
  });

  it('accepts an absolute projectDir on global wiring.list requests', () => {
    const request = ClientSchemas['wiring.list'].request.parse({
      clientId: 'claude-code',
      projectDir: '/home/user/project',
      makaioCommand: 'makaio',
    });

    expect(request.projectDir).toBe('/home/user/project');
  });

  it('rejects empty identifiers, relative projectDir, and missing makaioCommand', () => {
    expect(
      ClientSchemas['wiring.list'].request.safeParse({
        clientId: '',
        makaioCommand: 'makaio',
      }).success,
    ).toBe(false);
    expect(
      ClientSchemas['wiring.list'].request.safeParse({
        projectDir: 'relative/project',
        makaioCommand: 'makaio',
      }).success,
    ).toBe(false);
    expect(
      ClientSchemas['wiring.list'].request.safeParse({
        makaioCommand: '',
      }).success,
    ).toBe(false);
    expect(ClientSchemas['wiring.list'].request.safeParse({}).success).toBe(false);
  });
});
