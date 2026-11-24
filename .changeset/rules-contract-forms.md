---
"@makaio/contracts": major
"@makaio/framework": major
---

Add the public forms of rule evaluation (`makaio:rules`). The Node host registers rule contributions, serves their catalogs, and binds the source and trigger readers to the extension lifecycle. It withdraws the source before destroying its service.

## Breaking

- `NodeExtensionContext.rules: RulesCapability` is required. Hosts and tests that construct a context must supply the `validate` and `triggers` methods.
- `ReactionRule.reaction.params` accepts an object of `ParamTree` values when supplied.
- `RuleContributionsToken` gives extensions a read-only view for trigger and lookup discovery and contribution checks.
- The `evaluation-settled` event accepts `stoppedBy` only when its state is `stopped`.
- `ReactionDefinition.handler` now takes `(call, parameters, context)` and returns `Promise<ReactionOutcome>`. Both `ReactionDefinition` and `DefineReactionOptions` require `keyed: boolean` and support an optional `resultSchema`.
- `ReactionExecutionContext` replaces `ruleRef`, `eventKind`, `eventPayload` and `hostContext` with `key` and `cause`. `ReactionRuleRef` and `createReactionRuleRef` are removed.
- `ReactionOutcome` uses the four-state `state` discriminator (`accepted`, `rejected`, `failed`, `retry`). Contributed failure and rejection codes are open strings. `FrameworkReactionFailureCode` and its schema still enumerate `unknown-reaction`, `invalid-parameters`, `cancelled`, `handler-failed` and `outcome-unknown`.
- When cancellation or a deadline leaves no handler outcome, a keyed reaction yields `retry` with the same key on a later evaluation. An unkeyed reaction yields `failed` with `outcome-unknown` and receives no automatic retry.
- `ctx.getService(ReactionRegistryToken)` provides reaction registration and discovery. Hosts wire the live registry's `invoke` method into rule evaluation directly.
- Reaction, lookup and rule-block `validate` hooks return `RuleFinding[] | Promise<RuleFinding[]>`. Callers consuming those hooks must await their result.
- Catalog response schemas and types now describe the bus envelopes. Use `TriggerCatalogEntriesSchema`, `ReactionCatalogEntriesSchema` or `LookupCatalogEntriesSchema` to parse bare entry arrays. Their types are `TriggerCatalogEntries`, `ReactionCatalogEntries` and `LookupCatalogEntries`. The `TriggerCatalogResponseSchema` and `LookupCatalogResponseSchema` envelopes carry `entries` and `findings`. `ReactionCatalogResponseSchema` carries `entries`.
- `LookupContribution.answer(args, ctx)` accepts `ParamTree | undefined` as its first argument. A catalog read passes `undefined` to request the default answer schema.

## Rule contributions

- Paged rule evaluation requests can omit `limit`. Parsing supplies `RULES_EVALUATIONS_PAGE_DEFAULT_LIMIT` (50).
- `ConditionTemplate` accepts reference operands such as `{ $gt: { ref: "$lookup.limit" } }` in lookup filters.

- New `rules` domain in `@makaio/contracts`: `ReactionRule`, `RuleGroup`, `RuleExclusion`, `LookupCall`, `ParamTree`/`ValueExpr`, `EventFacts`, `RuleFinding`/`RuleValidationFinding`, `ValidateRulesInput`, the contribution shapes (`TriggerContribution`, `LookupContribution`, `RuleBlockContribution`, `GroupStrategyContribution`), the catalog forms, `CauseEvaluationView`/`EvaluationView`, `RuleSourceContribution`, and the `makaio:rules` bus namespace (`evaluations`, `reprocess`, the volatile hint `evaluation-settled`, and the `triggers`/`reactions`/`lookups` catalogs). Every request schema is exported so a handler can parse its own request — the bus does not validate payloads against the subject schema in production.

The host's contribution checker applies `rule-contributions.validationTimeoutMs` to each custom check. It defaults to 1,000 ms, giving normally local checks room to yield while bounding the wait for an unresponsive check. Configure it through the host's extension configuration. A thrown error or missed deadline produces an attributed finding. Full rule-set validation through `ctx.rules.validate` requires the rule validation engine.
