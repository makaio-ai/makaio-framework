/**
 * Characters an operator-config file stem reproduces verbatim.
 *
 * Deliberately narrow: letters, digits, and the three punctuation marks that
 * already appear in ordinary extension names. Everything else is percent-escaped,
 * which keeps path separators, drive-letter colons, and shell metacharacters out
 * of the stem entirely.
 *
 * Exported so the loader, its diagnostics, and any tool that offers to create an
 * operator-config file share one definition of the rule instead of restating it.
 *
 * Position-independent, with one exception the encoder applies on top of it: a
 * `.` in first position is escaped, so no stem names a hidden file. See
 * {@link encodeExtensionOperatorConfigName}.
 */
export const EXTENSION_OPERATOR_CONFIG_NAME_UNRESERVED = /^[A-Za-z0-9._-]$/;

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
 * ones, so a name well inside any manifest rule can still produce a stem no
 * filesystem accepts; without this bound such a name would be reported as
 * addressable and then fail at `open` with `ENAMETOOLONG`.
 *
 * The bound is on the encoded form rather than on the manifest name, because the
 * encoded form is what has to fit on disk.
 */
export const MAX_OPERATOR_CONFIG_FILE_NAME_BYTES = 255;

/** Names that address a directory position rather than a file, in every filesystem. */
const DOT_SEGMENTS: ReadonlySet<string> = new Set(['.', '..']);

/**
 * Decide whether a name is one an operator-config file could stand for at all.
 *
 * Three names are not, and none of them is a name an extension can usefully
 * carry: the empty name and the two dot segments name a directory position
 * rather than a file, and a name that is not well-formed Unicode has no
 * faithful byte encoding — UTF-8 encoding replaces an unpaired surrogate with
 * U+FFFD, so `"\uD800"` and `"\uFFFD"` would claim the same file and the
 * stem would no longer say which extension it belongs to.
 *
 * This is one half of "addressable"; the other half is the encoded length, a
 * question only the encoded form can answer. Encoding answers `undefined` in
 * both cases, and decoding therefore never produces such a name, because a stem
 * is accepted only when it is what encoding that name produces.
 * @param extensionName - Candidate extension name.
 * @returns Whether one operator-config file can stand for exactly this name.
 */
function isAddressableExtensionName(extensionName: string): boolean {
  if (extensionName.length === 0 || DOT_SEGMENTS.has(extensionName)) return false;
  // `isWellFormed` is ES2024 and is the whole rule, so no surrogate scan is
  // written out here; it is available in every runtime these contracts target,
  // the same way `TextEncoder` is.
  return extensionName.isWellFormed();
}

/**
 * Encode an extension name as a single operator-config file stem.
 *
 * The rule is percent-encoding over UTF-8: every byte outside
 * {@link EXTENSION_OPERATOR_CONFIG_NAME_UNRESERVED} becomes `%` followed by two
 * uppercase hex digits. That was chosen over a substitution scheme such as a
 * doubled separator because it is the encoding operators already recognise from
 * URLs, and because it cannot collide — no unreserved character can stand for an
 * escaped one.
 *
 * Four properties matter and all four hold:
 *
 * - **Defined for every addressable name**, including scoped and non-ASCII
 *   ones. The names it is not defined for are the ones no file can stand for
 *   (see {@link isAddressableExtensionName}) and the ones whose file name would
 *   not fit a filesystem component (see
 *   {@link MAX_OPERATOR_CONFIG_FILE_NAME_BYTES}).
 * - **A single path segment.** `@acme/weather-tools` becomes
 *   `%40acme%2Fweather-tools`, never a nested directory.
 * - **Identity on the common case.** `gateway` stays `gateway`, and so does any
 *   name built from letters, digits, `.`, `_`, and `-`, so the usual file stem
 *   is the extension name typed out unchanged.
 * - **Injective.** Two different addressable names never produce one stem, so a
 *   stem names exactly one extension.
 *
 * A leading `.` is the one character escaped for a reason that is not about
 * path syntax: it is unreserved everywhere else in the stem, but a stem that
 * begins with it would produce a file hidden from the very operator who has to
 * edit it, and would be indistinguishable from the editor and platform
 * bookkeeping a Makaio home collects. Escaping it as `%2E` means a canonical
 * stem never begins with a dot, so `.hidden` is addressable as
 * `%2Ehidden.json` while `.DS_Store` remains something this rule cannot have
 * produced.
 *
 * Case is preserved, because extension names preserve case. Two names differing
 * only in case therefore produce two stems that a case-insensitive filesystem
 * cannot keep apart; detecting that collision belongs to whoever scans the
 * directory, not to this pure rule.
 * @param extensionName - Extension manifest name to encode.
 * @returns The file stem for that name, without any file extension, or
 *   `undefined` when no operator-config file can address the name.
 */
export function encodeExtensionOperatorConfigName(extensionName: string): string | undefined {
  if (!isAddressableExtensionName(extensionName)) return undefined;

  let stem = '';
  for (const byte of new TextEncoder().encode(extensionName)) {
    const char = String.fromCharCode(byte);
    const isVerbatim = EXTENSION_OPERATOR_CONFIG_NAME_UNRESERVED.test(char) && !(stem.length === 0 && char === '.');
    stem += isVerbatim ? char : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  // A stem is ASCII by construction, so its length is its byte count and the
  // file name's byte count is that plus the suffix.
  if (stem.length + EXTENSION_OPERATOR_CONFIG_FILE_SUFFIX.length > MAX_OPERATOR_CONFIG_FILE_NAME_BYTES) {
    return undefined;
  }
  return stem;
}

/**
 * Decode an operator-config file stem back to the extension name it addresses.
 *
 * The inverse of {@link encodeExtensionOperatorConfigName}, and strict about it:
 * a stem is accepted only when it is exactly what encoding that name produces.
 * Lowercase escapes, escapes for characters that need none, and unescaped
 * characters outside the unreserved set are all rejected, so one extension has
 * one spelling and a scan cannot bind two stems to the same extension.
 *
 * Rejection is not a failure to report to an operator by itself — a stem that
 * does not decode simply does not address any extension. The caller decides
 * whether that deserves a diagnostic, exactly as it does for a stem that decodes
 * to an extension it has not loaded.
 * @param fileStem - Candidate file stem, with any file extension already removed.
 * @returns The extension name, or `undefined` when the stem is not a canonical
 *   encoding of one. A stem that spells a name no file can address — the empty
 *   name, a dot segment, or one that is not well-formed Unicode — is rejected
 *   by the same round-trip, because encoding such a name produces no stem at
 *   all — and so is a stem that begins with a dot, or one whose file name would
 *   exceed {@link MAX_OPERATOR_CONFIG_FILE_NAME_BYTES}. A name that contains
 *   dots anywhere but first, such as `com.example.tools` or `x..`, is accepted;
 *   a name that begins with one is spelled `%2Ehidden`, not `.hidden`.
 */
export function decodeExtensionOperatorConfigName(fileStem: string): string | undefined {
  const bytes = readEncodedBytes(fileStem);
  if (bytes === undefined) return undefined;

  let name: string;
  try {
    // `ignoreBOM` keeps a leading U+FEFF as a character of the name. The
    // default would consume it, and a name beginning with U+FEFF — which
    // encodes to `%EF%BB%BF...` and is addressable — would then decode to a
    // different name, fail the round-trip below, and have its correctly named
    // file rejected. This decodes a name, not a document, so there is no byte
    // order to mark.
    name = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(new Uint8Array(bytes));
  } catch {
    return undefined;
  }

  return encodeExtensionOperatorConfigName(name) === fileStem ? name : undefined;
}

/**
 * Read a stem's literal and percent-escaped characters as UTF-8 bytes.
 * @param fileStem - Candidate file stem to read.
 * @returns The bytes it spells, or `undefined` when its syntax is not that of a stem.
 */
function readEncodedBytes(fileStem: string): number[] | undefined {
  const bytes: number[] = [];
  let index = 0;

  while (index < fileStem.length) {
    const char = fileStem.charAt(index);
    if (char !== '%') {
      if (!EXTENSION_OPERATOR_CONFIG_NAME_UNRESERVED.test(char)) return undefined;
      bytes.push(char.charCodeAt(0));
      index += 1;
      continue;
    }
    const hexDigits = fileStem.slice(index + 1, index + 3);
    if (!/^[0-9A-Fa-f]{2}$/.test(hexDigits)) return undefined;
    bytes.push(Number.parseInt(hexDigits, 16));
    index += 3;
  }

  return bytes;
}
