# @makaio/rules

JSON-serializable predicate engine for the Makaio framework. Rules are
evaluated synchronously against a plain context object using a `Condition`
tree. All condition types — field comparisons, boolean combinators, and
Jexl expressions — are fully serializable to JSON so rule sets can be stored
in a database, sent over the bus, and edited via a UI without custom binary
formats.

## Usage

```typescript
import { evaluate, evaluateRules, validateCondition } from '@makaio/rules';
import type { Condition, Rule } from '@makaio/rules';

// A simple field comparison
const condition: Condition = {
  field: 'order.state',
  operator: { $eq: 'open' },
};

// Evaluation never throws. It returns `{ matched }` or `{ error: { path, message } }`.
const outcome = evaluate(condition, { order: { state: 'open' } });
if ('error' in outcome) {
  // `outcome.error.path` locates the failing node, for example `$and[1].$expr`
  console.error(`Condition failed at ${outcome.error.path}: ${outcome.error.message}`);
} else if (outcome.matched) {
  // ...
}

// Boolean combinators
const compound: Condition = {
  $and: [
    { field: 'order.state', operator: { $in: ['open', 'pending'] } },
    { field: 'invoice.total', operator: { $gte: 100 } },
    { $not: { field: 'order.archived', operator: true } },
  ],
};

// Jexl expression (full context available)
const expr: Condition = {
  $expr: 'invoice.total > 100 && order.state == "open"',
};

// Evaluate a rule set: disabled rules are skipped by default
const rules: Rule<{ action: string }>[] = [
  {
    id: 'r1',
    name: 'Flag large invoices',
    condition: { field: 'invoice.total', operator: { $gt: 1000 } },
    action: { action: 'flag' },
    priority: 10,
    enabled: true,
  },
];

const { matched, failed } = evaluateRules(rules, { invoice: { total: 2500 } });
// matched[0].action.action === 'flag'
// failed lists `{ rule, error }` for every rule whose condition could not be evaluated

// Check a condition against the schema of its context before activating it
const findings = validateCondition({
  condition: compound,
  context: {
    type: 'object',
    properties: {
      order: {
        type: 'object',
        properties: { state: { type: 'string' }, archived: { type: 'boolean' } },
        required: ['state', 'archived'],
      },
      invoice: { type: 'object', properties: { total: { type: 'number' } }, required: ['total'] },
    },
    required: ['order', 'invoice'],
  },
});
// [] when the condition is fine
```

## Condition Types

| Type | Shape | Description |
|------|-------|-------------|
| `FieldCondition` | `{ field: string; operator: FieldOperator }` | Compare a dot-notation path against an operand |
| `AndCondition` | `{ $and: Condition[] }` | Matches when every operand matched |
| `OrCondition` | `{ $or: Condition[] }` | Matches when any operand matched |
| `NotCondition` | `{ $not: Condition }` | Negates its operand |
| `ExpressionCondition` | `{ $expr: string }` | Jexl expression evaluated against the full context |

The types and their Zod schemas are defined once in `@makaio/contracts/shared`
(`Condition`, `ConditionSchema`, `ConditionOutcome`, `ConditionError`, `ConditionFinding` and
their schemas); this package re-exports them. Use `Condition` wherever a condition is stored
or passed; there is no separate context-rule condition type.

### Field paths

A `field` is a dot-notation path into the context. Only **own** properties are read, so
`constructor`, `__proto__`, `toString` and `hasOwnProperty` are absent unless the context
really has such a key. A numeric segment indexes an array (`items.0.name`); any other
segment on an array, any segment on a primitive, and every missing step give an absent
field. `readDotPath(value, path)` in `@makaio/contracts/shared` is the reader the evaluator
uses; `jsonValueType(value)` from the same entry names the JSON type of a value.

### Evaluation outcome and errors

`evaluate()` returns a `ConditionOutcome`: `{ matched: boolean }` when the condition could
be evaluated, `{ error: ConditionError }` (`{ path, message }`) when it could not (an `$expr` that does not
compile or fails at run time). `path` is the way through the condition tree, the root is
`''`: `$and[1].$not.$expr`.

The outcome does not depend on operand order. `$and` and `$or` evaluate **every** operand;
there is no short circuit. If any operand fails, the outcome is that error (with several,
the first by position), even when another operand already decides the result. Otherwise
`$and` matches when every operand matched and `$or` when any matched. `$not` passes an
error through unchanged.

`evaluateRules()` returns a `RuleSetOutcome`: `matched` (rules whose condition matched) and
`failed` (`{ rule, error }` for rules whose condition could not be evaluated), both in input
order.

### `FieldOperator` values

| Operator | Example | Semantics |
|----------|---------|-----------|
| Scalar literal | `"open"` | Strict equality |
| `{ $eq }` | `{ $eq: { currency: "EUR" } }` | JSON equality (see below) |
| `{ $ne }` | `{ $ne: null }` | JSON inequality |
| `{ $in }` | `{ $in: ["open", "pending"] }` | Value in array |
| `{ $nin }` | `{ $nin: ["closed"] }` | Value not in array |
| `{ $contains }` | `{ $contains: "priority" }` | Array contains value |
| `{ $containsPrefix }` | `{ $containsPrefix: "region:" }` | Array contains a string with prefix |
| `{ $exists }` | `{ $exists: true }` | Field is not `undefined` (`null` counts as present) |
| `{ $startsWith }` | `{ $startsWith: "INV-" }` | String prefix |
| `{ $endsWith }` | `{ $endsWith: ".pdf" }` | String suffix |
| `{ $glob }` | `{ $glob: "exports/**/*.csv" }` | Minimatch glob |
| `{ $lt }` | `{ $lt: 100 }` | Less than |
| `{ $lte }` | `{ $lte: "2026-01-31T23:59:59Z" }` | Less than or equal |
| `{ $gt }` | `{ $gt: 0 }` | Greater than |
| `{ $gte }` | `{ $gte: "2026-01-01T00:00:00Z" }` | Greater than or equal |
| `{ $empty }` | `{ $empty: true }` | Value is `''`, `[]`, `{}` or `null` (`false`: any other present value) |

**Ordering operators** (`$lt`, `$lte`, `$gt`, `$gte`) take a number or a string. A number
compares against a finite number field. A string compares only when both sides are RFC 3339
`date-time` values (time zone offset required); they compare as instants, using the full
fractional precision given (microsecond, 100 ns and nanosecond digits all count). Any other pairing
does not match. A date-time has to be real: a day the month does not have (`2026-02-30`), hour 24
and a leap second (`:60`) are not date-times, so they never match, on either side.

**JSON equality**: `$eq` and `$ne` compare any JSON value by value. Arrays compare element by
element in order; objects compare by their entries, independent of key order. For scalars
this is strict equality.

### Absent fields

A field is absent when its path resolves to `undefined`. `null` is a present value.

| Operator | Matches an absent field |
|----------|-------------------------|
| Scalar literal, `$eq` | no |
| `$ne` | **yes** |
| `$in` | no |
| `$nin` | **yes** |
| `$contains`, `$containsPrefix` | no |
| `$exists: true` | no |
| `$exists: false` | **yes** (never reported, see below) |
| `$startsWith`, `$endsWith`, `$glob` | no |
| `$lt`, `$lte`, `$gt`, `$gte` | no |
| `$empty: true`, `$empty: false` | no |

`validateCondition()` reports the "yes" rows on an optional field as `unguarded-negation`
when the paths through that leaf can match with the field absent and no `$exists: true`
guard protects it (see below). `$exists` itself, `$exists: false` included, is never
reported: it asks about presence explicitly.

## Checking a condition

`validateCondition({ condition, context })` checks a condition before it is activated,
against one JSON Schema that describes the whole evaluation context object. It is pure and
never throws, and returns `ConditionFinding[]` (`{ severity, code, path, message }`) in tree
order; an empty list means the condition is fine.

A field path resolves from the context schema with no special case for its first segment:
the first segment is known when `properties` lists it, and optional unless `required` lists
it, so `unguarded-negation` applies to top-level fields too. A first segment that
`properties` does not list follows `additionalProperties`: `false` reports `unknown-root`;
a schema describes it; `true` admits it as an optional field of unknown type. A missing
`additionalProperties` counts as open when the schema has no `properties` and as closed when
it has, at every level. A property an open schema lists in `required` counts as present; what
lies below it does not.

| Code | Severity | Meaning |
|------|----------|---------|
| `unknown-root` | error | The context schema does not admit the field's first segment |
| `unknown-path` | error | A closed schema does not admit the field path |
| `type-mismatch` | error | The operator or its operand does not fit the field's type, including a `$contains` / `$containsPrefix` operand the array's declared item types cannot have and a string operand of an ordering operator that is not an RFC 3339 date-time (`$gte: "2026-02-30T00:00:00Z"`) |
| `unguarded-negation` | error | A negation leaf on an optional field decides a match when the field is absent, and no `{ $exists: true }` on that field in an enclosing `$and` protects it |
| `expression-syntax` | error | An `$expr` does not compile |
| `expression-unchecked` | warning | An `$expr` compiles; it is not checked against the schemas |

`$expr` is checked for syntax only. Field references inside an expression are not resolved
against the context schema, so every valid expression yields the `expression-unchecked`
warning.

`unguarded-negation` is judged per leaf, one field at a time. A leaf on an optional field is
reported when its value on an absent field equals the result the root needs from it, and
every operand of every enclosing conjunction can reach its needed result with that field
absent (other fields as they come). An `$and` is a conjunction while the root needs `true`,
an `$or` while it needs `false`, and `$not` flips the need. Operands of enclosing
disjunctions impose nothing, so a match through an unrelated `$or` branch does not count.
A guard protects wherever it stands in the same `$and`, because evaluation never
short-circuits and position does not matter. A field required on every step of its path
needs no guard. For a nested path, a guard on the field or below it always protects; a guard
on an ancestor protects only when nothing below that ancestor on the path is optional.

A leaf whose operator is `$exists` is never reported, whatever its value or negation:
`{ field: 'x', operator: { $exists: false } }` and `$not` over `{ $exists: true }` are how a
condition asks for an absent field.

```typescript
const ne: Condition = { field: 'x', operator: { $ne: 'a' } };
const guard: Condition = { field: 'x', operator: { $exists: true } };
// x optional in the context schema:
// ne                                   -> unguarded-negation
// { $and: [ne, guard] }                -> no finding (the guard may also come first)
// { $and: [ne, { field: 'x', operator: 'b' }] } -> no finding (cannot match with x absent)
// { $or: [ne, { field: 'x', operator: 'b' }] }  -> unguarded-negation
// { $or: [{ $and: [guard, ne] }, { field: 'y', operator: 'c' }] } -> no finding (the match
//                                      through the other branch does not need x absent)
// { field: 'x', operator: { $exists: false } } -> no finding
```

Finding paths use the notation of evaluation errors; a field condition's findings point at
`.field` or `.operator`, for example `$or[0].operator`.

## API Overview

| Export | Description |
|--------|-------------|
| `evaluate()` | Evaluate a single `Condition` to a `ConditionOutcome` |
| `evaluateRules()` | Sort a rule array into `matched` and `failed` (`RuleSetOutcome`) |
| `validateCondition()` | Check a condition against the context schema; returns `ConditionFinding[]` |
| `ConditionSchema` | Zod schema for the full `Condition` union |
| `FieldConditionSchema` / `ExpressionConditionSchema` / `FieldOperatorSchema` | Individual condition schemas |
| `ConditionOutcomeSchema` / `ConditionFindingSchema` | Zod schemas for the evaluation outcome and a check finding |
| `RuleSchema(actionSchema)` / `RuleSetOptionsSchema` | Generic factory returning a `Rule<TAction>` Zod schema; `RuleSetOptionsSchema` for evaluation options |
| All condition and rule types | `Condition`, `FieldCondition`, `AndCondition`, `OrCondition`, `NotCondition`, `ExpressionCondition`, `FieldOperator`, `Rule`, `RuleSetOutcome`, `ConditionOutcome`, `ConditionFinding`, `ValidateConditionInput`, etc. |

Schemas are also available from the `./schemas` sub-path export for
import-without-side-effects scenarios.

## Key Concepts

- **Priority**: `Rule.priority` is metadata only — the engine preserves caller
  input order. Sort rules by priority before calling `evaluateRules()` if
  ordering matters.
- **Expression caching**: compiled Jexl expressions and Minimatch glob patterns
  are cached with an LRU limit of 256 entries for repeated evaluation.
- **Bus-core compatibility**: the operators shared with the `@makaio/bus-core`
  payload filter intentionally mirror its semantics so the same condition shapes
  work in both contexts, and both read field paths as own properties only. The ordering
  operators, `$empty`, and JSON equality for `$eq`/`$ne` exist only here. The bus
  `PayloadFilter` (transport and subscription routing) is a separate type and unchanged.

## Installation

`@makaio/rules` is a private workspace package:

```json
{ "@makaio/rules": "workspace:*" }
```
