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
import { z } from 'zod';
import { runClientWireCommand, type ClientWireCommandContext } from '../cli/wire-handler.js';
import { createClientWiringApplySubjectDef } from '../subjects.js';

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
  return bus.registerNamespace(`client:${clientId}`, {
    'wiring.apply': {
      request: z.object({
        scope: z.string(),
        projectDir: z.string().optional(),
        makaioCommand: z.string(),
      }),
      response: ClientWiringApplyResponseSchema,
    },
  }).subjects;
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
