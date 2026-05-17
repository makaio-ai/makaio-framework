/**
 * TmuxSession — wraps a Claude Code tmux process with hook event routing.
 *
 * Combines the {@link ITmuxPtyProcess} (from the supervisor/TmuxBackend) with a
 * bus subscription to `client:claude-code.hook.received` for lifecycle events.
 * The session translates hook events into the adapter's turn state machine
 * via the provided {@link HookEventCallbacks}.
 *
 * All I/O is routed through the {@link ITmuxPtyProcess} interface rather than
 * independent tmux CLI calls — the TmuxBackend owns the session name and
 * serializes access via its internal `TmuxPtyProcess`.
 * @packageDocumentation
 */

import { MakaioBus } from '@makaio/bus-core';
import { DeferredPromise } from '@makaio/utils';
import type { RawClientHookPayload } from '@makaio/clients-core';
import { ClaudeCodeClientSubjects } from '@makaio/client-claude-code/runtime';
import { CLAUDE_PROMPT_INDICATOR, CLAUDE_STATUS_TOKEN_MARKER } from './constants.js';
import type { ITmuxPtyProcess } from './types.js';
import { createHookEventRouter, type HookEventCallbacks } from './utils/hook-event-router.js';

/** Configuration for a TmuxSession instance. */
export interface TmuxSessionConfig {
  /** The tmux PTY process handle from the supervisor. */
  ptyProcess: ITmuxPtyProcess;
  /** Claude Code session ID expected from hook events. */
  expectedClaudeSessionId: string;
}

/**
 * Wraps a Claude Code interactive process running in a tmux session.
 *
 * Provides:
 * - Message sending via {@link ITmuxPtyProcess.write}
 * - Named-key delivery via {@link ITmuxPtyProcess.sendKey}
 * - Pane capture via {@link ITmuxPtyProcess.captureVisible}
 * - Process lifecycle via {@link ITmuxPtyProcess.kill}
 * - Hook event subscription with session ID filtering
 */
export class TmuxSession {
  private readonly ptyProcess: ITmuxPtyProcess;
  private readonly expectedClaudeSessionId: string;
  private claudeSessionId: string | undefined;
  private hookUnsubscribe: (() => void) | undefined;
  private readonly sessionStartDeferred = new DeferredPromise<void>();

  /**
   * @param config - Session configuration
   */
  public constructor(config: TmuxSessionConfig) {
    this.ptyProcess = config.ptyProcess;
    this.expectedClaudeSessionId = config.expectedClaudeSessionId;
  }

  /**
   * Send a user message to the Claude Code session.
   *
   * Writes the message text followed by a newline to the PTY process.
   * The TmuxBackend's `write()` uses `send-keys -l` internally, which
   * treats the string as literal keystrokes.
   * @param text - Message text to send
   */
  public async sendMessage(text: string): Promise<void> {
    await this.waitForInputReady();
    const beforeInput = this.captureVisible();
    this.ptyProcess.write(text);
    await this.waitForVisibleChange(beforeInput);
    this.ptyProcess.sendKey('Enter');
  }

  /**
   * Request that Claude Code stops the currently running turn.
   *
   * Uses tmux named-key delivery because `send-keys -l` does not reliably
   * treat ESC as a control key.
   */
  public sendEscape(): void {
    this.ptyProcess.sendKey('Escape');
  }

  /**
   * Clear any draft text left in the Claude Code composer.
   */
  public clearInput(): void {
    this.ptyProcess.sendKey('C-c');
  }

  /**
   * Wait until the Claude Code composer is visible in the tmux pane.
   * @param timeoutMs - Maximum time to wait for the composer.
   * @param intervalMs - Polling interval between pane captures.
   */
  public async waitForInputReady(timeoutMs = 3_000, intervalMs = 100): Promise<void> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const capture = this.ptyProcess.captureVisible();
      if (capture && isClaudeComposerVisible(capture)) {
        return;
      }
      await delay(intervalMs);
    }
    throw new Error(`Timed out waiting for Claude input composer after ${timeoutMs}ms`);
  }

  /**
   * Capture the visible tmux pane content.
   * @returns Visible pane text, or `null` when the pane no longer exists.
   */
  public captureVisible(): string | null {
    return this.ptyProcess.captureVisible();
  }

  /**
   * Wait for the visible pane to change after sending a composer control key.
   * @param previousCapture - Capture taken before the control key was sent.
   * @param timeoutMs - Maximum time to wait for a changed pane.
   * @param intervalMs - Polling interval between pane captures.
   */
  public async waitForVisibleChange(previousCapture: string | null, timeoutMs = 1_000, intervalMs = 50): Promise<void> {
    if (previousCapture === null) {
      await delay(intervalMs);
      return;
    }

    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const capture = this.ptyProcess.captureVisible();
      if (capture !== null && capture !== previousCapture && isClaudeComposerVisible(capture)) {
        return;
      }
      await delay(intervalMs);
    }
  }

  /**
   * Get the Claude Code-internal session ID (set by SessionStart hook).
   * @returns Session ID string, or `undefined` before SessionStart fires
   */
  public getClaudeSessionId(): string | undefined {
    return this.claudeSessionId;
  }

  /**
   * Get the underlying tmux PTY process handle.
   * @returns The tmux PTY process
   */
  public getPtyProcess(): ITmuxPtyProcess {
    return this.ptyProcess;
  }

  /**
   * Wait for the SessionStart hook to confirm Claude Code is live.
   * @returns Promise that resolves when SessionStart fires.
   */
  public waitForSessionStart(): Promise<void> {
    return this.sessionStartDeferred.getPromise();
  }

  /**
   * Kill the underlying PTY process.
   */
  public kill(): void {
    this.ptyProcess.kill();
  }

  /**
   * Subscribe to Claude Code hook events filtered to this session.
   *
   * Subscribes on the **global** bus because `client:claude-code.hook.received`
   * lives in the `client:claude-code` namespace, not the adapter's scoped
   * namespace. Hook events originate from external processes and are emitted
   * on the global bus by the hook bridge (tests) or the CLI kernel (production).
   *
   * The returned unsubscribe function removes the bus listener. Call it
   * during cleanup to prevent memory leaks.
   * @param callbacks - Typed hook event handlers
   * @returns Unsubscribe function
   */
  public subscribeToHooks(callbacks: HookEventCallbacks): () => void {
    const wrappedCallbacks: HookEventCallbacks = {
      onSessionStart: (sessionId, model) => {
        this.claudeSessionId = sessionId;
        this.sessionStartDeferred.resolve();
        return callbacks.onSessionStart(sessionId, model);
      },
      onUserPromptSubmit: callbacks.onUserPromptSubmit,
      onPreToolUse: callbacks.onPreToolUse,
      onPostToolUse: callbacks.onPostToolUse,
      onStop: callbacks.onStop,
    };

    const router = createHookEventRouter(() => this.expectedClaudeSessionId, wrappedCallbacks);

    this.hookUnsubscribe = MakaioBus.on(
      ClaudeCodeClientSubjects.hook.received,
      async (ctx: { payload: RawClientHookPayload }) => {
        await router(ctx.payload);
      },
      { filter: { 'payload.session_id': this.expectedClaudeSessionId } },
    );
    return this.hookUnsubscribe;
  }

  /**
   * Clean up resources: kill the process.
   *
   * Hook unsubscription is the responsibility of the **connector** that called
   * {@link subscribeToHooks} and holds the returned unsubscribe function. The
   * connector calls its own reference before calling `dispose()`, so this method
   * must not double-unsubscribe here.
   */
  public dispose(): void {
    this.kill();
  }
}

/**
 * Check whether a visible tmux pane looks like Claude Code's input composer.
 * @param capture - Visible pane text from tmux.
 * @returns True when the pane contains Claude Code's prompt and status line.
 */
function isClaudeComposerVisible(capture: string): boolean {
  return capture.includes(CLAUDE_PROMPT_INDICATOR) && capture.includes(CLAUDE_STATUS_TOKEN_MARKER);
}

/**
 * Wait for a fixed number of milliseconds.
 * @param ms - Duration to wait.
 * @returns Promise that resolves after the duration.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
