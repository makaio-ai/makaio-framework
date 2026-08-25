import { register, type NamespacedUnregister } from 'tsx/esm/api';
import {
  snapshotJsonBoundary,
  JsonValueSchema,
  type CodeExecutionFailedOutcomeCode,
  type JsonFidelityViolationKind,
  type JsonValue,
} from '@makaio/contracts';
import { isUnsupportedImportError, registerImportAllowlist } from './import-allowlist-guard.js';
import {
  CODE_EXECUTION_ENTRY_NAMESPACE_EXPORT,
  describeThrownValue,
  measureSerializedBytes,
  sanitizeDiagnosticMessage,
  type CodeExecutionWorkerFailedOutcome,
  type CodeExecutionWorkerOutcome,
  type CodeExecutionWorkerTask,
} from './types.js';

// ─────────────────────────────────────────────────────────────
// Module overview
// ─────────────────────────────────────────────────────────────

// Worker-thread entrypoint for the Piscina CodeExecution provider.
//
// TypeScript transpilation and module loading stay here, inside the worker.
// The entry module is imported through a scoped TypeScript loader registered
// under a per-invocation namespace with tsconfig discovery disabled, so this
// loader does not apply an ambient host tsconfig and successive invocations
// never share a module cache. When the provider runs its TypeScript source
// entry it also registers a process-wide TypeScript loader beneath the scoped
// one and beneath the resolve guard; that loader is pinned to an alias-free
// tsconfig this package ships, so a configured package name resolves through
// its materialized link rather than through an ambient `paths` alias — see
// `worker-entry-resolver.ts`. The built entry has no loader beneath it.
//
// A per-invocation resolve guard makes the host's package map the whole truth
// about which ordinary packages resolve: linking only the configured packages
// into the program root does not stop Node from walking up into an ancestor
// `node_modules`, so the guard classifies bare specifiers before resolution
// reaches the filesystem. See `import-allowlist-guard.ts`.
//
// Every expected failure resolves as a small, clone-safe envelope rather than
// rejecting, and the handler's return value is validated and measured here —
// before Piscina attempts to structured-clone it back to the host thread.
//
// This entry runs submitted code with the full privileges of its worker
// thread. It bounds resources and the set of resolvable ordinary imports; it
// is not an isolation boundary for hostile code.

/** Callable shape the entry module's named export must have. */
type CodeExecutionHandler = (input: JsonValue) => unknown;

/**
 * Namespaced importer supplied by the scoped TypeScript loader registration.
 * @param specifier - Absolute `file:` URL of the module to import.
 * @param parent - Absolute `file:` URL of the importing parent.
 * @returns The imported module namespace.
 */
type ScopedModuleImporter = (specifier: string, parent: string) => Promise<Record<string, unknown>>;

/** Outcome of importing the generated entry-namespace module. */
type EntryModuleImport =
  | { readonly ok: true; readonly moduleNamespace: Record<string, unknown> }
  | { readonly ok: false; readonly outcome: CodeExecutionWorkerFailedOutcome };

/** Outcome of validating a handler's return value inside the worker. */
type HandlerResultValidation =
  | { readonly ok: true; readonly value: JsonValue }
  | { readonly ok: false; readonly message: string };

/** Stable diagnostics for structural failures from the boundary snapshot. */
const RESULT_SNAPSHOT_MESSAGES: Readonly<Record<JsonFidelityViolationKind, string>> = {
  'prototype-key': 'The invoked export returned a value carrying a "__proto__" own key.',
  'non-plain-object': 'The invoked export returned an object that is not JSON data; only plain objects and arrays are.',
  'symbol-key': 'The invoked export returned a value that cannot be transported as JSON.',
  'non-enumerable-key': 'The invoked export returned a value that cannot be transported as JSON.',
  'extra-array-key': 'The invoked export returned a value that cannot be transported as JSON.',
  'cyclic-reference': 'The invoked export returned a non-serializable cyclic value.',
  'nesting-too-deep': 'The invoked export returned a value exceeding the maximum JSON container nesting.',
  'negative-zero': 'The invoked export returned -0, which JSON would transport as 0.',
  'unreadable-value': 'The invoked export returned a value that cannot be read into a JSON boundary snapshot.',
};

/**
 * Build a sanitized, bounded failure envelope.
 * @param code - Stable failure classification for the outcome.
 * @param message - Raw diagnostic text to sanitize and bound.
 * @param redactedPaths - Materialized program paths to strip from the message.
 * @returns Clone-safe failure envelope for the host thread.
 */
function failure(
  code: CodeExecutionFailedOutcomeCode,
  message: string,
  redactedPaths: readonly string[],
): CodeExecutionWorkerFailedOutcome {
  return { kind: 'failed', code, message: sanitizeDiagnosticMessage(message, redactedPaths) };
}

/**
 * Narrow an unknown module export to an invocable handler.
 * @param value - Value read from the entry module's namespace.
 * @returns True when the export can be invoked with the JSON argument.
 */
function isCodeExecutionHandler(value: unknown): value is CodeExecutionHandler {
  return typeof value === 'function';
}

/**
 * Narrow the export read off the generated module to the program's namespace.
 *
 * A module namespace is an ordinary object to every property read, so nothing
 * stronger than "an object" is asserted or needed. What this guards against is
 * not a hostile program — the generated module is written by the provider, and
 * the program cannot influence what it exports — but an internally malformed
 * worker task that does not point at the generated namespace.
 * @param value - Value read from the generated module's namespace.
 * @returns True when the export can be read for the requested handler.
 */
function isEntryNamespace(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Import the generated entry-namespace module through the scoped TypeScript loader.
 *
 * The program's own entry module is never imported directly, and the
 * indirection is not cosmetic: a dynamic import resolves its promise *with* the
 * module namespace, so a program exporting a callable `then` from its entry
 * makes that promise assimilate the namespace and hand back whatever the
 * program's `then` resolves with — or never settle at all. The generated module
 * this imports declares one plain export and nothing else, so there is nothing
 * for the promise machinery to adopt.
 *
 * A specifier that does not resolve — most commonly an ordinary package import
 * the host did not configure, which the allowlist guard rejects with Node's own
 * "module not found" code — is reported as an unsupported import. Every other
 * import-phase failure, including transpilation errors and throws during module
 * evaluation, is reported as a compilation failure.
 *
 * This covers the program's static import graph, which is what the module set
 * declares. A `import()` the handler evaluates at *run* time is rejected by the
 * same guard, but it rejects inside the handler call, so it is classified as a
 * handler failure — correctly: the program ran, and it is the program that has
 * to deal with a rejected dynamic import.
 * @param scopedImport - Namespaced importer for this invocation.
 * @param task - Task describing the entry-namespace module and its diagnostic redactions.
 * @returns The generated module's namespace, or the failure envelope to report.
 */
async function importEntryModule(
  scopedImport: ScopedModuleImporter,
  task: CodeExecutionWorkerTask,
): Promise<EntryModuleImport> {
  try {
    return { ok: true, moduleNamespace: await scopedImport(task.entryNamespaceUrl, task.parentUrl) };
  } catch (error) {
    return {
      ok: false,
      outcome: failure(
        isUnsupportedImportError(error) ? 'unsupported_import' : 'compilation_failed',
        describeThrownValue(error),
        task.redactedPaths,
      ),
    };
  }
}

/**
 * Validate and measure a handler's return value before it can be transferred.
 *
 * The boundary snapshot makes one finite detached tree before validation. It
 * detects cycles, rejects values whose own shape JSON cannot carry, and reads an
 * admissible accessor only once. Both the schema and the size measurement then
 * operate on that tree, so a result cannot change between validation and
 * transfer.
 *
 * This early measurement is a trusted-code best effort, not hostile-code
 * isolation before the clone: submitted code shares this worker realm and can
 * replace its serialization intrinsics. The host revalidates the received
 * clone and authoritatively enforces the result budget after the boundary.
 * @param value - Raw value returned or resolved by the invoked export.
 * @param maxResultBytes - Maximum serialized JSON size allowed, in bytes.
 * @returns The validated JSON value, or the reason it was rejected.
 */
function validateHandlerResult(value: unknown, maxResultBytes: number): HandlerResultValidation {
  const snapshot = snapshotJsonBoundary(value);
  if (!snapshot.ok) {
    return {
      ok: false,
      message: RESULT_SNAPSHOT_MESSAGES[snapshot.violation.kind],
    };
  }

  const parsed = JsonValueSchema.safeParse(snapshot.value);
  if (!parsed.success) {
    return {
      ok: false,
      message:
        snapshot.value === undefined
          ? 'The invoked export returned a value that has no JSON representation.'
          : 'The invoked export returned a value that is not JSON-safe.',
    };
  }

  const bytes = measureSerializedBytes(parsed.data);
  if (bytes > maxResultBytes) {
    return {
      ok: false,
      message: `The invoked export returned ${bytes} serialized bytes, which exceeds the limit of ${maxResultBytes}.`,
    };
  }

  return { ok: true, value: parsed.data };
}

/**
 * Unregister the scoped TypeScript loader for one invocation.
 *
 * A failure here is reported to local diagnostics only. Cleanup runs after the
 * outcome has already been computed, so letting it reject would replace a
 * precise classification — a `handler_failed`, or even a completed value — with
 * `provider_failed`, and report the teardown as though it were the execution.
 * The materialized program root is removed under the same rule on the host
 * side.
 * @param scoped - Scoped loader registration for this invocation.
 * @param namespace - Loader namespace, named in the local diagnostic.
 */
async function unregisterScopedLoader(scoped: NamespacedUnregister, namespace: string): Promise<void> {
  try {
    await scoped.unregister();
  } catch (error) {
    console.warn('[code-execution] Failed to unregister the loader for namespace %s: %s', namespace, error);
  }
}

/**
 * Execute one materialized program invocation inside a Piscina worker thread.
 *
 * Registers this invocation's import allowlist and a scoped TypeScript loader,
 * reaches the program's entry namespace through the generated module the
 * materializer wrote for it, invokes the requested export with the JSON
 * argument, validates the returned value, and always removes both registrations
 * before returning.
 *
 * Both registrations are keyed to this invocation alone — the allowlist to its
 * program root, the loader to its namespace — so a worker thread serving
 * invocations in sequence never lets one invocation's rules decide another's.
 * @param task - Structured-clone-safe task describing this invocation.
 * @returns Clone-safe outcome envelope for the host thread.
 */
export async function executeCodeInWorker(task: CodeExecutionWorkerTask): Promise<CodeExecutionWorkerOutcome> {
  // Registered ahead of the TypeScript loader so the guard sits closest to
  // Node's own resolution and only ever inspects clean specifiers.
  const imports = registerImportAllowlist(task.programRootUrls, task.allowedPackages);
  const scoped = register({ namespace: task.namespace, tsconfig: false });
  try {
    const imported = await importEntryModule((specifier, parent) => scoped.import(specifier, parent), task);
    if (!imported.ok) return imported.outcome;

    const entryNamespace = imported.moduleNamespace[CODE_EXECUTION_ENTRY_NAMESPACE_EXPORT];
    if (!isEntryNamespace(entryNamespace)) {
      // The provider generates this module, so its absence says the worker was
      // handed something the provider did not materialize — a composition fault
      // rather than anything the submitted program did.
      return failure(
        'provider_failed',
        `The entry module was not reached through a generated "${CODE_EXECUTION_ENTRY_NAMESPACE_EXPORT}" export.`,
        task.redactedPaths,
      );
    }

    const handler = entryNamespace[task.exportName];
    if (!isCodeExecutionHandler(handler)) {
      const detail = handler === undefined ? 'is not exported' : `is ${typeof handler}, not a function`;
      return failure('entrypoint_not_found', `Export "${task.exportName}" ${detail}.`, task.redactedPaths);
    }

    let result: unknown;
    try {
      result = await handler(task.arguments);
    } catch (error) {
      return failure('handler_failed', describeThrownValue(error), task.redactedPaths);
    }

    const validated = validateHandlerResult(result, task.maxResultBytes);
    if (!validated.ok) return failure('invalid_result', validated.message, task.redactedPaths);
    return { kind: 'completed', value: validated.value };
  } finally {
    // Deregistered in the reverse order of registration, so the loader is gone
    // before the guard it was resolving through.
    await unregisterScopedLoader(scoped, task.namespace);
    imports.deregister();
  }
}

// Piscina targets the default export of the worker entrypoint.
export default executeCodeInWorker;
