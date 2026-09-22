/**
 * Resolve `critical` from a server entrypoint's exported executable package.
 *
 * A descriptor that declares a server entrypoint may not declare `critical`
 * itself (`ExtensionDescriptorSchema` rejects the combination) — the
 * executable packages the entrypoint exports each own that flag instead (see
 * `ExtensionManifest.critical` in `@makaio/contracts`). The offline listing
 * producers in this package (`YarnPackageManager.listPackages` and the
 * local-path branch of `PackageManagerService`'s list handler) must read
 * `critical` from there to report the same fact the runtime would act on.
 *
 * The import worker below mirrors the exact same identity/structural contract
 * `normalizeExtensionManifestExport` / `isExtensionManifestLike`
 * (`@makaio/contracts`) enforce — the same contract `@makaio/runtime-node`'s
 * `normalizePackageExport` / `isMakaioExtensionLike` apply when loading
 * extensions at boot — so a server entry's exported package is only ever
 * treated as authoritative for `critical` when it would also be accepted by
 * the runtime loader. This package cannot import `@makaio/runtime-node`
 * directly (`@makaio/runtime-node` depends on this package,
 * `@makaio/services-package-manager`, to drive extension installs, so the
 * reverse import would form a cycle), and the worker text below cannot import
 * even the cycle-free `@makaio/contracts` helper — see the doc comment on
 * {@link IMPORT_WORKER_SOURCE} for why the validation is duplicated as plain
 * JavaScript there instead of imported.
 * @packageDocumentation
 */
import * as fs from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import type { PackageInfo } from './schemas.js';

/**
 * Validate that an exported package's `critical` field is either absent or a
 * genuine `boolean`.
 *
 * The worker that matches the exported package only checks its `name`, so a
 * malformed export (e.g. `critical: 'yes'`) still reaches this point and
 * would otherwise flow straight into `PackageInfoSchema`, whose `critical`
 * field is `z.boolean().optional()` — under strict bus validation, one such
 * extension would reject the entire `packages.list` response instead of just
 * its own entry.
 * @param value - Candidate `critical` value read off an exported package.
 * @returns Whether `value` is safe to report as `critical`.
 */
function isValidExportedCriticalFlag(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === 'boolean';
}

/** Milliseconds to wait for the import worker before treating it as hung and reporting criticality unknown. */
const IMPORT_WORKER_TIMEOUT_MS = 10_000;

/**
 * Source for the worker that performs the actual module import.
 *
 * Executed via `new Worker(IMPORT_WORKER_SOURCE, { eval: true })` — a worker
 * thread owns its own ESM module registry (Node keys import caches per
 * `vm.Context`, and each worker thread gets a fresh one), so it is plain
 * JavaScript text rather than a TypeScript file compiled alongside this
 * module: no bundling/build-output path resolution is needed for it to run
 * standalone inside the worker.
 *
 * It mirrors the full identity/structural contract `normalizeExtensionManifestExport`
 * (`@makaio/contracts`, also consumed by `@makaio/runtime-node`'s
 * `normalizePackageExport`) enforces on a server entry's default export: every
 * array entry must carry `name`/`displayName`/`version`, array entries must be
 * uniquely named, every array entry must stay within the descriptor's
 * namespace (the descriptor name itself or a `${descriptorName}.` prefix), and
 * a single-object export's `name` must equal the descriptor name. This text
 * cannot import `normalizeExtensionManifestExport` itself: the exported
 * package this worker inspects may carry non-cloneable values (functions,
 * class instances) that cannot cross back to the main thread via
 * `postMessage`'s structured clone, so the validation has to run here, inside
 * the worker, against the live import result — and a bare `@makaio/contracts`
 * specifier is not reliably resolvable from `eval: true` worker text across
 * this repo's execution modes (dev/test resolve workspace packages to `.ts`
 * sources via a bundler-only `exports` condition that plain Node cannot load;
 * only a built `dist` output would resolve, and that is not guaranteed to
 * exist while running from source). The two implementations are paired by
 * dedicated tests in `__tests__/exported-package-critical.test.ts` asserting
 * worker behavior for the same invalid-shape, duplicate-name, and
 * out-of-namespace cases `load-extensions.test.ts` asserts for
 * `normalizePackageExport`. It hands only the matched package's raw `critical`
 * value back to the main thread, which still applies
 * {@link isValidExportedCriticalFlag} — the boolean-shape check is
 * deliberately not duplicated in worker text.
 *
 * When `workerData.frameworkDistPath` is set (a packaged Electron host —
 * see {@link importOwnPackageViaWorker}'s `frameworkDistPath` parameter),
 * the worker registers a `node:module` resolve hook mirroring
 * `resolveFrameworkSpecifier`/`NodeFrameworkModuleResolver.install`
 * (`@makaio/runtime-node`, `framework-module-resolver.ts`) before importing
 * the target module. A locally-linked extension's server graph frequently
 * imports `@makaio/framework/*` subpaths; `NodeFrameworkModuleResolver`
 * installs the hook that resolves them, but only on the main thread — this
 * worker owns a separate loader context (see this function's own TSDoc for
 * why a fresh worker, not a cache-busted same-thread `import()`, is
 * required), so without its own hook such an import would reject and the
 * package would report criticality unknown even though the main thread can
 * import it fine. This cannot import `NodeFrameworkModuleResolver` itself —
 * the same cycle/bundler-condition constraint documented above for
 * `@makaio/contracts` applies identically to `@makaio/runtime-node` — so the
 * resolve hook is mirrored here instead. Kept intentionally small: only the
 * pure specifier-to-path mapping is duplicated, not the class wrapper, and
 * `framework-module-resolver.test.ts` and
 * `__tests__/exported-package-critical.test.ts` are paired the same way the
 * export-shape validation above already is.
 */
const IMPORT_WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  try {
    if (workerData.frameworkDistPath) {
      const nodeModule = require('node:module');
      if (typeof nodeModule.registerHooks === 'function') {
        const path = require('node:path');
        const fs = require('node:fs');
        const { pathToFileURL: toFileUrl } = require('node:url');
        const frameworkDistPath = workerData.frameworkDistPath;

        const readFrameworkPackageExports = () => {
          const packageJsonPath = path.join(frameworkDistPath, '..', 'package.json');
          const parsed = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
          const exportsField = parsed.exports;
          const normalized = {};
          if (exportsField && typeof exportsField === 'object' && !Array.isArray(exportsField)) {
            for (const key of Object.keys(exportsField)) {
              if (!key.startsWith('.')) continue;
              const value = exportsField[key];
              if (typeof value === 'string' || (value && typeof value === 'object' && !Array.isArray(value))) {
                normalized[key] = value;
              }
            }
          }
          return normalized;
        };

        const resolveRuntimeExportTarget = (value) => {
          if (typeof value === 'string') return value;
          if (!value) return undefined;
          for (const condition of ['default', 'import', 'require']) {
            const target = value[condition];
            if (typeof target === 'string') return target;
          }
          return undefined;
        };

        const isPathWithinDirectory = (candidate, directory) => {
          const relative = path.relative(directory, candidate);
          return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
        };

        const packageExports = readFrameworkPackageExports();
        nodeModule.registerHooks({
          resolve(specifier, context, nextResolve) {
            const prefix = '@makaio/framework/';
            if (specifier.startsWith(prefix)) {
              const subpath = specifier.slice(prefix.length);
              const segments = subpath.split('/');
              const segmentsValid =
                segments.length > 0 &&
                segments.every(
                  (segment) => segment.length > 0 && segment !== '.' && segment !== '..' && !segment.includes('\\\\'),
                );
              if (segmentsValid) {
                const exportTarget = resolveRuntimeExportTarget(packageExports['./' + subpath]);
                if (exportTarget) {
                  const normalizedTarget = exportTarget.split('\\\\').join('/');
                  const distPrefix = './dist/';
                  if (normalizedTarget.startsWith(distPrefix)) {
                    const distRelativeTarget = normalizedTarget.slice(distPrefix.length);
                    const resolved = path.resolve(frameworkDistPath, distRelativeTarget);
                    if (isPathWithinDirectory(resolved, frameworkDistPath)) {
                      return { shortCircuit: true, url: toFileUrl(resolved).href };
                    }
                  }
                }
              }
            }
            return nextResolve(specifier, context);
          },
        });
      }
    }

    const mod = await import(workerData.moduleUrl);
    const exported = mod.default;
    const descriptorName = workerData.descriptorName;

    const isExtensionManifestLike = (value) =>
      typeof value === 'object' &&
      value !== null &&
      typeof value.name === 'string' &&
      typeof value.displayName === 'string' &&
      typeof value.version === 'string';

    let packages;
    if (Array.isArray(exported)) {
      const seenNames = new Set();
      packages = [];
      for (const item of exported) {
        if (!isExtensionManifestLike(item)) {
          parentPort.postMessage({
            kind: 'invalid',
            reason: 'default export array contains an invalid MakaioExtension, skipping',
          });
          return;
        }
        if (seenNames.has(item.name)) {
          parentPort.postMessage({
            kind: 'invalid',
            reason: "default export array contains duplicate package name '" + item.name + "', skipping",
          });
          return;
        }
        seenNames.add(item.name);
        packages.push(item);
      }

      if (!packages.some((pkg) => pkg.name === descriptorName)) {
        parentPort.postMessage({ kind: 'no-match' });
        return;
      }

      if (packages.some((pkg) => pkg.name !== descriptorName && !pkg.name.startsWith(descriptorName + '.'))) {
        parentPort.postMessage({
          kind: 'invalid',
          reason:
            "default export array contains package names outside descriptor namespace '" + descriptorName + "', skipping",
        });
        return;
      }
    } else {
      if (!isExtensionManifestLike(exported)) {
        parentPort.postMessage({
          kind: 'invalid',
          reason: 'default export is not a valid MakaioExtension or MakaioExtension[], skipping',
        });
        return;
      }
      if (exported.name !== descriptorName) {
        parentPort.postMessage({ kind: 'no-match' });
        return;
      }
      packages = [exported];
    }

    const ownPackage = packages.find((item) => item.name === descriptorName);
    parentPort.postMessage({ kind: 'match', critical: ownPackage.critical });
  } catch (error) {
    parentPort.postMessage({
      kind: 'worker-error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
})();
`;

/** Message an import worker posts back after inspecting a server entry's default export. */
type WorkerResultMessage =
  | { readonly kind: 'match'; readonly critical: unknown }
  | { readonly kind: 'no-match' }
  | { readonly kind: 'invalid'; readonly reason: string }
  | { readonly kind: 'worker-error'; readonly message: string };

/**
 * Structural check for a message received from the import worker.
 * @param value - Value received via the worker's `message` event.
 * @returns Whether `value` matches the {@link WorkerResultMessage} contract.
 */
function isWorkerResultMessage(value: unknown): value is WorkerResultMessage {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const kind = record['kind'];
  if (kind === 'match' || kind === 'no-match' || kind === 'worker-error') {
    return true;
  }
  return kind === 'invalid' && typeof record['reason'] === 'string';
}

/**
 * Import a server entrypoint inside an isolated `worker_threads.Worker` and
 * report the exported package matching `descriptorName`.
 *
 * A worker thread's module registry is entirely separate from this process's
 * — importing the same file URL inside a fresh worker always re-evaluates
 * that file and everything it imports/re-exports, which is what a reinstall
 * check needs. The registry is torn down with the worker once the message
 * (or an error/timeout) settles this promise.
 * @param serverImportPath - Absolute, already-resolved import path for the
 *   descriptor's server entrypoint.
 * @param descriptorName - Descriptor package name the exported package must
 *   match.
 * @param label - Log prefix identifying the caller and extension for warnings.
 * @param frameworkDistPath - Absolute path to the assembled `@makaio/framework`
 *   dist, when the host uses `NodeFrameworkModuleResolver` (see
 *   `FrameworkModuleResolver.frameworkDistPath` in `@makaio/runtime-node`).
 *   Passed through to the worker so it can resolve `@makaio/framework/*`
 *   subpath imports in its own module registry — see
 *   {@link IMPORT_WORKER_SOURCE}'s TSDoc. `undefined` for hosts that resolve
 *   `@makaio/framework/*` natively (dev workspace, Bun) or do not need it.
 * @returns The worker's result message, or `undefined` when the worker
 *   errored or timed out (already logged by this function).
 */
async function importOwnPackageViaWorker(
  serverImportPath: string,
  descriptorName: string,
  label: string,
  frameworkDistPath: string | undefined,
): Promise<WorkerResultMessage | undefined> {
  const moduleUrl = pathToFileURL(serverImportPath).href;

  return new Promise((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(IMPORT_WORKER_SOURCE, {
        eval: true,
        workerData: { moduleUrl, descriptorName, frameworkDistPath },
      });
    } catch (error) {
      // `new Worker()` can throw synchronously (e.g. thread creation refused
      // under a resource limit) before any handler below is installed. Left
      // uncaught, this executor's throw would make the JS engine reject this
      // promise on its own — the caller never gets a chance to distinguish
      // that from any other rejection, and an unhandled one would abort the
      // whole `packages.list` call for every other extension being resolved
      // alongside this one. Catching here instead keeps the failure on the
      // same "warn and report undefined" path as the 'error' event below.
      console.warn(
        `${label}: failed to import server entry while resolving critical flag:`,
        error instanceof Error ? error.message : error,
      );
      resolve(undefined);
      return;
    }

    let settled = false;
    const settle = (result: WorkerResultMessage | undefined): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      worker.removeAllListeners();
      void worker.terminate();
      resolve(result);
    };

    const timer = setTimeout(() => {
      console.warn(`${label}: timed out importing server entry while resolving critical flag`);
      settle(undefined);
    }, IMPORT_WORKER_TIMEOUT_MS);

    worker.once('message', (message: unknown) => {
      if (!isWorkerResultMessage(message)) {
        console.warn(`${label}: server entry import worker returned an unexpected message shape`);
        settle(undefined);
        return;
      }
      settle(message);
    });

    worker.once('error', (error) => {
      console.warn(
        `${label}: failed to import server entry while resolving critical flag:`,
        error instanceof Error ? error.message : error,
      );
      settle(undefined);
    });

    // Guards against a worker that exits (e.g. a `process.exit()` call
    // inside imported top-level code, which the server-module contract
    // forbids but a broken extension could still do) without posting a
    // message or emitting 'error' — without this, such an exit would only
    // resolve once the timeout elapses.
    worker.once('exit', (code) => {
      if (code !== 0) {
        console.warn(`${label}: server entry import worker exited unexpectedly with code ${code}`);
      }
      settle(undefined);
    });
  });
}

/**
 * Import a resolved server entrypoint inside an isolated worker and read the
 * `critical` flag off the exported package whose name matches the descriptor
 * identity.
 *
 * The import executes the module's top-level code; the extension server-
 * module contract (see `docs/architecture/extensions/index.md`) requires
 * that top level to contain only declarations, with side effects deferred to
 * `create()`/`init()`, which this function never calls — so this never starts
 * a service. Import failures and shape violations are logged and resolve to
 * `undefined` rather than inventing `false`, so a broken export is reported
 * as "criticality unknown" instead of silently downgrading a critical
 * extension to optional.
 *
 * The import runs inside a `worker_threads.Worker` ({@link importOwnPackageViaWorker})
 * rather than a cache-busted `import()` on this thread: this process (a
 * long-lived server, not the short-lived CLI) can call this function again
 * for the same `serverImportPath` after an extension is reinstalled in place
 * — an update that bumps the file's content but not necessarily its path —
 * and Node's ESM loader caches modules by resolved URL, so importing the
 * same URL again on this thread would keep resolving to the pre-update
 * module. A query-string-busted URL only defeats that cache for the
 * entrypoint file itself: if the entrypoint re-exports its package object
 * from another file, Node resolves that dependency under its own unbusted
 * file URL and still returns the stale, process-cached copy of it. A fresh
 * worker thread instead gets an entirely separate module registry, so
 * re-importing the same file URL inside it always re-evaluates that file and
 * everything it imports/re-exports — the whole module graph is current, not
 * just the entrypoint. The cost is one worker spawn per server-backed
 * extension per `packages.list` call; accepted because that call is an
 * infrequent, interactive flow (settings/CLI), not a hot path — and unlike
 * the cache-busting approach, the worker's module registry is reclaimed with
 * it when it terminates instead of accumulating in this process.
 * @param serverImportPath - Absolute, already-resolved import path for the
 *   descriptor's server entrypoint.
 * @param descriptorName - Descriptor package name the exported package must
 *   match.
 * @param label - Log prefix identifying the caller and extension for warnings.
 * @param frameworkDistPath - Forwarded to {@link importOwnPackageViaWorker} —
 *   see its `frameworkDistPath` parameter.
 * @returns The matching exported package's `critical` flag, or `undefined`
 *   when the entrypoint does not exist, the import failed or timed out,
 *   contains no matching package, or declares a non-boolean `critical` value.
 */
export async function resolveExportedPackageCritical(
  serverImportPath: string,
  descriptorName: string,
  label: string,
  frameworkDistPath?: string,
): Promise<boolean | undefined> {
  try {
    // Existence check up front: fails fast with the same warning shape an
    // import failure would produce, without paying for a worker spawn.
    await fs.access(serverImportPath);
  } catch (error) {
    console.warn(
      `${label}: failed to import server entry while resolving critical flag:`,
      error instanceof Error ? error.message : error,
    );
    return undefined;
  }

  const result = await importOwnPackageViaWorker(serverImportPath, descriptorName, label, frameworkDistPath);
  if (result === undefined) {
    // Worker already logged its own error/timeout warning.
    return undefined;
  }

  if (result.kind === 'worker-error') {
    console.warn(`${label}: failed to import server entry while resolving critical flag:`, result.message);
    return undefined;
  }

  if (result.kind === 'no-match') {
    console.warn(`${label}: server entry export does not include a package named '${descriptorName}'`);
    return undefined;
  }

  if (result.kind === 'invalid') {
    console.warn(`${label}: ${result.reason}`);
    return undefined;
  }

  if (!isValidExportedCriticalFlag(result.critical)) {
    console.warn(
      `${label}: server entry export's 'critical' field for '${descriptorName}' is not a boolean ` +
        `(got ${typeof result.critical}); treating criticality as unresolved`,
    );
    return undefined;
  }

  return result.critical;
}

/**
 * Resolve the `critical` flag a listing producer should report for one
 * descriptor, given the value its own metadata declares and its resolved
 * server entrypoint, if any.
 *
 * Both offline listing producers in this package (`YarnPackageManager.listPackages`
 * and the local-path branch of `PackageManagerService`'s list handler) apply
 * the identical rule: a descriptor with a server entrypoint owns `critical`
 * on its exported package, never on the descriptor itself, so it is resolved
 * via {@link resolveExportedPackageCritical}; a descriptor with no server
 * entrypoint has no exported package, so its own declared value is
 * authoritative.
 * @param descriptorCritical - `critical` as declared directly on the
 *   descriptor, when present. Only meaningful when `serverImportPath` is
 *   `undefined` — the schema rejects declaring both.
 * @param serverImportPath - Absolute, already-resolved import path for the
 *   descriptor's server entrypoint, when it declares one.
 * @param descriptorName - Descriptor package name.
 * @param label - Log prefix identifying the caller and extension for warnings.
 * @param frameworkDistPath - Forwarded to {@link resolveExportedPackageCritical}
 *   when `serverImportPath` is present — see its `frameworkDistPath` parameter.
 * @returns Resolved `critical` flag, or `undefined` when nothing declares it
 *   or the export could not be read.
 */
export async function resolveCriticalFlag(
  descriptorCritical: boolean | undefined,
  serverImportPath: string | undefined,
  descriptorName: string,
  label: string,
  frameworkDistPath?: string,
): Promise<boolean | undefined> {
  return serverImportPath !== undefined
    ? resolveExportedPackageCritical(serverImportPath, descriptorName, label, frameworkDistPath)
    : descriptorCritical;
}

/** One entry reported by a local extension installer's listing, as consumed by {@link toLocalPackageInfo}. */
export interface LocalExtensionListingEntry {
  /** Extension identity, already the descriptor name for a local install. */
  readonly name: string;
  /** Installed version. */
  readonly version: string;
  /** Absolute import path for the resolved server entrypoint, when present. */
  readonly serverImportPath?: string;
  /**
   * Whether `descriptor.json` declares `entrypoints.server` at all,
   * independent of whether `serverImportPath` could be resolved — see
   * `PackageInfoSchema.declaresServerEntrypoint` for why this cannot be
   * inferred from `serverImportPath` alone.
   */
  readonly declaresServerEntrypoint?: boolean;
  /** `critical` as declared in the package's `descriptor.json`. */
  readonly critical?: boolean;
}

/**
 * Normalize one local extension listing entry into a {@link PackageInfo}.
 *
 * A local install's identifier is already the descriptor name (see
 * `LocalPathInstaller.list`, which keys its symlinks and entries by
 * `descriptor.name`) — unlike an npm install, whose `name` is the npm
 * dependency identifier. When the entry has a server entrypoint, its
 * descriptor may not declare `critical` itself (the schema rejects that
 * combination), so the flag is read from the entrypoint's exported package
 * via {@link resolveExportedPackageCritical} instead — the same resolution
 * `YarnPackageManager.listPackages` applies for npm installs.
 * @param extension - Entry reported by the local installer.
 * @param frameworkDistPath - Forwarded to {@link resolveCriticalFlag} — see
 *   its `frameworkDistPath` parameter.
 * @returns Normalized package info for the offline listing.
 */
export async function toLocalPackageInfo(
  extension: LocalExtensionListingEntry,
  frameworkDistPath?: string,
): Promise<PackageInfo> {
  const critical = await resolveCriticalFlag(
    extension.critical,
    extension.serverImportPath,
    extension.name,
    `[PackageManagerService] ${extension.name}`,
    frameworkDistPath,
  );
  return {
    name: extension.name,
    version: extension.version,
    hasDescriptor: true,
    descriptorName: extension.name,
    ...(extension.serverImportPath !== undefined && { serverImportPath: extension.serverImportPath }),
    ...(extension.declaresServerEntrypoint && { declaresServerEntrypoint: extension.declaresServerEntrypoint }),
    ...(critical !== undefined && { critical }),
  };
}
