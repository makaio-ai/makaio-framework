/**
 * Operator-owned extension configuration, read from the Makaio home.
 *
 * An operator configures one extension by hand-writing a single JSON file under
 * `<makaioHome>/config/extensions/`, named after the extension. This module
 * turns that directory into an immutable
 * {@link ExtensionOperatorConfigSource} snapshot: one read pass, one entry per
 * file, and no filesystem vocabulary beyond this module.
 *
 * The snapshot is built once per process, before any extension activates, and
 * never re-read. Editing a file afterwards has no effect until the next start,
 * which is what lets an extension be stopped and started again without its
 * configuration changing underneath it.
 * @packageDocumentation
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  decodeExtensionOperatorConfigName,
  encodeExtensionOperatorConfigName,
  EXTENSION_OPERATOR_CONFIG_FILE_SUFFIX,
  type ExtensionOperatorConfigEntry,
  type ExtensionOperatorConfigFailure,
  type ExtensionOperatorConfigFailureReason,
  type ExtensionOperatorConfigSource,
  type JsonValue,
} from '@makaio/contracts';
import { summarizeDiagnosticText } from '@makaio/utils';

/** Path, relative to the Makaio home, of the directory that holds operator config files. */
const OPERATOR_CONFIG_DIR_SEGMENTS = ['config', 'extensions'] as const;

/**
 * Largest operator config file the loader will read into memory.
 *
 * The file is a hand-authored configuration object, so a megabyte is orders of
 * magnitude more than any real one needs. The bound exists because the loader
 * runs before anything else in boot and reads whatever the directory holds: a
 * stray database dump or log file that happens to end in `.json` would
 * otherwise be parsed in full, on the boot path, for an extension that cannot
 * use it. Exceeding it is reported as an unusable entry rather than ignored,
 * because the operator did put a file there.
 */
export const MAX_OPERATOR_CONFIG_BYTES = 1024 * 1024;

/**
 * Position report a JSON parser appends to a syntax error.
 *
 * Only this fragment is reproduced in a diagnostic. The rest of the parser's
 * message quotes the offending input, which may hold values the operator does
 * not expect echoed into logs or persisted as an extension's failure reason.
 */
const JSON_SYNTAX_POSITION_PATTERN = /\bat position \d+(?: \(line \d+ column \d+\))?/u;

/** Options for {@link loadExtensionOperatorConfig}. */
export interface LoadExtensionOperatorConfigOptions {
  /** Absolute Makaio data-home path whose `config/extensions/` directory is scanned. */
  readonly makaioHome: string;
}

/**
 * An immutable operator-config layer that can also be enumerated.
 *
 * {@link ExtensionOperatorConfigSource} answers "what did the operator supply
 * for this extension?", which is all the kernel needs. A composition root needs
 * the inverse question too — "is there an entry nothing will ever read?" — to
 * tell an operator that a file they wrote has no effect. Enumeration is
 * therefore part of the boot-facing type rather than of the kernel contract.
 */
export interface ExtensionOperatorConfigSnapshot extends ExtensionOperatorConfigSource {
  /**
   * Every entry in the snapshot, as `[extension name, entry]` pairs in the
   * order they were captured.
   *
   * A frozen array rather than the lookup structure itself: the snapshot has to
   * answer every lookup with the same entry for the coordinator's lifetime, and
   * handing out the map it looks up in would let whoever holds the snapshot add
   * or drop entries after boot has read it. Enumeration is a report, not a
   * handle on the store.
   */
  readonly entries: readonly (readonly [string, ExtensionOperatorConfigEntry])[];
}

/** The part of a retained package {@link warnOnUnappliedExtensionOperatorConfig} inspects. */
export interface ExtensionOperatorConfigConsumer {
  /** Package name, matched against the name an operator file decodes to. */
  readonly name: string;
  /** The package's config schema, or `undefined` when it declares no configuration surface. */
  readonly configSchema?: unknown;
}

/** One operator config file accepted by the directory scan. */
interface OperatorConfigFile {
  /** Extension name the file's stem decodes to. */
  readonly extensionName: string;
  /** File name as the directory listing reported it, used in diagnostics. */
  readonly fileName: string;
  /** Absolute path to the file. */
  readonly filePath: string;
}

/**
 * Resolve the directory that holds operator-owned extension config files.
 *
 * Exported so a host, a test, or a future scaffolding command names the
 * location through this module rather than restating the path layout.
 * @param makaioHome - Absolute Makaio data-home path.
 * @returns Absolute path to the operator config directory. It is not created.
 */
export function resolveExtensionOperatorConfigDir(makaioHome: string): string {
  return path.join(makaioHome, ...OPERATOR_CONFIG_DIR_SEGMENTS);
}

/**
 * Build an operator-config snapshot from an already-collected set of entries.
 *
 * The scan calls this with what it read; a host embedding the runtime calls it
 * to inject a layer of its own without touching a filesystem.
 *
 * Entries are frozen in place, configuration objects deeply. The contract
 * requires a source to answer every lookup with equivalent values for the
 * coordinator's lifetime, and an extension that is handed a configuration
 * object holds a reference to it — so the guarantee has to be a property of the
 * values themselves, not of this module's discipline in not touching them.
 * Freezing the caller's objects rather than copying them is deliberate: a copy
 * would leave the caller holding a mutable original that silently diverges from
 * what every extension sees.
 *
 * The map the snapshot looks up in is private to it. The caller's map is
 * copied, and enumeration answers with a frozen array of pairs, so nothing the
 * snapshot is handed to can add, drop, or repoint an entry after boot has
 * resolved against it.
 * @param entries - Operator entries keyed by extension name. The map is copied,
 *   so adding or removing entries afterwards cannot change the snapshot; the
 *   entry objects themselves are frozen rather than cloned.
 * @returns An immutable snapshot over those entries.
 */
export function createExtensionOperatorConfigSnapshot(
  entries: ReadonlyMap<string, ExtensionOperatorConfigEntry>,
): ExtensionOperatorConfigSnapshot {
  const captured = new Map<string, ExtensionOperatorConfigEntry>();
  for (const [extensionName, entry] of entries) {
    if (entry.kind === 'config') deepFreeze(entry.config);
    captured.set(extensionName, Object.freeze(entry));
  }
  const listed = Object.freeze([...captured].map((pair) => Object.freeze(pair)));

  // The wrapper is frozen for the same reason its contents are: whoever holds
  // the snapshot must not be able to repoint `get` or `entries` at something
  // else once boot has resolved configuration against it.
  return Object.freeze({
    entries: listed,
    get(extensionName: string): ExtensionOperatorConfigEntry | undefined {
      return captured.get(extensionName);
    },
  });
}

/**
 * Read every operator config file in the Makaio home exactly once.
 *
 * Per-file failure is data, not an exception: a file that cannot be read,
 * cannot be parsed, or does not hold a JSON object becomes a failure entry, so
 * one broken file cannot stop the scan. The failure surfaces when the affected
 * extension activates, where the coordinator's criticality rules decide between
 * isolating that extension and failing boot.
 *
 * Failure of the *directory* is different and does throw. An absent directory
 * is the normal case and yields an empty snapshot with no diagnostic; any other
 * reason the listing cannot be taken — a permission denial, a file where the
 * directory should be — means the operator's configuration cannot be seen at
 * all, and starting every extension without it would look exactly like success.
 * The directory is never created: an empty one would be indistinguishable from
 * "the operator configured nothing", and every home would carry it.
 *
 * Files are read one at a time. A handful of small hand-written files does not
 * need concurrency, and a deterministic order keeps the diagnostics a failing
 * boot prints in the order the directory lists them.
 *
 * Entries that address no extension are skipped: a name that does not end in
 * `.json`, or whose stem is not a canonical encoding of an extension name, is
 * reported and dropped. Dot-prefixed names are skipped silently — a canonical
 * stem never begins with a dot, so an editor lock file such as `.#gateway.json`
 * or a `.DS_Store` is bookkeeping, not something an operator wrote to configure
 * anything.
 *
 * Windows reserves a handful of device names (`con`, `prn`, `aux`, `nul`,
 * `com1`–`com9`, `lpt1`–`lpt9`) that an extension manifest does not exclude, so
 * an extension named for one has no writable operator-config path there. No
 * special handling exists: such a file cannot be created in the first place, so
 * the scan simply never sees it.
 * @param options - Makaio home whose operator config directory is scanned.
 * @returns The snapshot of everything the directory holds.
 * @throws Error When the operator config directory exists but cannot be listed.
 */
export async function loadExtensionOperatorConfig(
  options: LoadExtensionOperatorConfigOptions,
): Promise<ExtensionOperatorConfigSnapshot> {
  const directory = resolveExtensionOperatorConfigDir(options.makaioHome);
  const files = await listOperatorConfigFiles(directory);
  warnOnCaseInsensitiveFileCollisions(files);

  const entries = new Map<string, ExtensionOperatorConfigEntry>();
  for (const file of files) {
    entries.set(file.extensionName, await readOperatorConfigEntry(file.filePath));
  }
  return createExtensionOperatorConfigSnapshot(entries);
}

/**
 * Report operator entries that no extension will ever read.
 *
 * Three shapes are silent without this: a file naming an extension that is not
 * loaded, a file whose name differs in case from the extension it was meant for
 * — which decodes to a name the coordinator's exact, case-sensitive keys never
 * match, so it lands in the same "not loaded" case — and a usable file for an
 * extension that declares no config schema, where config resolution has nothing
 * to parse it into and drops it. All three are operator mistakes that otherwise
 * look exactly like success.
 *
 * Never fatal. An operator who prepares a file for an extension they have not
 * installed yet, or who disables one temporarily, must still be able to boot.
 *
 * Unusable entries for loaded extensions are deliberately not reported here:
 * they are raised when that extension activates, so reporting them twice would
 * only make the activation failure harder to find.
 * @param snapshot - Operator config snapshot built for this process.
 * @param retainedPackages - Packages the coordinator retained for this boot.
 */
export function warnOnUnappliedExtensionOperatorConfig(
  snapshot: ExtensionOperatorConfigSnapshot,
  retainedPackages: readonly ExtensionOperatorConfigConsumer[],
): void {
  const configSchemaByName = new Map(retainedPackages.map((pkg) => [pkg.name, pkg.configSchema]));

  for (const [extensionName, entry] of snapshot.entries) {
    const displayName = summarizeDiagnosticText(extensionName);
    if (!configSchemaByName.has(extensionName)) {
      console.warn(
        `[boot] Operator config ${entry.source} names extension "${displayName}", which is not loaded; it has no effect`,
      );
      continue;
    }
    if (entry.kind === 'config' && configSchemaByName.get(extensionName) === undefined) {
      console.warn(
        `[boot] Operator config ${entry.source} names extension "${displayName}", which declares no config schema; it has no effect`,
      );
    }
  }
}

/**
 * Report loaded extensions that no operator config file can ever name.
 *
 * The encoding is defined for every name an extension realistically carries, but
 * not for all of them: a name whose percent-encoded file name would exceed a
 * filesystem's per-component limit has no stem, and neither has one that is not
 * well-formed Unicode. Such an extension is configurable through every other
 * layer and only through them, which is invisible until an operator writes a
 * file for it and nothing happens — there is no file name for them to have
 * written, so the unapplied-entry check above can never speak for it either.
 *
 * Never fatal: the extension runs, it simply cannot be configured by file.
 * @param retainedPackages - Packages the coordinator retained for this boot.
 */
export function warnOnUnaddressableExtensionOperatorConfigNames(
  retainedPackages: readonly ExtensionOperatorConfigConsumer[],
): void {
  for (const pkg of retainedPackages) {
    if (encodeExtensionOperatorConfigName(pkg.name) !== undefined) continue;
    console.warn(
      `[boot] Extension "${summarizeDiagnosticText(pkg.name)}" has no operator config file name; it cannot be configured from ${OPERATOR_CONFIG_DIR_SEGMENTS.join('/')}`,
    );
  }
}

/**
 * List the operator config files a directory holds, reporting what it ignores.
 * @param directory - Operator config directory to scan.
 * @returns Accepted files in directory-listing order; empty when the directory is absent.
 * @throws Error When the directory exists but its listing cannot be taken.
 */
async function listOperatorConfigFiles(directory: string): Promise<readonly OperatorConfigFile[]> {
  let fileNames: readonly string[];
  try {
    fileNames = await fs.readdir(directory);
  } catch (error) {
    // An absent directory is how a home with no operator configuration looks,
    // and is the overwhelmingly common case. Every other reason hides
    // configuration the operator believes is in effect, which is a boot-time
    // configuration error rather than something to continue past.
    if (isNotFoundError(error)) return [];
    throw new Error(`[boot] Cannot read operator config directory at ${directory}: ${describeIoFailure(error)}`, {
      cause: error,
    });
  }

  const files: OperatorConfigFile[] = [];
  for (const fileName of fileNames) {
    const file = acceptOperatorConfigFile(directory, fileName);
    if (file !== undefined) files.push(file);
  }
  return files;
}

/**
 * Decide whether one directory entry addresses an extension, and report it when it does not.
 * @param directory - Directory the entry was listed from.
 * @param fileName - Entry name exactly as the listing reported it.
 * @returns The accepted file, or `undefined` when the entry addresses no extension.
 */
function acceptOperatorConfigFile(directory: string, fileName: string): OperatorConfigFile | undefined {
  // Checked before the suffix, so `.#gateway.json` is as silent as `.DS_Store`.
  // Nothing addressable is lost: the encoding escapes a leading dot as `%2E`,
  // so a canonical stem never begins with one and a dot-prefixed entry can only
  // ever be editor or platform bookkeeping. Reporting each one would turn every
  // boot on a machine that writes such files into a page of noise about files
  // no operator authored.
  if (fileName.startsWith('.')) return undefined;

  if (!fileName.endsWith(EXTENSION_OPERATOR_CONFIG_FILE_SUFFIX)) {
    console.warn(
      `[boot] Ignoring ${describeDirectoryEntry(directory, fileName)}: operator config file names must end in ${EXTENSION_OPERATOR_CONFIG_FILE_SUFFIX}`,
    );
    return undefined;
  }

  const fileStem = fileName.slice(0, -EXTENSION_OPERATOR_CONFIG_FILE_SUFFIX.length);
  const extensionName = decodeExtensionOperatorConfigName(fileStem);
  if (extensionName === undefined) {
    console.warn(
      `[boot] Ignoring ${describeDirectoryEntry(directory, fileName)}: its name is not the encoded form of any extension name`,
    );
    return undefined;
  }

  return { extensionName, fileName, filePath: path.join(directory, fileName) };
}

/**
 * Report files whose names a case-insensitive filesystem cannot keep apart.
 *
 * Both files are kept. Each is a correctly spelled entry for its own extension,
 * extension names preserve case, and the coordinator's keys are case-sensitive,
 * so each reaches exactly the extension it names. The warning is a portability
 * notice: the same home copied onto APFS or NTFS would hold only one of them.
 *
 * Only whole file names are compared, never decoded extension names. Two
 * non-ASCII names that differ in case — `ä-tools` and `Ä-tools` — encode to
 * `%C3%A4-tools` and `%C3%84-tools`, which differ in more than case and coexist
 * everywhere; folding decoded names would report those as a collision they are
 * not.
 * @param files - Accepted files from one directory listing.
 */
function warnOnCaseInsensitiveFileCollisions(files: readonly OperatorConfigFile[]): void {
  const byFoldedFileName = new Map<string, OperatorConfigFile[]>();
  for (const file of files) {
    const folded = file.fileName.toLowerCase();
    const collected = byFoldedFileName.get(folded);
    if (collected === undefined) byFoldedFileName.set(folded, [file]);
    else collected.push(file);
  }

  for (const collided of byFoldedFileName.values()) {
    if (collided.length < 2) continue;
    const names = collided.map((file) => `"${summarizeDiagnosticText(file.extensionName)}"`).join(', ');
    const fileNames = collided.map((file) => file.fileName).join(', ');
    console.warn(
      `[boot] Operator config files ${fileNames} differ only in case and name extensions ${names}; a case-insensitive filesystem cannot keep them apart`,
    );
  }
}

/**
 * Read and classify one operator config file.
 * @param filePath - Absolute path to the file.
 * @returns The file's configuration object, or the reason it cannot be used.
 */
async function readOperatorConfigEntry(filePath: string): Promise<ExtensionOperatorConfigEntry> {
  let bytes: Uint8Array;
  try {
    const irregularity = await findIrregularFileReason(filePath);
    if (irregularity !== undefined) return operatorConfigFailure(filePath, 'unreadable', irregularity);

    // `O_NONBLOCK` so that opening cannot block even if the entry became a FIFO
    // after the check above: a FIFO with no writer opens immediately instead of
    // parking the boot path. It has no effect on a regular file.
    const handle = await fs.open(filePath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    try {
      // The descriptor, not the path, is what is judged and measured, so an
      // entry swapped between the check above and this open cannot get itself
      // read: whatever was opened has to be a regular file within the bound.
      const opened = await handle.stat();
      if (!opened.isFile()) return operatorConfigFailure(filePath, 'unreadable', 'not a regular file');
      if (opened.size > MAX_OPERATOR_CONFIG_BYTES) {
        return operatorConfigFailure(filePath, 'unreadable', `exceeds ${MAX_OPERATOR_CONFIG_BYTES} bytes`);
      }
      bytes = await handle.readFile();
    } finally {
      await handle.close();
    }
  } catch (error) {
    return operatorConfigFailure(filePath, 'unreadable', describeIoFailure(error));
  }

  let content: string;
  try {
    // Fatal decoding, because the lenient one substitutes U+FFFD for every
    // malformed sequence: a truncated or corrupted file would then parse as a
    // valid object whose strings — URLs, identifiers, credential references —
    // silently differ from what the operator wrote.
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return operatorConfigFailure(filePath, 'invalid-json', 'not valid UTF-8');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    return operatorConfigFailure(filePath, 'invalid-json', describeJsonSyntaxFailure(error));
  }

  if (!isJsonObject(parsed)) {
    return operatorConfigFailure(filePath, 'not-an-object', `top-level value is ${describeJsonKind(parsed)}`);
  }
  return { kind: 'config', source: filePath, config: parsed };
}

/**
 * Decide whether a candidate is something other than a regular file, before it is opened.
 *
 * This is the reporting half of the rule, not the authoritative one. It names
 * what is wrong with a path — a directory, a FIFO, a socket, a device, a
 * dangling symlink — while the entry can still be described, which a descriptor
 * cannot do as precisely. The decision is then confirmed on the opened
 * descriptor, so an entry swapped in between the two calls is still refused.
 *
 * A symlink is resolved to its final target and judged by it, because pointing
 * an operator config file at a file kept elsewhere is a reasonable thing for an
 * operator to do. Everything else is refused.
 * @param filePath - Absolute path to the candidate.
 * @returns A short phrase naming what is wrong, or `undefined` for a regular file.
 * @throws Error When the candidate cannot be inspected at all.
 */
async function findIrregularFileReason(filePath: string): Promise<string | undefined> {
  const listed = await fs.lstat(filePath);
  if (listed.isFile()) return undefined;
  if (listed.isSymbolicLink() && (await fs.stat(filePath)).isFile()) return undefined;
  return 'not a regular file';
}

/**
 * Build a failure entry, omitting a detail the producer could not determine.
 * @param source - Absolute path of the file the entry came from.
 * @param reason - Category of the problem.
 * @param detail - Short explanation, or `undefined` when none is available.
 * @returns The failure entry.
 */
function operatorConfigFailure(
  source: string,
  reason: ExtensionOperatorConfigFailureReason,
  detail: string | undefined,
): ExtensionOperatorConfigFailure {
  return detail === undefined ? { kind: 'failure', source, reason } : { kind: 'failure', source, reason, detail };
}

/**
 * Freeze a JSON tree in place, containers first and then their children.
 *
 * Only arrays and records are walked; every other JSON value is already
 * immutable.
 *
 * The walk keeps its own stack rather than recursing. Nesting depth here is
 * whatever an operator's file contains, bounded only by
 * {@link MAX_OPERATOR_CONFIG_BYTES} — deep enough that recursion would exhaust
 * the call stack and abort boot with an error about stack size rather than
 * about the file.
 *
 * Termination comes from a visited set, not from `Object.isFrozen`. A caller
 * may hand in a value that is already shallow-frozen — a host assembling its
 * own layer plausibly does — and treating frozen as "already done" would stop
 * at the root and leave every nested object mutable, which is precisely the
 * guarantee this exists to provide. `JSON.parse` output has no cycles, but a
 * host-supplied object may, and the visited set covers both that and shared
 * subtrees.
 * @param value - JSON value to freeze.
 */
function deepFreeze(value: unknown): void {
  const visited = new WeakSet<object>();
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current !== 'object' || current === null || visited.has(current)) continue;
    visited.add(current);
    Object.freeze(current);
    for (const child of Object.values(current)) {
      pending.push(child);
    }
  }
}

/**
 * Decide whether a parsed JSON value is the object an operator config must be.
 * @param value - Value `JSON.parse` produced, which is a JSON value by construction.
 * @returns Whether it is a JSON object rather than an array, `null`, or a scalar.
 */
function isJsonObject(value: unknown): value is Readonly<Record<string, JsonValue>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Name the shape of a JSON value that should have been an object.
 * @param value - Parsed top-level value.
 * @returns A short phrase naming its kind, never any of its content.
 */
function describeJsonKind(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}

/**
 * Render a directory entry for a log line.
 *
 * The directory half is ours and is reproduced verbatim; the entry name is
 * whatever the operator put on disk, and a name carrying control characters
 * would otherwise rewrite the terminal reading the warning.
 * @param directory - Directory the entry was listed from.
 * @param fileName - Entry name exactly as the listing reported it.
 * @returns The entry's path, with the entry name flattened to one safe line.
 */
function describeDirectoryEntry(directory: string, fileName: string): string {
  return path.join(directory, summarizeDiagnosticText(fileName));
}

/**
 * Decide whether an error reports a missing filesystem entry.
 * @param error - Error thrown by a filesystem call.
 * @returns Whether it is `ENOENT`.
 */
function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/**
 * Summarize a filesystem failure for a diagnostic.
 *
 * Prefers the error code, which names the problem without reproducing anything
 * the file holds.
 * @param error - Error thrown by a filesystem call.
 * @returns A short phrase describing why the read did not happen.
 */
function describeIoFailure(error: unknown): string {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') return error.code;
  return summarizeDiagnosticText(error instanceof Error ? error.message : String(error));
}

/**
 * Summarize a JSON syntax error without echoing the input that caused it.
 *
 * A parser reports the offending token by quoting the document, so only its
 * position report is reproduced. When the parser gives none — an empty or
 * truncated document — the diagnostic carries the reason alone.
 * @param error - Error thrown by `JSON.parse`.
 * @returns The parser's position report, or `undefined` when it made none.
 */
function describeJsonSyntaxFailure(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : String(error);
  return JSON_SYNTAX_POSITION_PATTERN.exec(message)?.[0];
}
