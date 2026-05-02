import { describe, expect, it } from 'vitest';
import { createAcpConnection } from '../connection.js';

describe('createAcpConnection', () => {
  it('rejects immediately when the subprocess cannot be spawned', async () => {
    await expect(
      createAcpConnection(
        () => ({
          sessionUpdate: async () => {},
          requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
        }),
        {
          command: '/definitely/missing/binary',
          args: [],
          cwd: process.cwd(),
          env: { ...process.env } as Record<string, string>,
        },
      ),
    ).rejects.toThrow();
  });
});
