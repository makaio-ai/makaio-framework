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
 */
export const EXTENSION_OPERATOR_CONFIG_NAME_UNRESERVED = /^[A-Za-z0-9._-]$/;

/** Names that address a directory position rather than a file, in every filesystem. */
const DOT_SEGMENTS: ReadonlySet<string> = new Set(['.', '..']);

/**
 * Decide whether a name can be addressed by an operator-config file at all.
 *
 * Three names cannot, and none of them is a name an extension can usefully
 * carry: the empty name and the two dot segments name a directory position
 * rather than a file, and a name that is not well-formed Unicode has no
 * faithful byte encoding — UTF-8 encoding replaces an unpaired surrogate with
 * U+FFFD, so `"\uD800"` and `"\uFFFD"` would claim the same file and the
 * stem would no longer say which extension it belongs to.
 *
 * This is the single definition of "addressable": encoding answers `undefined`
 * for such a name, and decoding therefore never produces one, because a stem is
 * accepted only when it is what encoding that name produces.
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
 * Three properties matter and all three hold:
 *
 * - **Defined for every addressable name**, including scoped and non-ASCII
 *   ones. The names it is not defined for are the ones no file can stand for;
 *   see {@link isAddressableExtensionName}.
 * - **A single path segment.** `@acme/weather-tools` becomes
 *   `%40acme%2Fweather-tools`, never a nested directory.
 * - **Identity on the common case.** `gateway` stays `gateway`, and so does any
 *   name built from letters, digits, `.`, `_`, and `-`, so the usual file stem
 *   is the extension name typed out unchanged.
 * - **Injective.** Two different addressable names never produce one stem, so a
 *   stem names exactly one extension.
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
    stem += EXTENSION_OPERATOR_CONFIG_NAME_UNRESERVED.test(char)
      ? char
      : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
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
 *   all. A name that merely contains dots, such as `.hidden` or `...`, is
 *   accepted.
 */
export function decodeExtensionOperatorConfigName(fileStem: string): string | undefined {
  const bytes = readEncodedBytes(fileStem);
  if (bytes === undefined) return undefined;

  let name: string;
  try {
    name = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes));
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
