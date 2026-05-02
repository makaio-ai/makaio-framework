/**
 * Tests for the `client wiring` CLI handler.
 *
 * The handler is exercised against an isolated bus with a test-local
 * `client.wiring.list` handler registered so tests verify the full request
 * dispatch path without relying on an actual client service. The narrow
 * `ctx.bus` context interface keeps the handler fully injectable.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { ClientSubjects } from '@makaio/contracts/client';
import { runClientWiringCommand, type ClientWiringCommandContext } from '../cli/wiring-handler.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const stdoutChunks: string[] = [];
const stderrChunks: string[] = [];

afterEach(() => {
  stdoutChunks.length = 0;
  stderrChunks.length = 0;
  vi.restoreAllMocks();
});

function createOutput() {
  return {
    write(text: string) {
      stdoutChunks.push(text);
    },
    error(text: string) {
      stderrChunks.push(text);
    },
  };
}

function createContext(
  bus: Pick<ClientWiringCommandContext, 'bus'>['bus'],
  args: ClientWiringCommandContext['args'] = {},
): ClientWiringCommandContext & { readonly setExitCodeSpy: ReturnType<typeof vi.fn> } {
  const setExitCodeSpy = vi.fn<(code: number) => void>();
  return {
    args,
    bus,
    output: createOutput(),
    setExitCode: setExitCodeSpy,
    setExitCodeSpy,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runClientWiringCommand', () => {
  let bus: IMakaioBus;
  let cleanupHandler: (() => void) | undefined;

  beforeEach(() => {
    bus = createBusInstance();
    cleanupHandler = undefined;
  });

  afterEach(() => {
    cleanupHandler?.();
    cleanupHandler = undefined;
  });

  it('formats wiring entries grouped by client', async () => {
    cleanupHandler = bus.on(ClientSubjects.wiring.list, (ctx) => {
      ctx.setResult({
        results: [
          {
            clientId: 'claude-code',
            entries: [
              { group: 'session-events', name: 'PreToolUse', installed: true, command: 'makaio hook' },
              { group: 'session-events', name: 'PostToolUse', installed: false, command: 'makaio hook' },
            ],
          },
        ],
      });
    });

    const ctx = createContext(bus);
    await runClientWiringCommand(ctx);

    const stdout = stdoutChunks.join('');
    expect(stdout).toContain('claude-code');
    expect(stdout).toContain('PreToolUse');
    expect(stdout).toContain('PostToolUse');
    expect(stdout).toContain('installed');
    expect(stdout).toContain('missing');
    expect(stderrChunks.join('')).toBe('');
    expect(ctx.setExitCodeSpy).not.toHaveBeenCalled();
  });

  it('prints a "no wiring entries" message when results are empty', async () => {
    cleanupHandler = bus.on(ClientSubjects.wiring.list, (ctx) => {
      ctx.setResult({ results: [] });
    });

    const ctx = createContext(bus);
    await runClientWiringCommand(ctx);

    const stdout = stdoutChunks.join('');
    expect(stdout).toContain('No wiring entries found');
    expect(stderrChunks.join('')).toBe('');
    expect(ctx.setExitCodeSpy).not.toHaveBeenCalled();
  });

  it('forwards clientId, projectDir, and makaioCommand to the aggregator', async () => {
    const capturedPayloads: Array<Record<string, unknown>> = [];
    cleanupHandler = bus.on(ClientSubjects.wiring.list, (ctx) => {
      capturedPayloads.push(ctx.payload as Record<string, unknown>);
      ctx.setResult({ results: [] });
    });

    const ctx = createContext(bus, {
      client: 'claude-code',
      projectDir: '/home/user/project',
    });
    await runClientWiringCommand(ctx, { resolveMakaioCommand: () => '/usr/local/bin/makaio' });

    expect(capturedPayloads).toEqual([
      {
        clientId: 'claude-code',
        projectDir: '/home/user/project',
        makaioCommand: '/usr/local/bin/makaio',
      },
    ]);
  });

  it('writes an error and sets exit code 1 when the bus request fails', async () => {
    // Inject a bus stub that rejects — simulates no handler or runtime unavailable.
    const ctx = createContext({
      request: vi.fn(async () => {
        throw new Error('no handler');
      }),
    });

    await runClientWiringCommand(ctx);

    expect(stderrChunks.join('')).toContain('Failed to retrieve wiring status');
    expect(stdoutChunks.join('')).toBe('');
    expect(ctx.setExitCodeSpy).toHaveBeenCalledWith(1);
  });
});
