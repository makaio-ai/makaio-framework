---
"@makaio/contracts": major
"@makaio/framework": major
"@makaio/rules": major
"@makaio/services-core": major
"@makaio/subsystem-workflow-engine": major
"@makaio/runtime-node": major
"@makaio/extension-telemetry-otel": major
"@makaio/bus-core": major
"@makaio/expression": major
---

Replace the rules condition language with one checked definition, and use it for workflow
trigger bindings, transition rules, context rules, and telemetry enricher rules.

**Condition language (`@makaio/contracts`, `@makaio/framework/rules`)**

- The `Condition` type and its schemas are defined once in `@makaio/contracts`, together with
  `ConditionOutcome`, `ConditionError` (`{ path, message }`), and `ConditionFinding`. The
  `@makaio/rules` entry point re-exports them.
- `evaluate` and `evaluateRules` return an outcome instead of a boolean. An invalid condition
  or a failing expression no longer throws; it is reported as a `ConditionError` in the
  outcome, and callers decide what a failed condition means.
- `$and` and `$or` evaluate every operand, and an error in any operand is the result, so a
  broken operand can no longer be hidden by a sibling that already decided the answer.
- Equality compares JSON values structurally, so objects and arrays are equal when their
  contents are equal. Five operators are new (the ordering operators and `$empty`); see the
  README of the rules package.
- Field paths read own properties only: `constructor`, `__proto__`, and `hasOwnProperty` are
  absent unless the context really has such a key. This also holds for `matchesFilter` of
  the bus. `readDotPath` and `jsonValueType` are exported from `@makaio/contracts` for code
  that reads paths the same way.
- `validateCondition` takes `{ condition, context }`, where `context` is one JSON Schema of
  the evaluation context. It checks a condition without evaluating it: a field is known when
  the schema lists it, optional unless the schema requires it, and an unlisted field follows
  `additionalProperties`. It reports unknown fields, operand types that do not fit the field,
  and invalid expression syntax as errors, and an `$expr` operand as a warning because its
  result cannot be checked statically.
- `unguarded-negation` rejects a negation (`$ne`, `$nin`, or any operator under `$not`) that can
  match while an optional field is absent. It is judged per leaf and per field: a leaf is
  reported when its value on an absent field equals the result the root needs from it, and
  every operand of every enclosing conjunction can reach its needed result with that field
  absent. An `$and` is a conjunction while the root needs `true`, an `$or` while it needs
  `false`, and `$not` flips the need. Operands of enclosing disjunctions impose nothing, so a
  match through an unrelated `$or` branch is not counted. A `{ $exists: true }` on the same
  field in an enclosing `$and` protects the leaf, at any position. A leaf whose operator is
  `$exists` is never reported, so `{ $exists: false }` and `$not` over `{ $exists: true }` are
  valid ways to ask for an absent field.
  For a nested path the check considers every optional part of the path: a guard on that part
  or below it protects, so `previousArtifact.kind` behind a `previousArtifact` guard is accepted
  when `kind` is required, and still reported when the nested field is optional itself.
- Ordering operators compare only real RFC 3339 date-times: a day the month does not have
  (`2026-02-30`), hour 24 and a leap second never match, instead of comparing as a shifted
  instant. The validator reports `type-mismatch` for a string operand of `$lt`, `$lte`, `$gt`
  and `$gte` that is not an RFC 3339 date-time, and for a `$contains` / `$containsPrefix`
  operand that the array's declared item types cannot have (it stays silent when the item
  types are unknown, open or a tuple). An array index into a 2020-12 `prefixItems` tuple is not
  resolved to the `items` schema. `$empty` on a number or boolean field is a `type-mismatch`
  for both operand values; use `{ $exists: true }` to test presence.
- Ordering on RFC 3339 date-times uses the full fractional-second precision instead of whole
  milliseconds, so timestamps with microsecond or nanosecond digits order correctly within one
  millisecond.
- The `artifact.status.changed` transition context marks `previous` and `current` as optional,
  because both can be absent on an initial set or a clear. A rule that negates either field is
  rejected as `unguarded-negation` unless an `$exists: true` guard sits next to it in the same
  `$and`; use `{ $exists: false }` to match the missing side.
- Workflow trigger conditions are checked against the event schema with its local `$ref`s (`#`,
  `#/$defs/…`, `#/definitions/…`) resolving inside the event schema, so valid paths through
  recursive or named event schemas are not rejected as unknown and typos below them are not
  silently admitted.
- Workflow trigger refreshes stay batch-atomic for `when` conditions: if any binding's condition
  does not fit its event schema or has an `$expr` syntax error, the workflow keeps all of its
  last-good triggers instead of running a mix of old and new bindings.
- Condition validation does not reject `$ne`/`$nin` on a property that an open schema lists in
  `required` but not in `properties` (including through `anyOf`/`oneOf` when every branch
  requires it); only the undescribed levels below it still need a guard.
- Breaking for importers: the alias names `JsonPrimitive`, `ScalarValue`, `ScalarValueSchema`,
  `JsonObjectSchema`, and `JsonObject` are gone from the `@makaio/rules` entry point, and
  `JsonValue` there is the one from `@makaio/contracts`. `ContextRuleCondition` of
  `@makaio/services-core` is gone; use `Condition`.
- `TransitionConditionSchema` is removed. The `when` of a transition rule is a `Condition`.

**Workflow trigger bindings (`@makaio/contracts`, `@makaio/subsystem-workflow-engine`, `@makaio/runtime-node`)**

- A trigger binding carries `when?: Condition` instead of `filter` and `filterExpression`. The
  evaluation context is `{ payload }`, so field paths start with `payload.`. The authoring
  options of the trigger helpers take `when`; `payloadField<TPayload>(path, operator)` builds
  a field condition on `payload.<path>` with the path checked against the payload type.
- `filter` and `filterExpression` are rejected with an error that names `when`; they are not
  stripped. A stored binding that still carries a legacy key fails to parse and stays
  inactive until it is rewritten.
- Migration: a `filter` entry `key: operator` becomes `{ field: 'payload.key', operator }`;
  the operators `$in`, `$ne`, `$exists`, `$startsWith`, and `$endsWith` keep their names. A
  `filterExpression` becomes `{ $expr: ... }` unchanged, because the expression context is
  still `{ payload }`. Join several parts with `$and`.
- `compileWorkflowTriggerBindingFilter` and `WorkflowTriggerPayloadPredicate` are replaced by
  `compileWorkflowTriggerCondition` and `WorkflowTriggerConditionEvaluator`, which returns a
  `ConditionOutcome`. A condition that cannot be evaluated is logged and the trigger does not
  fire; it never throws.
- A prepared trigger binding (`PreparedAutomationTriggerBinding`, `@makaio/services-core`)
  exposes `eventSchema`, the JSON Schema of the events the trigger emits. The reconciler and
  the workflow await check a binding's `when` against it and reject error findings.
- Condition semantics differ from the removed filter: review migrated filters for the new
  operators and for negation on optional payload fields, which now needs an `$exists` guard.
- Typed payload paths in the authoring options are gone for `when`; use `payloadField`.
- Not changed: `PayloadFilter` as a transport and subscription filter.

**Tool-call formatters (`@makaio/contracts`)**

- `toolFormatters[].filter` (a `PayloadFilter`) becomes `toolFormatters[].when` (a `Condition`).
  `priority` is unchanged. The condition is evaluated over the formatter input itself, so
  `toolName`, `args`, `status`, and `output` are at the root, without a `payload.` prefix.
- Migration: a `filter` entry `key: operator` becomes `{ field: 'key', operator }`; join
  several entries with `$and`. For example `{ toolName: 'Agent', 'args.subagent_type': { $exists: true } }`
  becomes `{ $and: [{ field: 'toolName', operator: 'Agent' }, { field: 'args.subagent_type', operator: { $exists: true } }] }`.
- `@makaio/contracts` exports `ToolCallFormatterInputSchema`; `PluginToolCallFormatterInput` is
  derived from it. A formatter's `when` is checked against it when the formatter is registered:
  a declaration that is not a valid `Condition`, or that names a field outside the formatter
  input (`toolName`, `args`, `status`, `output`; `args` is open), is rejected. A condition that
  cannot be evaluated (a failing `$expr`) means the formatter does not apply; it is logged once
  per formatter and never throws into rendering.

**Transition rules, context rules, telemetry enrichers (`@makaio/contracts`, `@makaio/services-core`, `@makaio/extension-telemetry-otel`)**

- Transition rules are checked when they are registered, against a context schema per event
  type (`TransitionEvaluationContextSchemas`). An unknown field, which is a field the event
  does not provide, or invalid expression syntax rejects the rule; `$expr` yields a warning.
  `artifact.data` stays open.
- Context rules are checked with `validateCondition` when they are written, including the
  negation guard described above.
- Telemetry enricher rules are checked against the span draft fields when they are
  registered; an error finding rejects the rule.
- The transition pipeline, the context rules service, and the telemetry enricher registry
  handle the failed-condition outcome.

**Expression (`@makaio/expression`)**

- `compile` rejects an expression without an operand (empty, whitespace only, or only
  opening parentheses) when it is compiled instead of when it is first evaluated.
- `compile` also rejects unbalanced parentheses (such as `(a` or `a ? b : (c`) and calls to
  transforms or functions that are not registered, at compile time instead of at evaluation.
  A condition check therefore reports them as `expression-syntax`.

**Checks and guarantees (`@makaio/rules`, `@makaio/subsystem-workflow-engine`, `@makaio/bus-core`)**

- `evaluate` and `evaluateRules` never throw: any failure while a node is evaluated (a throwing
  getter or Proxy trap, a cyclic comparison, an over-long `$glob` pattern) is returned as an
  error outcome with the path of the failing node. The context parameter is typed `object`.
- `@makaio/rules` adds `assertValidCondition(input, label)` and `ConditionValidationError`: one
  error that lists every error finding of a condition check; the warnings are returned.
- `compileWorkflowTriggerCondition` takes the trigger's event schema, checks the `when`
  condition against it, and returns `{ matches, warnings }`, so no trigger consumer can skip
  the check.
- `@makaio/bus-core` no longer exports `getPath`; use `readDotPath` from `@makaio/contracts`,
  which reads the same own-property dot paths.

A trigger whose event schema is an open record (the bus event trigger) gives the check nothing to compare field names or operand types against: there the check covers expression syntax and fields outside `payload` only. Triggers with a typed event schema are checked field by field.
