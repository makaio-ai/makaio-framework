---
title: "review"
editUrl: false
prev: false
next: false
---

# `review`

| Field | Value |
|-------|-------|
| Prefix | `review` |
| Namespace constant | `ReviewNamespace` |
| Subjects constant | `ReviewSubjects` |
| Kind | bus |
| Schema record | `ReviewSchemas` |
| Tier | framework |
| Package | `@makaio/contracts` |
| Defined in | [`core/contracts/src/capabilities/review/namespace.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/capabilities/review/namespace.ts) |

## Subjects

| Key | Wire | Type | Schema |
|-----|------|------|--------|
| `finding.statusChanged` | [`review.finding.statusChanged`](#review.finding.statusChanged) | event | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/capabilities/review/schemas.ts) |
| `finding.updateStatus` | [`review.finding.updateStatus`](#review.finding.updateStatus) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/capabilities/review/schemas.ts) |
| `findings.arrived` | [`review.findings.arrived`](#review.findings.arrived) | event | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/capabilities/review/schemas.ts) |
| `findings.fetch` | [`review.findings.fetch`](#review.findings.fetch) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/capabilities/review/schemas.ts) |
| `findings.list` | [`review.findings.list`](#review.findings.list) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/capabilities/review/schemas.ts) |
| `findings.submit` | [`review.findings.submit`](#review.findings.submit) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/capabilities/review/schemas.ts) |
| `source.list` | [`review.source.list`](#review.source.list) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/capabilities/review/schemas.ts) |
| `source.rateLimitChanged` | [`review.source.rateLimitChanged`](#review.source.rateLimitChanged) | event | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/capabilities/review/schemas.ts) |
| `source.registered` | [`review.source.registered`](#review.source.registered) | event | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/capabilities/review/schemas.ts) |
| `start` | [`review.start`](#review.start) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/capabilities/review/schemas.ts) |
| `started` | [`review.started`](#review.started) | event | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/capabilities/review/schemas.ts) |

## Subject Details

### <a id="review.finding.statusChanged"></a>`review.finding.statusChanged` (event)

Finding status changed.

Subject: `review.finding.statusChanged`

Type: Event

| Field | Type | Required |
|-------|------|----------|
| `finding` | `{ id: string; target: { repository: string; prNumber?: number \| undefined; branch?: string \| undefined; headSha?: string \| undefined; }; sourceId: string; reviewer: string; origin: "agent" \| "inline" \| "review-body" \| "issue-comment" \| "cli-output"; threadId: string \| null; severity: "critical" \| "major" \| "minor" \| "nitpick"; file: string \| null; startLine: number \| null; endLine: number \| null; message: string; agentPrompt: string \| null; suggestedChanges: { file: string; oldCode: string; newCode: string; }[]; status: "open" \| "addressed" \| "verified" \| "dismissed" \| "deferred"; addressedBy: string \| null; addressedAt: number \| null; verifiedAt: number \| null; dismissedReason: string \| null; createdAt: number; updatedAt: number; rawCommentId: number \| null; }` | yes |
| `previousStatus` | `"open" \| "addressed" \| "verified" \| "dismissed" \| "deferred"` | yes |

### <a id="review.finding.updateStatus"></a>`review.finding.updateStatus` (rpc)

Update finding lifecycle status.

Subject: `review.finding.updateStatus`

Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `addressedBy` | `string \| undefined` | no |
| `findingId` | `string` | yes |
| `reason` | `string \| undefined` | no |
| `status` | `"open" \| "addressed" \| "verified" \| "dismissed" \| "deferred"` | yes |
| `target` | `{ repository: string; prNumber?: number \| undefined; branch?: string \| undefined; headSha?: string \| undefined; }` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `finding` | `{ id: string; target: { repository: string; prNumber?: number \| undefined; branch?: string \| undefined; headSha?: string \| undefined; }; sourceId: string; reviewer: string; origin: "agent" \| "inline" \| "review-body" \| "issue-comment" \| "cli-output"; threadId: string \| null; severity: "critical" \| "major" \| "minor" \| "nitpick"; file: string \| null; startLine: number \| null; endLine: number \| null; message: string; agentPrompt: string \| null; suggestedChanges: { file: string; oldCode: string; newCode: string; }[]; status: "open" \| "addressed" \| "verified" \| "dismissed" \| "deferred"; addressedBy: string \| null; addressedAt: number \| null; verifiedAt: number \| null; dismissedReason: string \| null; createdAt: number; updatedAt: number; rawCommentId: number \| null; }` | yes |
| `success` | `boolean` | yes |

### <a id="review.findings.arrived"></a>`review.findings.arrived` (event)

New/updated findings available.

Subject: `review.findings.arrived`

Type: Event

| Field | Type | Required |
|-------|------|----------|
| `created` | `number` | yes |
| `target` | `{ repository: string; prNumber?: number \| undefined; branch?: string \| undefined; headSha?: string \| undefined; }` | yes |
| `updated` | `number` | yes |

### <a id="review.findings.fetch"></a>`review.findings.fetch` (rpc)

Fetch findings from external sources.

Subject: `review.findings.fetch`

Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `repoPath` | `string` | yes |
| `target` | `{ repository: string; prNumber?: number \| undefined; branch?: string \| undefined; headSha?: string \| undefined; }` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `created` | `number` | yes |
| `findings` | `{ id: string; target: { repository: string; prNumber?: number \| undefined; branch?: string \| undefined; headSha?: string \| undefined; }; sourceId: string; reviewer: string; origin: "agent" \| "inline" \| "review-body" \| "issue-comment" \| "cli-output"; threadId: string \| null; severity: "critical" \| "major" \| "minor" \| "nitpick"; file: string \| null; startLine: number \| null; endLine: number \| null; message: string; agentPrompt: string \| null; suggestedChanges: { file: string; oldCode: string; newCode: string; }[]; status: "open" \| "addressed" \| "verified" \| "dismissed" \| "deferred"; addressedBy: string \| null; addressedAt: number \| null; verifiedAt: number \| null; dismissedReason: string \| null; createdAt: number; updatedAt: number; rawCommentId: number \| null; }[]` | yes |
| `updated` | `number` | yes |

### <a id="review.findings.list"></a>`review.findings.list` (rpc)

List stored findings.

Subject: `review.findings.list`

Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `status` | `"open" \| "addressed" \| "verified" \| "dismissed" \| "deferred" \| undefined` | no |
| `target` | `{ repository: string; prNumber?: number \| undefined; branch?: string \| undefined; headSha?: string \| undefined; }` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `findings` | `{ id: string; target: { repository: string; prNumber?: number \| undefined; branch?: string \| undefined; headSha?: string \| undefined; }; sourceId: string; reviewer: string; origin: "agent" \| "inline" \| "review-body" \| "issue-comment" \| "cli-output"; threadId: string \| null; severity: "critical" \| "major" \| "minor" \| "nitpick"; file: string \| null; startLine: number \| null; endLine: number \| null; message: string; agentPrompt: string \| null; suggestedChanges: { file: string; oldCode: string; newCode: string; }[]; status: "open" \| "addressed" \| "verified" \| "dismissed" \| "deferred"; addressedBy: string \| null; addressedAt: number \| null; verifiedAt: number \| null; dismissedReason: string \| null; createdAt: number; updatedAt: number; rawCommentId: number \| null; }[]` | yes |

### <a id="review.findings.submit"></a>`review.findings.submit` (rpc)

Submit an agent-produced finding.

Subject: `review.findings.submit`

Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `finding` | `{ message: string; file: string \| null; status: "open" \| "addressed" \| "verified" \| "dismissed" \| "deferred"; target: { repository: string; prNumber?: number \| undefined; branch?: string \| undefined; headSha?: string \| undefined; }; origin: "agent" \| "inline" \| "review-body" \| "issue-comment" \| "cli-output"; id: string; sourceId: string; threadId: string \| null; reviewer: string; severity: "critical" \| "major" \| "minor" \| "nitpick"; startLine: number \| null; endLine: number \| null; agentPrompt: string \| null; suggestedChanges: { file: string; oldCode: string; newCode: string; }[]; dismissedReason: string \| null; rawCommentId: number \| null; createdAt?: number \| undefined; updatedAt?: number \| undefined; }` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `finding` | `{ id: string; target: { repository: string; prNumber?: number \| undefined; branch?: string \| undefined; headSha?: string \| undefined; }; sourceId: string; reviewer: string; origin: "agent" \| "inline" \| "review-body" \| "issue-comment" \| "cli-output"; threadId: string \| null; severity: "critical" \| "major" \| "minor" \| "nitpick"; file: string \| null; startLine: number \| null; endLine: number \| null; message: string; agentPrompt: string \| null; suggestedChanges: { file: string; oldCode: string; newCode: string; }[]; status: "open" \| "addressed" \| "verified" \| "dismissed" \| "deferred"; addressedBy: string \| null; addressedAt: number \| null; verifiedAt: number \| null; dismissedReason: string \| null; createdAt: number; updatedAt: number; rawCommentId: number \| null; }` | yes |

### <a id="review.source.list"></a>`review.source.list` (rpc)

List available sources and their rate limits.

Subject: `review.source.list`

Type: Request (RPC)

**Request:**

_Empty object._

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `rateLimits` | `{ sourceId: string; remaining: number; limit: number; resetsAt: number; lastUpdatedAt: number; }[]` | yes |
| `sources` | `{ sourceId: string; reviewer: string; displayName: string; capabilities: { canTrigger: boolean; canFetch: boolean; isPush: boolean; }; processorKey: string \| null; shadowedProcessors?: string[] \| undefined; }[]` | yes |

### <a id="review.source.rateLimitChanged"></a>`review.source.rateLimitChanged` (event)

Source rate limit changed.

Subject: `review.source.rateLimitChanged`

Type: Event

| Field | Type | Required |
|-------|------|----------|
| `rateLimit` | `{ sourceId: string; remaining: number; limit: number; resetsAt: number; lastUpdatedAt: number; }` | yes |

### <a id="review.source.registered"></a>`review.source.registered` (event)

Source announces itself.

Subject: `review.source.registered`

Type: Event

| Field | Type | Required |
|-------|------|----------|
| `displayName` | `string` | yes |
| `reviewer` | `string` | yes |
| `sourceId` | `string` | yes |

### <a id="review.start"></a>`review.start` (rpc)

Trigger a review.

Subject: `review.start`

Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `repoPath` | `string` | yes |
| `sourceId` | `string \| undefined` | no |
| `target` | `{ repository: string; prNumber?: number \| undefined; branch?: string \| undefined; headSha?: string \| undefined; }` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `estimatedDelayMs` | `number \| undefined` | no |
| `rateLimit` | `{ sourceId: string; remaining: number; limit: number; resetsAt: number; lastUpdatedAt: number; } \| null` | yes |
| `triggered` | `boolean` | yes |

### <a id="review.started"></a>`review.started` (event)

Review was triggered.

Subject: `review.started`

Type: Event

| Field | Type | Required |
|-------|------|----------|
| `sourceId` | `string` | yes |
| `target` | `{ repository: string; prNumber?: number \| undefined; branch?: string \| undefined; headSha?: string \| undefined; }` | yes |

---

*Auto-generated by `yarn docs:bus`. Do not edit manually.*
