# @makaio/expression

Jexl-based expression evaluation and template interpolation.

## What This Is

Thin wrapper around `jexl-extended` that provides:

- **Expression evaluation** - Synchronous and async evaluation of jexl expressions against a variable context
- **Expression compilation** - Compile hot-path expressions once, evaluate repeatedly
- **Template interpolation** - Resolve `{{ expr }}` placeholders in strings using jexl evaluation

Used by framework packages to evaluate workflow expressions, rule predicates, trigger filters, and template strings.

## Key Exports

**Engine:**
- `evaluate(expr, context)` - Evaluate a jexl expression asynchronously
- `evaluateSync(expr, context)` - Evaluate a jexl expression synchronously
- `compile(expr)` - Compile an expression for repeated evaluation (returns `CompiledExpression`)

**Template:**
- `resolveTemplate(template, context)` - Replace `{{ expr }}` placeholders in a string

**Types:**
- `ExpressionContext` - Generic variable map passed to jexl
- `WorkflowExpressionContext` - Workflow-specific context (`trigger`, `steps`, `inputs`, `item`, `index`)
- `CompiledExpression` - Compiled expression with `eval()` and `evalSync()` methods

## Basic Usage

```typescript
import { evaluate, evaluateSync, compile, resolveTemplate } from '@makaio/expression';
import type { ExpressionContext, WorkflowExpressionContext } from '@makaio/expression';

const genericCtx: ExpressionContext = {
  branch: 'main',
  packageName: 'workflow',
};

const label = resolveTemplate('{{ packageName }} on {{ branch }}', genericCtx);
// 'workflow on main'

const ctx: WorkflowExpressionContext = {
  trigger: { event: 'push', branch: 'main' },
  steps: { lint: { result: 'success', status: 'completed' } },
  inputs: { threshold: 80 },
};

// One-shot evaluation
const branch = evaluateSync('trigger.branch', ctx); // 'main'

// Compile for repeated use (e.g., trigger filter evaluation)
const filter = compile('trigger.branch == "main"');
const matches = filter.evalSync(ctx); // true

// Template interpolation
const message = resolveTemplate('Branch: {{ trigger.branch }}', ctx);
// 'Branch: main'
```

## Architecture

`@makaio/expression` is a leaf package — it has no dependencies on other Makaio packages (only on `@makaio/contracts` for the `StepStatus` type). Consumers are:

- `@makaio/rules` — evaluates step conditions and for-each expressions
- Trigger filters — compile expressions at registration time, evaluate at event time

Unknown paths and evaluation errors degrade gracefully to empty string in `resolveTemplate`.

---

*Part of Makaio Framework*
