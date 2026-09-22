---
"@makaio/runtime-node": patch
---

Harden the operator extension config loader and its boot diagnostics.

- Candidates are `lstat`-checked before being opened: a directory, FIFO, socket,
  or device — or a symlink to one — becomes an `unreadable` entry instead of
  being opened. Opening a FIFO blocks until a writer appears, which hung the
  host in the first phase of boot. A symlink to a regular file is still followed,
  and the size bound is taken from the open descriptor.
- File bytes are decoded with a fatal UTF-8 decoder. Malformed input is an
  `invalid-json` entry rather than a document silently repaired with U+FFFD,
  which used to hand an extension strings that differ from what is on disk.
- A file saved with a leading byte-order mark is now accepted. The mark reached
  `JSON.parse` before and failed the file over a byte the operator's editor does
  not show them.
- The snapshot object returned by `createExtensionOperatorConfigSnapshot` is
  frozen, so a holder cannot repoint `get` or `entries` after boot.
- The unapplied-config warning now runs against the package set the extension
  coordinator retained rather than the set handed to it, so a file for an
  extension excluded by surface or environment filtering is reported instead of
  counted as consumed. New `warnOnUnaddressableExtensionOperatorConfigNames`
  reports every loaded extension whose name has no operator config file name at
  all.
- `registerExtensionBootContributions` now runs only for the packages the
  coordinator retained, so a package excluded by surface or environment
  filtering no longer has its `runtimeBoot.configure` called — it never
  activates, and its contribution processors, bus handlers, and cleanups were
  being installed for an extension that does not run.
