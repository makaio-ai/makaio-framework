import { describe, it, expect } from 'vitest';
import {
  decodeExtensionNamePathSegment,
  encodeExtensionNameAsPathSegment,
  EXTENSION_OPERATOR_CONFIG_FILE_SUFFIX,
  EXTENSION_NAME_PATH_SEGMENT_UNRESERVED,
  MAX_OPERATOR_CONFIG_FILE_NAME_BYTES,
} from '../extension-name-path-segment.js';

/** Extension names spanning every shape the manifest name rule accepts. */
const ROUND_TRIP_NAMES = [
  'gateway',
  'account-manager',
  'my_extension',
  'com.example.tools',
  'Gateway',
  '@acme/weather-tools',
  '@acme/tools.v2',
  'name with spaces',
  'ünïcödé-extension',
  '日本語',
  'percent%name',
  'plus+name',
  '.hidden',
  '...',
  'gateway.',
  'gateway..',
  'x.',
  '.x.',
  'café'.normalize('NFC'),
  'café'.normalize('NFD'),
  '.Gateway',
  'Gateway.',
] as const;

/**
 * Longest path segment the encoding may produce, given the file name bound.
 *
 * Restated from the two constants rather than written out, so a change to
 * either is a change to what this test expects.
 */
const MAX_SEGMENT_LENGTH = MAX_OPERATOR_CONFIG_FILE_NAME_BYTES - EXTENSION_OPERATOR_CONFIG_FILE_SUFFIX.length;

/**
 * Encode a name the test states is addressable, failing loudly when it is not.
 * @param name - Extension name the test expects to have a path segment.
 * @returns That name's path segment.
 */
function segmentOf(name: string): string {
  const segment = encodeExtensionNameAsPathSegment(name);
  if (segment === undefined) throw new Error(`expected "${name}" to be addressable`);
  return segment;
}

describe('extension name path-segment encoding', () => {
  it('leaves an unscoped name of unreserved characters unchanged', () => {
    expect(encodeExtensionNameAsPathSegment('gateway')).toBe('gateway');
    expect(encodeExtensionNameAsPathSegment('com.example_tools-v2')).toBe('com.example_tools-v2');
  });

  it('collapses a scoped name into a single path segment', () => {
    expect(encodeExtensionNameAsPathSegment('@acme/weather-tools')).toBe('%40acme%2Fweather-tools');
  });

  it.each(ROUND_TRIP_NAMES)('round-trips %s', (name) => {
    expect(decodeExtensionNamePathSegment(segmentOf(name))).toBe(name);
  });

  it.each(ROUND_TRIP_NAMES)('produces a segment free of path separators for %s', (name) => {
    const segment = segmentOf(name);
    // Walk the segment as the codec's own grammar defines it: a literal
    // unreserved character, or a `%` followed by two hex digits. A bare loop
    // over individual characters would wrongly reject the hex digits of an
    // escape triplet, since `A`-`F` are not themselves unreserved.
    let index = 0;
    while (index < segment.length) {
      if (segment[index] === '%') {
        expect(segment.slice(index + 1, index + 3)).toMatch(/^[0-9A-F]{2}$/);
        index += 3;
        continue;
      }
      expect(EXTENSION_NAME_PATH_SEGMENT_UNRESERVED.test(segment[index]!)).toBe(true);
      index += 1;
    }
    expect(segment).not.toMatch(/[/\\:]/);
  });

  it.each(ROUND_TRIP_NAMES)('produces a segment with no literal uppercase letter for %s', (name) => {
    // The whole injectivity argument under case folding rests on this: every
    // uppercase ASCII byte is escaped, so the only uppercase letters that can
    // ever appear in a canonical segment are the hex digits `A`-`F` inside an
    // escape triplet, which fold in lockstep rather than colliding with
    // anything else.
    const segment = segmentOf(name);
    for (let index = 0; index < segment.length; index += 1) {
      if (/[A-Z]/.test(segment[index]!)) {
        // Every uppercase letter must be a hex digit immediately preceded by
        // a `%` two positions back, i.e. the second or third character of an
        // escape triplet.
        const tripletStart = segment[index - 1] === '%' ? index - 1 : index - 2;
        expect(segment[tripletStart]).toBe('%');
      }
    }
  });

  it('escapes with uppercase hex digits', () => {
    expect(encodeExtensionNameAsPathSegment('a b')).toBe('a%20b');
  });

  it('escapes every uppercase letter, so the encoded form of an uppercase name changes shape', () => {
    expect(encodeExtensionNameAsPathSegment('Gateway')).toBe('%47ateway');
    expect(encodeExtensionNameAsPathSegment('GATEWAY')).toBe('%47%41%54%45%57%41%59');
  });

  it('keeps `Gateway` and `gateway` on distinct segments that stay distinct after case folding', () => {
    const upper = segmentOf('Gateway');
    const lower = segmentOf('gateway');
    expect(upper).not.toBe(lower);
    // The whole point of escaping case in the encoder: a case-insensitive
    // filesystem folds both segments before comparing them, so the segments
    // themselves — not just the original names — must stay apart.
    expect(upper.toLowerCase()).not.toBe(lower.toLowerCase());
  });

  it('keeps two segments distinct after case folding for every round-trip name that has an uppercase counterpart', () => {
    // A stronger, general form of the `Gateway`/`gateway` case above: for every
    // name in the round-trip set, swapping the case of one ASCII letter must
    // never produce a segment that folds onto the original's segment, because
    // that swap changes an escaped uppercase byte to an escaped lowercase one
    // (or vice versa) and canonical escape triplets never fold onto each other.
    for (const name of ROUND_TRIP_NAMES) {
      const swapped = [...name].map((char) => (/[a-z]/.test(char) ? char.toUpperCase() : char.toLowerCase())).join('');
      if (swapped === name) continue;
      const original = encodeExtensionNameAsPathSegment(name);
      const swappedSegment = encodeExtensionNameAsPathSegment(swapped);
      if (original === undefined || swappedSegment === undefined) continue;
      expect(original.toLowerCase()).not.toBe(swappedSegment.toLowerCase());
    }
  });

  it('escapes a mixed-case leading dot so the escape and the uppercase letter both hold', () => {
    expect(encodeExtensionNameAsPathSegment('.Gateway')).toBe('%2E%47ateway');
    expect(decodeExtensionNamePathSegment('%2E%47ateway')).toBe('.Gateway');
  });

  it('escapes a mixed-case trailing dot so the escape and the uppercase letter both hold', () => {
    expect(encodeExtensionNameAsPathSegment('Gateway.')).toBe('%47ateway%2E');
    expect(decodeExtensionNamePathSegment('%47ateway%2E')).toBe('Gateway.');
  });

  it('rejects a mixed-case reserved Windows device basename regardless of the case escape', () => {
    // A reserved basename has no rescuable segment at all (case 1 in the
    // codec's own TSDoc): the case-insensitivity of the basename comparison
    // is independent of, and unaffected by, the case-escaping mechanism that
    // closes the filesystem-level case-folding hazard.
    expect(encodeExtensionNameAsPathSegment('CoM1')).toBeUndefined();
    expect(encodeExtensionNameAsPathSegment('con')).toBeUndefined();
    expect(encodeExtensionNameAsPathSegment('Con.txt')).toBeUndefined();
  });

  it.each([
    ['a lowercase escape', '%40acme%2fweather-tools'],
    ['an escape for a character that needs none', '%67ateway'],
    ['a truncated escape', 'gateway%2'],
    ['a non-hex escape', 'gate%zzway'],
    ['an unescaped separator', 'acme/tools'],
    ['an unescaped colon', 'c:tools'],
    ['a current-directory segment', '.'],
    ['a parent-directory segment', '..'],
    ['an empty segment', ''],
  ])('rejects %s', (_label, segment) => {
    expect(decodeExtensionNamePathSegment(segment)).toBeUndefined();
  });

  it('rejects an escape sequence that is not valid UTF-8', () => {
    expect(decodeExtensionNamePathSegment('%FF')).toBeUndefined();
  });

  it('escapes a leading dot so no segment it produces starts with a dot', () => {
    expect(encodeExtensionNameAsPathSegment('.hidden')).toBe('%2Ehidden');
  });

  it('escapes a trailing dot so no segment it produces ends with a dot', () => {
    expect(encodeExtensionNameAsPathSegment('gateway.')).toBe('gateway%2E');
    expect(encodeExtensionNameAsPathSegment('x.')).toBe('x%2E');
  });

  it('escapes only the outermost dots of a name with several leading and trailing dots', () => {
    // The two outer dots each sit at an edge and are escaped; the one in the
    // middle needs no escape, because only the segment's first and last
    // character can be silently stripped by a Windows path resolver.
    expect(encodeExtensionNameAsPathSegment('...')).toBe('%2E.%2E');
    expect(encodeExtensionNameAsPathSegment('x..')).toBe('x.%2E');
    expect(encodeExtensionNameAsPathSegment('.x.')).toBe('%2Ex%2E');
  });

  it('keeps dots that are neither leading nor trailing verbatim', () => {
    expect(encodeExtensionNameAsPathSegment('com.example.tools')).toBe('com.example.tools');
  });

  it('never produces a segment a Windows path resolver would shorten to a different one', () => {
    // `gateway` and `gateway.` are two distinct, valid manifest names; without
    // the trailing-dot escape they would both resolve to the Windows path
    // component `gateway`, silently sharing one data directory.
    expect(encodeExtensionNameAsPathSegment('gateway')).toBe('gateway');
    expect(encodeExtensionNameAsPathSegment('gateway.')).not.toBe(encodeExtensionNameAsPathSegment('gateway'));
  });

  it('never produces a segment containing a literal space, so a Windows path resolver has none to strip', () => {
    // A space is always percent-escaped regardless of position, so this needs
    // no dedicated trailing-space rule the way the dot does.
    expect(encodeExtensionNameAsPathSegment('gateway ')).toBe('gateway%20');
    expect(encodeExtensionNameAsPathSegment('gateway ')).not.toBe(encodeExtensionNameAsPathSegment('gateway'));
  });

  it('keeps two Unicode-normalisation variants of one name on two distinct segments', () => {
    // macOS's default APFS format folds these two byte sequences together for
    // lookup (verified separately against the real filesystem), but neither
    // segment below contains a literal combining sequence for a host to fold.
    const nfc = 'café'.normalize('NFC');
    const nfd = 'café'.normalize('NFD');
    expect(nfc).not.toBe(nfd);
    expect(encodeExtensionNameAsPathSegment(nfc)).toBe('caf%C3%A9');
    expect(encodeExtensionNameAsPathSegment(nfd)).toBe('cafe%CC%81');
    expect(encodeExtensionNameAsPathSegment(nfc)).not.toBe(encodeExtensionNameAsPathSegment(nfd));
  });

  it.each([
    ['a segment spelled with a literal leading dot', '.hidden'],
    ['a segment spelled with a literal trailing dot', 'gateway.'],
    ['a segment that is only literal dots', '...'],
    ['platform bookkeeping that survives the suffix check', '.DS_Store'],
  ])('rejects %s, which the encoding cannot have produced', (_label, segment) => {
    expect(decodeExtensionNamePathSegment(segment)).toBeUndefined();
  });

  it('gives a name no segment once its file name would pass the component limit', () => {
    expect(segmentOf('a'.repeat(MAX_SEGMENT_LENGTH))).toHaveLength(MAX_SEGMENT_LENGTH);
    expect(encodeExtensionNameAsPathSegment('a'.repeat(MAX_SEGMENT_LENGTH + 1))).toBeUndefined();
  });

  it('measures the bound on the encoded name, not on the name as typed', () => {
    // 43 two-byte characters are 43 characters and 258 encoded ones.
    const name = 'ü'.repeat(43);
    expect(name).toHaveLength(43);
    expect(encodeExtensionNameAsPathSegment(name)).toBeUndefined();
  });

  it('never produces a file name above the bound for a name it accepts', () => {
    // 41 two-byte characters encode to 246 characters, the longest such name
    // that still fits.
    for (const name of [...ROUND_TRIP_NAMES, 'a'.repeat(MAX_SEGMENT_LENGTH), 'ü'.repeat(41)]) {
      const fileName = `${segmentOf(name)}${EXTENSION_OPERATOR_CONFIG_FILE_SUFFIX}`;
      expect(new TextEncoder().encode(fileName).byteLength).toBeLessThanOrEqual(MAX_OPERATOR_CONFIG_FILE_NAME_BYTES);
    }
  });

  it.each([
    ['a lone high surrogate', '\uD800'],
    ['a lone low surrogate', '\uDFFF'],
    ['a name that only partly pairs its surrogates', 'tools-\uD83D'],
    ['an empty name', ''],
    ['a current-directory name', '.'],
    ['a parent-directory name', '..'],
  ])('encodes %s to no segment at all', (_label, name) => {
    expect(encodeExtensionNameAsPathSegment(name)).toBeUndefined();
  });

  it.each([
    ['the bare basename', 'CON'],
    ['a different case of the bare basename', 'con'],
    ['mixed case', 'CoM1'],
    ['every reserved COM port', 'COM9'],
    ['every reserved LPT port', 'LPT9'],
    ['the basename followed by an extension', 'CON.txt'],
    ['a multi-dot name whose first component is the basename', 'NUL.tar.gz'],
    ['the basename followed by a trailing dot', 'NUL.'],
  ])('gives no segment to a reserved Windows device basename: %s (%s)', (_label, name) => {
    expect(encodeExtensionNameAsPathSegment(name)).toBeUndefined();
  });

  it.each([
    ['the basename is only a prefix', 'CONSOLE'],
    ['the basename is not first', 'tools-CON'],
    ['a reserved port number out of range', 'COM10'],
    ['a dot after a look-alike prefix', 'CON2.txt'],
    // A trailing space is never left literal in the segment (it is
    // percent-escaped regardless of position), so the basename check —
    // which compares the raw name up to its first `.` — correctly leaves
    // this addressable: its segment is `NUL%20`, not the literal basename
    // `NUL` a Windows path resolver would otherwise strip it down to.
    ['the basename followed only by a trailing space', 'NUL '],
  ])('keeps a segment for a name that only resembles a reserved basename: %s (%s)', (_label, name) => {
    expect(encodeExtensionNameAsPathSegment(name)).toBeDefined();
  });

  it('keeps distinct names on distinct segments where UTF-8 encoding would fold them', () => {
    // `TextEncoder` turns an unpaired surrogate into U+FFFD, so encoding both
    // names would hand them the same path and a segment would no longer say which
    // extension it belongs to. The ill-formed one gets no segment instead.
    expect(encodeExtensionNameAsPathSegment('\uD800')).toBeUndefined();
    expect(segmentOf('\uFFFD')).toBe('%EF%BF%BD');
    expect(decodeExtensionNamePathSegment('%EF%BF%BD')).toBe('\uFFFD');
  });

  it('keeps a leading byte-order mark, which is a character of the name and not a document marker', () => {
    // A decoder that consumed it would answer a different name, the round-trip
    // would fail, and the correctly named path would be rejected.
    const name = '﻿tools';
    expect(segmentOf(name)).toBe('%EF%BB%BFtools');
    expect(decodeExtensionNamePathSegment('%EF%BB%BFtools')).toBe(name);
    expect(decodeExtensionNamePathSegment('%EF%BB%BFtools')).not.toBe('tools');
  });

  it('keeps an astral character, which is a well-formed surrogate pair', () => {
    expect(decodeExtensionNamePathSegment(segmentOf('emoji-\u{1F680}'))).toBe('emoji-\u{1F680}');
  });
});
