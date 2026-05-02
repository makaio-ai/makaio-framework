/**
 * Tests for CLI handlers (non-interactive subcommands).
 *
 * Handlers are exercised against a real `MakaioBus`, mostly with per-test
 * request handlers plus a small integration-style path that uses a real
 * `AccountManager` instance. Output is captured via the injected CLI writer so
 * the tests follow the same command contract used by local and remote
 * execution.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { AccountManagerSubjects } from '../bus/namespace.js';
import type { IMakaioBus } from '@makaio/bus-core';
import type { Account } from '../bus/schemas.js';
import type { OutputWriter } from '@makaio/kernel/cli';
import { AccountManager } from '../account-manager.js';
import { handleList, handleSwitch, handleLabel, handleRemove, handleSources } from '../cli/handlers.js';
import { makeAccount } from './fixtures/account.js';
import { InMemoryCredentialSource } from './testing/in-memory-source.js';
import { InMemoryAccountStore } from './testing/in-memory-store.js';

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

const stdoutChunks: string[] = [];
const stderrChunks: string[] = [];
let exitCode: number | undefined;
const cleanups: Array<() => void> = [];

/**
 * Register a mock request handler on the global bus and queue its cleanup.
 * @param subject - The bus subject to handle.
 * @param handler - A function that receives the request payload and returns the response.
 */
function onRequest<Req, Res>(subject: Parameters<IMakaioBus['on']>[0], handler: (payload: Req) => Res): void {
  // Bus request handlers receive a context with payload and setResult.
  // The generic `on` overload accepts the typed handler; we cast to satisfy
  // the narrowed union type while keeping the actual logic fully typed.
  const cleanup = MakaioBus.on(
    subject as never,
    ((ctx: { payload: Req; setResult: (res: Res) => void }) => {
      ctx.setResult(handler(ctx.payload));
    }) as never,
  );
  cleanups.push(cleanup);
}

beforeEach(() => {
  stdoutChunks.length = 0;
  stderrChunks.length = 0;
  exitCode = undefined;
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
  exitCode = undefined;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal CommandContext with only the fields handlers actually use.
 * @param bus - Bus instance to include in context.
 * @param args - Parsed CLI arguments.
 * @returns A CommandContext-compatible object.
 */
function makeCtx<TArgs>(bus: IMakaioBus, args: TArgs) {
  const output: OutputWriter = {
    write: (text) => {
      stdoutChunks.push(text);
    },
    error: (text) => {
      stderrChunks.push(text);
    },
  };

  return {
    bus,
    args,
    output,
    signal: new AbortController().signal,
    setExitCode: (nextExitCode: number) => {
      exitCode = nextExitCode;
    },
  };
}

/** Concatenate all stdout.write call arguments into a single string. */
function capturedStdout(): string {
  return stdoutChunks.join('');
}

/** Concatenate all stderr.write call arguments into a single string. */
function capturedStderr(): string {
  return stderrChunks.join('');
}

// ---------------------------------------------------------------------------
// handleList
// ---------------------------------------------------------------------------

describe('handleList', () => {
  it('lists accounts in table format by default', async () => {
    const account = makeAccount({ id: 'acc-1', active: true, label: 'Work' });

    onRequest(AccountManagerSubjects.accounts.getSources, () => ({
      sources: [{ clientId: 'claude', displayName: 'Claude Code', available: true }],
    }));
    onRequest(AccountManagerSubjects.accounts.list, () => ({
      accounts: [account],
    }));

    await handleList(makeCtx(MakaioBus, { format: 'table' as const }));

    const out = capturedStdout();
    expect(out).toContain('claude');
    expect(out).toContain('Work');
    expect(out).toContain('●');
    expect(out).toContain('(active)');
  });

  it('shows a re-auth note in table output when account metadata marks usage auth invalid', async () => {
    const account = makeAccount({
      id: 'acc-1',
      active: true,
      label: 'Work',
      metadata: {
        authMode: 'chatgpt',
        usageAuthState: 'reauth-required',
      },
    });

    onRequest(AccountManagerSubjects.accounts.getSources, () => ({
      sources: [{ clientId: 'claude', displayName: 'Claude Code', available: true }],
    }));
    onRequest(AccountManagerSubjects.accounts.list, () => ({
      accounts: [account],
    }));

    await handleList(makeCtx(MakaioBus, { format: 'table' as const }));

    expect(capturedStdout()).toContain('[chatgpt, reauth required]');
  });

  it('lists accounts in JSON format when --format json', async () => {
    const account = makeAccount({ id: 'acc-1', active: false, label: 'Personal' });

    onRequest(AccountManagerSubjects.accounts.getSources, () => ({
      sources: [{ clientId: 'claude', displayName: 'Claude Code', available: true }],
    }));
    onRequest(AccountManagerSubjects.accounts.list, () => ({
      accounts: [account],
    }));

    await handleList(makeCtx(MakaioBus, { format: 'json' as const }));

    const raw = capturedStdout();
    const parsed = JSON.parse(raw) as Array<{ clientId: string; accounts: Account[] }>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0].clientId).toBe('claude');
    expect(parsed[0].accounts[0].id).toBe('acc-1');
  });

  it('filters by clientId when --clientId is provided', async () => {
    // getSources returns two sources, but only 'other' should be queried since
    // clientId is specified; the handler routes directly to the given clientId.
    onRequest(AccountManagerSubjects.accounts.getSources, () => ({
      sources: [
        { clientId: 'claude', displayName: 'Claude Code', available: true },
        { clientId: 'other', displayName: 'Other', available: true },
      ],
    }));

    const queriedClientIds: string[] = [];
    onRequest(AccountManagerSubjects.accounts.list, (payload: { clientId: string }) => {
      queriedClientIds.push(payload.clientId);
      return { accounts: [makeAccount({ id: payload.clientId + '-acc' })] };
    });

    await handleList(makeCtx(MakaioBus, { clientId: 'claude', format: 'table' as const }));

    // Only the specified clientId should be queried.
    expect(queriedClientIds).toEqual(['claude']);
    expect(capturedStdout()).toContain('claude');
  });

  it('shows "No accounts found." when no accounts exist', async () => {
    onRequest(AccountManagerSubjects.accounts.getSources, () => ({
      sources: [{ clientId: 'claude', displayName: 'Claude Code', available: true }],
    }));
    onRequest(AccountManagerSubjects.accounts.list, () => ({ accounts: [] }));

    await handleList(makeCtx(MakaioBus, { format: 'table' as const }));

    expect(capturedStdout()).toBe('No accounts found.\n');
  });
});

// ---------------------------------------------------------------------------
// handleSwitch
// ---------------------------------------------------------------------------

describe('handleSwitch', () => {
  it('switches account successfully and writes confirmation', async () => {
    onRequest(AccountManagerSubjects.accounts.getSources, () => ({
      sources: [{ clientId: 'claude', displayName: 'Claude Code', available: true }],
    }));
    onRequest(AccountManagerSubjects.accounts.list, () => ({
      accounts: [makeAccount({ id: 'acc-1' })],
    }));
    onRequest(AccountManagerSubjects.credentials.switch, () => ({ success: true }));

    await handleSwitch(makeCtx(MakaioBus, { accountId: 'acc-1' }));

    expect(capturedStdout()).toBe('Switched claude to acc-1\n');
    expect(exitCode).toBeUndefined();
  });

  it('sets exitCode=1 and reports error when account is not found', async () => {
    onRequest(AccountManagerSubjects.accounts.getSources, () => ({
      sources: [{ clientId: 'claude', displayName: 'Claude Code', available: true }],
    }));
    onRequest(AccountManagerSubjects.accounts.list, () => ({ accounts: [] }));

    await handleSwitch(makeCtx(MakaioBus, { accountId: 'missing-acc' }));

    expect(capturedStderr()).toContain('"missing-acc" not found');
    expect(exitCode).toBe(1);
  });

  it('sets exitCode=1 and reports error when switch RPC fails', async () => {
    onRequest(AccountManagerSubjects.accounts.getSources, () => ({
      sources: [{ clientId: 'claude', displayName: 'Claude Code', available: true }],
    }));
    onRequest(AccountManagerSubjects.accounts.list, () => ({
      accounts: [makeAccount({ id: 'acc-1' })],
    }));
    onRequest(AccountManagerSubjects.credentials.switch, () => ({
      success: false,
      error: 'keychain locked',
    }));

    await handleSwitch(makeCtx(MakaioBus, { accountId: 'acc-1' }));

    expect(capturedStderr()).toContain('keychain locked');
    expect(exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// handleLabel
// ---------------------------------------------------------------------------

describe('handleLabel', () => {
  it('labels account successfully', async () => {
    onRequest(AccountManagerSubjects.accounts.getSources, () => ({
      sources: [{ clientId: 'claude', displayName: 'Claude Code', available: true }],
    }));
    onRequest(AccountManagerSubjects.accounts.list, () => ({
      accounts: [makeAccount({ id: 'acc-1' })],
    }));
    onRequest(AccountManagerSubjects.accounts.label, () => ({ success: true }));

    await handleLabel(makeCtx(MakaioBus, { accountId: 'acc-1', label: 'Work' }));

    expect(capturedStdout()).toBe('Labeled acc-1 as "Work"\n');
    expect(exitCode).toBeUndefined();
  });

  it('sets exitCode=1 and reports error when account is not found', async () => {
    onRequest(AccountManagerSubjects.accounts.getSources, () => ({
      sources: [{ clientId: 'claude', displayName: 'Claude Code', available: true }],
    }));
    onRequest(AccountManagerSubjects.accounts.list, () => ({ accounts: [] }));

    await handleLabel(makeCtx(MakaioBus, { accountId: 'missing-acc', label: 'Work' }));

    expect(capturedStderr()).toContain('"missing-acc" not found');
    expect(exitCode).toBe(1);
  });

  it('skips inference and uses explicit --clientId when provided', async () => {
    // getSources and listAccounts must NOT be called when clientId is explicit.
    onRequest(AccountManagerSubjects.accounts.label, () => ({ success: true }));

    await handleLabel(makeCtx(MakaioBus, { accountId: 'acc-1', label: 'Work', clientId: 'claude' }));

    expect(capturedStdout()).toBe('Labeled acc-1 as "Work"\n');
    expect(exitCode).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// handleRemove
// ---------------------------------------------------------------------------

describe('handleRemove', () => {
  it('removes account successfully', async () => {
    onRequest(AccountManagerSubjects.accounts.getSources, () => ({
      sources: [{ clientId: 'claude', displayName: 'Claude Code', available: true }],
    }));
    onRequest(AccountManagerSubjects.accounts.list, () => ({
      accounts: [makeAccount({ id: 'acc-1' })],
    }));
    onRequest(AccountManagerSubjects.accounts.remove, () => ({ success: true }));

    await handleRemove(makeCtx(MakaioBus, { accountId: 'acc-1' }));

    expect(capturedStdout()).toBe('Removed acc-1 from claude\n');
    expect(exitCode).toBeUndefined();
  });

  it('sets exitCode=1 and reports error when account is not found', async () => {
    onRequest(AccountManagerSubjects.accounts.getSources, () => ({
      sources: [{ clientId: 'claude', displayName: 'Claude Code', available: true }],
    }));
    onRequest(AccountManagerSubjects.accounts.list, () => ({ accounts: [] }));

    await handleRemove(makeCtx(MakaioBus, { accountId: 'missing-acc' }));

    expect(capturedStderr()).toContain('"missing-acc" not found');
    expect(exitCode).toBe(1);
  });

  it('skips inference and uses explicit --clientId when provided', async () => {
    // getSources and listAccounts must NOT be called when clientId is explicit.
    onRequest(AccountManagerSubjects.accounts.remove, () => ({ success: true }));

    await handleRemove(makeCtx(MakaioBus, { accountId: 'acc-1', clientId: 'claude' }));

    expect(capturedStdout()).toBe('Removed acc-1 from claude\n');
    expect(exitCode).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// handleSources
// ---------------------------------------------------------------------------

describe('handleSources', () => {
  it('lists sources with availability status', async () => {
    onRequest(AccountManagerSubjects.accounts.getSources, () => ({
      sources: [
        { clientId: 'claude', displayName: 'Claude Code', available: true },
        { clientId: 'gemini', displayName: 'Gemini', available: false },
      ],
    }));

    await handleSources(makeCtx(MakaioBus, {}));

    const out = capturedStdout();
    expect(out).toContain('✓ Claude Code (claude)');
    expect(out).toContain('✗ Gemini (gemini)');
  });

  it('shows config issue reason and action when present', async () => {
    onRequest(AccountManagerSubjects.accounts.getSources, () => ({
      sources: [
        {
          clientId: 'claude',
          displayName: 'Claude Code',
          available: false,
          configIssue: {
            reason: 'Token file not found',
            action: 'Run `claude login` to authenticate',
          },
        },
      ],
    }));

    await handleSources(makeCtx(MakaioBus, {}));

    const out = capturedStdout();
    expect(out).toContain('Token file not found');
    expect(out).toContain('Run `claude login` to authenticate');
  });
});

// ---------------------------------------------------------------------------
// withErrorHandling (shared bus-rejection contract)
// ---------------------------------------------------------------------------

describe('bus rejection error handling', () => {
  it('writes error message to stderr and sets exitCode=1 when bus request rejects', async () => {
    // Register a getSources handler that throws to simulate a transport or
    // service error. The bus wraps this in a RequestError, so handler.message
    // contains the subject and original message.
    onRequest(AccountManagerSubjects.accounts.getSources, () => {
      throw new Error('service unavailable');
    });

    await handleList(makeCtx(MakaioBus, { format: 'table' as const }));

    expect(capturedStderr()).toContain('service unavailable');
    expect(exitCode).toBe(1);
  });

  it('writes the raw string representation to stderr when a non-Error is thrown', async () => {
    onRequest(AccountManagerSubjects.accounts.getSources, () => {
      throw 'transport failure';
    });

    await handleSources(makeCtx(MakaioBus, {}));

    expect(capturedStderr()).toContain('transport failure');
    expect(exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Integration-style coverage with a real AccountManager instance
// ---------------------------------------------------------------------------

describe('CLI handlers with real account-manager wiring', () => {
  it('handleList reads through real subjects registered by AccountManager', async () => {
    vi.useFakeTimers();
    const source = new InMemoryCredentialSource('claude-code', 'Claude Code');
    // Install a label resolver before constructing AccountManager so the
    // LabelResolver's source map includes this client. The account id is now a
    // stable UUID (not the fingerprint), so the display label must be
    // resolved — it cannot be predicted from the fixture data.
    source.setLabelResolver(async () => 'Integration Account');
    const store = new InMemoryAccountStore();
    const service = new AccountManager(MakaioBus, {
      sources: [source],
      credentialStore: store.credentialStore,
      metadataStore: store.metadataStore,
      usageSnapshotStore: store.usageSnapshotStore,
      pollIntervalMs: 1000,
      makaioCommand: 'makaio-test',
    });

    try {
      await service.init();
      source.setCredential({
        token: 'real-token',
        fingerprint: 'real-account',
        metadata: {},
      });
      await vi.advanceTimersByTimeAsync(1000);

      await handleList(makeCtx(MakaioBus, { format: 'table' as const }));

      expect(capturedStdout()).toContain('claude-code');
      expect(capturedStdout()).toContain('Integration Account');
    } finally {
      await service.destroy();
      vi.useRealTimers();
    }
  });
});
