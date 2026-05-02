---
title: Publishing
description: Adapter publishing strategy, versioning, and CI cascade design for the Makaio Framework.
---

> **Status: Design** — This document describes the target publishing architecture.
> Adapters are currently `private: true` and not yet published to npm.

Adapters are independently publishable packages that bridge the framework to external AI
providers. This document defines the versioning strategy, dependency architecture, and CI
automation for adapter publishing.

## What changes an adapter

An adapter artifact is a function of three inputs:

```
Adapter Artifact = f(own source, upstream SDK, framework APIs)
```

Crucially, these are **decoupled** from adapter publishing:

- **Managed binaries** (claude, codex CLI) — handled by `ClientBinaryManager`, separate axis.
- **Model catalog** — dynamic registry fetched at boot from CDN + user overlays, no publish
  needed.
- **Provider configs** — user-specific, stored at `$MAKAIO_HOME/provider-configs/`.

## Dependency architecture (target state)

Current state: all framework dependencies use `workspace:*` as regular dependencies.

**Target:** Framework packages become **peer dependencies** with semver ranges. Upstream SDKs
remain peer dependencies (already the case).

```json
{
  "peerDependencies": {
    "@makaio/ai-adapters-core": "^0.2.0",
    "@makaio/contracts": "^0.3.0",
    "@makaio/bus-core": "^0.2.0",
    "openai": ">=6.22.0"
  },
  "devDependencies": {
    "@makaio/ai-adapters-core": "workspace:*",
    "@makaio/contracts": "workspace:*",
    "@makaio/bus-core": "workspace:*",
    "openai": "6.22.0"
  }
}
```

**Rationale:** Peer deps correctly express the adapter-to-framework relationship: "I work with
any compatible version of the framework, but I don't bundle it." This enables the
Framework-Cascade publish mode (see below) to be metadata-only.

## Three publish modes

| Mode | Trigger | What happens | Cost |
|------|---------|-------------|------|
| **Adapter-Fix** | Own source changes | Conformance tests + publish | High (API calls), rare, 1 adapter |
| **SDK-Update** | Upstream SDK bumps | Conformance tests + publish | High (API calls), 1 adapter |
| **Framework-Cascade** | Framework dep breaking change | `tsc` per adapter → peer range bump + publish | Low — no API call, type-check + npm publish only |

## Framework-Cascade (the common case)

Framework-Cascade is the most frequent publish mode and the cheapest.

**Why `tsc` is sufficient:**

```
Adapter Source (unchanged)
  + SDK Pin (unchanged)
  + Framework Types (still compiles)
  ────────────────────────────────
  = Identical JavaScript output
  = Identical runtime behavior
  = Conformance tests would produce identical results
```

Running conformance tests after a framework-only type change where `tsc` passes would be like
re-running a unit test when neither the test nor the tested code changed. Correct, but wasteful
— and expensive (real API calls with real costs).

**Automated CI flow:**

```
contracts@0.3.0 published
        │
        ▼
CI job: "adapter-cascade"
  for each adapter in implementations/*:
    1. Bump peer range: @makaio/contracts ^0.3.0
    2. yarn install
    3. tsc --noEmit (on the adapter alone)
       │
    ┌──┴──────────────────────┐
  pass                       fail
    │                          │
  4a. Commit peer bump       4b. Create draft PR:
  5a. npm publish              "contracts 0.3 broke
  (metadata-only,              adapter X, needs
   identical dist/)            manual fix"
    │
  Done. No conformance test.
```

In the common case (90%+ of framework bumps), only 4a/5a runs — an automatic peer range bump
without any test. No human intervention needed.

## When it gets manual

The only case requiring manual work: a framework breaking change AND the adapter uses the
changed API. Then `tsc` fails, a draft PR is created, and someone must fix the adapter + run
conformance tests.

This happens only when `ai-adapters-core` breaks its public API surface. After stabilization,
this should be rare.

## Future: contracts split (noise reduction)

`@makaio/contracts` is currently a single package with 13+ export entry points (`./adapter`,
`./session`, `./extension`, etc.). Every minor bump — even for unrelated types — triggers a
peer range check in all adapters.

A future split into separate packages would reduce cascade noise:

```
@makaio/contracts/adapter   → only adapter-relevant types
@makaio/contracts/session   → only session types
@makaio/contracts/extension → only extension types
```

This is an optimization, not a blocker. Even with the monolithic contracts package, the `tsc`
filter ensures cascades are metadata-only bumps.

Note: the export entrypoints already exist — the split is about separate versioning, not
separate code.

## Build infrastructure

Each adapter requires `publishConfig` in `package.json` to remap source exports to dist:

```json
{
  "publishConfig": {
    "exports": {
      ".": "./dist/index.mjs",
      "./server": "./dist/server.mjs"
    }
  }
}
```

Build uses `tsdown` (the framework standard) or custom `tsx build.ts` scripts.

The `assemble-dist.ts` script validates that `publishConfig.exports` entries exist in the
assembled dist.

## Summary

```
1. Upstream SDK (openai, anthropic, etc.)
   → Pinned peer dep, SDK-Update workflow, conformance tests on real bump

2. Managed binaries (claude, codex)
   → Fully decoupled, separate axis, no adapter publish

3. Framework deps (contracts, core)
   → Peer deps with ^-range, cascade = tsc + metadata publish

4. Model catalog
   → Dynamic registry, no publish needed
```

<!-- web:hide -->

## Key source files

| File | Purpose |
|------|---------|
| `../../adapters/core/package.json` | Core package with publishConfig |
| `../../adapters/implementations/*/package.json` | Adapter package configs |
| `../../scripts/assemble-dist.ts` | Dist validation script |
| `../../.github/workflows/conformance.yml` | Conformance test CI |
| `../../packages/clients-core/src/client-binary-manager.ts` | ClientBinaryManager (decoupled) |
| `../../runtimes/node/src/boot-model-registry.ts` | Dynamic model registry |

<!-- /web:hide -->
