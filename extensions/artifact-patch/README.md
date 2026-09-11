# @makaio/extension-artifact-patch

Portable patch-based Artifact revisions, applied through an authorized host.

A revision costs the size of the change instead of the size of the payload. The caller sends the
`artifact.patch` request — artifact identity, the `baseRevision` it was written against, and the
instructions — and the package applies them to a copy of the stored payload, validates the complete
result against the effective Kind schema, and asks the host to persist it.

## Declared operators

`$set` and `$unset` address declared paths; `$push` and `$pull` address declared collections. This is
a subset of Mongo update semantics and it is closed: any other operator is rejected by the request
schema. One collection entry is addressed by field match (`tasks.$[entry].status` with
`arrayFilters: [{ 'entry.title': '…' }]`) or by position (`tasks.3.status`). Field match is what keeps
the addressing independent of the list order a caller read earlier.

Four deviations from Mongo are deliberate, because a write that quietly does nothing — or only part
of what was asked — is worse than a rejected one:

- **Addressing nothing is an error.** Mongo treats an unmatched `arrayFilters` update or `$pull` as a
  no-op. Here it is `NO_MATCH`.
- **A path that only some selected entries carry is an error.** An instruction is all-or-nothing
  across the entries a filter selects: if one of them does not carry an intermediate object or the
  addressed position, applying the change to the rest would report a partial write as a complete
  one. A missing intermediate is `PATH_NOT_RESOLVABLE`; a missing position is `NO_MATCH`.
- **An undeclared path is an error.** A misspelled field is never created; the Kind schema decides
  which paths exist. A declared optional field that this revision does not carry stays valid.
- **`$unset` addresses object properties only.** A collection entry is removed with `$pull`, so an
  element is never replaced by a hole.

`$push` follows Mongo in creating a declared collection that the revision does not yet carry, and
`$pull` follows Mongo in matching object elements by the fields its condition declares.

## Concurrency and diagnostics

`baseRevision` is mandatory, and it is enforced twice. This package compares it against the revision
it loads, which rejects a stale caller cheaply and before any work; the host's `store` is the
authoritative check and must be a compare-and-swap against `previous.revision`, because two callers
can pass the first comparison concurrently. A `store` that reports a conflict is surfaced as
`BASE_REVISION_CONFLICT` exactly like the early rejection.

A conflict names the current revision and says what to do with it in the error's `repair` field.
Only an append at a fixed path can be resent as written: a `$push` whose every path segment is a
plain property adds an entry, and that means the same thing whatever else landed in between.
Everything else has to be rebased against a fresh read. `$set` replaces a value the caller has not
seen since; `$unset` and `$pull` delete state the caller has not re-read, which the concurrent
revision may have written for a reason; a position addresses a different entry once something is
inserted ahead of it; and a `$[filter]` placeholder addresses a set the concurrent revision may have
changed, by editing the compared field or by adding another matching entry, so even an append
through a filter can land somewhere the caller never addressed. Field match still keeps the
*addressing* independent of list order, which is why it exists — it just does not make a write safe
to repeat blindly.

A rejected write is a separate case from a refused one. A `store` that returns a conflict persisted
nothing. A `store` that throws leaves the outcome unknown — the contract covers the compare-and-swap,
not what a throw means — so the repair hint asks for a re-read instead of promising a safe retry.

Every rejection names the failing path and a repair hint; schema rejections add the expected type or
the allowed values per path. `dryRun` applies and validates without persisting.

## Host boundary

An integrating product supplies an `ArtifactPatchHost` through `createArtifactPatchToolset(host)` or
`createArtifactPatchPackage(host)`. The host owns authorization, repository scope, effective Kind
discovery, and persistence. `store` receives the resolved previous revision — payload included — and
the request's optional `statusPath`, so a host layered over a lifecycle writer can derive the same
status observation a full revise produces. The package never issues raw Artifact bus requests and
never reaches a store directly, so a service handling `artifact.patch` and the `artifacts_patch` MCP
tool run the same engine over the same contract. Its default package marker contributes no tools until a host is
explicitly bound.
