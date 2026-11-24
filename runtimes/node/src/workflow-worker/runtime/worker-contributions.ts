import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRefusingRightsCapability } from '@makaio/contracts/rights';
import type { IMakaioBus } from '@makaio/bus-core';
import { createCarrierBus } from '@makaio/bus-core/kernel-api';
import type { IsolatedNodeExtensionContext } from '@makaio/contracts/extension';
import { WORKER_NAMESPACE_CLAIM_UNAVAILABLE, type ExtensionManifest } from '@makaio/contracts/extension';
import { filterEligibleExtensions } from '@makaio/kernel';
import type { Toolset } from '@makaio/tools-core';
import { buildRuntimeEnvironment } from '../../boot-extension-selection.js';

/** A toolset and the carrier from the context of its contributing extension. */
interface WorkerToolsetContribution {
  readonly toolset: Toolset;
  /** Carrier bus when the loader is given a worker-local bus. */
  readonly bus: IMakaioBus | undefined;
}

/**
 * Collected contributions from worker-local extension packages.
 *
 * Contains the subset of extension contributions relevant to isolated worker
 * processes: toolsets for tool execution. Agent steps spawn subagents to the
 * host, so adapter contributions are not harvested for workers.
 */
export interface WorkerRuntimeContributions {
  /** Toolsets extracted from loaded packages and their contributor buses. */
  readonly toolsets: WorkerToolsetContribution[];
}

/**
 * Shape of a loaded extension module that may contribute tools.
 *
 * Workers inspect eligibility metadata and harvest toolsets without invoking
 * extension lifecycle callbacks.
 */
interface ExtensionModuleShape
  extends Pick<ExtensionManifest, 'name' | 'storage' | 'requires' | 'surface' | 'dependencies'> {
  readonly tools?: {
    // `unknown` on purpose: the worker context carries an optional `bus` (see
    // `WorkerToolsetContext`), so it is not assignable to `NodeExtensionContext`.
    readonly createToolsets: (ctx: unknown) => Toolset[];
  };
}

/** Runtime context available while extracting worker-local contributions. */
export interface WorkerRuntimeContributionLoadOptions {
  /** Worker-local bus instance. */
  readonly bus?: IMakaioBus;
  /** Cancellation signal for worker-local contribution setup. */
  readonly signal?: AbortSignal;
}

/**
 * Determine whether a value looks like a Makaio extension module shape.
 *
 * Checks for an object with at least one contribution surface (`tools` or
 * `adapters`) plus the required `name` field that all MakaioExtension manifests
 * carry. An adapters-only package is still recognized as a valid extension (so
 * it is not warned about), but workers harvest only its toolsets.
 * @param value - Candidate value from a dynamic import.
 * @returns `true` when the value structurally matches an extension module.
 */
function isExtensionShape(value: unknown): value is ExtensionModuleShape {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj['name'] !== 'string') return false;
  return (typeof obj['tools'] === 'object' && obj['tools'] !== null) || Array.isArray(obj['adapters']);
}

/**
 * Resolve the extension shape from a dynamically imported module.
 *
 * Inspects the module's `default` export first, then falls back to the first
 * named export with the same shape.
 * @param mod - ESM module namespace from `import()`.
 * @returns The extension shape, or `undefined` when no recognizable export is found.
 */
function resolveExtensionExport(mod: Record<string, unknown>): ExtensionModuleShape | undefined {
  // 1. Check default export
  if (isExtensionShape(mod['default'])) {
    return mod['default'];
  }

  // 2. Look for a named export that matches the extension shape
  for (const key of Object.keys(mod)) {
    if (key === 'default') continue;
    if (isExtensionShape(mod[key])) {
      return mod[key];
    }
  }

  // 3. Not found -- fall through to caller diagnostic
  return undefined;
}

/**
 * Context handed to `tools.createToolsets()` in the worker.
 *
 * Every required key of {@link IsolatedNodeExtensionContext} except three known gaps:
 * - `bus` is optional in the worker (see {@link WorkerRuntimeContributionLoadOptions}).
 * - `config` is present only for an extension that declares a `configSchema`;
 *   the worker loads no schema, so it passes none.
 * - `identity` is a branded value minted by the kernel coordinator; the worker
 *   cannot mint one without a cast, so the plain `{ extensionName }` object
 *   stays outside the check.
 * The context carries no call context: a carrier's own context comes from
 * `bus.own(purpose)`.
 * A new required key on the contract makes {@link createWorkerToolsetContext}
 * fail to compile until it is supplied here.
 */
type WorkerToolsetContext = Omit<IsolatedNodeExtensionContext, 'bus' | 'config' | 'identity'> & {
  readonly bus?: IMakaioBus;
  readonly identity: { readonly extensionName: string };
};

/** A toolset attempted to claim a namespace without an activated extension. */
export class WorkerNamespaceClaimError extends Error {
  public readonly code = WORKER_NAMESPACE_CLAIM_UNAVAILABLE;

  /** Explain why the worker toolset cannot claim namespaces. */
  public constructor() {
    super(
      'Namespace claims are not available in the workflow worker: no extension is activated there; the worker registers its namespaces as host.',
    );
    this.name = 'WorkerNamespaceClaimError';
  }
}

/**
 * Reject a namespace claim in a worker toolset context.
 * @throws WorkerNamespaceClaimError Always, since workers do not activate extensions.
 */
function rejectNamespaceClaim(): never {
  throw new WorkerNamespaceClaimError();
}

/**
 * Minimal context passed to `tools.createToolsets()` in the worker environment.
 *
 * Workers expose their local bus and cancellation signal, but not the host
 * lifecycle/service registry. Extensions whose toolset factories depend on
 * host-only services should not be listed in the worker contribution manifest.
 * The bus, when present, is bound to the loaded extension as its carrier.
 * @param name - Name of the loaded extension (`ext.name`).
 * @param options - Worker-local runtime surfaces exposed during extraction.
 * @returns Context object passed to extension toolset factories.
 */
function createWorkerToolsetContext(
  name: string,
  options?: WorkerRuntimeContributionLoadOptions,
): WorkerToolsetContext {
  return Object.freeze({
    bus:
      options?.bus === undefined
        ? undefined
        : createCarrierBus(options.bus, { kind: 'makaio.extension', id: name }, rejectNamespaceClaim),
    rights: createRefusingRightsCapability(),
    identity: Object.freeze({ extensionName: name }),
    dataDir: '',
    machineId: '',
    platform: process.platform,
    homedir: '',
    makaioHome: '',
    username: '',
    signal: options?.signal ?? new AbortController().signal,
    tryImport: async () => null,
    getService: () => {
      throw new Error('Worker-local contribution context does not expose host services.');
    },
    hasExtension: () => false,
    namespaces: { lease: rejectNamespaceClaim },
    openContributions: {
      of: () => {
        throw new Error(
          'Open contributions are not available in the workflow worker: no extension is activated there.',
        );
      },
    },
  } satisfies WorkerToolsetContext);
}

/**
 * Load worker-local contributions from materializer-verified entrypoints.
 *
 * For each package reference in the manifest, the loader:
 * 1. Dynamic-imports each verified absolute entrypoint
 * 2. Resolves the extension export (default or first matching named export)
 * 3. Checks eligibility for the isolated worker
 * 4. Extracts toolsets via `pkg.tools.createToolsets()` when available
 *
 * Import errors, unrecognizable exports, ineligible packages, and toolset
 * creation failures are fatal. Contribution load is fail-closed so
 * workers never start execution with a partial contribution set.
 * @param entrypoints - Absolute worker-local entrypoints verified by a materializer.
 * @param options - Worker-local runtime surfaces exposed during extraction.
 * @returns Combined toolsets from all loaded packages.
 * @throws When a package is ineligible or fails to import, export, or create toolsets.
 */
export async function loadWorkerRuntimeContributions(
  entrypoints: readonly string[],
  options?: WorkerRuntimeContributionLoadOptions,
): Promise<WorkerRuntimeContributions> {
  const packages = await Promise.all(entrypoints.map(loadSinglePackage));
  const environment = buildRuntimeEnvironment(process.platform, ['node']);
  const eligible = new Set(filterEligibleExtensions(packages, 'headless', environment));
  const rejected = packages.filter((pkg) => !eligible.has(pkg));
  if (rejected.length > 0) {
    throw new Error(`Ineligible workflow worker contributions: ${rejected.map((pkg) => pkg.name).join(', ')}`);
  }

  return { toolsets: packages.flatMap((pkg) => extractWorkerToolsets(pkg, options)) };
}

/**
 * Import and resolve one contribution package.
 * @param entrypoint - Verified absolute path to the contribution entrypoint.
 * @returns The package manifest before admission.
 * @throws When the package cannot be imported or has no recognizable export.
 */
async function loadSinglePackage(entrypoint: string): Promise<ExtensionModuleShape> {
  if (!path.isAbsolute(entrypoint)) {
    throw new Error(`Worker contribution entrypoint must be an absolute materialized path: ${entrypoint}`);
  }
  const importSpecifier = pathToFileURL(entrypoint).href;
  const mod = (await import(importSpecifier)) as Record<string, unknown>;

  const ext = resolveExtensionExport(mod);
  if (!ext) {
    throw new Error(
      `No recognizable extension export in "${entrypoint}". ` +
        `Expected a default export or named export with a "name" field and "tools" or "adapters" surface.`,
    );
  }

  return ext;
}

/**
 * Create an admitted package's toolsets, each with the carrier bus of its contributing extension.
 * @param ext - Admitted extension module.
 * @param options - Worker-local runtime surfaces exposed during extraction.
 * @returns The package's toolsets with their contributor's carrier.
 * @throws When toolset creation fails.
 */
function extractWorkerToolsets(
  ext: ExtensionModuleShape,
  options?: WorkerRuntimeContributionLoadOptions,
): WorkerToolsetContribution[] {
  if (!ext.tools?.createToolsets) return [];

  const ctx = createWorkerToolsetContext(ext.name, options);
  return ext.tools.createToolsets(ctx).map((toolset) => ({ toolset, bus: ctx.bus }));
}
