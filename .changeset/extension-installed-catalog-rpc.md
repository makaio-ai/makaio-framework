---
"@makaio/framework": major
"@makaio/kernel": minor
"@makaio/runtime-node": minor
"@makaio/services-package-manager": minor
---

Expose the runtime's installed-extension catalog over the bus, and let it own
enablement decisions for names it never loaded.

`kernel:extension.catalog` reports every extension package installed on the
coordinator's host — across all its discovery tiers, including the project-local
`node_modules` of the directory it was started from — with each package's
version, provenance, criticality (fail-closed when its export cannot be read),
and the enablement facts the coordinator holds for it. It answers
`entries: null`, never an empty list, on a runtime wired without a catalog
source, so "nothing installed" and "cannot answer" stay distinguishable.

`kernel:extension.setEnabled` now validates a name it did not load against that
same catalog and persists the preference itself, instead of refusing. Its
response carries a machine-readable `reason` alongside the existing `outcome`,
so a caller can tell which refusal it hit, or why a persisted preference is not
in effect yet, without inspecting the host.

This closes three client-side limitations that all had the same root cause: a
client configured against a remote bus can now enable/disable and enumerate
extensions on that host, and a client invoked from a different working directory
than the server can address the server's project-local packages. Clients no
longer write another host's enablement state from their own view.

Breaking changes:

- `kernel:extension.setEnabled` reports a refused disable of a `critical`
  extension as `{ outcome: 'rejected', reason: 'critical' }` instead of throwing.
  The request is well-formed and the refusal is a fact about the extension, which
  a caller that cannot inspect the host must be able to read off the response. The
  remaining throws (no durable enablement store; a framework package holding the
  name on a runtime with no catalog) are unchanged.
- While a server is reachable, clients no longer write the enablement file
  themselves for a name that server did not load — they forward the request and
  render its answer. A runtime wired without a catalog source therefore refuses
  such a name (`reason: 'no-catalog'`) where a client previously wrote its own
  file for it; every runtime booted through `bootMakaioRuntime` has one.
- The tier scan behind the catalog moved into `@makaio/runtime-node`
  (`scanInstalledExtensions`), which both the runtime and command surfaces now
  share instead of each carrying their own copy. It takes the host's resolved
  `ExtensionDiscovery` instead of a data home and a project root, so the catalog
  describes the roots and `include`/`exclude` filters the host is actually
  configured with rather than a second, independently assembled filesystem view.
  A host that passes an explicit `discovery` to `bootMakaioRuntime` now gets a
  catalog matching it.
- `@makaio/services-package-manager` gained `resolveExportedPackages`, reporting
  every package a server entry exports rather than only the descriptor's own;
  `resolveExportedPackageCritical` is now a projection of it and keeps its
  contract.
- A host that preloads extension server modules (a bundled deployment handing
  discovery a `preloadedModule`) is now catalogued from that module directly,
  the way the loader already consumed it, instead of being reported as
  criticality-unknown with none of its exported child packages because its
  package root carries no convention-resolvable entry file.
- A recursively searched discovery root now traverses symlinked directories.
  `extension install --path` links the managed install directory at the
  extension's source tree, so a runtime configured through `makaio.config.*`
  previously discovered none of its locally installed extensions.
- Catalog records carry the name contests the runtime cannot resolve: `surface`,
  `shadowedBy` (a descriptor name a higher-priority tier already claimed), and
  `collidesWith` (a name claimed by two copies neither of which will load).
  Where boot refuses such a name, the catalog describes it — it is an
  observation over every installed package, including ones no boot loads, so it
  reports the contest instead of aborting the whole answer. Reading the raw
  discovery tiers is what makes that possible: `ExtensionDiscovery` gained an
  optional `discoverTiers()` reporting its precedence layers before any
  collision is resolved, defaulted for strategies that do not implement it.
- `kernel:extension.setEnabled` refuses a contested name with
  `reason: 'name-collision'` and writes nothing. It consults the catalog for
  every request, including one it resolves to a loaded package: a second copy
  installed while the process runs never reaches the coordinator's entries,
  which still describe the copy loaded at boot, yet it stops the next start.
- The discovery assembled from `makaio.config.*` now applies the same
  descriptor-name rule every other discovery strategy applies: each configured
  root is one precedence layer, an earlier root wins a name a later one also
  declares (reported), and two packages declaring one name inside a single root
  are refused rather than resolved by filesystem order.
