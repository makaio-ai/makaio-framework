/**
 * Unit tests for ClaudeCodeTmuxConnector.
 *
 * These tests mock the external process layer (TmuxBackend, TmuxSession) to
 * exercise the connector's lifecycle, queue processing, and hook-driven turn
 * state machine without spawning real tmux sessions.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { IPtyProcess } from '@makaio/subsystem-native-session-supervisor';
import { MakaioBus } from '@makaio/bus-core';
import { McpSubjects } from '@makaio/contracts';
import { CONNECTOR_EXIT_OBSERVATION_MS } from '@makaio/ai-adapters-core';
import { ClaudeCodeClientSubjects, CLAUDE_CODE_HOOK_SESSION_START } from '@makaio/client-claude-code/runtime';
import { ClientSubjects } from '@makaio/contracts/client';
import type { HookEventCallbacks } from '../utils/hook-event-router.js';

// ---------------------------------------------------------------------------
// Hoisted mock state — shared between the mock factories and tests
// ---------------------------------------------------------------------------

const mockState = vi.hoisted(() => ({
  sendMessage: vi.fn<(text: string) => void>(),
  sendEscape: vi.fn<() => void>(),
  clearInput: vi.fn<() => void>(),
  kill: vi.fn(),
  dispose: vi.fn(),
  observeSessionStart: vi.fn<(sessionId: string) => void>(),
  isAlive: vi.fn().mockReturnValue(true),
  subscribeUnsubscribe: vi.fn(),
  tmuxAvailable: true,
  callOrder: [] as string[],
  /** Exit listeners the connector registered on the mocked pane process. */
  exitListeners: [] as Array<(event: { exitCode: number; signal?: number }) => void>,
  /**
   * Whether killing the session publishes the pane's exit.
   *
   * The real backend publishes an exit synchronously from `kill()` whenever a
   * server established the session's absence, and publishes none when nothing
   * could be established. Both are normal, so the mock models both and a test
   * chooses which one it is driving.
   */
  publishExitOnKill: true,
  /**
   * Delay before a kill publishes the pane exit.
   *
   * Zero mirrors the backend's synchronous publication when absence is proven at
   * the kill; a positive value lets a test prove the teardown *waited* rather
   * than merely happening to resolve after a synchronous event.
   */
  publishExitDelayMs: 0,
  hooks: {
    onSessionStart: undefined as ((sessionId: string, model: string) => void) | undefined,
    onUserPromptSubmit: undefined as ((sessionId: string) => Promise<void> | void) | undefined,
    onPreToolUse: undefined as ((sessionId: string, tool: string, id: string, input: unknown) => void) | undefined,
    onPostToolUse: undefined as
      | ((sessionId: string, tool: string, id: string, result: unknown, isError?: boolean) => void)
      | undefined,
    onStop: undefined as ((sessionId: string, lastMessage: string) => void) | undefined,
  },
}));

// ---------------------------------------------------------------------------
// Module mocks — must be declared before any imports from the mocked modules
// ---------------------------------------------------------------------------

vi.mock('../session.js', () => {
  class TmuxSession {
    public sendMessage(text: string): Promise<void> {
      mockState.sendMessage(text);
      return Promise.resolve();
    }
    public sendEscape(): void {
      mockState.sendEscape();
    }
    public clearInput(): void {
      mockState.clearInput();
    }
    public waitForInputReady(): Promise<void> {
      return Promise.resolve();
    }
    public captureVisible(): string | null {
      return null;
    }
    public waitForVisibleChange(): Promise<void> {
      return Promise.resolve();
    }
    public kill(): void {
      mockState.kill();
    }
    public dispose(): void {
      mockState.dispose();
      if (!mockState.publishExitOnKill) return;
      const publish = (): void => {
        mockState.callOrder.push('exit-published');
        for (const listener of mockState.exitListeners) listener({ exitCode: 0 });
      };
      if (mockState.publishExitDelayMs === 0) publish();
      else setTimeout(publish, mockState.publishExitDelayMs);
    }
    public getClaudeSessionId(): string | undefined {
      return undefined;
    }
    public waitForSessionStart(): Promise<void> {
      mockState.callOrder.push('waitForSessionStart');
      return Promise.resolve();
    }
    public observeSessionStart(sessionId: string): void {
      mockState.callOrder.push('observeSessionStart');
      mockState.observeSessionStart(sessionId);
    }
    public subscribeToHooks(callbacks: HookEventCallbacks): () => void {
      mockState.callOrder.push('subscribeToHooks');
      mockState.hooks.onSessionStart = callbacks.onSessionStart;
      mockState.hooks.onUserPromptSubmit = callbacks.onUserPromptSubmit;
      mockState.hooks.onPreToolUse = callbacks.onPreToolUse;
      mockState.hooks.onPostToolUse = callbacks.onPostToolUse;
      mockState.hooks.onStop = callbacks.onStop;
      return mockState.subscribeUnsubscribe;
    }
  }
  return { TmuxSession };
});

const mockBackendDispose = vi.hoisted(() => vi.fn<() => Promise<void>>().mockResolvedValue(undefined));
const mockSpawn = vi.hoisted(() =>
  vi.fn<(file: string, args: string[], opts: unknown) => Promise<IPtyProcess>>().mockResolvedValue({
    pid: 1234,
    process: 'claude',
    cols: 80,
    rows: 24,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    onExit: vi.fn((listener: (event: { exitCode: number; signal?: number }) => void) => {
      mockState.exitListeners.push(listener);
      return {
        dispose: () => {
          mockState.exitListeners = mockState.exitListeners.filter((registered) => registered !== listener);
        },
      };
    }),
  } as IPtyProcess),
);

vi.mock('@makaio/subsystem-native-session-supervisor', async (importOriginal) => {
  const original = await importOriginal<typeof import('@makaio/subsystem-native-session-supervisor')>();

  class TmuxBackend {
    public async spawn(file: string, args: string[], opts: unknown): Promise<IPtyProcess> {
      mockState.callOrder.push('spawn');
      return mockSpawn(file, args, opts);
    }
    public async dispose(): Promise<void> {
      return mockBackendDispose();
    }
  }

  return { ...original, TmuxBackend, isTmuxAvailable: () => mockState.tmuxAvailable };
});

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { ClaudeCodeTmuxConnector } from '../connector.js';
import { ClaudeCodeTmuxConnectorNamespace, ClaudeCodeTmuxConnectorSubjects } from '../namespace/index.js';
import type { ClaudeCodeTmuxAgentConfig } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_CWD = '/tmp';

async function makeConnector(overrides: Partial<ClaudeCodeTmuxAgentConfig> = {}): Promise<ClaudeCodeTmuxConnector> {
  const bus = await ClaudeCodeTmuxConnectorNamespace.scopedBus();
  return new ClaudeCodeTmuxConnector({
    bus,
    adapterId: 'test-adapter-id',
    cwd: TEST_CWD,
    model: 'claude-sonnet',
    env: { PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '/tmp/claude-session-config' },
    contextEnv: { PATH: '/usr/bin' },
    ...overrides,
  } as ClaudeCodeTmuxAgentConfig);
}

/**
 * Fire the SessionStart hook after a short delay so that `initializeSession`
 * can proceed past its `Promise.race` timeout guard.
 * @param sessionId - Session ID to emit
 * @param delayMs - Delay before firing
 */
function fireSessionStart(sessionId = 'claude-session-abc', delayMs = 5): void {
  setTimeout(() => {
    mockState.hooks.onSessionStart?.(sessionId, 'claude-sonnet');
  }, delayMs);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ClaudeCodeTmuxConnector', () => {
  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
    vi.clearAllMocks();
    MakaioBus.on(ClaudeCodeClientSubjects.wiring.apply, (ctx) => {
      ctx.setResult({ applied: 1, skipped: 0 });
    });
    // Reset hook registry between tests.
    mockState.hooks.onSessionStart = undefined;
    mockState.hooks.onUserPromptSubmit = undefined;
    mockState.hooks.onPreToolUse = undefined;
    mockState.hooks.onPostToolUse = undefined;
    mockState.hooks.onStop = undefined;
    mockState.observeSessionStart.mockClear();
    mockState.tmuxAvailable = true;
    mockState.callOrder = [];
    mockState.exitListeners = [];
    mockState.publishExitOnKill = true;
    mockState.publishExitDelayMs = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    MakaioBus.__resetHandlers?.();
  });

  // ── Initialize ────────────────────────────────────────────────────────────

  describe('initialize()', () => {
    it('spawns Claude Code and waits for SessionStart', async () => {
      const connector = await makeConnector();
      fireSessionStart();

      await connector.initialize();

      expect(mockSpawn).toHaveBeenCalledOnce();
      expect(mockState.subscribeUnsubscribe).toBeDefined();
    });

    it('captures SessionStart when Claude emits it during spawn', async () => {
      const connector = await makeConnector();
      const claudeSessionId = connector.adapterSessionId;
      mockSpawn.mockImplementationOnce(async () => {
        await MakaioBus.emit(ClaudeCodeClientSubjects.hook.received, {
          eventName: CLAUDE_CODE_HOOK_SESSION_START,
          receivedAt: Date.now(),
          payload: { session_id: claudeSessionId, model: 'claude-sonnet' },
        });
        return {
          pid: 1234,
          process: 'claude',
          cols: 80,
          rows: 24,
          write: vi.fn(),
          resize: vi.fn(),
          kill: vi.fn(),
          onData: vi.fn(() => ({ dispose: vi.fn() })),
          onExit: vi.fn(() => ({ dispose: vi.fn() })),
        } as IPtyProcess;
      });

      await expect(connector.initialize()).resolves.toBeUndefined();
      expect(mockState.observeSessionStart).toHaveBeenCalledWith(claudeSessionId);
    });

    it('is idempotent — calling it twice does not re-spawn', async () => {
      const connector = await makeConnector();
      fireSessionStart();

      await connector.initialize();
      await connector.initialize();

      expect(mockSpawn).toHaveBeenCalledOnce();
    });

    it('spawns with only the selected API-key delivery', async () => {
      const connector = await makeConnector({
        env: {
          PATH: '/usr/bin',
          CLAUDE_CONFIG_DIR: '/tmp/claude-session-config',
          ANTHROPIC_API_KEY: 'api-secret',
        },
      });
      fireSessionStart();

      await connector.initialize();

      const spawnOptions = mockSpawn.mock.calls[0]?.[2] as { env: Record<string, string> };
      expect(spawnOptions.env).toMatchObject({ ANTHROPIC_API_KEY: 'api-secret' });
      expect(spawnOptions.env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
    });

    it('spawns with only the selected explicit OAuth-token delivery', async () => {
      const connector = await makeConnector({
        env: {
          PATH: '/usr/bin',
          CLAUDE_CONFIG_DIR: '/tmp/claude-session-config',
          CLAUDE_CODE_OAUTH_TOKEN: 'oauth-secret',
        },
      });
      fireSessionStart();

      await connector.initialize();

      const spawnOptions = mockSpawn.mock.calls[0]?.[2] as { env: Record<string, string> };
      expect(spawnOptions.env).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: 'oauth-secret' });
      expect(spawnOptions.env).not.toHaveProperty('ANTHROPIC_API_KEY');
    });

    it('spawns inferred native state without explicit auth variables', async () => {
      const connector = await makeConnector();
      fireSessionStart();

      await connector.initialize();

      const spawnOptions = mockSpawn.mock.calls[0]?.[2] as { env: Record<string, string> };
      expect(spawnOptions.env).toMatchObject({ CLAUDE_CONFIG_DIR: '/tmp/claude-session-config' });
      expect(spawnOptions.env).not.toHaveProperty('ANTHROPIC_API_KEY');
      expect(spawnOptions.env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
    });

    it('uses the central binary selection without resolving it again', async () => {
      const resolveBinary = vi.fn();
      MakaioBus.on(ClientSubjects.resolveBinary, (ctx) => {
        resolveBinary();
        ctx.setResult({
          binaryPath: '/unexpected/bin/claude',
          env: {},
          configDir: null,
          source: 'managed',
          version: null,
        });
      });
      const connector = await makeConnector({
        clientExecution: {
          binaryPath: '/selected/bin/claude',
          env: {},
          configDir: null,
          source: 'managed',
          version: null,
        },
      });
      fireSessionStart();

      await connector.initialize();

      expect(resolveBinary).not.toHaveBeenCalled();
      expect(mockSpawn).toHaveBeenCalledWith('/selected/bin/claude', expect.any(Array), expect.any(Object));
    });

    it('sets adapterSessionId in constructor (before initialize)', async () => {
      const connector = await makeConnector();

      expect(connector.adapterSessionId).toBeDefined();
      expect(typeof connector.adapterSessionId).toBe('string');
    });

    it('registers a pinned MCP session and writes the makaio MCP server before spawning', async () => {
      const connector = await makeConnector({
        sessionId: 'makaio-session-1',
        agentId: 'agent-1',
        env: {
          PATH: '/usr/bin',
          CLAUDE_CONFIG_DIR: '/tmp/claude-session-config',
          ANTHROPIC_API_KEY: 'selected-secret',
          CLAUDE_CODE_OAUTH_TOKEN: 'opposing-secret',
        },
        contextEnv: { PATH: '/usr/bin' },
      });
      const registrations: unknown[] = [];
      const mcpWrites: unknown[] = [];

      MakaioBus.on(McpSubjects.session.register, (ctx) => {
        registrations.push(ctx.payload);
        ctx.setResult({ port: 4123 });
      });
      MakaioBus.on(ClaudeCodeClientSubjects.config.mcpServers.add, (ctx) => {
        mcpWrites.push(ctx.payload);
        ctx.setResult({ added: true, replaced: false });
      });
      fireSessionStart();

      await connector.initialize();

      expect(registrations).toHaveLength(1);
      expect(registrations[0]).toMatchObject({
        adapterSessionId: connector.adapterSessionId,
        agentId: 'agent-1',
        adapterId: 'test-adapter-id',
        adapterName: 'claude-code-tmux',
        sessionId: 'makaio-session-1',
        pinned: true,
        contextOverrides: {
          cwd: TEST_CWD,
          env: { PATH: '/usr/bin' },
          sessionId: 'makaio-session-1',
          agentId: 'agent-1',
        },
      });
      expect(JSON.stringify(registrations[0])).not.toContain('selected-secret');
      expect(JSON.stringify(registrations[0])).not.toContain('opposing-secret');
      expect(JSON.stringify(registrations[0])).not.toContain('CLAUDE_CONFIG_DIR');
      expect(mcpWrites).toHaveLength(1);
      expect(mcpWrites[0]).toMatchObject({
        projectDir: TEST_CWD,
        server: { type: 'http', url: `http://127.0.0.1:4123/mcp?adapterSessionId=${connector.adapterSessionId}` },
      });
      expect((mcpWrites[0] as { name: string }).name).toMatch(/^makaio-/);
      expect(mockSpawn).toHaveBeenCalledOnce();
    });

    it('uses the centrally supplied config directory without a local config-service request', async () => {
      const connector = await makeConnector();
      const registrations: unknown[] = [];
      const sessionConfigRequests = vi.fn();

      MakaioBus.on(McpSubjects.session.register, (ctx) => {
        registrations.push(ctx.payload);
        ctx.setResult({ port: 4123 });
      });
      MakaioBus.on(ClientSubjects.sessionConfig.create, () => {
        sessionConfigRequests();
        throw new Error('connector must not request another lease');
      });
      fireSessionStart();

      await expect(connector.initialize()).resolves.toBeUndefined();

      expect(registrations).toHaveLength(1);
      expect(sessionConfigRequests).not.toHaveBeenCalled();
      expect(mockSpawn).toHaveBeenCalledOnce();
    });

    it('fails early when Claude Code wiring support is missing', async () => {
      MakaioBus.__resetHandlers?.();
      const connector = await makeConnector();

      await expect(connector.initialize()).rejects.toThrow('requires active Claude Code wiring support');
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it('fails closed when the central client lease did not supply a config directory', async () => {
      MakaioBus.__resetHandlers?.();
      MakaioBus.on(ClaudeCodeClientSubjects.wiring.apply, (ctx) => {
        ctx.setResult({ applied: 1, skipped: 0 });
      });
      const connector = await makeConnector({ env: { PATH: '/usr/bin' } });

      await expect(connector.initialize()).rejects.toThrow(
        'requires CLAUDE_CONFIG_DIR from the central client config lease',
      );

      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it('wires hooks into the session config directory using user scope', async () => {
      MakaioBus.__resetHandlers?.();
      const connector = await makeConnector({
        sessionId: 'makaio-session-1',
        env: { PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '/tmp/isolated-claude-config' },
      });
      const wiringRequests: unknown[] = [];

      MakaioBus.on(ClaudeCodeClientSubjects.wiring.apply, (ctx) => {
        wiringRequests.push(ctx.payload);
        ctx.setResult({ applied: 1, skipped: 0 });
      });
      fireSessionStart();

      await connector.initialize();

      expect(wiringRequests).toHaveLength(1);
      expect(wiringRequests.at(-1)).toMatchObject({
        scope: 'user',
        projectDir: TEST_CWD,
        configDir: '/tmp/isolated-claude-config',
        skipDangerousModePermissionPrompt: true,
      });
    });

    it('does not create a second connector-local auth lease', async () => {
      MakaioBus.__resetHandlers?.();
      const connector = await makeConnector();
      const sessionConfigRequests: unknown[] = [];

      MakaioBus.on(ClientSubjects.sessionConfig.create, (ctx) => {
        sessionConfigRequests.push(ctx.payload);
        throw new Error('connector must not create a second lease');
      });
      MakaioBus.on(ClaudeCodeClientSubjects.wiring.apply, (ctx) => {
        ctx.setResult({ applied: 1, skipped: 0 });
      });
      fireSessionStart();

      await connector.initialize();

      expect(sessionConfigRequests).toHaveLength(0);
    });

    it('checks tmux availability before spawning', async () => {
      const connector = await makeConnector();
      mockState.tmuxAvailable = false;

      await expect(connector.initialize()).rejects.toThrow('Claude Code tmux adapter requires tmux on PATH');

      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it('subscribes to hooks before waiting for SessionStart after spawn', async () => {
      const connector = await makeConnector();
      fireSessionStart();

      await connector.initialize();

      expect(mockState.callOrder).toEqual(expect.arrayContaining(['spawn', 'subscribeToHooks', 'waitForSessionStart']));
      expect(mockState.callOrder.indexOf('subscribeToHooks')).toBeLessThan(
        mockState.callOrder.indexOf('waitForSessionStart'),
      );
    });

    it('waits for MCP prerequisite cleanup when hook wiring fails first', async () => {
      MakaioBus.__resetHandlers?.();
      const connector = await makeConnector();
      const unregisters: unknown[] = [];
      const removals: unknown[] = [];

      MakaioBus.on(McpSubjects.session.register, async (ctx) => {
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
        ctx.setResult({ port: 4123 });
      });
      MakaioBus.on(ClaudeCodeClientSubjects.config.mcpServers.add, (ctx) => {
        ctx.setResult({ added: true, replaced: false });
      });
      MakaioBus.on(ClaudeCodeClientSubjects.config.mcpServers.remove, (ctx) => {
        removals.push(ctx.payload);
        ctx.setResult({ removed: true });
      });
      MakaioBus.on(McpSubjects.session.unregister, (ctx) => {
        unregisters.push(ctx.payload);
        ctx.setResult({});
      });

      await expect(connector.initialize()).rejects.toThrow('requires active Claude Code wiring support');

      expect(mockSpawn).not.toHaveBeenCalled();
      expect(removals).toHaveLength(1);
      expect(unregisters).toEqual([{ adapterSessionId: connector.adapterSessionId }]);
    });

    it('preserves initialization and rollback failures when both phases fail', async () => {
      MakaioBus.__resetHandlers?.();
      const connector = await makeConnector();

      MakaioBus.on(McpSubjects.session.register, (ctx) => {
        ctx.setResult({ port: 4123 });
      });
      MakaioBus.on(ClaudeCodeClientSubjects.config.mcpServers.add, (ctx) => {
        ctx.setResult({ added: true, replaced: false });
      });
      MakaioBus.on(ClaudeCodeClientSubjects.config.mcpServers.remove, () => {
        throw new Error('settings removal failed');
      });
      MakaioBus.on(McpSubjects.session.unregister, (ctx) => {
        ctx.setResult({});
      });

      const failure = await connector.initialize().catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(AggregateError);
      const aggregate = failure as AggregateError;
      expect(aggregate.message).toBe('Claude Code tmux initialization and rollback both failed.');
      expect(aggregate.errors).toHaveLength(2);
      expect(aggregate.errors[0]).toBeInstanceOf(Error);
      expect((aggregate.errors[0] as Error).message).toContain('requires active Claude Code wiring support');
      expect(aggregate.errors[1]).toBeInstanceOf(Error);
      expect((aggregate.errors[1] as Error).message).toContain('settings removal failed');
      expect(aggregate.cause).toBe(aggregate.errors[0]);
    });
  });

  // ── getAdapterSessionId ───────────────────────────────────────────────────

  describe('getAdapterSessionId()', () => {
    it('returns the session ID immediately (generated in constructor)', async () => {
      const connector = await makeConnector();

      const id = await connector.getAdapterSessionId();
      expect(id).toBeDefined();
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    });

    it('returns a stable UUID across calls', async () => {
      const connector = await makeConnector();

      const id1 = await connector.getAdapterSessionId();
      const id2 = await connector.getAdapterSessionId();
      expect(id1).toBe(id2);
    });
  });

  // ── sendMessage ───────────────────────────────────────────────────────────

  describe('sendMessage()', () => {
    it('sends text via tmux send-keys', async () => {
      const connector = await makeConnector();
      fireSessionStart();
      await connector.initialize();

      // Fire Stop hook shortly after send so the turn completes.
      setTimeout(() => {
        mockState.hooks.onStop?.('claude-session-abc', 'Hello back!');
      }, 10);

      const handle = await connector.sendMessage({ role: 'user', blocks: [], message: 'Hello Claude!' });

      expect(mockState.sendMessage).toHaveBeenCalledWith('Hello Claude!');
      expect(handle.message.message).toBe('Hello Claude!');
      await connector.complete();
    });

    it('materializes turnContext and messageHistory into the prompt', async () => {
      const connector = await makeConnector();
      fireSessionStart();
      await connector.initialize();

      await connector.sendMessage(
        { role: 'user', blocks: [{ type: 'text', content: 'What code do you see?' }], message: 'fallback' },
        {
          turnContext: { testMarker: 'TC-unit-123' },
          messageHistory: [{ role: 'user', blocks: { type: 'text', content: 'My name is Alice.' } }],
        },
      );

      const prompt = mockState.sendMessage.mock.calls.at(-1)?.[0] ?? '';
      expect(prompt).toContain('<testMarker>');
      expect(prompt).toContain('TC-unit-123');
      expect(prompt).toContain('<message_history>');
      expect(prompt).toContain('User: My name is Alice.');
      expect(prompt).toContain('What code do you see?');

      mockState.hooks.onStop?.('claude-session-abc', 'done');
      await connector.complete();
    });

    it('initializes session lazily if not yet initialized', async () => {
      const connector = await makeConnector();
      fireSessionStart();

      setTimeout(() => {
        mockState.hooks.onStop?.('claude-session-abc', 'done');
      }, 20);

      await connector.sendMessage({ role: 'user', blocks: [], message: 'ping' });

      expect(mockSpawn).toHaveBeenCalledOnce();
      await connector.complete();
    });

    it('returns a handle immediately without waiting for turn completion', async () => {
      const connector = await makeConnector();
      fireSessionStart();
      await connector.initialize();

      // Do NOT fire Stop — handle should still be returned immediately.
      const handlePromise = connector.sendMessage({ role: 'user', blocks: [], message: 'test' });

      // Resolve quickly by firing stop after we've gotten the handle.
      const handle = await handlePromise;

      expect(handle).toBeDefined();
      await mockState.hooks.onStop?.('claude-session-abc', 'done');
      await connector.complete();
    });

    it('interrupts an active turn before sending an immediate replacement', async () => {
      const connector = await makeConnector();
      fireSessionStart();
      await connector.initialize();

      const initial = await connector.sendMessage({ role: 'user', blocks: [], message: 'Peter gave me 5 apples.' });
      const queued = await connector.sendMessage(
        { role: 'user', blocks: [], message: 'Alice gave me 3 apples.' },
        { deliveryMode: 'enqueue' },
      );

      const immediatePromise = connector.sendMessage(
        { role: 'user', blocks: [], message: 'How many apples total? Respond only with the number.' },
        { deliveryMode: 'immediate' },
      );

      expect(mockState.sendEscape).toHaveBeenCalledOnce();

      mockState.hooks.onStop?.('claude-session-abc', 'interrupted');
      const immediate = await immediatePromise;

      await expect(initial.waitForCompletion()).resolves.toMatchObject({ outcome: 'superseded' });
      await expect(queued.waitForCompletion()).resolves.toMatchObject({ outcome: 'merged' });
      expect(mockState.clearInput).toHaveBeenCalledOnce();

      const prompt = mockState.sendMessage.mock.calls.at(-1)?.[0] ?? '';
      expect(prompt).toContain('<merged_context>');
      expect(prompt).toContain('Peter gave me 5 apples.');
      expect(prompt).toContain('Alice gave me 3 apples.');
      expect(prompt).toContain('How many apples total?');

      mockState.hooks.onStop?.('claude-session-abc', '8');
      await expect(immediate.waitForCompletion()).resolves.toMatchObject({
        outcome: 'completed',
        result: { message: '8' },
      });
    });
  });

  // ── Hook-driven turn lifecycle ────────────────────────────────────────────

  describe('hook-driven turn lifecycle', () => {
    it('completes the message handle when Stop fires', async () => {
      const connector = await makeConnector();
      fireSessionStart();
      await connector.initialize();

      const handlePromise = connector.sendMessage({ role: 'user', blocks: [], message: 'Do something' });

      setTimeout(() => {
        mockState.hooks.onStop?.('claude-session-abc', 'Task completed!');
      }, 10);

      const handle = await handlePromise;
      await connector.complete();

      expect(handle.state).toBe('completed');
    });

    it('emits turn_completed through the connector identity path', async () => {
      const connector = await makeConnector();
      const completions: string[] = [];
      connector.on(ClaudeCodeTmuxConnectorSubjects.turn.turn_completed, (ctx) => {
        completions.push(ctx.payload.message);
      });
      fireSessionStart();
      await connector.initialize();

      const handlePromise = connector.sendMessage({ role: 'user', blocks: [], message: 'Do something' });

      setTimeout(() => {
        mockState.hooks.onStop?.('claude-session-abc', 'Task completed!');
      }, 10);

      await handlePromise;
      await connector.complete();

      expect(completions).toEqual(['Task completed!']);
    });

    it('acknowledges the active message on UserPromptSubmit', async () => {
      const connector = await makeConnector();
      fireSessionStart();
      await connector.initialize();

      const handle = await connector.sendMessage({ role: 'user', blocks: [], message: 'Do something' });
      await mockState.hooks.onUserPromptSubmit?.('claude-session-abc');

      await expect(handle.waitForAcknowledgment()).resolves.toBe(true);
      mockState.hooks.onStop?.('claude-session-abc', 'Task completed!');
      await connector.complete();
    });

    it('emits step transitions for direct responses without tool hooks', async () => {
      const connector = await makeConnector();
      const transitions: string[] = [];
      connector.onProcessingStateChanged((state) => {
        transitions.push(state);
      });
      fireSessionStart();
      await connector.initialize();

      await connector.sendMessage({ role: 'user', blocks: [], message: 'Say HI' });
      await mockState.hooks.onUserPromptSubmit?.('claude-session-abc');
      mockState.hooks.onStop?.('claude-session-abc', 'HI');
      await connector.complete();

      expect(transitions).toContain('step_started');
      expect(transitions).toContain('step_finished');
      expect(transitions).toContain('turn_finished');
      expect(connector.getProcessingState()).toBe('idle');
    });

    it('returns to idle state after turn completes', async () => {
      const connector = await makeConnector();
      fireSessionStart();
      await connector.initialize();

      connector.sendMessage({ role: 'user', blocks: [], message: 'Q' }).catch(() => {});

      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      mockState.hooks.onStop?.('claude-session-abc', 'A');

      await connector.complete();

      expect(connector.getProcessingState()).toBe('idle');
    });

    it('transitions through step_started / step_finished on tool use', async () => {
      const connector = await makeConnector();
      fireSessionStart();
      await connector.initialize();

      connector.sendMessage({ role: 'user', blocks: [], message: 'Run a tool' }).catch(() => {});

      // Simulate: PreToolUse → PostToolUse → Stop
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      mockState.hooks.onPreToolUse?.('claude-session-abc', 'Bash', 'tu_1', { command: 'ls' });

      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      mockState.hooks.onPostToolUse?.('claude-session-abc', 'Bash', 'tu_1', 'file.ts');

      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      mockState.hooks.onStop?.('claude-session-abc', 'Done.');

      await connector.complete();

      expect(connector.getProcessingState()).toBe('idle');
    });
  });

  // ── abort / close ─────────────────────────────────────────────────────────

  describe('abort()', () => {
    it('kills the tmux session', async () => {
      const connector = await makeConnector();
      fireSessionStart();
      await connector.initialize();

      connector.abort();

      expect(mockState.kill).toHaveBeenCalled();
    });
  });

  describe('close()', () => {
    it('disposes the tmux session and backend', async () => {
      const connector = await makeConnector();
      fireSessionStart();
      await connector.initialize();

      await connector.close();

      expect(mockState.dispose).toHaveBeenCalled();
      expect(mockBackendDispose).toHaveBeenCalled();
    });

    it('removes the MCP server and unregisters the MCP session', async () => {
      const connector = await makeConnector();
      const removals: unknown[] = [];
      const unregisters: unknown[] = [];

      MakaioBus.on(McpSubjects.session.register, (ctx) => {
        ctx.setResult({ port: 4123 });
      });
      MakaioBus.on(ClaudeCodeClientSubjects.config.mcpServers.add, (ctx) => {
        ctx.setResult({ added: true, replaced: false });
      });
      MakaioBus.on(ClaudeCodeClientSubjects.config.mcpServers.remove, (ctx) => {
        removals.push(ctx.payload);
        ctx.setResult({ removed: true });
      });
      MakaioBus.on(McpSubjects.session.unregister, (ctx) => {
        unregisters.push(ctx.payload);
        ctx.setResult({});
      });
      fireSessionStart();
      await connector.initialize();

      await connector.close();

      expect(removals).toHaveLength(1);
      expect(removals[0]).toMatchObject({ projectDir: TEST_CWD });
      expect((removals[0] as { name: string }).name).toMatch(/^makaio-/);
      expect(unregisters).toEqual([{ adapterSessionId: connector.adapterSessionId }]);
    });

    it('disposes backend without releasing the central lease when MCP removal fails', async () => {
      MakaioBus.__resetHandlers?.();
      const connector = await makeConnector({ sessionId: 'makaio-session-close-failure' });
      const destroyedLeaseIds: string[] = [];
      const unregisters: unknown[] = [];

      MakaioBus.on(ClaudeCodeClientSubjects.wiring.apply, (ctx) => {
        ctx.setResult({ applied: 1, skipped: 0 });
      });
      MakaioBus.on(ClientSubjects.sessionConfig.destroy, (ctx) => {
        destroyedLeaseIds.push(ctx.payload.leaseId);
        ctx.setResult({ success: true });
      });
      MakaioBus.on(McpSubjects.session.register, (ctx) => {
        ctx.setResult({ port: 4123 });
      });
      MakaioBus.on(ClaudeCodeClientSubjects.config.mcpServers.add, (ctx) => {
        ctx.setResult({ added: true, replaced: false });
      });
      MakaioBus.on(ClaudeCodeClientSubjects.config.mcpServers.remove, () => {
        throw new Error('settings removal failed');
      });
      MakaioBus.on(McpSubjects.session.unregister, (ctx) => {
        unregisters.push(ctx.payload);
        ctx.setResult({});
      });
      fireSessionStart();
      await connector.initialize();

      await expect(connector.close()).rejects.toThrow('settings removal failed');

      expect(unregisters).toEqual([{ adapterSessionId: connector.adapterSessionId }]);
      expect(mockBackendDispose).toHaveBeenCalled();
      expect(destroyedLeaseIds).toEqual([]);
    });

    it('does not call the central lease release subject during connector close', async () => {
      MakaioBus.__resetHandlers?.();
      const connector = await makeConnector();
      const destroyRequests = vi.fn();

      MakaioBus.on(ClaudeCodeClientSubjects.wiring.apply, (ctx) => {
        ctx.setResult({ applied: 1, skipped: 0 });
      });
      MakaioBus.on(ClientSubjects.sessionConfig.destroy, () => {
        destroyRequests();
        throw new Error('connector must not release the central lease');
      });
      fireSessionStart();
      await connector.initialize();

      // The class is asserted rather than the old "resolved with nothing": the
      // connector-owned lease question this test protects is unchanged, and the
      // report is what replaced the `void` return.
      await expect(connector.close()).resolves.toEqual({ evidence: 'exited' });
      expect(mockBackendDispose).toHaveBeenCalled();
      expect(destroyRequests).not.toHaveBeenCalled();
    });

    it('is safe to call without initialization, and reports that nothing was spawned', async () => {
      const connector = await makeConnector();

      await expect(connector.close()).resolves.toEqual({ evidence: 'released' });
    });

    it('caps a close that raced the spawn at detached, rather than claiming nothing was started', async () => {
      // The one window in which a pane process can exist while no subscription to
      // its exit does: `backend.spawn()` is in flight, so `paneExit` is still
      // unassigned. A teardown reading that as "no session" reported `released` —
      // "nothing was spawned, so nothing can still be speaking" — about a process
      // whose only kill happens later, through `backend.dispose()`, unobserved.
      // `released` may stand only when no process was ever asked for.
      const connector = await makeConnector();
      let spawnEntered: () => void = () => undefined;
      const entered = new Promise<void>((resolve) => {
        spawnEntered = resolve;
      });
      let releaseSpawn: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        releaseSpawn = resolve;
      });
      mockSpawn.mockImplementationOnce(async () => {
        spawnEntered();
        await gate;
        throw new Error('spawn abandoned after the close');
      });

      const initialization = connector.initialize().catch((error: unknown) => error);
      await entered;

      const report = await connector.close();

      expect(mockState.exitListeners).toEqual([]);
      expect(report).toEqual({
        evidence: 'detached',
        detail: 'The tmux pane process was spawned before this teardown could subscribe to its exit.',
      });
      releaseSpawn();
      await initialization;
    });
  });

  // ── complete ──────────────────────────────────────────────────────────────

  describe('complete()', () => {
    it('resolves with the last message result after Stop fires', async () => {
      const connector = await makeConnector();
      fireSessionStart();
      await connector.initialize();

      setTimeout(() => {
        mockState.hooks.onStop?.('claude-session-abc', 'Final answer');
      }, 5);

      await connector.sendMessage({ role: 'user', blocks: [], message: 'Q?' });
      const result = await connector.complete();

      expect(result?.outcome).toBe('completed');
      expect(result?.result?.message).toBe('Final answer');
    });

    it('returns null when no message was processed', async () => {
      const connector = await makeConnector();
      // No session started, no message sent — state is idle already.

      const result = await connector.complete();

      expect(result).toBeNull();
    });
  });

  // ── interrupt ─────────────────────────────────────────────────────────────

  describe('interrupt()', () => {
    it('sends Escape to the tmux session', async () => {
      const connector = await makeConnector();
      fireSessionStart();
      await connector.initialize();

      await expect(connector.interrupt()).resolves.toBeUndefined();
      expect(mockState.sendEscape).toHaveBeenCalledOnce();
    });
  });
});

// Cases 206b and 206c — the class comes from an awaited pane exit, the wait is
// bounded, and a crash racing a stop finalises the turn exactly once.
describe('ClaudeCodeTmuxConnector teardown evidence', () => {
  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
    vi.clearAllMocks();
    MakaioBus.on(ClaudeCodeClientSubjects.wiring.apply, (ctx) => {
      ctx.setResult({ applied: 1, skipped: 0 });
    });
    mockState.hooks.onSessionStart = undefined;
    mockState.hooks.onStop = undefined;
    mockState.callOrder = [];
    mockState.exitListeners = [];
    mockState.publishExitOnKill = true;
    mockState.publishExitDelayMs = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    MakaioBus.__resetHandlers?.();
  });

  it('206b arm 1 — resolves `exited` only after the pane exit has been published', async () => {
    const connector = await makeConnector();
    fireSessionStart();
    await connector.initialize();

    // Delayed publication, so "resolves only after the exit" is an ordering fact
    // rather than a coincidence of both happening in the same synchronous turn.
    mockState.publishExitDelayMs = 5;
    mockState.callOrder = [];

    const report = await connector.close();
    mockState.callOrder.push('close-resolved');

    expect(report).toEqual({ evidence: 'exited' });
    expect(mockState.callOrder).toEqual(['exit-published', 'close-resolved']);
  });

  it('206b arm 2 — a kill whose exit never arrives resolves `detached` at the budget', async () => {
    const connector = await makeConnector();
    fireSessionStart();
    await connector.initialize();
    mockState.publishExitOnKill = false;

    vi.useFakeTimers();
    const closing = connector.close();
    await vi.advanceTimersByTimeAsync(CONNECTOR_EXIT_OBSERVATION_MS);
    const report = await closing;

    // Neither hanging nor claiming an end nobody established.
    expect(report.evidence).toBe('detached');
    expect(report.detail).toContain('tmux pane process');
  });

  it('206c — a crash arriving inside the teardown finalisation finalises the turn once', async () => {
    const connector = await makeConnector();
    fireSessionStart();
    await connector.initialize();

    const turnFinished: unknown[] = [];
    const bus = await ClaudeCodeTmuxConnectorNamespace.scopedBus();
    let injectedCrash = false;
    bus.on(ClaudeCodeTmuxConnectorSubjects.turn.turn_finished, (ctx) => {
      turnFinished.push(ctx.payload);
      if (injectedCrash) return;
      injectedCrash = true;
      // The exit lands *inside* the first finalisation, after the completion
      // guard has already been passed — the interleaving a guard alone cannot
      // cover. Asserted on the finalisation count, not on an absent error.
      for (const listener of mockState.exitListeners) listener({ exitCode: 1, signal: 9 });
    });

    await connector.sendMessage({ role: 'user', blocks: [], message: 'Q?' });
    await connector.close();

    expect(turnFinished).toHaveLength(1);
  });
});
