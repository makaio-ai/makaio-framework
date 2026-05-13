/**
 * End-to-end integration tests for descriptor-backed extension CLI loading.
 *
 * Uses a real fixture extension to verify the full path from descriptor
 * discovery through command registration, arg parsing, module import, and
 * handler dispatch — without a running server.
 *
 * The fixture extension (`fixtures/test-extension`) exports a real
 * {@link CliContribution} with a `greet` subcommand that writes to stdout.
 * Bus interaction is provided via a minimal test double.
 */
import * as path from 'node:path';
import * as url from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import type { EmbeddedDescriptor } from '@makaio/contracts';
import { resolveConventionEntrypoint } from '@makaio/runtime-node';
import type { CliContribution } from '@makaio/kernel/cli';
import { createMockBus } from '@makaio/test-utils';
import { registerManifestCommand } from '../manifest-commands.js';
import type { ManifestCommandContext } from '../manifest-commands.js';

// ---------------------------------------------------------------------------
// Fixture paths
// ---------------------------------------------------------------------------

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.join(__dirname, 'fixtures', 'test-extension');

// ---------------------------------------------------------------------------
// Fixture descriptor (matches fixtures/test-extension/descriptor.json)
// ---------------------------------------------------------------------------

const fixtureDescriptor: EmbeddedDescriptor = {
  name: 'test-ext',
  displayName: 'Test Extension',
  version: '1.0.0',
  makaio: { framework: '>=0.1.0' },
  entrypoints: { cli: 'cli/index' },
  cli: {
    name: 'test-ext',
    description: 'A test extension',
    subcommands: [
      {
        name: 'greet',
        description: 'Say hello',
        // Args are derived from the live Zod schema at discovery time; this
        // copy mirrors what `enrichManifestFromLiveSchema` produces so unit
        // tests that drive `registerManifestCommand` directly (bypassing the
        // enrichment step) still wire up Commander with the correct args.
        args: [{ name: 'name', description: 'Who to greet', positional: true, required: true }],
      },
    ],
  },
};

/**
 * Resolve the fixture CLI module through the production convention resolver so
 * this test stays coupled to the descriptor contract rather than a hardcoded
 * development path.
 * @returns Absolute path to the fixture CLI entry module.
 */
function resolveFixtureCliEntry(): string {
  const cliEntrypoint = fixtureDescriptor.entrypoints.cli;
  if (!cliEntrypoint) {
    throw new Error('Fixture descriptor must declare a CLI entrypoint');
  }

  const resolved = resolveConventionEntrypoint('cli', cliEntrypoint, FIXTURE_ROOT);
  if (!resolved) {
    throw new Error('Fixture CLI entrypoint did not resolve');
  }
  return resolved;
}

const FIXTURE_CLI_ENTRY = resolveFixtureCliEntry();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Dynamically import the fixture contribution, matching the real import logic
 * used by {@link main}.
 * @param entryPath - Absolute path to the CLI entry module.
 * @returns The loaded {@link CliContribution}.
 */
async function importFixture(entryPath: string): Promise<CliContribution> {
  const mod = (await import(url.pathToFileURL(entryPath).href)) as { default?: CliContribution };
  const contribution = mod.default;
  if (!contribution) {
    throw new Error(`Module at ${entryPath} does not have a default export`);
  }
  return contribution;
}

/**
 * Return type for {@link makeFixtureCtx} that exposes the fresh bus mock so
 * individual tests can assert on it.
 */
interface FixtureCtx {
  ctx: ManifestCommandContext;
  stubBus: ReturnType<typeof createMockBus>['bus'];
}

/**
 * Create a {@link ManifestCommandContext} backed by the real fixture import
 * and a **fresh** bus mock. Each call produces an independent bus so that
 * `disconnect` assertions are not polluted by other tests.
 * @param hasInteractive - Whether to enable interactive mode.
 * @returns Context and the fresh bus mock for assertions.
 */
function makeFixtureCtx(hasInteractive = false): FixtureCtx {
  const { bus: stubBus } = createMockBus();
  return {
    ctx: {
      cliEntryPath: FIXTURE_CLI_ENTRY,
      bus: stubBus,
      hasInteractive,
      importModule: importFixture,
    },
    stubBus,
  };
}

/**
 * Create a fresh Commander program with `.exitOverride()` so Commander errors
 * throw instead of calling `process.exit`.
 */
function makeProgram(): InstanceType<typeof Command> {
  return new Command().exitOverride();
}

/**
 * Capture text written to `process.stdout.write` while running `fn`.
 * @param fn - Async function to execute while capturing stdout.
 * @returns Text written to stdout during execution.
 */
async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  });
  try {
    await fn();
  } finally {
    spy.mockRestore();
  }
  return chunks.join('');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('descriptor-backed extension e2e — handler dispatch', () => {
  let originalExitCode: number | undefined;

  beforeEach(() => {
    originalExitCode = process.exitCode as number | undefined;
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
  });

  it('greet subcommand writes greeting to stdout', async () => {
    const program = makeProgram();
    const { ctx } = makeFixtureCtx();
    registerManifestCommand(program, fixtureDescriptor.cli!, ctx);

    const output = await captureStdout(async () => {
      await program.parseAsync(['test-ext', 'greet', 'World'], { from: 'user' });
    });

    expect(output).toBe('Hello, World!\n');
  });

  it('greet subcommand does not disconnect bus (main owns teardown)', async () => {
    const { ctx, stubBus: localBus } = makeFixtureCtx();
    const program = makeProgram();
    registerManifestCommand(program, fixtureDescriptor.cli!, ctx);

    await captureStdout(async () => {
      await program.parseAsync(['test-ext', 'greet', 'World'], { from: 'user' });
    });

    expect(localBus.disconnect).not.toHaveBeenCalled();
  });

  it('greet subcommand without required name arg → Commander validation error', async () => {
    const program = makeProgram();
    const { ctx } = makeFixtureCtx();
    registerManifestCommand(program, fixtureDescriptor.cli!, ctx);

    // Commander throws a CommanderError when a required positional arg is missing.
    await expect(program.parseAsync(['test-ext', 'greet'], { from: 'user' })).rejects.toThrow();
  });
});
