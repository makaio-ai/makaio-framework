import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { stagePackageForNpmPublish } from '../../scripts/lib/npm-publish-staging.js';
import { CALL_CONTEXT_PROGRAMS } from './call-context-declarations.fixture.js';
import {
  INSTALLED_PACKAGE_CONSUMER_INSTALL_ARGUMENTS,
  prepareInstalledPackageConsumer,
  runInstalledPackageSetupStage,
} from './installed-package-consumer.fixture.js';

const execFileAsync = promisify(execFile);
const requireFromHere = createRequire(import.meta.url);

const CONTRACTS_BUILD_TIMEOUT_MS = 270_000;
const PACK_TIMEOUT_MS = 60_000;
const INSTALL_TIMEOUT_MS = 120_000;
const COMPILE_TIMEOUT_MS = 180_000;
const RUNTIME_TIMEOUT_MS = 60_000;
const SETUP_OPERATIONS_TIMEOUT_MS = CONTRACTS_BUILD_TIMEOUT_MS + PACK_TIMEOUT_MS + 2 * INSTALL_TIMEOUT_MS;
const SETUP_TIMEOUT_MS = SETUP_OPERATIONS_TIMEOUT_MS + 5_000;

const CONTRACTS_PACKAGE_ROOT = resolve(import.meta.dirname, '../../core/contracts');
const FRAMEWORK_MANIFEST = resolve(import.meta.dirname, 'package.json');

/** Result of one `tsc -p` run in the consumer. */
interface CompileResult {
  readonly exitCode: number;
  readonly output: string;
}

/** What the runtime program of the consumer reports. */
interface RuntimeReport {
  readonly mintedIsMinted: boolean;
  readonly spreadCopyIsMinted: boolean;
  readonly literalIsMinted: boolean;
  readonly handlerCallerKind: string;
  readonly handlerCallerId: string;
  readonly handlerPrincipal: { readonly kind: string; readonly id: string };
  readonly foreignOwnRejected: boolean;
  readonly claimWriteThrew: boolean;
  readonly claimAfterWrite: number;
}

/**
 * Runtime program: mints through the kernel entry and reads through the public entry,
 * sends through a carrier-bound bus and tries the forbidden moves.
 */
const RUNTIME_PROGRAM = String.raw`
import { writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { createBusInstance, ForeignOwnContextError, isMintedCallContext } from '@makaio/framework/bus';
import { createCarrierBus, mintCallContext } from '@makaio/framework/bus/kernel-api';
import { createBusNamespace } from '@makaio/framework/core';

const person = { kind: 'acme.person', id: 'person-1' };
const carrierA = { kind: 'makaio.extension', id: 'consumer-a' };
const carrierB = { kind: 'makaio.extension', id: 'consumer-b' };

const minted = mintCallContext({ caller: person, principal: person });
const literal = { caller: person, principal: person };

const host = createBusInstance();
const namespace = host.registerNamespace(
  createBusNamespace('call-context-runtime', {
    ping: { request: z.object({ id: z.string() }), response: z.object({ ok: z.boolean() }) },
  }),
);
const seen = [];
host.on(namespace.subjects.ping, (ctx) => {
  seen.push(ctx.call);
  ctx.setResult({ ok: true });
});

const busA = createCarrierBus(host, carrierA);
const busB = createCarrierBus(host, carrierB);
await busA.request(minted, namespace.subjects.ping, { id: 'a' });

let foreignOwnRejected = false;
try {
  await busA.request(busB.own('start'), namespace.subjects.ping, { id: 'b' });
} catch (error) {
  foreignOwnRejected = error instanceof ForeignOwnContextError;
}

const withClaims = mintCallContext({
  caller: { kind: 'acme.person', id: 'person-2', claims: { level: 1 } },
  principal: person,
});
let claimWriteThrew = false;
try {
  withClaims.caller.claims.level = 2;
} catch {
  claimWriteThrew = true;
}

await writeFile(
  'result.json',
  JSON.stringify({
    mintedIsMinted: isMintedCallContext(minted),
    spreadCopyIsMinted: isMintedCallContext({ ...minted }),
    literalIsMinted: isMintedCallContext(literal),
    handlerCallerKind: seen[0].caller.kind,
    handlerCallerId: seen[0].caller.id,
    handlerPrincipal: { kind: seen[0].principal.kind, id: seen[0].principal.id },
    foreignOwnRejected,
    claimWriteThrew,
    claimAfterWrite: withClaims.caller.claims.level,
  }),
);
`;

let temporaryRoot: string | undefined;
let consumerRoot: string;
let compilerEntry: string;
let runtimeReport: RuntimeReport;

/**
 * Build the contracts package of this commit, stage it for publishing and pack it.
 * @param packRoot - Directory that receives the tarball.
 * @param version - Version of the framework, used for the staged manifest and the peer range.
 * @param signal - Deadline shared by the bounded child processes.
 * @returns Absolute path of the contracts tarball.
 */
async function packContractsTarball(packRoot: string, version: string, signal: AbortSignal): Promise<string> {
  await runInstalledPackageSetupStage('build', () =>
    execFileAsync(process.execPath, ['--max-old-space-size=8192', '--import', 'tsx', 'build.ts'], {
      cwd: CONTRACTS_PACKAGE_ROOT,
      timeout: CONTRACTS_BUILD_TIMEOUT_MS,
      signal,
      maxBuffer: 10 * 1024 * 1024,
    }),
  );
  const publishDirectory = stagePackageForNpmPublish(CONTRACTS_PACKAGE_ROOT, version, {
    '@makaio/framework': version,
    '@makaio/contracts': version,
  });
  const { stdout } = await runInstalledPackageSetupStage('pack', () =>
    execFileAsync('npm', ['pack', '--pack-destination', packRoot], {
      cwd: publishDirectory,
      timeout: PACK_TIMEOUT_MS,
      signal,
    }),
  );
  return join(packRoot, stdout.trim());
}

/**
 * Read the version of the framework package.
 * @returns The version string of the manifest.
 */
async function readFrameworkVersion(): Promise<string> {
  const manifest: unknown = JSON.parse(await readFile(FRAMEWORK_MANIFEST, 'utf8'));
  if (typeof manifest !== 'object' || manifest === null || !('version' in manifest)) {
    throw new Error('The framework manifest has no version');
  }
  if (typeof manifest.version !== 'string') throw new Error('The framework version is not a string');
  return manifest.version;
}

/**
 * Prepare the consumer: both tarballs installed in ONE npm call, programs written, runtime run.
 * @param root - Temporary directory owned by this suite.
 * @param signal - Deadline shared by setup's bounded child processes.
 */
async function prepareConsumer(root: string, signal: AbortSignal): Promise<void> {
  const frameworkTarball = inject('installedFrameworkTarball');
  const packRoot = join(root, 'contracts-pack');
  await mkdir(packRoot);
  const contractsTarball = await packContractsTarball(packRoot, await readFrameworkVersion(), signal);
  const installed = await prepareInstalledPackageConsumer({
    root,
    consumerName: 'call-context-declarations-consumer',
    tarball: frameworkTarball,
    signal,
    installTimeoutMs: INSTALL_TIMEOUT_MS,
  });
  consumerRoot = installed.consumerRoot;
  // One call with both tarballs: a `--no-save` call naming only the second could prune the first.
  await runInstalledPackageSetupStage('install', () =>
    execFileAsync('npm', [...INSTALLED_PACKAGE_CONSUMER_INSTALL_ARGUMENTS, frameworkTarball, contractsTarball], {
      cwd: consumerRoot,
      timeout: INSTALL_TIMEOUT_MS,
      signal,
    }),
  );
  compilerEntry = join(resolve(requireFromHere.resolve('typescript/package.json'), '..'), 'bin', 'tsc');
  await Promise.all([
    ...Object.entries(CALL_CONTEXT_PROGRAMS).flatMap(([name, program]) => [
      writeFile(join(consumerRoot, name), program),
      writeFile(
        join(consumerRoot, `tsconfig.${name}.json`),
        JSON.stringify({
          compilerOptions: {
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            noEmit: true,
            strict: true,
            skipLibCheck: true,
          },
          files: [name],
        }),
      ),
    ]),
    writeFile(join(consumerRoot, 'runtime.mjs'), RUNTIME_PROGRAM),
  ]);
  await execFileAsync(process.execPath, ['runtime.mjs'], {
    cwd: consumerRoot,
    timeout: RUNTIME_TIMEOUT_MS,
    signal,
  });
  runtimeReport = JSON.parse(await readFile(join(consumerRoot, 'result.json'), 'utf8'));
}

/**
 * Compile one program in the consumer.
 * @param name - File name of the program in the consumer.
 * @returns Exit code and the compiler's diagnostics.
 */
async function compileProgram(name: string): Promise<CompileResult> {
  try {
    const { stdout } = await execFileAsync(process.execPath, [compilerEntry, '-p', `tsconfig.${name}.json`], {
      cwd: consumerRoot,
      timeout: COMPILE_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { exitCode: 0, output: stdout };
  } catch (error) {
    if (error instanceof Error && 'code' in error && typeof error.code === 'number') {
      const stdout = 'stdout' in error && typeof error.stdout === 'string' ? error.stdout : '';
      return { exitCode: error.code, output: stdout };
    }
    throw error;
  }
}

describe('call context declarations of the installed packages', () => {
  beforeAll(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'call-context-declarations-'));
    await prepareConsumer(temporaryRoot, AbortSignal.timeout(SETUP_OPERATIONS_TIMEOUT_MS));
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  });

  it('installs the contracts package next to the framework package', async () => {
    const installed = await readdir(join(consumerRoot, 'node_modules', '@makaio'));
    expect(installed.sort()).toEqual(['contracts', 'framework']);
  });

  // An unused `@ts-expect-error` is TS2578, so exit 0 proves that every rejected line is rejected.
  it.each(Object.keys(CALL_CONTEXT_PROGRAMS))(
    'compiles %s: accepted lines pass and every rejected line is rejected',
    async (name) => {
      const result = await compileProgram(name);
      expect(result.output).toBe('');
      expect(result.exitCode).toBe(0);
    },
    COMPILE_TIMEOUT_MS + 5_000,
  );

  it('shares one stamp registry between the kernel entry and the public entry', () => {
    expect(runtimeReport.mintedIsMinted).toBe(true);
    expect(runtimeReport.spreadCopyIsMinted).toBe(false);
    expect(runtimeReport.literalIsMinted).toBe(false);
  });

  it('shows the handler the carrier as caller and the principal of the passed call', () => {
    expect(runtimeReport.handlerCallerKind).toBe('makaio.extension');
    expect(runtimeReport.handlerCallerId).toBe('consumer-a');
    expect(runtimeReport.handlerPrincipal).toEqual({ kind: 'acme.person', id: 'person-1' });
  });

  it('rejects the own context of another carrier', () => {
    expect(runtimeReport.foreignOwnRejected).toBe(true);
  });

  it('does not let a write to claims change the context', () => {
    expect(runtimeReport.claimWriteThrew).toBe(true);
    expect(runtimeReport.claimAfterWrite).toBe(1);
  });
});
