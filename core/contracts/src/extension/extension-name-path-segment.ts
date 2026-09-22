/**
 * Extension name path-segment codec.
 *
 * Encodes an extension name into a single filesystem path segment safe for use
 * as a directory name (for per-extension data directories) or as an
 * operator-config file stem. Both uses share one rule so a name valid for one
 * is valid for both.
 * @packageDocumentation
 */

/**
 * Characters an encoded path segment reproduces verbatim.
 *
 * Deliberately narrow: lowercase letters, digits, and the three punctuation
 * marks that already appear in ordinary extension names. Everything else is
 * percent-escaped, which keeps path separators, drive-letter colons, and shell
 * metacharacters out of the segment entirely — and, deliberately, keeps every
 * uppercase `A`–`Z` out of it too. An uppercase byte is escaped exactly like
 * any other byte outside this set, so a canonical segment never contains a
 * literal uppercase letter; see the case-folding property in
 * {@link encodeExtensionNameAsPathSegment} for why that closes the
 * case-insensitive-filesystem hazard rather than merely working around it.
 *
 * Exported so every consumer — the data-dir resolver, the operator-config loader,
 * and any tool that creates either — shares one definition of the rule instead of
 * restating it.
 *
 * Position-independent, with two exceptions the encoder applies on top of it: a
 * `.` in first position is escaped, so no segment names a hidden file or
 * directory, and a `.` in last position is escaped, so no segment is one a
 * Windows path component resolver silently shortens. See
 * {@link encodeExtensionNameAsPathSegment}.
 */
export const EXTENSION_NAME_PATH_SEGMENT_UNRESERVED = /^[a-z0-9._-]$/;

/**
 * Suffix every operator-config file carries; JSON is the only accepted format.
 *
 * Exported because a file name is its stem followed by this suffix, and both
 * halves belong to one contract: the length bound below bounds the whole name,
 * and a loader that strips a suffix before decoding must strip exactly this one.
 */
export const EXTENSION_OPERATOR_CONFIG_FILE_SUFFIX = '.json';

/**
 * Longest operator-config file name, in UTF-8 bytes, including the suffix.
 *
 * 255 bytes is the per-component limit of every filesystem a Makaio home is
 * likely to live on — ext4, XFS, btrfs, APFS, and NTFS all stop there or lower.
 * Percent-encoding expands one non-ASCII character to as many as twelve ASCII
 * ones, so a name well inside any manifest rule can still produce a segment that
 * no filesystem accepts; without this bound such a name would be reported as
 * addressable and then fail at `open` with `ENAMETOOLONG`.
 *
 * The bound is on the encoded form rather than on the manifest name, because the
 * encoded form is what has to fit on disk.
 *
 * The bound reserves room for the {@link EXTENSION_OPERATOR_CONFIG_FILE_SUFFIX}
 * even when encoding a data directory name. This is intentional: a name that
 * encodes within the limit is valid for both uses, so there is one addressability
 * rule for the whole codec.
 */
export const MAX_OPERATOR_CONFIG_FILE_NAME_BYTES = 255;

/**
 * Directory segment under the Makaio home that holds all per-extension data
 * directories.
 *
 * The full path for an extension's data directory is
 * `$MAKAIO_HOME/EXTENSION_DATA_DIR_SEGMENT/<encoded>`, where `<encoded>` is
 * the percent-encoded path segment produced by
 * {@link encodeExtensionNameAsPathSegment}. Exporting this constant here keeps
 * the resolver ({@link encodeExtensionNameAsPathSegment}) and every consumer of
 * the layout in agreement on which subdirectory stores extension data, instead
 * of each one hardcoding the literal.
 */
export const EXTENSION_DATA_DIR_SEGMENT = 'data';

/** Names that address a directory position rather than a file, in every filesystem. */
const DOT_SEGMENTS: ReadonlySet<string> = new Set(['.', '..']);

/**
 * Basenames Windows reserves for device I/O rather than for a file or directory,
 * compared case-insensitively against a name up to its first `.`.
 *
 * `NUL`, `COM1`, and the rest of this set open a device on every Windows build
 * currently shipping, not a path under the Makaio home — `CreateFile` on `NUL`
 * opens the null device regardless of which directory precedes it, so no
 * segment can ever address a name in this set there. A name equal to one of
 * these, or beginning with one followed by an extension (`CON.txt`), is
 * therefore unaddressable on every host by the same rule that already governs
 * this codec: one addressability rule for every host, not a host-conditional
 * one. See {@link isAddressableExtensionName}.
 */
const WINDOWS_RESERVED_DEVICE_BASENAMES: ReadonlySet<string> = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
]);

/**
 * Decide whether a name's basename is a reserved Windows device name.
 * @param extensionName - Candidate extension name.
 * @returns Whether the name's basename (everything before its first `.`, or the
 *   whole name when it has none) is in {@link WINDOWS_RESERVED_DEVICE_BASENAMES}.
 */
function isWindowsReservedDeviceName(extensionName: string): boolean {
  const dotIndex = extensionName.indexOf('.');
  const basename = dotIndex === -1 ? extensionName : extensionName.slice(0, dotIndex);
  return WINDOWS_RESERVED_DEVICE_BASENAMES.has(basename.toUpperCase());
}

/**
 * Decide whether a name is one an encoded path segment could stand for at all.
 *
 * Four names are not, and none of them is a name an extension can usefully
 * carry: the empty name and the two dot segments name a directory position
 * rather than a file, a name that is not well-formed Unicode has no faithful
 * byte encoding — UTF-8 encoding replaces an unpaired surrogate with U+FFFD,
 * so `"\uD800"` and `"�"` would claim the same path and the segment would no
 * longer say which extension it belongs to — and a name whose basename is a
 * reserved Windows device name addresses a device, not a path, on that host
 * (see {@link isWindowsReservedDeviceName}). The last of those is rejected on
 * every host, not only Windows: the codec produces one path segment per name
 * for every host, so a name addressable on macOS and not on Windows would work
 * until the same Makaio home is opened from the other host, and the failure
 * would surface far from this rule.
 *
 * This is one half of "addressable"; the other half is the encoded length, a
 * question only the encoded form can answer. Encoding answers `undefined` in
 * both cases, and decoding therefore never produces such a name, because a stem
 * is accepted only when it is what encoding that name produces.
 * @param extensionName - Candidate extension name.
 * @returns Whether an encoded path segment can stand for exactly this name.
 */
function isAddressableExtensionName(extensionName: string): boolean {
  if (extensionName.length === 0 || DOT_SEGMENTS.has(extensionName)) return false;
  if (isWindowsReservedDeviceName(extensionName)) return false;
  // `isWellFormed` is ES2024 and is the whole rule, so no surrogate scan is
  // written out here; it is available in every runtime these contracts target,
  // the same way `TextEncoder` is.
  return extensionName.isWellFormed();
}

/**
 * Encode an extension name as a single filesystem path segment.
 *
 * The rule is percent-encoding over UTF-8: every byte outside
 * {@link EXTENSION_NAME_PATH_SEGMENT_UNRESERVED} becomes `%` followed by two
 * uppercase hex digits. That was chosen over a substitution scheme such as a
 * doubled separator because it is the encoding operators already recognise from
 * URLs, and because it cannot collide — no unreserved character can stand for an
 * escaped one.
 *
 * Four properties matter and all four hold:
 *
 * - **Defined for every addressable name**, including scoped and non-ASCII
 *   ones. The names it is not defined for are the ones no path segment can stand
 *   for (see `isAddressableExtensionName`) and the ones whose encoded form would
 *   not fit a filesystem component (see {@link MAX_OPERATOR_CONFIG_FILE_NAME_BYTES}).
 * - **A single path segment.** `@acme/weather-tools` becomes
 *   `%40acme%2Fweather-tools`, never a nested directory.
 * - **Identity on the common case.** `gateway` stays `gateway`, and so does any
 *   name built from lowercase letters, digits, `.`, `_`, and `-` — which is also
 *   the package-name convention every extension name in this codebase already
 *   follows — so the usual segment is the extension name typed out unchanged.
 *   An uppercase letter changes shape: `Gateway` becomes `%47ateway`, not
 *   `Gateway`. That is the point, not an accident; see case 4 below.
 * - **Injective.** Two different addressable names never produce one segment,
 *   and — because no canonical segment can contain a literal uppercase letter —
 *   no two *distinct* canonical segments can ever be folded onto each other by a
 *   case-insensitive comparison either. A segment names exactly one extension on
 *   every host, including one whose default filesystem ignores case.
 *
 * A leading `.` is escaped for a reason that is not about path syntax: it is
 * unreserved everywhere else in the segment, but a segment that begins with it
 * would produce a path hidden from the operator who has to inspect it, and
 * would be indistinguishable from the editor and platform bookkeeping a
 * Makaio home collects. Escaping it as `%2E` means a canonical segment never
 * begins with a dot, so `.hidden` is addressable as `%2Ehidden` while
 * `.DS_Store` remains something this rule cannot have produced.
 *
 * The four properties above are stated per name; the codec owes callers a
 * fifth one across names: **a name must yield exactly one usable directory on
 * every supported host — macOS, Linux, and Windows — not only on whichever
 * host happens to be running.** A name and a segment that satisfy the four
 * per-name properties can still fail the fifth one, because a host can look at
 * an encoded segment and read a different path component than the bytes that
 * were written, or no component at all. Every way a supported host does that
 * is enumerated here, together with which of the two mechanisms below closes
 * it — so this list, not a changelog of review rounds, is what a future
 * reviewer checks a new host quirk against:
 *
 * 1. **Reserved Windows device basenames** (`CON`, `NUL`, `COM1`, `LPT1`,
 *    …) — {@link isAddressableExtensionName} rejects a name whose basename up
 *    to its first `.` is one of these, case-insensitively, because `CreateFile`
 *    on a name in this set opens a device, not a path, no matter which
 *    directory precedes it or what follows the first `.` (`CON.txt`,
 *    `NUL.tar.gz`). No escape can rescue this — the whole point of the name is
 *    to open the device — so it is rejected rather than escaped, on every host,
 *    not only Windows. A name that merely *resembles* one, such as `CONSOLE`
 *    or `COM10`, keeps its segment.
 * 2. **A trailing `.` on a Windows path component is stripped** by the Win32
 *    layer before the name is resolved, the same mechanism that lets `CON.`
 *    open the device that `CON` does — so `gateway` and `gateway.` would
 *    resolve to the same directory on Windows even though they are two
 *    distinct, valid segments by every property above. Unlike a reserved
 *    basename, this is rescuable: escaping the segment's *last* character as
 *    `%2E` when it is a literal `.` means no canonical segment ends with a
 *    dot, so `gateway.` is addressable as `gateway%2E` and stays distinct from
 *    `gateway` on every host, mirroring the leading-dot escape above. Because
 *    this closes the hazard at the encoding, no case-insensitive-style
 *    collision entry is needed for it — the two names never produce
 *    colliding segments in the first place.
 * 3. **A trailing space on a Windows path component is stripped** the same
 *    way, so `gateway` and `gateway ` would collide by the same mechanism as
 *    (2). This needs no dedicated escape: a space is outside
 *    {@link EXTENSION_NAME_PATH_SEGMENT_UNRESERVED} and is therefore *always*
 *    percent-escaped to `%20` regardless of position, so a canonical segment
 *    can never end — or contain — a literal space for Windows to strip. A name
 *    such as `NUL ` (a reserved basename with a trailing space) is addressable
 *    for the same reason: its segment is `NUL%20`, which is neither the
 *    reserved basename nor something Windows shortens into it.
 * 4. **Case folding on a case-insensitive filesystem** (the default on macOS
 *    and Windows) cannot keep two segments apart that differ only in case —
 *    and, unlike (2) and (3), this cannot be closed by checking the *loaded*
 *    name set, because the other half of a colliding pair need not be loaded
 *    at all: an extension can be uninstalled and leave its data directory
 *    behind, or be filtered onto a different surface, and either way it is
 *    absent from any set a coordinator could inspect while the survivor
 *    starts and is handed the same directory unknowingly. The only knowledge
 *    that is always available is the one name being encoded right now, so the
 *    fix has to live here: every uppercase `A`–`Z` byte is percent-escaped,
 *    exactly like any other byte outside
 *    {@link EXTENSION_NAME_PATH_SEGMENT_UNRESERVED}, so a canonical segment
 *    never contains a literal uppercase letter at all. The only uppercase ASCII
 *    that can appear in a canonical segment is the hex digits `A`–`F` inside an
 *    escape triplet (`%`, followed by two uppercase hex digits), and `%` itself
 *    is always escaped when literal, so every `%` in a canonical segment
 *    starts such a triplet. Case-folding a canonical segment therefore only
 *    ever touches those hex digits, uniformly and in lockstep between any two
 *    segments that agree everywhere else — it can never turn one *distinct*
 *    canonical segment into another, because doing so would require an
 *    uppercase letter outside a triplet to fold onto a literal character, and
 *    no literal character is ever uppercase. `Gateway` and `gateway` — the
 *    case this closes concretely — encode to `%47ateway` and `gateway`, which
 *    share no literal uppercase letter to fold and therefore cannot collide on
 *    any host. This is why no load-set collision detector is needed for this
 *    codec any more: distinctness is now a property of one name at a time, not
 *    of a set the coordinator happens to have assembled.
 * 5. **Unicode normalisation-insensitive comparison**, which macOS's default
 *    APFS format performs (verified directly: creating a directory named with
 *    the NFC form of `café` and then the NFD form of the same text on this
 *    codec's own development host fails the second `mkdir` with `EEXIST`,
 *    even though the two names are different byte sequences), cannot collide
 *    two segments this function produces, because normalisation-insensitive
 *    comparison only folds *combining* Unicode sequences into their composed
 *    or decomposed equivalent, and every byte outside
 *    {@link EXTENSION_NAME_PATH_SEGMENT_UNRESERVED} — which is exactly the set
 *    of bytes normalisation could ever fold — is percent-escaped into three
 *    literal ASCII characters that are not combining sequences and do not
 *    themselves have a second normalised form. Two Unicode-normalisation
 *    variants of one name, such as the NFC and NFD spellings of `café`,
 *    therefore encode to two segments (`caf%C3%A9` and `cafe%CC%81`) that stay
 *    distinct on every host without any additional escape or collision check.
 *
 * Two more properties of the encoding matter because a host has no
 * normalisation to defend against them: a name whose basename is a reserved
 * Windows device name has no rescuable segment (case 1, above, restated as an
 * exhaustiveness note), and 8.3 short-name generation on NTFS — a Windows
 * feature, often disabled, that derives a second, shortened alias for a long
 * name from filesystem-generated state this codec cannot predict — is a known,
 * unaddressed limitation: a manifest name could in principle collide with
 * another extension's *generated* short alias, but only NTFS decides that
 * alias, so no encoding choice here can rule it out. The failure mode is a
 * loud `EEXIST` at directory creation, not the silent data-sharing every other
 * item in this list defends against, so it is documented rather than
 * engineered around.
 *
 * The encoded segment fits within {@link MAX_OPERATOR_CONFIG_FILE_NAME_BYTES}
 * minus the {@link EXTENSION_OPERATOR_CONFIG_FILE_SUFFIX} length. This shared
 * bound means a name encodable as a data-directory segment is also encodable as
 * an operator-config file stem, and vice versa.
 * @param extensionName - Extension manifest name to encode.
 * @returns The path segment for that name, or `undefined` when no segment can
 *   address the name on every supported host (empty name, dot segment,
 *   non-well-formed Unicode, a reserved Windows device basename, or encoded
 *   form too long for a filesystem component).
 */
export function encodeExtensionNameAsPathSegment(extensionName: string): string | undefined {
  if (!isAddressableExtensionName(extensionName)) return undefined;

  const bytes = new TextEncoder().encode(extensionName);
  const lastIndex = bytes.length - 1;
  let segment = '';
  for (const [index, byte] of bytes.entries()) {
    const char = String.fromCharCode(byte);
    const isEdge = index === 0 || index === lastIndex;
    const isVerbatim = EXTENSION_NAME_PATH_SEGMENT_UNRESERVED.test(char) && !(isEdge && char === '.');
    segment += isVerbatim ? char : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  // A segment is ASCII by construction, so its length is its byte count and the
  // file name's byte count is that plus the suffix.
  if (segment.length + EXTENSION_OPERATOR_CONFIG_FILE_SUFFIX.length > MAX_OPERATOR_CONFIG_FILE_NAME_BYTES) {
    return undefined;
  }
  return segment;
}

/**
 * Decode an encoded path segment back to the extension name it addresses.
 *
 * The inverse of {@link encodeExtensionNameAsPathSegment}, and strict about it:
 * a segment is accepted only when it is exactly what encoding that name produces.
 * Lowercase escapes, escapes for characters that need none, and unescaped
 * characters outside the unreserved set are all rejected, so one extension has
 * one spelling and a scan cannot bind two segments to the same extension.
 *
 * Rejection is not a failure to report to an operator by itself — a segment that
 * does not decode simply does not address any extension. The caller decides
 * whether that deserves a diagnostic, exactly as it does for a segment that
 * decodes to an extension it has not loaded.
 * @param segment - Candidate path segment, with any file extension already removed
 *   when decoding an operator-config file stem.
 * @returns The extension name, or `undefined` when the segment is not a canonical
 *   encoding of one. A segment that spells a name no file can address — the empty
 *   name, a dot segment, or one that is not well-formed Unicode — is rejected by
 *   the same round-trip, because encoding such a name produces no segment at all —
 *   and so is a segment that begins or ends with a literal dot, or one whose
 *   encoded form would exceed {@link MAX_OPERATOR_CONFIG_FILE_NAME_BYTES}. A name
 *   that contains dots anywhere but first or last, such as `com.example.tools`, is
 *   accepted; a name that begins or ends with one is spelled `%2Ehidden` or
 *   `gateway%2E`, never `.hidden` or `gateway.`. A segment spelled `CON` or
 *   `COM1.log` is rejected too, because a reserved Windows device basename has no
 *   segment at all — encoding it produces `undefined`, not a literal spelling for
 *   the round-trip to match.
 */
export function decodeExtensionNamePathSegment(segment: string): string | undefined {
  const bytes = readEncodedBytes(segment);
  if (bytes === undefined) return undefined;

  let name: string;
  try {
    // `ignoreBOM` keeps a leading U+FEFF as a character of the name. The
    // default would consume it, and a name beginning with U+FEFF — which
    // encodes to `%EF%BB%BF...` and is addressable — would then decode to a
    // different name, fail the round-trip below, and have its correctly named
    // path rejected. This decodes a name, not a document, so there is no byte
    // order to mark.
    name = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(new Uint8Array(bytes));
  } catch {
    return undefined;
  }

  return encodeExtensionNameAsPathSegment(name) === segment ? name : undefined;
}

/**
 * Read a segment's literal and percent-escaped characters as UTF-8 bytes.
 * @param segment - Candidate path segment to read.
 * @returns The bytes it spells, or `undefined` when its syntax is not that of a segment.
 */
function readEncodedBytes(segment: string): number[] | undefined {
  const bytes: number[] = [];
  let index = 0;

  while (index < segment.length) {
    const char = segment.charAt(index);
    if (char !== '%') {
      if (!EXTENSION_NAME_PATH_SEGMENT_UNRESERVED.test(char)) return undefined;
      bytes.push(char.charCodeAt(0));
      index += 1;
      continue;
    }
    const hexDigits = segment.slice(index + 1, index + 3);
    if (!/^[0-9A-Fa-f]{2}$/.test(hexDigits)) return undefined;
    bytes.push(Number.parseInt(hexDigits, 16));
    index += 3;
  }

  return bytes;
}
