---
"@makaio/framework": major
"@makaio/core": minor
"@makaio/bus-core": minor
"@makaio/contracts": major
"@makaio/runtime-node": major
---

Validate candidate rule sets against active contributions and rights. Pin rule decisions and effect inputs in host storage before invoking reactions, then resume interrupted effects according to their key guarantees. The generic bus request reaction carries the stored part key as request metadata, available to responders as `idempotencyKey`.

Candidate validation checks the registered request target and validates fully literal payloads with its request schema. The handler validates dynamic payloads after parameter expansion.

`@makaio/core` exports `ownsCanonicalContributionName(owner, name)` to check that a name follows the canonical contribution grammar and belongs to the given extension.

Breaking changes

- `ExtensionServiceLifecycle.extensionServiceView` optional object property -> optional method `extensionServiceView(identity, lifetime)`.
- Extension reaction registry `register(owner, reactions)` -> `register(reactions)` bound to the caller's activation.
- Extension reaction registry `deregister(owner)` -> `deregister()` bound to the caller's activation.
- Extension reaction registry `getValidator(kind)` -> host-only metadata access, with `ctx.rules.validate` for candidate validation.
- Extension `ctx.getService(RuleContributionsToken)` full service -> frozen view for trigger and lookup discovery and contribution checks. Validate complete rule sets through `ctx.rules`.
- Static `ruleContributionsPackage` in `frameworkCorePackages` -> explicit `createRuleContributionsPackage(resolveHostRegistry)` at host composition.
- Reaction catalog response `{ entries }` -> `{ entries, findings }`.
- `RuleValidationFinding.ruleId` is now optional because findings on group declarations have no associated rule.
- Evaluation views allow `stoppedBy` only in the `stopped` state.
- Lookup `where` comparison objects interpreted directly as literals -> single-key `ref`, `template`, and `literal` objects are operands. Wrap fixed data of these shapes in `literal`. Rule `when` keeps literal operands.
- Malformed single-key `ref` and `template` objects interpreted as data in parameter trees -> rejected operands. Wrap fixed data of these shapes in `literal`.
- Lookup contribution `resolve(call, args, where, deadline)` -> `resolve(call, args, where, deadline, signal)` with cancellation at the decision deadline.
- A reaction cancelled before handler entry could report `failed/outcome-unknown` -> pre-entry cancellation reports `retry` for both keyed and unkeyed reactions.
- `MakaioRuntime` without an evaluator -> required `MakaioRuntime.ruleEvaluator`.
- Node boot could proceed without rule registries -> boot requires both the rule contribution and reaction registries.
