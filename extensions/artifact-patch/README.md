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
  which paths exist. A declared optional field that this revision does not carry stays valid. The one
  relaxation is a migration: `$unset` may address a property the target schema no longer declares,
  because that is exactly what the migration has to remove (see Schema versions).
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
plain property adds an entry, and that means the same thing whatever else landed in between — and
only when the request does not also name `representations`, which were authored against the base
the caller read, nor a target `schemaVersion`, which was chosen against it.
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

## Schema versions

A patch is validated against the registration at the base revision's schema version, so a plain
patch never moves an artifact between versions. An artifact left behind by a kind bump has no
registration at its own version any more and is rejected with `SCHEMA_VERSION_MISMATCH`, which
names the versions that are registered. Naming a target `schemaVersion` on the request is how the
caller migrates it: the instructions bring the payload to the newer shape, the whole result — declared
paths and schema alike — is held to the target registration, and the host stores the new revision at
that version. There is no migration logic in the package; the caller writes the instructions, and
the target schema's validation of the completed payload is the only judge of the result.
A migration only moves forward: a target older than the base revision's version is
`SCHEMA_VERSION_MISMATCH`, whatever is registered. Two rules bend for a migration and only there:
`$unset` may address a property the target schema does not declare (it must still address something
the revision carries; `$pull` gets no such relaxation, because pulling from an undeclared collection
leaves the collection the target refuses), and the patch may carry no instruction at all when the
stored payload already satisfies the target, so a registration that changed only metadata is
migrated without a fabricated write. An instructionless patch that targets the version the base
already has is `NO_CHANGE`.
A success that moved the artifact reports `migration: { from, to }`; without it, a success must
list at least one applied instruction.
A request that names a `schemaVersion` is never resent after a conflict, because the concurrent
revision may itself have migrated the artifact.

## Host boundary

An integrating product supplies an `ArtifactPatchHost` through `createArtifactPatchToolset(host)` or
`createArtifactPatchPackage(host)`. The host owns authorization, repository scope, effective Kind
discovery, and persistence. `store` receives the resolved previous revision — payload included — and
the request's optional `statusPath`, so a host layered over a lifecycle writer can derive the same
status observation a full revise produces. It also receives the request's `representations` when
the caller named them — an object to replace the rendering hints wholesale, `null` to clear them —
and must carry the previous revision's hints over when the property is absent, because hints are
caller-authored and the engine cannot tell whether the change made them stale. `store` also receives
the `schemaVersion` the payload was validated against and must persist the revision at that version,
which differs from `previous.schemaVersion` exactly when the request migrated the artifact. The package never issues raw Artifact bus requests and
never reaches a store directly, so a service handling `artifact.patch` and the `artifacts_patch` MCP
tool run the same engine over the same contract. Its default package marker contributes no tools until a host is
explicitly bound.
