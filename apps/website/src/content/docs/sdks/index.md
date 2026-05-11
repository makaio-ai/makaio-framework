---
title: SDKs
description: Build extensions and integrations in TypeScript, Python, or Rust with generated, conformance-tested SDKs.
---

Makaio SDKs let external processes participate in the Makaio bus protocol without depending on
host application code. They are framework distribution artifacts.

## Architecture Tracks

SDKs follow two intentionally different architecture tracks.

### Cross-Language Protocol SDKs

Python, Rust, and future non-TypeScript SDKs reimplement the bus protocol in the target language.
All three SDKs share a common feature surface: local-first request dispatch, request middleware
chaining, HMAC authentication, typed subject descriptors generated from the protocol manifest,
and conformance-tested wire behavior. Python and Rust additionally support stdio transport for
detached extension processes.

The canonical language-neutral protocol definition is generated from `@makaio/contracts` through
the explicit `PublicProtocolNamespaces` catalog.

### TypeScript SDK

The TypeScript SDK re-exports the framework's own bus-core types and transport layer, providing a
thin convenience wrapper for TypeScript consumers that want to connect to a running Makaio instance.

## Available SDKs

| SDK | Language | Transport | Status |
|-----|----------|-----------|--------|
| [Python](/sdks/python/) | Python 3.10+ | WebSocket + stdio | Pre-release |
| [Rust](/sdks/rust/) | Rust (stable) | WebSocket + stdio | Pre-release |
| [TypeScript](/sdks/typescript/) | TypeScript 5+ | Framework-native | Pre-release |

All SDKs support HMAC authentication, local-first request dispatch with middleware chaining,
and typed subject descriptors.
