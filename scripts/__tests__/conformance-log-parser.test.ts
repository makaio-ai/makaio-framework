import { readFile, rm } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parseAndWriteLogs, parseViolationsFromLogs, type RawLog } from '../lib/conformance/log-parser.js';

describe('conformance log parser', () => {
  it('redacts credential-like keys from schema violation samples', () => {
    const logs: RawLog[] = [
      {
        content:
          '[BUS:VIOLATION] ' +
          JSON.stringify({
            subject: 'adapter:test.sdk.event',
            issues: ['type: Invalid input'],
            sample: {
              type: 'tool',
              apiKey: 'secret-api-key',
              nested: {
                authorization: 'Bearer secret-token',
              },
            },
          }),
        time: 1,
        type: 'stderr',
        size: 1,
      },
    ];

    expect(parseViolationsFromLogs(logs)).toEqual([
      {
        subject: 'adapter:test.sdk.event',
        issues: ['type: Invalid input'],
        sample: {
          type: 'tool',
          apiKey: '[redacted]',
          nested: {
            authorization: '[redacted]',
          },
        },
      },
    ]);
  });

  it('redacts credential-like assignments in raw fallback logs', async () => {
    const logFile = await parseAndWriteLogs([
      {
        content: 'plain error api_key=secret-value token:abc123',
        time: 1,
        type: 'stderr',
        size: 1,
      },
    ]);

    expect(logFile).toBeDefined();
    if (logFile === undefined) throw new Error('Expected log file to be written');
    try {
      const logs = JSON.parse(await readFile(logFile, 'utf8')) as Array<{ message?: string }>;
      expect(logs[0]?.message).toBe('plain error api_key=[redacted] token:[redacted]');
    } finally {
      await rm(logFile, { force: true });
    }
  });
});
