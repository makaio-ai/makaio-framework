/**
 * Shared test utilities for shell tool tests.
 *
 * Provides common setup/teardown, default options, and mock context
 * used across all shell tool test files.
 */

import { beforeEach, afterEach } from 'vitest';
import { ShellManager, type CreateShellOptions } from '../../src/manager/shell-manager.js';
import { ShellInstance } from '../../src/manager/shell-instance.js';
import { DEFAULT_CONSTRAINTS } from '../../src/types.js';
import type { MakaioContext } from '@makaio/core';

/**
 * Default shell creation options for tests.
 */
export const defaultCreateOptions: CreateShellOptions = {
  command: 'echo "test"',
  cwd: process.cwd(),
  env: {},
  platform: 'posix',
  colors: false,
  constraints: DEFAULT_CONSTRAINTS,
};

/**
 * Mock MakaioContext for tool execution.
 */
export const mockContext: MakaioContext = {
  cwd: process.cwd(),
  env: {},
  platform: 'posix',
};

/**
 * Context returned by {@link setupShellToolTest} for tests that need
 * instance-level tracking (kill, send, grep).
 */
export interface ShellToolTestContext {
  manager: ShellManager;
  /** Mutable ref - set by tests; afterEach will clean it up. */
  instance: ShellInstance | undefined;
}

/**
 * Register beforeEach/afterEach for shell tool tests that manage individual instances.
 *
 * The returned object exposes a `manager` and a mutable `instance` ref.
 * Tests assign `ctx.instance` after creation; afterEach cleans it up.
 * @param initTool - Callback receiving the manager; return value is available as `ctx.tool`.
 * @returns Shared test context
 */
export function setupShellToolTest<T>(initTool: (manager: ShellManager) => T): ShellToolTestContext & { tool: T } {
  const ctx: ShellToolTestContext & { tool: T } = {
    manager: undefined!,
    instance: undefined,
    tool: undefined!,
  };

  beforeEach(() => {
    ctx.manager = new ShellManager();
    ctx.tool = initTool(ctx.manager);
    ctx.instance = undefined;
  });

  afterEach(async () => {
    if (ctx.instance) {
      try {
        await ctx.instance.kill('SIGKILL');
        await ctx.instance.waitForExit();
      } catch {
        // Ignore errors during cleanup
      }
      ctx.instance = undefined;
    }
    await ctx.manager.killAll();
  });

  return ctx;
}

/**
 * Context for shell tool tests using the exec/output/status pattern.
 *
 * These tools create shells through the tool API, so afterEach only
 * needs to call killAll + stopCleanupTimer on the manager.
 */
export interface ShellManagerTestContext {
  manager: ShellManager;
  context: MakaioContext;
}

/**
 * Register beforeEach/afterEach for shell tool tests using manager-level cleanup.
 * @param initTool - Callback receiving the manager; return value is available as `ctx.tool`.
 * @returns Shared test context
 */
export function setupShellManagerTest<T>(
  initTool: (manager: ShellManager) => T,
): ShellManagerTestContext & { tool: T } {
  const ctx: ShellManagerTestContext & { tool: T } = {
    manager: undefined!,
    context: {
      cwd: process.cwd(),
      env: {},
      platform: 'posix',
      constraints: {
        shell: DEFAULT_CONSTRAINTS,
      },
    },
    tool: undefined!,
  };

  beforeEach(() => {
    ctx.manager = new ShellManager();
    ctx.tool = initTool(ctx.manager);
  });

  afterEach(async () => {
    ctx.manager.stopCleanupTimer();
    await ctx.manager.killAll();
  });

  return ctx;
}
