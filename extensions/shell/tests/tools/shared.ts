/**
 * Shared test utilities for shell tool tests.
 *
 * Provides common setup/teardown with bus-backed service initialization
 * used across all shell tool test files.
 */

import { beforeEach, afterEach, expect } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { ToolRegistry } from '@makaio/services-core/tools';
import { ShellManager } from '../../src/manager/shell-manager.js';
import { ShellInstance } from '../../src/manager/shell-instance.js';
import { ShellService } from '../../src/shell-service.js';
import { shellToolset } from '../../src/toolset.js';
import { DEFAULT_CONSTRAINTS } from '../../src/types.js';
import type { CreateShellOptions } from '../../src/manager/shell-manager.js';

/**
 * Context returned by {@link setupShellToolTest} for tests that need
 * instance-level tracking (kill, send, grep).
 */
export interface ShellToolTestContext {
  manager: ShellManager;
  service: ShellService;
  registry: ToolRegistry;
  /** Mutable ref - set by tests; afterEach will clean it up. */
  instance: ShellInstance | undefined;
}

type ShellConstraintsContext = {
  shell: typeof DEFAULT_CONSTRAINTS;
};

/**
 * Context for shell tool tests using the exec/output/status pattern.
 *
 * These tools create shells through the tool API, so afterEach only
 * needs to destroy the service.
 */
export interface ShellManagerTestContext {
  manager: ShellManager;
  service: ShellService;
  registry: ToolRegistry;
  constraints: ShellConstraintsContext;
}

/**
 * Create default shell creation options for tests.
 * @returns Fresh shell creation options.
 */
export function createDefaultCreateOptions(): CreateShellOptions {
  return {
    command: 'echo "test"',
    cwd: process.cwd(),
    env: {},
    platform: 'posix',
    colors: false,
    constraints: { ...DEFAULT_CONSTRAINTS },
  };
}

/**
 * Register beforeEach/afterEach for shell tool tests that manage individual instances.
 *
 * The returned object exposes a `manager`, `service`, `registry`, and a mutable `instance` ref.
 * Tests assign `ctx.instance` after creation; afterEach cleans it up.
 * @returns Shared test context
 */
export function setupShellToolTest(): ShellToolTestContext {
  const ctx: ShellToolTestContext = {
    manager: undefined!,
    service: undefined!,
    registry: undefined!,
    instance: undefined,
  };

  beforeEach(async () => {
    MakaioBus.__resetHandlers?.();
    ctx.manager = new ShellManager();
    ctx.service = new ShellService(MakaioBus, ctx.manager);
    await ctx.service.init();
    ctx.registry = new ToolRegistry({ bus: MakaioBus });
    await ctx.registry.register(shellToolset);
    ctx.instance = undefined;
  });

  afterEach(async () => {
    if (ctx.instance) {
      const instance = ctx.instance;
      ctx.instance = undefined;
      await ignoreTeardownError(() => instance.kill('SIGKILL'));
      await ignoreTeardownError(() => instance.waitForExit());
    }
    await ignoreTeardownError(() => ctx.service.destroy());
    await ignoreTeardownError(() => ctx.registry.deregister('shell'));
    MakaioBus.__resetHandlers?.();
  });

  return ctx;
}

/**
 * Resolve a shell instance that must exist for the current test scenario.
 * @param manager - Shell manager owning the instance.
 * @param shellId - Shell ID returned by `shell_exec`.
 * @returns The resolved shell instance.
 */
export function getRequiredShellInstance(manager: ShellManager, shellId: string): ShellInstance {
  const instance = manager.get(shellId);
  expect(instance).toBeDefined();
  if (!instance) {
    throw new Error(`Expected shell instance '${shellId}' to exist`);
  }
  return instance;
}

/**
 * Register beforeEach/afterEach for shell tool tests using manager-level cleanup.
 * @returns Shared test context
 */
export function setupShellManagerTest(): ShellManagerTestContext {
  const ctx: ShellManagerTestContext = {
    manager: undefined!,
    service: undefined!,
    registry: undefined!,
    constraints: createConstraints(),
  };

  beforeEach(async () => {
    MakaioBus.__resetHandlers?.();
    ctx.manager = new ShellManager();
    ctx.service = new ShellService(MakaioBus, ctx.manager);
    await ctx.service.init();
    ctx.registry = new ToolRegistry({ bus: MakaioBus });
    await ctx.registry.register(shellToolset);
    ctx.constraints = createConstraints();
  });

  afterEach(async () => {
    await ignoreTeardownError(() => ctx.service.destroy());
    await ignoreTeardownError(() => ctx.registry.deregister('shell'));
    MakaioBus.__resetHandlers?.();
  });

  return ctx;
}

/**
 * Run one teardown step without masking the original test failure.
 * @param action - Teardown action to run.
 * @returns A promise that resolves after the action succeeds or fails.
 */
async function ignoreTeardownError(action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch {
    // Best-effort teardown keeps the original setup/test failure visible.
  }
}

/**
 * Create fresh shell constraints context for a test.
 * @returns Constraint context payload.
 */
function createConstraints(): ShellConstraintsContext {
  return {
    shell: { ...DEFAULT_CONSTRAINTS },
  };
}
