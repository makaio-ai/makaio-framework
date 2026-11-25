---
title: "makaio:rules"
editUrl: false
prev: false
next: false
---

# `makaio:rules`

| Field | Value |
|-------|-------|
| Prefix | `makaio:rules` |
| Namespace constant | `RulesNamespace` |
| Subjects constant | `RulesSubjects` |
| Kind | bus |
| Schema record | `RulesSchemas` |
| Tier | framework |
| Package | `@makaio/contracts` |
| Defined in | [`core/contracts/src/rules/namespace.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/rules/namespace.ts) |

## Subjects

| Key | Wire | Type | Schema |
|-----|------|------|--------|
| `evaluation-settled` | [`makaio:rules.evaluation-settled`](#makaio:rules.evaluation-settled) | event | [`evaluation-settled.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/rules/evaluation-settled.ts) |
| `evaluations` | [`makaio:rules.evaluations`](#makaio:rules.evaluations) | rpc | — |
| `lookups` | [`makaio:rules.lookups`](#makaio:rules.lookups) | rpc | — |
| `reactions` | [`makaio:rules.reactions`](#makaio:rules.reactions) | rpc | — |
| `reprocess` | [`makaio:rules.reprocess`](#makaio:rules.reprocess) | rpc | — |
| `triggers` | [`makaio:rules.triggers`](#makaio:rules.triggers) | rpc | — |

## Subject Details

### <a id="makaio:rules.evaluation-settled"></a>`makaio:rules.evaluation-settled` (event)

Payload of the volatile hint `makaio:rules.evaluation-settled`, for every
final state of an evaluation, including `not-matched` and `stopped`.

Without any promise, for observers. No rule names it (`hint-subject`).

Subject: `makaio:rules.evaluation-settled`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `cause` | `{ entryId: string; position: number; } \| { message: { receivedAt: string; }; }` | yes |
| `evaluationId` | `string` | yes |
| `group` | `string \| undefined` | no |
| `reason` | `string \| undefined` | no |
| `ruleId` | `string` | yes |
| `state` | `"stopped" \| "failed" \| "rejected" \| "accepted" \| "not-matched"` | yes |
| `stoppedBy` | `{ ruleIds: string[]; reach: "event" \| "group"; } \| undefined` | no |

### <a id="makaio:rules.evaluations"></a>`makaio:rules.evaluations` (rpc)

Subject: `makaio:rules.evaluations`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `cursor` | `string \| undefined` | no |
| `entryId` | `string \| undefined` | no |
| `evaluationId` | `string \| undefined` | no |
| `limit` | `number \| undefined` | no |
| `ruleId` | `string \| undefined` | no |
| `since` | `string \| undefined` | no |
| `state` | `"failed" \| "rejected" \| "pending" \| "accepted" \| "not-matched" \| "stopped" \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `cause` | `{ ruleSet: { id: string; digest: string; }; event: { cause: { entryId: string; position: number; } \| { message: { receivedAt: string; }; }; subject: string; origin: { caller: { kind: string; id: string; claims?: { readonly [key: string]: CallClaim; } \| undefined; }; principal: { kind: string; id: string; claims?: { readonly [key: string]: CallClaim; } \| undefined; }; extension: string; attestedBy?: { kind: string; id: string; claims?: { readonly [key: string]: CallClaim; } \| undefined; } \| undefined; edge?: string \| undefined; witnessed?: { extension: string; site: string; accountId: string; display?: string \| undefined; } \| undefined; } \| { caller: { kind: string; id: string; claims?: { readonly [key: string]: CallClaim; } \| undefined; }; principal: { kind: string; id: string; claims?: { readonly [key: string]: CallClaim; } \| undefined; }; attestedBy?: { kind: string; id: string; claims?: { readonly [key: string]: CallClaim; } \| undefined; } \| undefined; }; facts: Record<string, JsonValue>; }; state: "decided" \| "pending"; groups: { group: string \| null; strategy: string; members: { ruleId: string; priority?: number \| undefined; }[]; acting: string[]; stopped: { ruleId: string; by: string[]; reach: "event" \| "group"; }[]; notMatched: string[]; state: "decided" \| "pending"; reason?: string \| undefined; }[]; mandatory: string[]; excluded: RuleExclusion[]; eventStops?: { matched: string[]; stopped: string[]; } \| undefined; } \| undefined` | no |
| `evaluations` | `({ evaluationId: string; ruleId: string; ruleSet: { id: string; digest: string; }; event: { cause: { entryId: string; position: number; } \| { message: { receivedAt: string; }; }; subject: string; origin: { caller: { kind: string; id: string; claims?: { readonly [key: string]: CallClaim; } \| undefined; }; principal: { kind: string; id: string; claims?: { readonly [key: string]: CallClaim; } \| undefined; }; extension: string; attestedBy?: { kind: string; id: string; claims?: { readonly [key: string]: CallClaim; } \| undefined; } \| undefined; edge?: string \| undefined; witnessed?: { extension: string; site: string; accountId: string; display?: string \| undefined; } \| undefined; } \| { caller: { kind: string; id: string; claims?: { readonly [key: string]: CallClaim; } \| undefined; }; principal: { kind: string; id: string; claims?: { readonly [key: string]: CallClaim; } \| undefined; }; attestedBy?: { kind: string; id: string; claims?: { readonly [key: string]: CallClaim; } \| undefined; } \| undefined; }; facts: Record<string, JsonValue>; }; retries: number; parts: { reaction: string; key: string; state: "failed" \| "rejected" \| "pending" \| "accepted"; item?: JsonValue \| undefined; reason?: string \| undefined; result?: JsonValue \| undefined; }[]; state: "stopped"; group?: string \| undefined; reason?: string \| undefined; notBefore?: string \| undefined; stoppedBy?: { ruleIds: string[]; reach: "event" \| "group"; } \| undefined; } \| { evaluationId: string; ruleId: string; ruleSet: { id: string; digest: string; }; event: { cause: { entryId: string; position: number; } \| { message: { receivedAt: string; }; }; subject: string; origin: { caller: { kind: string; id: string; claims?: { readonly [key: string]: CallClaim; } \| undefined; }; principal: { kind: string; id: string; claims?: { readonly [key: string]: CallClaim; } \| undefined; }; extension: string; attestedBy?: { kind: string; id: string; claims?: { readonly [key: string]: CallClaim; } \| undefined; } \| undefined; edge?: string \| undefined; witnessed?: { extension: string; site: string; accountId: string; display?: string \| undefined; } \| undefined; } \| { caller: { kind: string; id: string; claims?: { readonly [key: string]: CallClaim; } \| undefined; }; principal: { kind: string; id: string; claims?: { readonly [key: string]: CallClaim; } \| undefined; }; attestedBy?: { kind: string; id: string; claims?: { readonly [key: string]: CallClaim; } \| undefined; } \| undefined; }; facts: Record<string, JsonValue>; }; retries: number; parts: { reaction: string; key: string; state: "failed" \| "rejected" \| "pending" \| "accepted"; item?: JsonValue \| undefined; reason?: string \| undefined; result?: JsonValue \| undefined; }[]; state: "failed" \| "rejected" \| "pending" \| "accepted" \| "not-matched"; group?: string \| undefined; reason?: string \| undefined; notBefore?: string \| undefined; })[]` | yes |
| `nextCursor` | `string \| undefined` | no |

### <a id="makaio:rules.lookups"></a>`makaio:rules.lookups` (rpc)

Subject: `makaio:rules.lookups`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `catalogContext` | `JsonValue \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `entries` | `{ kind: string; extension: string; description: string; args: Record<string, JsonValue>; answer: Record<string, JsonValue>; acceptsWhere: boolean; }[]` | yes |
| `findings` | `{ code: "catalog-contribution-failed"; extension: string; kind: string; message: string; }[]` | yes |

### <a id="makaio:rules.reactions"></a>`makaio:rules.reactions` (rpc)

Subject: `makaio:rules.reactions`
Type: Request (RPC)

**Request:**

_Empty object._

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `entries` | `{ kind: string; extension: string; description: string; params: Record<string, JsonValue>; result: Record<string, JsonValue> \| null; keyed: boolean; }[]` | yes |
| `findings` | `{ code: "catalog-contribution-failed"; extension: string; kind: string; message: string; }[]` | yes |

### <a id="makaio:rules.reprocess"></a>`makaio:rules.reprocess` (rpc)

Subject: `makaio:rules.reprocess`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `evaluationId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `code` | `"not-found" \| "not-failed" \| undefined` | no |
| `status` | `"requeued" \| undefined` | no |
| `success` | `true \| false` | yes |

### <a id="makaio:rules.triggers"></a>`makaio:rules.triggers` (rpc)

Subject: `makaio:rules.triggers`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `catalogContext` | `JsonValue \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `entries` | `{ kind: string; extension: string; description: string; params: Record<string, JsonValue> \| null; facts: Record<string, JsonValue>; subjects: string[]; }[]` | yes |
| `findings` | `{ code: "catalog-contribution-failed"; extension: string; kind: string; message: string; }[]` | yes |

---

*Auto-generated by `yarn docs:bus`. Do not edit manually.*
