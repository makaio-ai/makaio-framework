/**
 * Tests for the `client wire` CLI handler.
 *
 * The handler is exercised against a real `createBusInstance()` with a
 * test-local `client:<id>.wiring.apply` handler registered so tests verify
 * the full request dispatch path without relying on an actual client service.
 * The injectable `resolveMakaioCommand` dependency keeps process state out of
 * the test process entirely.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { ClientWiringApplyResponseSchema } from '@makaio/clients-core';
import { createBusNamespace } from '@makaio/core';
import { z } from 'zod';
import {
  runClientWireCommand,
  resolveDefaultMakaioCommand,
  resolveDefaultEnvPairs,
  type ClientWireCommandContext,
} from '../cli/wire-handler.js';
import { createClientWiringApplySubjectDef } from '../subjects.js';
import { wireSchema } from '../cli/contribution.js';

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
  bus: Pick<IMakaioBus, 'request'>,
  args: ClientWireCommandContext['args'],
): ClientWireCommandContext & { readonly setExitCodeSpy: ReturnType<typeof vi.fn> } {
  const setExitCodeSpy = vi.fn<(code: number) => void>();
  return {
    args,
    bus,
    output: createOutput(),
    setExitCode: setExitCodeSpy,
    setExitCodeSpy,
  };
}

/**
 * Register a minimal `wiring.apply` schema on a test bus instance.
 *
 * The CLI bridge dispatches through a non-owning subject definition, so tests
 * that use an isolated bus must register the schema on that same bus instance.
 * Using a loose schema here keeps the test agnostic to per-client scope enums.
 * @param bus - Isolated bus instance under test.
 * @param clientId - Test-only client identifier.
 * @returns Subjects registered on the local test bus. The `wiring.apply`
 *   subject is accessible as `subjects.wiring.apply` (nested dot notation).
 */
function registerTestClientWiringNamespace(bus: IMakaioBus, clientId: string) {
  return bus.registerNamespace(
    createBusNamespace(`client:${clientId}`, {
      'wiring.apply': {
        request: z.object({
          scope: z.string(),
          projectDir: z.string().optional(),
          makaioCommand: z.string(),
          envPairs: z.array(z.string()).optional(),
        }),
        response: ClientWiringApplyResponseSchema,
      },
    }),
  ).subjects;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runClientWireCommand', () => {
  let bus: IMakaioBus;

  beforeEach(() => {
    bus = createBusInstance();
  });

  it('dispatches wiring.apply with correct subject and payload', async () => {
    const subjects = registerTestClientWiringNamespace(bus, 'claude-code');

    const capturedPayloads: Array<Record<string, unknown>> = [];
    const cleanup = bus.on(subjects.wiring.apply, (ctx) => {
      capturedPayloads.push(ctx.payload as Record<string, unknown>);
      ctx.setResult({ applied: 3, skipped: 1 });
    });

    const ctx = createContext(bus, { client: 'claude-code', scope: 'user' });
    await runClientWireCommand(ctx, { resolveMakaioCommand: () => '/usr/local/bin/makaio' });

    cleanup();

    expect(capturedPayloads).toHaveLength(1);
    expect(capturedPayloads[0]).toMatchObject({
      scope: 'user',
      makaioCommand: '/usr/local/bin/makaio',
    });
    expect(capturedPayloads[0]?.projectDir).toBeUndefined();
  });

  it('includes projectDir in the request when provided', async () => {
    const subjects = registerTestClientWiringNamespace(bus, 'codex');

    const capturedPayloads: Array<Record<string, unknown>> = [];
    const cleanup = bus.on(subjects.wiring.apply, (ctx) => {
      capturedPayloads.push(ctx.payload as Record<string, unknown>);
      ctx.setResult({ applied: 1, skipped: 0 });
    });

    const ctx = createContext(bus, {
      client: 'codex',
      scope: 'global',
      projectDir: '/home/user/my-project',
    });
    await runClientWireCommand(ctx, { resolveMakaioCommand: () => 'makaio' });

    cleanup();

    expect(capturedPayloads[0]).toMatchObject({
      scope: 'global',
      projectDir: '/home/user/my-project',
      makaioCommand: 'makaio',
    });
  });

  it('writes a success message with applied and skipped counts', async () => {
    const subjects = registerTestClientWiringNamespace(bus, 'claude-code');
    const cleanup = bus.on(subjects.wiring.apply, (ctx) => {
      ctx.setResult({ applied: 2, skipped: 1 });
    });

    const ctx = createContext(bus, { client: 'claude-code', scope: 'user' });
    await runClientWireCommand(ctx, { resolveMakaioCommand: () => 'makaio' });

    cleanup();

    const stdout = stdoutChunks.join('');
    expect(stdout).toContain('claude-code');
    expect(stdout).toContain('applied 2');
    expect(stdout).toContain('skipped 1');
    expect(stderrChunks.join('')).toBe('');
    expect(ctx.setExitCodeSpy).not.toHaveBeenCalled();
  });

  it('writes an error and sets exit code 1 when no handler is registered', async () => {
    // No handler registered — bus will throw NoHandlerError.
    const ctx = createContext(bus, { client: 'unknown-client', scope: 'user' });
    await runClientWireCommand(ctx, { resolveMakaioCommand: () => 'makaio' });

    expect(stderrChunks.join('')).toContain('unknown-client');
    expect(stdoutChunks.join('')).toBe('');
    expect(ctx.setExitCodeSpy).toHaveBeenCalledWith(1);
  });

  it('uses the subject definition for the correct client namespace', async () => {
    // Register two separate client namespaces to confirm the subject routes correctly.
    const claudeSubjects = registerTestClientWiringNamespace(bus, 'claude-code');
    const codexSubjects = registerTestClientWiringNamespace(bus, 'codex');

    let claudeCalled = false;
    let codexCalled = false;

    const cleanupClaude = bus.on(claudeSubjects.wiring.apply, (ctx) => {
      claudeCalled = true;
      ctx.setResult({ applied: 1, skipped: 0 });
    });
    const cleanupCodex = bus.on(codexSubjects.wiring.apply, () => {
      codexCalled = true;
    });

    const ctx = createContext(bus, { client: 'claude-code', scope: 'user' });
    await runClientWireCommand(ctx, { resolveMakaioCommand: () => 'makaio' });

    cleanupClaude();
    cleanupCodex();

    expect(claudeCalled).toBe(true);
    expect(codexCalled).toBe(false);
  });

  it('uses createClientWiringApplySubjectDef to build the subject', () => {
    const def = createClientWiringApplySubjectDef('test-client');
    expect(def.subject).toBe('wiring.apply');
    expect(def.$meta.namespace).toBe('client:test-client');
    expect(def.$meta.isRequest).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// wireSchema — Bug D: scope must default to 'user'
// ---------------------------------------------------------------------------

describe('wireSchema', () => {
  it('parses successfully with scope defaulting to user when omitted', () => {
    const result = wireSchema.parse({ client: 'claude-code' });
    expect(result.scope).toBe('user');
  });

  it('preserves an explicitly supplied scope value', () => {
    const result = wireSchema.parse({ client: 'claude-code', scope: 'project' });
    expect(result.scope).toBe('project');
  });
});

// ---------------------------------------------------------------------------
// resolveDefaultMakaioCommand — Bug C: dev-mode .ts entry must be executable
// ---------------------------------------------------------------------------

describe('resolveDefaultMakaioCommand', () => {
  it('returns the script path unchanged when it is a compiled binary (no .ts extension)', () => {
    const result = resolveDefaultMakaioCommand(['/usr/bin/node', '/usr/local/bin/makaio']);
    expect(result).toBe('/usr/local/bin/makaio');
  });

  it('returns the script path unchanged when argv[1] ends with .ts (dev mode)', () => {
    const result = resolveDefaultMakaioCommand(['/usr/bin/node', '/path/to/cli-entry.ts']);
    expect(result).toBe('/path/to/cli-entry.ts');
  });

  it('keeps .ts paths containing spaces as one executable path', () => {
    const result = resolveDefaultMakaioCommand(['/usr/bin/node', '/Users/alice/My Projects/cli-entry.ts']);
    expect(result).toBe('/Users/alice/My Projects/cli-entry.ts');
  });

  it('returns the script path unchanged when argv[1] ends with .mts (dev mode)', () => {
    const result = resolveDefaultMakaioCommand(['/usr/bin/tsx', '/path/to/cli-entry.mts']);
    expect(result).toBe('/path/to/cli-entry.mts');
  });

  it('returns makaio when argv[1] is absent', () => {
    const result = resolveDefaultMakaioCommand(['/usr/bin/node']);
    expect(result).toBe('makaio');
  });

  it('returns makaio when argv is empty', () => {
    const result = resolveDefaultMakaioCommand([]);
    expect(result).toBe('makaio');
  });
});

// ---------------------------------------------------------------------------
// resolveDefaultEnvPairs — dev-mode env var detection
// ---------------------------------------------------------------------------

describe('resolveDefaultEnvPairs', () => {
  it('returns undefined when MAKAIO_CONFIG_FILE is not set', () => {
    expect(resolveDefaultEnvPairs({})).toBeUndefined();
  });

  it('returns MAKAIO_CONFIG_FILE pair when set', () => {
    const result = resolveDefaultEnvPairs({ MAKAIO_CONFIG_FILE: '/path/to/config.ts' });
    expect(result).toEqual(['MAKAIO_CONFIG_FILE=/path/to/config.ts']);
  });

  it('includes MAKAIO_HOME when both are set', () => {
    const result = resolveDefaultEnvPairs({
      MAKAIO_CONFIG_FILE: '/path/to/config.ts',
      MAKAIO_HOME: '/path/to/.makaio-dev',
    });
    expect(result).toEqual(['MAKAIO_CONFIG_FILE=/path/to/config.ts', 'MAKAIO_HOME=/path/to/.makaio-dev']);
  });

  it('omits MAKAIO_HOME when only MAKAIO_CONFIG_FILE is set', () => {
    const result = resolveDefaultEnvPairs({ MAKAIO_CONFIG_FILE: '/path/to/config.ts' });
    expect(result).toHaveLength(1);
    expect(result![0]).toMatch(/^MAKAIO_CONFIG_FILE=/);
  });
});

// ---------------------------------------------------------------------------
// runClientWireCommand — envPairs forwarding
// ---------------------------------------------------------------------------

describe('runClientWireCommand envPairs', () => {
  let bus: IMakaioBus;

  beforeEach(() => {
    bus = createBusInstance();
  });

  it('forwards envPairs to the bus request payload when provided', async () => {
    const subjects = registerTestClientWiringNamespace(bus, 'claude-code');

    const capturedPayloads: Array<Record<string, unknown>> = [];
    const cleanup = bus.on(subjects.wiring.apply, (ctx) => {
      capturedPayloads.push(ctx.payload as Record<string, unknown>);
      ctx.setResult({ applied: 6, skipped: 0 });
    });

    const ctx = createContext(bus, { client: 'claude-code', scope: 'user' });
    await runClientWireCommand(ctx, {
      resolveMakaioCommand: () => '/path/to/cli-entry.ts',
      resolveEnvPairs: () => ['MAKAIO_CONFIG_FILE=/path/to/config.ts', 'MAKAIO_HOME=/path/to/.makaio-dev'],
    });

    cleanup();

    expect(capturedPayloads[0]).toMatchObject({
      makaioCommand: '/path/to/cli-entry.ts',
      envPairs: ['MAKAIO_CONFIG_FILE=/path/to/config.ts', 'MAKAIO_HOME=/path/to/.makaio-dev'],
    });
  });

  it('sends undefined envPairs when resolveEnvPairs is not provided', async () => {
    const subjects = registerTestClientWiringNamespace(bus, 'claude-code');

    const capturedPayloads: Array<Record<string, unknown>> = [];
    const cleanup = bus.on(subjects.wiring.apply, (ctx) => {
      capturedPayloads.push(ctx.payload as Record<string, unknown>);
      ctx.setResult({ applied: 6, skipped: 0 });
    });

    const ctx = createContext(bus, { client: 'claude-code', scope: 'user' });
    await runClientWireCommand(ctx, { resolveMakaioCommand: () => 'makaio' });

    cleanup();

    expect(capturedPayloads[0]?.envPairs).toBeUndefined();
  });
});
