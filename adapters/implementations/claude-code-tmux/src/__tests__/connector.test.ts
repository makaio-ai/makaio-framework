/**
 * Unit tests for ClaudeCodeTmuxConnector.
 *
 * These tests mock the external process layer (TmuxBackend, TmuxSession) to
 * exercise the connector's lifecycle, queue processing, and hook-driven turn
 * state machine without spawning real tmux sessions.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { IPtyProcess } from '@makaio/native-session-supervisor';
import { MakaioBus } from '@makaio/bus-core';
import { McpSubjects } from '@makaio/contracts';
import { ClaudeCodeClientSubjects } from '@makaio/client-claude-code/runtime';
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
  isAlive: vi.fn().mockReturnValue(true),
  subscribeUnsubscribe: vi.fn(),
  tmuxAvailable: true,
  callOrder: [] as string[],
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
    }
    public getClaudeSessionId(): string | undefined {
      return undefined;
    }
    public waitForSessionStart(): Promise<void> {
      mockState.callOrder.push('waitForSessionStart');
      return Promise.resolve();
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
    onExit: vi.fn(() => ({ dispose: vi.fn() })),
  } as IPtyProcess),
);

vi.mock('@makaio/native-session-supervisor', async (importOriginal) => {
  const original = await importOriginal<typeof import('@makaio/native-session-supervisor')>();

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

vi.mock('@makaio/ai-adapters-core/config', async (importOriginal) => {
  const original = await importOriginal<typeof import('@makaio/ai-adapters-core/config')>();
  return {
    ...original,
    resolveSessionEnvironment: vi.fn().mockResolvedValue({
      credentials: {},
      credEnv: {},
      resolvedBinary: undefined,
      spawnEnv: { PATH: '/usr/bin' },
    }),
  };
});

vi.mock('@makaio/ai-adapters-claude-process-shared', async (importOriginal) => {
  const original = await importOriginal<typeof import('@makaio/ai-adapters-claude-process-shared')>();
  return {
    ...original,
    resolveClaudeProcessEnv: vi.fn((opts: { spawnEnv: Record<string, string> }) => opts.spawnEnv),
    readClaudeProviderBaseUrl: vi.fn(() => undefined),
  };
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
    MakaioBus.on(ClientSubjects.sessionConfig.create, (ctx) => {
      ctx.setResult({
        sessionDir: '/tmp/claude-session-config',
        env: { CLAUDE_CONFIG_DIR: '/tmp/claude-session-config' },
      });
    });
    MakaioBus.on(ClientSubjects.sessionConfig.destroy, (ctx) => {
      ctx.setResult({ success: true });
    });
    // Reset hook registry between tests.
    mockState.hooks.onSessionStart = undefined;
    mockState.hooks.onUserPromptSubmit = undefined;
    mockState.hooks.onPreToolUse = undefined;
    mockState.hooks.onPostToolUse = undefined;
    mockState.hooks.onStop = undefined;
    mockState.tmuxAvailable = true;
    mockState.callOrder = [];
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

    it('is idempotent — calling it twice does not re-spawn', async () => {
      const connector = await makeConnector();
      fireSessionStart();

      await connector.initialize();
      await connector.initialize();

      expect(mockSpawn).toHaveBeenCalledOnce();
    });

    it('sets adapterSessionId in constructor (before initialize)', async () => {
      const connector = await makeConnector();

      expect(connector.adapterSessionId).toBeDefined();
      expect(typeof connector.adapterSessionId).toBe('string');
    });

    it('registers a pinned MCP session and writes the makaio MCP server before spawning', async () => {
      const connector = await makeConnector({ sessionId: 'makaio-session-1', agentId: 'agent-1' });
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
          sessionId: 'makaio-session-1',
          agentId: 'agent-1',
        },
      });
      expect(mcpWrites).toHaveLength(1);
      expect(mcpWrites[0]).toMatchObject({
        projectDir: TEST_CWD,
        server: { type: 'http', url: `http://127.0.0.1:4123/mcp?adapterSessionId=${connector.adapterSessionId}` },
      });
      expect((mcpWrites[0] as { name: string }).name).toMatch(/^makaio-/);
      expect(mockSpawn).toHaveBeenCalledOnce();
    });

    it('starts when the MCP bridge is present but the Claude Code config service is absent', async () => {
      const connector = await makeConnector();
      const registrations: unknown[] = [];

      MakaioBus.on(McpSubjects.session.register, (ctx) => {
        registrations.push(ctx.payload);
        ctx.setResult({ port: 4123 });
      });
      fireSessionStart();

      await expect(connector.initialize()).resolves.toBeUndefined();

      expect(registrations).toHaveLength(1);
      expect(mockSpawn).toHaveBeenCalledOnce();
    });

    it('fails early when Claude Code wiring support is missing', async () => {
      MakaioBus.__resetHandlers?.();
      MakaioBus.on(ClientSubjects.sessionConfig.create, (ctx) => {
        ctx.setResult({
          sessionDir: '/tmp/claude-session-config',
          env: { CLAUDE_CONFIG_DIR: '/tmp/claude-session-config' },
        });
      });
      const connector = await makeConnector();

      await expect(connector.initialize()).rejects.toThrow('requires active Claude Code wiring support');
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it('fails closed when session config isolation is unavailable', async () => {
      MakaioBus.__resetHandlers?.();
      MakaioBus.on(ClaudeCodeClientSubjects.wiring.apply, (ctx) => {
        ctx.setResult({ applied: 1, skipped: 0 });
      });
      const connector = await makeConnector();

      await expect(connector.initialize()).rejects.toThrow('requires session-scoped Claude Code config support');

      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it('wires hooks into the session config directory using user scope', async () => {
      MakaioBus.__resetHandlers?.();
      const connector = await makeConnector({ sessionId: 'makaio-session-1' });
      const wiringRequests: unknown[] = [];

      MakaioBus.on(ClientSubjects.sessionConfig.create, (ctx) => {
        ctx.setResult({
          sessionDir: '/tmp/isolated-claude-config',
          env: { CLAUDE_CONFIG_DIR: '/tmp/isolated-claude-config' },
        });
      });
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
      });
    });

    it('checks tmux availability before spawning', async () => {
      MakaioBus.on(ClientSubjects.sessionConfig.create, (ctx) => {
        ctx.setResult({
          sessionDir: '/tmp/claude-session-config',
          env: { CLAUDE_CONFIG_DIR: '/tmp/claude-session-config' },
        });
      });
      const connector = await makeConnector();
      mockState.tmuxAvailable = false;

      await expect(connector.initialize()).rejects.toThrow('Claude Code tmux adapter requires tmux on PATH');

      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it('subscribes to hooks before waiting for SessionStart after spawn', async () => {
      MakaioBus.on(ClientSubjects.sessionConfig.create, (ctx) => {
        ctx.setResult({
          sessionDir: '/tmp/claude-session-config',
          env: { CLAUDE_CONFIG_DIR: '/tmp/claude-session-config' },
        });
      });
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
      MakaioBus.on(ClientSubjects.sessionConfig.create, (ctx) => {
        ctx.setResult({
          sessionDir: '/tmp/claude-session-config',
          env: { CLAUDE_CONFIG_DIR: '/tmp/claude-session-config' },
        });
      });
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
    });

    it('returns a handle immediately without waiting for turn completion', async () => {
      const connector = await makeConnector();
      fireSessionStart();
      await connector.initialize();

      // Do NOT fire Stop — handle should still be returned immediately.
      const handlePromise = connector.sendMessage({ role: 'user', blocks: [], message: 'test' });

      // Resolve quickly by firing stop after we've gotten the handle.
      const handle = await handlePromise;
      mockState.hooks.onStop?.('claude-session-abc', 'done');

      expect(handle).toBeDefined();
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

    it('disposes backend and destroys session config when MCP removal fails', async () => {
      MakaioBus.__resetHandlers?.();
      const connector = await makeConnector({ sessionId: 'makaio-session-close-failure' });
      const destroyedSessionIds: string[] = [];
      const unregisters: unknown[] = [];

      MakaioBus.on(ClaudeCodeClientSubjects.wiring.apply, (ctx) => {
        ctx.setResult({ applied: 1, skipped: 0 });
      });
      MakaioBus.on(ClientSubjects.sessionConfig.create, (ctx) => {
        ctx.setResult({
          sessionDir: '/tmp/claude-session-config-close',
          env: { CLAUDE_CONFIG_DIR: '/tmp/claude-session-config-close' },
        });
      });
      MakaioBus.on(ClientSubjects.sessionConfig.destroy, (ctx) => {
        destroyedSessionIds.push(ctx.payload.sessionId);
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
      expect(destroyedSessionIds).toEqual(['makaio-session-close-failure']);
    });

    it('is safe to call without initialization', async () => {
      const connector = await makeConnector();

      await expect(connector.close()).resolves.toBeUndefined();
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
