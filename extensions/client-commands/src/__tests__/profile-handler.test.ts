import { describe, expect, it, vi } from 'vitest';
import { ClientSubjects, type ClientProfile } from '@makaio/contracts/client';

const childProcessMocks = vi.hoisted(() => ({
  exec: vi.fn(),
  execFile: vi.fn((_command: string, _args: readonly string[], callback?: (error: Error | null) => void) => {
    callback?.(null);
  }),
}));

vi.mock('node:child_process', () => childProcessMocks);

import { runProfileOpenCommand, type ProfileOpenCommandContext } from '../cli/profile-handler.js';

/**
 * Build a profile record for CLI handler tests.
 * @param overrides - Optional profile field overrides.
 * @returns Complete profile record.
 */
function makeProfile(overrides: Partial<ClientProfile> = {}): ClientProfile {
  return {
    id: 'profile-1',
    clientId: 'claude-code',
    name: 'work',
    description: null,
    configDir: '/tmp/makaio/clients/claude-code/profiles/work',
    isDefault: false,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('profile CLI handlers', () => {
  it('opens profile directories without constructing a shell command string', async () => {
    const output = { write: vi.fn(), error: vi.fn() };
    const setExitCode = vi.fn();
    const request = vi.fn().mockResolvedValue({ profile: makeProfile({ configDir: '/tmp/profile with spaces' }) });
    const ctx: ProfileOpenCommandContext = {
      args: { client: 'claude-code', name: 'work' },
      bus: { request },
      output,
      setExitCode,
    };

    await runProfileOpenCommand(ctx);

    expect(request).toHaveBeenCalledWith(ClientSubjects.profile.get, {
      clientId: 'claude-code',
      name: 'work',
    });
    const openCommand = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
    expect(childProcessMocks.execFile).toHaveBeenCalledWith(
      openCommand,
      ['/tmp/profile with spaces'],
      expect.any(Function),
    );
    expect(childProcessMocks.exec).not.toHaveBeenCalled();
    expect(setExitCode).not.toHaveBeenCalled();
  });
});
