# Makaio SDKs

Makaio SDKs let external processes participate in the Makaio bus protocol without depending on
host application code. They are framework distribution artifacts: no SDK may depend on host-only
descriptors, package names, or private service internals.

## Architecture Tracks

SDKs have two intentionally different architecture tracks.

### Cross-Language Protocol SDKs

Python, Rust, and future non-TypeScript SDKs implement the bus protocol in the target language. The
canonical language-neutral protocol definition is
`sdks/manifest/makaio-bus-protocol.json`, generated from `@makaio/contracts` through the
explicit `PublicProtocolNamespaces` catalog.

```
sdks/manifest/               -> makaio-bus-protocol.json
  | codegen
  v
sdks/python/                 -> makaio-sdk package, generated subjects + hand-authored BusClient
sdks/rust/                   -> makaio-sdk crate, generated subjects + hand-authored BusClient
  ^ validated by
sdks/conformance/            -> language-neutral cases and wire fixtures
```

The manifest is the source of truth for these SDKs. If a language-neutral public subject or wire
feature changes, regenerate the manifest and bindings from the repository root:

```bash
yarn tsx scripts/generate-sdk-bindings.ts
```

The committed source-tree artifacts are `sdks/manifest/makaio-bus-protocol.json`,
`sdks/python/src/makaio/generated/` (namespace modules, payload dataclasses, and subjects),
and `sdks/rust/src/generated/subjects.rs` (typed subject structs and payload types).
Update the shared conformance fixtures before changing individual SDK implementations.

`makaio-sdk` (Python) and `makaio-sdk` (Rust) are workspace artifacts and are not published yet.

### TypeScript Framework SDK

`sdks/typescript/` provides `@makaio/sdk`, a framework-native TypeScript facade. It is not a
from-scratch TypeScript reimplementation of the bus runtime. It may wrap private framework
workspace packages such as `@makaio/bus-core`, `@makaio/bus-transport-websocket`,
`@makaio/contracts`, `@makaio/core`, and small shared utilities.

For TypeScript, "thin SDK" means a thin public facade and central import surface:

```ts
import { BusClient, AgentSubjects, SessionSubjects } from '@makaio/sdk';
```

It does not mean duplicating the TypeScript bus runtime or forcing SDK consumers to import several
framework-internal packages for ordinary SDK use.

## Public Surface Rules

All SDKs expose the same logical API where the protocol concepts overlap, with language-native
method names:

| Concept | TypeScript `@makaio/sdk` | Python `makaio-sdk` | Rust `makaio-sdk` |
|---------|---------------------------|---------------------|-----------------------|
| Connect | `client.connect(options?)` | `await client.connect()` | `BusClient::connect(url).await` |
| Connect (options) | `new BusClient(url, { dispatch, auth })` | `BusClient(url, dispatch=..., auth=...)` | `BusClient::connect_with_options(url, opts).await` |
| Connect (stdio) | — | `BusClient.from_stdio()` | `BusClient::from_stdio(stream).await` |
| Subscribe | `client.subscribe(subject, handler)` | `await client.subscribe(subject, handler)` | `client.subscribe(subject, handler).await` |
| Request handler | `client.onRequest(subject, handler)` | `await client.on_request(subject, handler)` | `client.on_request(subject, handler).await` |
| Emit | `client.emit(subject, payload)` | `await client.emit(subject, payload)` | `client.emit(subject, payload).await` |
| Request | `client.request(subject, payload)` | `await client.request(subject, payload)` | `client.request(subject, payload).await` |
| Once | `client.once(subject, options?)` | `await client.once(subject, filter=..., timeout_ms=...)` | — |
| Close | `client.close()` | `await client.close()` | `client.close().await` |

All three SDKs support HMAC authentication via `MAKAIO_BUS_SECRET` with automatic `/health`
probing. The TypeScript SDK resolves auth through `BusClientOptions.auth`; Python and Rust resolve
it through `BusClient` constructor options (`auth` parameter) and environment variable fallback.

Payload validation remains server-side. SDKs trust the wire format and do not re-validate schemas
locally; the server's Zod schemas remain authoritative.

Cross-field rules are a specific case of that: refinements such as "an adapter selection that names
an instance must name its machine, and vice versa" are not exported by `z.toJSONSchema`, so they
appear in neither the manifest nor the generated types even though JSON Schema itself could express
them — the generator is the limit, not the format. Read such pairing rules from the schema
documentation of the subject you are calling; the server is the only place they are enforced.

`@makaio/sdk` may re-export explicit framework-owned subject namespaces from `@makaio/contracts`
when that keeps the external TypeScript entrypoint coherent. Those exports are TypeScript framework
API and are not automatically part of the language-neutral protocol manifest.

When adding or changing an SDK surface:

- If the subject or feature should be portable to Python, Rust, or future language SDKs, add it to
  `PublicProtocolNamespaces`, regenerate the manifest and bindings, and update conformance coverage.
- If it is TypeScript/framework-native only, expose it through `@makaio/sdk`, document why it belongs
  in the central TypeScript entrypoint, and cover the behavior through facade tests.
- Do not re-export whole framework packages for convenience. Export explicit stable namespaces,
  types, and helpers that external SDK consumers need.
- Test TypeScript SDK behavior through `@makaio/sdk`, not by bypassing the facade into framework
  internals.

## Conformance

`sdks/conformance/cases.json` and `sdks/conformance/fixtures/messages.json` define
language-neutral protocol scenarios covering wire protocol shapes, local dispatch behavior,
request middleware chaining, and HMAC authentication handshakes.

Cross-language protocol SDKs must pass the full conformance suite. The TypeScript SDK must exercise
the same fixtures through its public `BusClient` facade where behavior overlaps, and it should add
focused facade tests for TypeScript-specific wrapper behavior such as handler options, auth, or
connection injection.
