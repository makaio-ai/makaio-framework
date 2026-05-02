import type { ExtensionEntrypoints } from '@makaio/contracts';

/**
 * Stable diagnostic codes emitted by `verifyExtensionWorkspace`.
 */
export type ExtensionVerifyDiagnosticCode =
  | 'descriptor.read-failed'
  | 'descriptor.invalid-json'
  | 'descriptor.invalid-schema'
  | 'entrypoint.no-candidate'
  | 'entrypoint.import-failed'
  | 'server.invalid-default-export'
  | 'browser.unsupported-bare-import'
  | 'browser.static-root-escape'
  | 'browser.invalid-esm'
  | 'cli.invalid-default-export';

/**
 * Structured verification diagnostic.
 */
export interface ExtensionVerifyDiagnostic {
  /** Stable machine-readable diagnostic code. */
  readonly code: ExtensionVerifyDiagnosticCode;
  /** Human-readable failure message used by the CLI. */
  readonly message: string;
  /** Declared extension surface when applicable. */
  readonly surface?: keyof ExtensionEntrypoints;
  /** Descriptor-relative entrypoint when applicable. */
  readonly entrypoint?: string;
  /** Absolute file path involved in the failure when known. */
  readonly filePath?: string;
  /** Unsupported bare imports collected from a browser bundle graph. */
  readonly bareImports?: readonly string[];
  /** Additional human-readable cause detail for import/build failures. */
  readonly cause?: string;
}

/**
 * Per-check verification result.
 */
export interface ExtensionVerifyCheckResult {
  /** Verification phase that produced this result. */
  readonly check: 'descriptor' | 'entrypoint' | 'runtime';
  /** Pass/fail/skip status for the phase. */
  readonly status: 'passed' | 'failed' | 'skipped';
  /** Declared extension surface when the check targets one surface. */
  readonly surface?: keyof ExtensionEntrypoints;
  /** Descriptor-relative entrypoint under verification. */
  readonly entrypoint?: string;
  /** Absolute file path that was resolved for the check when present. */
  readonly filePath?: string;
  /** Diagnostics emitted by this check. */
  readonly diagnostics: readonly ExtensionVerifyDiagnostic[];
}

/**
 * Successful verification result for a local extension workspace.
 */
export interface ExtensionVerifyResult {
  /** Always `true` for successful verification. */
  readonly ok: true;
  /** Absolute extension root that was verified. */
  readonly rootDir: string;
  /** Verified descriptor entrypoints. */
  readonly entrypoints: ExtensionEntrypoints;
  /** Machine-readable check results in execution order. */
  readonly checks: readonly ExtensionVerifyCheckResult[];
  /** Diagnostics emitted during verification. Empty on success. */
  readonly diagnostics: readonly ExtensionVerifyDiagnostic[];
}

/**
 * Failed verification result exposed via `ExtensionVerifyError`.
 */
export interface ExtensionVerifyFailureResult {
  /** Always `false` for failed verification. */
  readonly ok: false;
  /** Absolute extension root that was verified. */
  readonly rootDir: string;
  /** Parsed descriptor entrypoints when descriptor parsing succeeded. */
  readonly entrypoints?: ExtensionEntrypoints;
  /** Machine-readable check results collected before the failure. */
  readonly checks: readonly ExtensionVerifyCheckResult[];
  /** Diagnostics emitted before verification aborted. */
  readonly diagnostics: readonly [ExtensionVerifyDiagnostic, ...ExtensionVerifyDiagnostic[]];
}

/**
 * Mutable verifier state used while building a structured result.
 */
export interface ExtensionVerifyState {
  /** Absolute extension root being verified. */
  readonly rootDir: string;
  /** Parsed entrypoints once descriptor validation succeeds. */
  entrypoints?: ExtensionEntrypoints;
  /** Ordered check results collected so far. */
  readonly checks: ExtensionVerifyCheckResult[];
  /** Ordered diagnostics collected so far. */
  readonly diagnostics: ExtensionVerifyDiagnostic[];
}

/**
 * Typed verification failure thrown by `verifyExtensionWorkspace`.
 */
export class ExtensionVerifyError extends Error {
  /** Machine-readable verification result. */
  public readonly result: ExtensionVerifyFailureResult;

  /**
   * @param result - Failed verification result.
   */
  public constructor(result: ExtensionVerifyFailureResult) {
    super(result.diagnostics[0].message);
    this.name = 'ExtensionVerifyError';
    this.result = result;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Create mutable verification state.
 * @param rootDir - Absolute extension root.
 * @returns Mutable state used while verifying.
 */
export function createVerifyState(rootDir: string): ExtensionVerifyState {
  return {
    rootDir,
    checks: [],
    diagnostics: [],
  };
}

/**
 * Record a check result.
 * @param state - Mutable verification state.
 * @param check - Check result to append.
 */
export function recordCheck(state: ExtensionVerifyState, check: ExtensionVerifyCheckResult): void {
  state.checks.push(check);
}

/**
 * Record a failure and throw a typed verification error.
 * @param state - Mutable verification state.
 * @param failedCheck - Failed check result to append.
 * @throws ExtensionVerifyError Always.
 */
export function failVerification(state: ExtensionVerifyState, failedCheck: ExtensionVerifyCheckResult): never {
  state.diagnostics.push(...failedCheck.diagnostics);
  recordCheck(state, failedCheck);
  throw new ExtensionVerifyError({
    ok: false,
    rootDir: state.rootDir,
    ...(state.entrypoints ? { entrypoints: state.entrypoints } : {}),
    checks: [...state.checks],
    diagnostics: toNonEmptyDiagnostics(state.diagnostics),
  });
}

/**
 * Convert a diagnostic list into the non-empty tuple required by failure results.
 * @param diagnostics - Diagnostics collected so far.
 * @returns Non-empty diagnostic tuple.
 */
function toNonEmptyDiagnostics(
  diagnostics: readonly ExtensionVerifyDiagnostic[],
): [ExtensionVerifyDiagnostic, ...ExtensionVerifyDiagnostic[]] {
  if (diagnostics.length === 0) {
    throw new Error('Extension verification failed without diagnostics.');
  }

  const [firstDiagnostic, ...remainingDiagnostics] = diagnostics;
  if (!firstDiagnostic) {
    throw new Error('Extension verification failed without diagnostics.');
  }

  return [firstDiagnostic, ...remainingDiagnostics];
}

/**
 * Format schema issues into a compact diagnostic string.
 * @param issues - Validation issues from the descriptor schema.
 * @returns Semicolon-delimited issue summary.
 */
export function formatSchemaIssues(
  issues: ReadonlyArray<{ readonly path: readonly PropertyKey[]; readonly message: string }>,
): string {
  return issues
    .map((issue) => {
      const issuePath = issue.path.length > 0 ? issue.path.map(String).join('.') : 'root';
      return `${issuePath}: ${issue.message}`;
    })
    .join('; ');
}
