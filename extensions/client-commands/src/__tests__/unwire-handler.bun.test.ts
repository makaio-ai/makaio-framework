/**
 * Tests for the `client unwire` CLI handler.
 *
 * The handler is exercised against a real `createBusInstance()` with a
 * test-local `client:<id>.wiring.remove` handler registered so tests verify
 * the full request dispatch path without relying on an actual client service.
 */

import { afterEach, beforeEach, describe, expect, it, mock, type Mock } from 'bun:test';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { ClientWiringRemoveResponseSchema } from '@makaio/clients-core';
import { createBusNamespace } from '@makaio/core';
import { z } from 'zod';
import { runClientUnwireCommand, type ClientUnwireCommandContext } from '../cli/unwire-handler.js';
import { createClientWiringRemoveSubjectDef } from '../subjects.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const stdoutChunks: string[] = [];
const stderrChunks: string[] = [];

afterEach(() => {
  stdoutChunks.length = 0;
  stderrChunks.length = 0;
  mock.restore();
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
  args: ClientUnwireCommandContext['args'],
): ClientUnwireCommandContext & { readonly setExitCodeSpy: Mock<(code: number) => void> } {
  const setExitCodeSpy = mock<(code: number) => void>();
  return {
    args,
    bus,
    output: createOutput(),
    setExitCode: setExitCodeSpy,
    setExitCodeSpy,
  };
}

/**
 * Register a minimal `wiring.remove` schema on a test bus instance.
 *
 * The CLI bridge dispatches through a non-owning subject definition, so tests
 * that use an isolated bus must register the schema on that same bus instance.
 * Using a loose schema here keeps the test agnostic to per-client scope enums.
 * @param bus - Isolated bus instance under test.
 * @param clientId - Test-only client identifier.
 * @returns Subjects registered on the local test bus.
 */
function registerTestClientWiringRemoveNamespace(bus: IMakaioBus, clientId: string) {
  return bus.registerNamespace(
    createBusNamespace(`client:${clientId}`, {
      'wiring.remove': {
        request: z.object({
          scope: z.string(),
          projectDir: z.string().optional(),
        }),
        response: ClientWiringRemoveResponseSchema,
      },
    }),
  ).subjects;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runClientUnwireCommand', () => {
  let bus: IMakaioBus;

  beforeEach(() => {
    bus = createBusInstance();
  });

  it('dispatches wiring.remove with correct subject and payload', async () => {
    const subjects = registerTestClientWiringRemoveNamespace(bus, 'claude-code');

    const capturedPayloads: Array<Record<string, unknown>> = [];
    const cleanup = bus.on(subjects.wiring.remove, (ctx) => {
      capturedPayloads.push(ctx.payload as Record<string, unknown>);
      ctx.setResult({ removed: 2 });
    });

    const ctx = createContext(bus, { client: 'claude-code', scope: 'user' });
    await runClientUnwireCommand(ctx);

    cleanup();

    expect(capturedPayloads).toHaveLength(1);
    expect(capturedPayloads[0]).toMatchObject({ scope: 'user' });
    expect(capturedPayloads[0]?.projectDir).toBeUndefined();
  });

  it('includes projectDir in the request when provided', async () => {
    const subjects = registerTestClientWiringRemoveNamespace(bus, 'codex');

    const capturedPayloads: Array<Record<string, unknown>> = [];
    const cleanup = bus.on(subjects.wiring.remove, (ctx) => {
      capturedPayloads.push(ctx.payload as Record<string, unknown>);
      ctx.setResult({ removed: 1 });
    });

    const ctx = createContext(bus, {
      client: 'codex',
      scope: 'global',
      projectDir: '/home/user/my-project',
    });
    await runClientUnwireCommand(ctx);

    cleanup();

    expect(capturedPayloads[0]).toMatchObject({
      scope: 'global',
      projectDir: '/home/user/my-project',
    });
  });

  it('uses the subject definition for the correct client namespace', async () => {
    // Register two separate client namespaces to confirm the subject routes correctly.
    const claudeSubjects = registerTestClientWiringRemoveNamespace(bus, 'claude-code');
    const codexSubjects = registerTestClientWiringRemoveNamespace(bus, 'codex');

    let claudeCalled = false;
    let codexCalled = false;

    const cleanupClaude = bus.on(claudeSubjects.wiring.remove, (ctx) => {
      claudeCalled = true;
      ctx.setResult({ removed: 1 });
    });
    const cleanupCodex = bus.on(codexSubjects.wiring.remove, () => {
      codexCalled = true;
    });

    const ctx = createContext(bus, { client: 'claude-code', scope: 'user' });
    await runClientUnwireCommand(ctx);

    cleanupClaude();
    cleanupCodex();

    expect(claudeCalled).toBe(true);
    expect(codexCalled).toBe(false);
  });

  it('writes a success message with the removed count', async () => {
    const subjects = registerTestClientWiringRemoveNamespace(bus, 'claude-code');
    const cleanup = bus.on(subjects.wiring.remove, (ctx) => {
      ctx.setResult({ removed: 3 });
    });

    const ctx = createContext(bus, { client: 'claude-code', scope: 'user' });
    await runClientUnwireCommand(ctx);

    cleanup();

    const stdout = stdoutChunks.join('');
    expect(stdout).toContain('claude-code');
    expect(stdout).toContain('removed 3 hook(s)');
    expect(stderrChunks.join('')).toBe('');
    expect(ctx.setExitCodeSpy).not.toHaveBeenCalled();
  });

  it('writes an error and sets exit code 1 when no handler is registered', async () => {
    // No handler registered — bus will throw NoHandlerError.
    const ctx = createContext(bus, { client: 'unknown-client', scope: 'user' });
    await runClientUnwireCommand(ctx);

    expect(stderrChunks.join('')).toContain('unknown-client');
    expect(stdoutChunks.join('')).toBe('');
    expect(ctx.setExitCodeSpy).toHaveBeenCalledWith(1);
  });

  it('uses createClientWiringRemoveSubjectDef to build the subject', () => {
    const def = createClientWiringRemoveSubjectDef('test-client');
    expect(def.subject).toBe('wiring.remove');
    expect(def.$meta.namespace).toBe('client:test-client');
    expect(def.$meta.isRequest).toBe(true);
  });
});
