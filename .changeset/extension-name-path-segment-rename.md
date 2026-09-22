---
'@makaio/contracts': major
---

Rename the extension-name codec from operator-config-specific names to neutral
path-segment names.

The codec is now used for both operator-config file stems and per-extension data
directory segments, so the old operator-config-only names no longer describe it.

Breaking renames (no compatibility re-exports — this project is pre-release):

- `encodeExtensionOperatorConfigName` → `encodeExtensionNameAsPathSegment`
- `decodeExtensionOperatorConfigName` → `decodeExtensionNamePathSegment`
- `EXTENSION_OPERATOR_CONFIG_NAME_UNRESERVED` → `EXTENSION_NAME_PATH_SEGMENT_UNRESERVED`
- Source module `extension-operator-config-name.ts` → `extension-name-path-segment.ts`

Stable names unchanged: `EXTENSION_OPERATOR_CONFIG_FILE_SUFFIX`,
`MAX_OPERATOR_CONFIG_FILE_NAME_BYTES`.

New export: `EXTENSION_DATA_DIR_SEGMENT` — the `'data'` subdirectory name used
for per-extension data directories under the Makaio home. Exported from the
codec module so the resolver and every consumer of the layout agree on which
subdirectory stores extension data, instead of each one hardcoding the literal.

The `MAX_OPERATOR_CONFIG_FILE_NAME_BYTES` bound (255 bytes including the `.json`
suffix) is now shared between operator-config file names and data-directory
segments by design: a name that encodes within the limit is valid for both uses,
so there is one addressability rule for the whole codec.

**The contract this codec now guarantees:** an extension name yields exactly
one usable directory on every supported host — macOS, Linux, and Windows —
not only on whichever host happens to be running. The codec's TSDoc enumerates
every way a supported host can disagree about what a path component means and
states which of the two mechanisms (escaping, or rejection) closes each one, so
a reviewer checks that one list instead of a changelog of fixes. Summarised:

- **Reserved Windows device basenames** (`CON`, `PRN`, `AUX`, `NUL`,
  `COM1`-`COM9`, `LPT1`-`LPT9`, compared case-insensitively against the name up
  to its first `.`, such as `CON` or `COM1.log`) have no segment at all.
  **Breaking:** `encodeExtensionNameAsPathSegment` now returns `undefined` for
  these — previously such a name encoded to itself unchanged. No escaping can
  rescue them: `CreateFile` on one of these opens a device, not a path,
  regardless of which directory precedes it, so rejection applies on every
  host, not only Windows.
- **A trailing `.`** on a Windows path component is silently stripped before
  the name is resolved — the same mechanism that lets `CON.` open the device
  `CON` does — so `gateway` and `gateway.` would otherwise resolve to the same
  directory on Windows despite being two distinct, valid manifest names.
  **Breaking:** `encodeExtensionNameAsPathSegment` now escapes a trailing `.`
  the same way it already escaped a leading one — `gateway.` encodes to
  `gateway%2E`, not `gateway.` — so the two names stay on distinct segments on
  every host without any additional collision check.
- **A trailing space** on a Windows path component is stripped the same way,
  but needs no dedicated escape: a space is outside the codec's unreserved
  character set and was already percent-escaped regardless of position, so a
  canonical segment never contained a literal trailing space for Windows to
  strip in the first place.
- **Case folding** on a case-insensitive filesystem (the default on macOS and
  Windows) cannot keep two segments apart that differ only in case, and
  detecting it after the fact — over whichever names happen to be loaded at
  once — cannot cover every case: an extension can be uninstalled and leave its
  data directory behind, or be filtered onto a different runtime surface, and
  either way it is absent from any set a coordinator could inspect while the
  survivor starts. **Breaking:** every uppercase `A`-`Z` byte is now
  percent-escaped, exactly like any other byte outside the codec's unreserved
  set, so a canonical segment never contains a literal uppercase letter at
  all. `gateway` still encodes to `gateway`, but `Gateway` now encodes to
  `%47ateway` instead of `Gateway`. The two segments cannot be folded onto
  each other by any case-insensitive comparison, because the only uppercase
  ASCII that can appear in a canonical segment is the hex digits `A`-`F` of an
  escape triplet, and those fold in lockstep rather than colliding with a
  literal character — the codec's TSDoc walks the full argument. This closes
  the hazard for every name, not only the ones a coordinator happens to have
  loaded together, so `@makaio/kernel`'s load-set collision detector
  (`findCaseInsensitiveDataDirCollisions` and friends) is removed as dead
  weight; see the companion `extension-data-dir-subtree` changeset.
  Every extension name in this repository already follows lowercase
  package-name conventions, so this changes no segment any extension here
  currently uses; it changes the segment of any *future* uppercase-containing
  name. Note this reaches the operator-config surface too, where file names
  are hand-written rather than generated: the config file for a hypothetical
  extension `Gateway` must now be named `%47ateway.json`, and a hand-written
  `Gateway.json` is no longer the encoded form of anything, so it is ignored as
  an unrecognised file rather than silently attributed to that extension.
- **Unicode normalisation-insensitive comparison**, which macOS's default APFS
  format performs, cannot fold two segments together either: every non-ASCII
  byte is percent-escaped into literal ASCII characters that have no second
  normalised form, so the NFC and NFD spellings of one name always produce two
  distinct segments. No code change was needed for this — it already held —
  but it is now verified and stated explicitly in the codec's TSDoc rather
  than left implicit.
- **NTFS 8.3 short-name aliasing** is documented as a known, unaddressed
  limitation: a manifest name could in principle collide with another
  extension's filesystem-generated short alias, but only NTFS decides that
  alias, so no encoding choice can rule it out. Its failure mode is a loud
  `EEXIST` at directory creation, not the silent data-sharing every item above
  defends against.
