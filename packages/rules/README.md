# @makaio/rules

JSON-serializable predicate engine for the Makaio framework. Rules are
evaluated synchronously against a plain context object using a `Condition`
tree. All condition types — field comparisons, boolean combinators, and
Jexl expressions — are fully serializable to JSON so rule sets can be stored
in a database, sent over the bus, and edited via a UI without custom binary
formats.

## Usage

```typescript
import { evaluate, evaluateRules } from '@makaio/rules';
import type { Rule, Condition } from '@makaio/rules';

// A simple field comparison
const condition: Condition = {
  field: 'session.status',
  operator: { $eq: 'active' },
};

evaluate(condition, { session: { status: 'active' } }); // true

// Boolean combinators
const compound: Condition = {
  $and: [
    { field: 'user.role', operator: { $in: ['admin', 'editor'] } },
    { field: 'feature.enabled', operator: { $eq: true } },
    { $not: { field: 'user.suspended', operator: true } },
  ],
};

// Glob matching
const glob: Condition = {
  field: 'file.path',
  operator: { $glob: 'src/**/*.ts' },
};

// Jexl expression (full context available)
const expr: Condition = {
  $expr: 'session.turnCount > 10 && user.plan == "pro"',
};

// Evaluate a rule set — disabled rules are skipped by default
const rules: Rule<{ action: string }>[] = [
  {
    id: 'r1',
    name: 'Compress long sessions',
    condition: { $expr: 'session.turnCount >= 20' },
    action: { action: 'compress' },
    priority: 10,
    enabled: true,
  },
];

const matched = evaluateRules(rules, { session: { turnCount: 25 } });
// matched[0].action.action === 'compress'
```

## Condition Types

| Type | Shape | Description |
|------|-------|-------------|
| `FieldCondition` | `{ field: string; operator: FieldOperator }` | Compare a dot-notation path against a scalar value |
| `AndCondition` | `{ $and: Condition[] }` | All children must be truthy |
| `OrCondition` | `{ $or: Condition[] }` | Any child must be truthy |
| `NotCondition` | `{ $not: Condition }` | Negate a child condition |
| `ExpressionCondition` | `{ $expr: string }` | Jexl expression evaluated against the full context |

### `FieldOperator` values

| Operator | Example | Semantics |
|----------|---------|-----------|
| Scalar literal | `"active"` | Strict equality |
| `{ $eq }` | `{ $eq: "active" }` | Strict equality |
| `{ $ne }` | `{ $ne: null }` | Strict inequality |
| `{ $in }` | `{ $in: ["a", "b"] }` | Value in array |
| `{ $nin }` | `{ $nin: ["x"] }` | Value not in array |
| `{ $contains }` | `{ $contains: "admin" }` | Array contains value |
| `{ $containsPrefix }` | `{ $containsPrefix: "repo:" }` | Array contains a string with prefix |
| `{ $exists }` | `{ $exists: true }` | Field is not `undefined` |
| `{ $startsWith }` | `{ $startsWith: "src/" }` | String prefix |
| `{ $endsWith }` | `{ $endsWith: ".ts" }` | String suffix |
| `{ $glob }` | `{ $glob: "src/**/*.ts" }` | Minimatch glob |

## API Overview

| Export | Description |
|--------|-------------|
| `evaluate()` | Evaluate a single `Condition` synchronously |
| `evaluateRules()` | Filter a rule array to those whose conditions matched |
| `ConditionSchema` | Zod schema for the full `Condition` union |
| `FieldConditionSchema` / `ExpressionConditionSchema` | Individual condition schemas |
| `RuleSchema(actionSchema)` / `RuleSetOptionsSchema` | Generic factory returning a `Rule<TAction>` Zod schema; `RuleSetOptionsSchema` for evaluation options |
| All condition and rule types | `Condition`, `FieldCondition`, `AndCondition`, `OrCondition`, `NotCondition`, `ExpressionCondition`, `Rule`, `FieldOperator`, etc. |

Schemas are also available from the `./schemas` sub-path export for
import-without-side-effects scenarios.

## Key Concepts

- **Priority**: `Rule.priority` is metadata only — the engine preserves caller
  input order. Sort rules by priority before calling `evaluateRules()` if
  ordering matters.
- **Expression caching**: compiled Jexl expressions and Minimatch glob patterns
  are cached with an LRU limit of 256 entries for repeated evaluation.
- **Bus-core compatibility**: `FieldCondition` semantics intentionally mirror
  the `@makaio/bus-core` payload filter so the same condition shapes work in
  both contexts.

## Installation

`@makaio/rules` is a private workspace package:

```json
{ "@makaio/rules": "workspace:*" }
```
