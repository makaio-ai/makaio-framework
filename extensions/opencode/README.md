# @makaio/extension-opencode

Import session logs from the OpenCode AI coding tool.

Uses the `logImport` extension contribution to read OpenCode's JSON session files and normalise them into Makaio session events. This is the reference implementation for the `logImport` contribution seam — no storage, tools, UI, or triggers are needed.

Schema verified against OpenCode v1.1.x logs (2026-01-22).

## Browser surface

`descriptor.json` currently declares `entrypoints.browser: true`, so `src/browser.ts` exists
for descriptor/source alignment. The browser entrypoint default-exports a valid no-op
`ExtensionBrowserFactory` and returns an empty contribution object. No runtime browser UI
is provided by this extension.

## Features

- **Log importer** — parses OpenCode session JSON files into Makaio messages
- **Auto-detection** — watches `**/storage/session/*/*.json` for new/updated log files
- **Incremental import** — file watcher triggers partial re-import on change

## Log import seam

| Field | Value |
|-------|-------|
| `adapterName` | `plugin:opencode` |
| `displayName` | `OpenCode` |
| `logFilePattern` | `**/storage/session/*/*.json` |
| `LogImporterClass` | `OpenCodeLogImporter` |

The canonical runtime adapter name for imported session events is `plugin:opencode`,
defined by the executable `logImport.adapterName` in `src/index.ts`. The descriptor's
`contributions.logImporters` entry is discovery metadata; it does not register a second
runtime adapter.

## Config

No configuration schema — the extension activates as-is.

## File Index

| File | Description |
|------|-------------|
| [`src/index.ts`](src/index.ts) | Extension package descriptor and public API |
| [`src/browser.ts`](src/browser.ts) | Valid no-op `ExtensionBrowserFactory` for descriptor/source alignment |
| [`src/importer.ts`](src/importer.ts) | `OpenCodeLogImporter` implementation |
| [`src/message-normalizer.ts`](src/message-normalizer.ts) | Transforms OpenCode messages to Makaio format |
| [`src/types.ts`](src/types.ts) | `OpenCodeSession`, `OpenCodeMessage`, `OpenCodeSessionLog` |
