---
title: SDKs
description: Build extensions and integrations in TypeScript, Python, or Rust with generated, conformance-tested SDKs.
---

Makaio SDKs let external processes participate in the Makaio bus protocol without depending on
host application code. They are framework distribution artifacts.

## Architecture Tracks

SDKs follow two intentionally different architecture tracks.

### Cross-Language Protocol SDKs

Python, Rust, and future non-TypeScript SDKs implement the bus protocol in the target language. The
canonical language-neutral protocol definition is generated from `@makaio/contracts` through the
explicit `PublicProtocolNamespaces` catalog.

### TypeScript SDK

The TypeScript SDK re-exports the framework's own bus-core types and transport layer, providing a
thin convenience wrapper for TypeScript consumers that want to connect to a running Makaio instance.

## Available SDKs

| SDK | Language | Status |
|-----|----------|--------|
| [Python](/sdks/python/) | Python 3.11+ | Phase 1 |
| [Rust](/sdks/rust/) | Rust (stable) | Phase 1 |
| [TypeScript](/sdks/typescript/) | TypeScript 5+ | Phase 1 |
