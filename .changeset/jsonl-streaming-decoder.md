---
"@makaio/framework": major
"@makaio/adapter-codex-app-server": patch
---

JSONL streams are decoded by one stateful decoder, `createJsonlDecoder({ finalLine, maxLineLength? })`, shared by `createJsonlTransport`, `StdioClientTransport` and the codex app-server transport. It decodes UTF-8 across chunk boundaries, so a multibyte character split between two pipe chunks now arrives intact instead of as replacement characters. Lines longer than the maximum (default 64 Mi UTF-16 code units) are dropped and counted without being buffered whole. `end()` flushes the input at its genuine end under an explicit final-line policy (`parse` or `discard`); `abandon()` drops the buffered rest and reports its length. The decoder keeps counts only, never line content; `describeJsonlDrops` renders them. Each call site chooses its own final-line policy. `StdioClientTransport` keeps `discard`: an unterminated final line is not delivered and is logged as a count at the stream's end. The JSONL transport defaults to `discard`; `StdioServerTransport` and the codex app-server transport opt into `parse` (see their changesets).

`@makaio/subprocess` also exports the types of a process end model that keeps the process exit, the stop intent and the communication outcome apart: `ProcessExit` (`exited` with separate `code` and `signal`, `spawn-failed`, `unobserved`), `ObservedProcessExit`, `DrainOutcome`, `CommunicationFailure`, `EndCause`, `TransportEnd`, `StdoutEndPolicy`, `FinalLinePolicy` and `ProcessTreeEvidence`, plus `describeProcessExit` and `describeTransportEnd`, which describe an end by codes, signals, errno codes and counts only, never by an error message or stream content.

**Breaking:**

- `decodeJsonlChunk` and `JsonlDecodeResult` are removed from `@makaio/subprocess`, and `decodeBusChunk` and `DecodeBusChunkResult` from `@makaio/bus-transport-stdio`. Use `createJsonlDecoder` and keep one decoder per stream.
- `StdioClientTransport` reports dropped input as `Dropped N malformed JSONL line(s) from stdin` instead of `Failed to parse N stdio JSONL line(s)`, also reports over-length lines and an unterminated final line at stdin's end, and no longer calls `setEncoding('utf8')` on its stdin stream.
