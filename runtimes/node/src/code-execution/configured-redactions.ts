import { realpath, stat } from 'node:fs/promises';
import { collapseDiagnosticWhitespace } from './types.js';
import { collectPathSpellings } from './path-spellings.js';

// ─────────────────────────────────────────────────────────────
// Module overview
// ─────────────────────────────────────────────────────────────

// The host-configured values a CodeExecution provider strips from diagnostics
// before they can reach the bus: the environment it hands its worker threads,
// the package roots it links into a program, and the paths its worker threads
// are launched against — the entry file and whatever its loader is configured
// with.
//
// These are exactly the strings the provider itself introduced, so the *set* is
// complete in a way no filter over program-authored text could be. Text an
// executing program embeds of its own accord is a different problem and not one
// a substring filter can solve; see `sanitizeDiagnosticMessage`.
//
// Environment values and paths have deliberately different matching rules.
// A short environment value such as `dev`, `on`, or `1` is indistinguishable
// from ordinary prose, so redacting it would corrupt the diagnostic it is meant
// to protect. The threshold is therefore where the obligation moves to the
// host: it must not place a secret in an environment value that short.
// `PiscinaCodeExecutionProviderOptions.environment` states the same rule where
// a host actually supplies those values.
//
// A configured path is different: its filesystem and `file:` URL spellings
// identify host layout even when short. Those spellings are always redacted.

/**
 * Shortest configured environment value that is redacted from diagnostics.
 *
 * A very short environment value — `on` or `1` — occurs in ordinary prose, so
 * redacting it would mangle the message it is meant to protect without
 * concealing anything worth concealing. Configured path spellings are always
 * redacted because they can disclose host layout even when short.
 *
 * This is a deliberate tradeoff with a security consequence the composing host
 * owns: an environment value shorter than this threshold is **not** redacted
 * and can therefore appear verbatim in a diagnostic that reaches the bus. Hosts
 * must not place secrets in environment values this short.
 *
 * Measured on the whitespace-collapsed value, because that is the form the
 * sanitizer matches against — applying the threshold to the raw value instead
 * would admit a redaction that is short in the only spelling that ever occurs
 * in a message.
 */
export const MIN_CONFIGURED_REDACTION_LENGTH = 4;

/** Host-configured values that must never appear in a bus-bound message. */
export interface ConfiguredRedactionSources {
  /** Environment variables handed to worker threads. */
  readonly environment: Readonly<Record<string, string>>;
  /** Validated package names mapped to absolute package roots. */
  readonly packageRoots: ReadonlyMap<string, string>;
  /**
   * Absolute host paths a worker thread is launched with.
   *
   * The entry file and anything its launch configuration names — a loader's
   * tsconfig among them. Every one of them can appear verbatim in a startup
   * failure the provider then reports as an outcome, so they are redacted as a
   * set rather than one privileged path plus whatever was added later.
   */
  readonly workerPaths: readonly string[];
}

/** The pinned package targets and diagnostic redactions derived from one read. */
export interface ResolvedConfiguredRuntime {
  /** Package roots after symlinks have been resolved for execution. */
  readonly packageRoots: ReadonlyMap<string, string>;
  /** Redactions covering configured and resolved package path spellings. */
  readonly redactions: readonly string[];
}

/**
 * Resolve package targets and diagnostics together for the provider's first admitted invocation.
 *
 * Pinning the target before materialization makes a later symlink rotation
 * unable to change which package is linked into a program. The redaction set is
 * built from both the supplied and pinned spellings in the same operation, so a
 * diagnostic cannot name one while execution used the other.
 * @param sources - Host configuration to resolve and redact.
 * @returns Pinned package targets with their diagnostic redactions.
 */
export async function resolveConfiguredRuntime(
  sources: ConfiguredRedactionSources,
): Promise<ResolvedConfiguredRuntime> {
  const packageRoots = new Map<string, string>();
  for (const [name, configuredRoot] of sources.packageRoots) {
    try {
      const resolvedRoot = await realpath(configuredRoot);
      if (!(await stat(resolvedRoot)).isDirectory()) throw new Error('Package root is not a directory.');
      packageRoots.set(name, resolvedRoot);
    } catch {
      // Node's realpath diagnostic includes the configured absolute path. The
      // provider may not have reached its redaction snapshot yet, so normalize
      // it here instead of allowing that host detail onto the bus.
      throw new Error('A configured package root could not be resolved.');
    }
  }
  const redactions = await collectConfiguredRedactions({
    ...sources,
    packageRoots: new Map([
      ...sources.packageRoots,
      ...[...packageRoots].map(([name, root]) => [`resolved:${name}`, root] as const),
    ]),
  });
  return { packageRoots, redactions };
}

/**
 * Collect the host-configured values that are stripped from diagnostics.
 *
 * Environment values are collapsed into the form diagnostics are matched in
 * before the {@link MIN_CONFIGURED_REDACTION_LENGTH} threshold is applied; a
 * value below that threshold is deliberately left out of the set — see the
 * module overview for why, and for what the composing host owes as a result.
 * Path spellings are always included when nonempty. A `file:` URL percent-encodes
 * whitespace, so that spelling is unaffected by the collapse.
 *
 * Configured paths are expanded through {@link collectPathSpellings}, which is
 * why this is asynchronous. A host may configure a package root that is itself
 * a symlink, and the module loader resolves a package through its *real* path —
 * so the real path is the only spelling of that root an executing program can
 * ever observe, and the one it would put into a thrown message. Redacting the
 * configured spelling alone would match nothing there. Resolution failures are
 * absorbed in the helper, so this never rejects — callers on a failure path
 * depend on that.
 * @param sources - Configured environment, package roots, and worker launch paths.
 * @returns Distinct strings to strip from every bus-bound message.
 */
export async function collectConfiguredRedactions(sources: ConfiguredRedactionSources): Promise<readonly string[]> {
  const redactions = new Set<string>();
  const addEnvironmentValue = (value: string): void => {
    const matchable = collapseDiagnosticWhitespace(value);
    if (matchable.length >= MIN_CONFIGURED_REDACTION_LENGTH) redactions.add(matchable);
  };
  const addPathSpelling = (value: string): void => {
    const matchable = collapseDiagnosticWhitespace(value);
    if (matchable.length > 0) redactions.add(matchable);
  };
  for (const value of Object.values(sources.environment)) addEnvironmentValue(value);
  for (const path of [...sources.packageRoots.values(), ...sources.workerPaths]) {
    for (const spelling of await collectPathSpellings(path)) addPathSpelling(spelling);
  }
  return [...redactions];
}
