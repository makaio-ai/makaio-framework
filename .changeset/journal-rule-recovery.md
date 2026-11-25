---
"@makaio/framework": major
"@makaio/runtime-node": major
"@makaio/contracts": major
---

Evaluate recorded events through the built-in journal reader. Its reading state and pinned occasion commit together. On startup and after committed writes, the host resumes outstanding decisions and effects from the database. Reaction retries retain their original keys.

A rule source can answer that no set applies to an entry. The reader completes that entry without creating an occasion. An unavailable source or a reply from a retired registration leaves the entry open, preserving order. `RuleEvaluator.prepare` now returns a discriminated result with `prepared`, `no-match`, and `source-unavailable` states. Callers constructing a `RuleEvaluator` must supply the active registration object containing the contribution, with stable identity for that activation.

The built-in reader pauses admission and claims while no rule source is registered and resumes at the saved position when a source activates. Committed occasions remain eligible for evaluation. Unexpected evaluation failures defer the affected occasion so other order keys can proceed. Reader state pages include `readerPosition` when the reader has a stored cursor, even if the page contains no entries. Clients using the previous strict response schema must update it to accept the new field.

Reader cursors now preserve their declaring extension. Activation adopts a legacy cursor without an owner by exact reader name and preserves its position. An owned cursor can only be resumed by its recorded extension. A failed activation rolls back its exclusive cursor reservations and legacy adoptions while the position is unchanged. Activations of the same owner on separate hosts share the cursor and protect it from rollback. The reader-state request now checks subject permissions in the host, including for callers in the same process.
