/**
 * ShellManager - Manages lifecycle of shell instances.
 *
 * Features:
 * - Creates and tracks shell instances
 * - Enforces concurrent shell limits
 * - Periodic cleanup of expired buffers
 * - Process exit handlers to kill all shells
 */

import { ShellInstance, type ShellInstanceOptions } from './shell-instance.js';
import { detectShell, getColorEnv, type Platform } from '../utils/index.js';
import type { ShellConstraints } from '../types.js';

// =============================================================================
// Types
// =============================================================================

export interface CreateShellOptions {
  /** Command to execute */
  command: string;
  /** Working directory */
  cwd: string;
  /** Environment variables */
  env: Record<string, string>;
  /** Platform (posix or windows) */
  platform: Platform;
  /** Preserve ANSI color codes */
  colors: boolean;
  /** Override timeout in ms */
  timeout?: number;
  /** Constraints from runtime */
  constraints: Required<ShellConstraints>;
}

interface TrackedShell {
  instance: ShellInstance;
  constraints: Required<ShellConstraints>;
  exitTime?: number;
}

// =============================================================================
// Module-level Registry for Process Handlers
// =============================================================================

/**
 * All active ShellManager instances. Used by process handlers to kill all
 * shells across all managers on process exit.
 */
const activeManagers = new Set<ShellManager>();
let processHandlersRegistered = false;

/**
 *
 */
function registerGlobalProcessHandlers(): void {
  if (processHandlersRegistered) {
    return;
  }

  // Synchronous kill on exit
  process.on('exit', () => {
    for (const manager of activeManagers) {
      manager.killAllSync();
    }
  });

  // Handle signals gracefully
  const handleSignal = (signal: 'SIGINT' | 'SIGTERM') => {
    for (const manager of activeManagers) {
      manager.killAllSync();
    }
    // Re-emit the signal to allow normal shutdown
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  };

  process.on('SIGINT', () => handleSignal('SIGINT'));
  process.on('SIGTERM', () => handleSignal('SIGTERM'));

  processHandlersRegistered = true;
}

// =============================================================================
// ShellManager Class
// =============================================================================

export class ShellManager {
  private readonly shells = new Map<string, TrackedShell>();
  private cleanupTimer: ReturnType<typeof setInterval> | undefined;

  public constructor() {
    activeManagers.add(this);
    registerGlobalProcessHandlers();
  }

  // ===========================================================================
  // Public Methods
  // ===========================================================================

  /**
   * Create a new shell instance.
   * @param options - Shell creation options
   * @returns The created shell instance
   * @throws Error if max concurrent shells limit is reached
   */
  public async create(options: CreateShellOptions): Promise<ShellInstance> {
    // Count running shells
    const runningCount = this.getRunningCount();

    if (runningCount >= options.constraints.maxConcurrentShells) {
      throw new Error(
        `Max concurrent shells (${options.constraints.maxConcurrentShells}) reached. ` +
          `Currently running: ${runningCount}`,
      );
    }

    // Detect shell and prepare environment
    const shell = detectShell(options.platform, process.env);
    const colorEnv = getColorEnv(options.colors);

    // Determine timeout
    const timeout = options.timeout ?? options.constraints.timeout;

    // Create instance options
    const instanceOptions: ShellInstanceOptions = {
      command: options.command,
      shell,
      cwd: options.cwd,
      env: { ...colorEnv, ...options.env },
      colors: options.colors,
      maxOutputSize: options.constraints.maxOutputSize,
      timeout,
    };

    // Create the shell instance
    const instance = new ShellInstance(instanceOptions);

    // Track it
    const tracked: TrackedShell = {
      instance,
      constraints: options.constraints,
    };
    this.shells.set(instance.shellId, tracked);

    // Set up exit tracking
    instance.waitForExit().then(() => {
      const entry = this.shells.get(instance.shellId);
      if (entry) {
        entry.exitTime = Date.now();
      }
    });

    return instance;
  }

  /**
   * Get a shell instance by ID.
   * @param shellId - The shell identifier
   * @returns The shell instance or undefined if not found
   */
  public get(shellId: string): ShellInstance | undefined {
    return this.shells.get(shellId)?.instance;
  }

  /**
   * Kill all running shells.
   */
  public async killAll(): Promise<void> {
    const killPromises: Promise<boolean>[] = [];

    for (const { instance } of this.shells.values()) {
      if (instance.getStatus() === 'running') {
        killPromises.push(instance.kill('SIGTERM'));
      }
    }

    await Promise.all(killPromises);
  }

  /**
   * Remove expired shells based on bufferRetentionMs.
   * Only removes shells that have exited and exceeded retention time.
   */
  public cleanup(): void {
    const now = Date.now();
    const toRemove: string[] = [];

    for (const [shellId, tracked] of this.shells) {
      const { instance, constraints, exitTime } = tracked;

      // Skip running shells
      if (instance.getStatus() === 'running') {
        continue;
      }

      // Check if retention period has passed
      if (exitTime !== undefined) {
        const age = now - exitTime;
        if (age > constraints.bufferRetentionMs) {
          toRemove.push(shellId);
        }
      }
    }

    // Remove expired shells
    for (const shellId of toRemove) {
      this.shells.delete(shellId);
    }
  }

  /**
   * Start the periodic cleanup timer.
   * @param intervalMs - Cleanup interval in ms (default: 60000 = 1 minute)
   */
  public startCleanupTimer(intervalMs = 60_000): void {
    this.stopCleanupTimer();
    this.cleanupTimer = setInterval(() => this.cleanup(), intervalMs);
    // Ensure timer doesn't prevent process exit
    this.cleanupTimer.unref();
  }

  /**
   * Stop the periodic cleanup timer.
   */
  public stopCleanupTimer(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }

  /**
   * Synchronously kill all running shells.
   * Used by process exit handlers.
   */
  public killAllSync(): void {
    for (const { instance } of this.shells.values()) {
      if (instance.getStatus() === 'running') {
        // Use process.kill directly for sync operation
        try {
          process.kill(instance.pid, 'SIGKILL');
        } catch {
          // Ignore errors - process may have already exited
        }
      }
    }
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  private getRunningCount(): number {
    let count = 0;
    for (const { instance } of this.shells.values()) {
      if (instance.getStatus() === 'running') {
        count++;
      }
    }
    return count;
  }
}
