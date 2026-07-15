---
title: "storage:extension:review"
editUrl: false
prev: false
next: false
---

# `storage:extension:review`

| Field | Value |
|-------|-------|
| Prefix | `storage:extension:review` |
| Namespace constant | `ReviewStorageNamespace` |
| Subjects constant | `ReviewStorageSubjects` |
| Kind | extension-storage |
| Schema record | `<inline>` |
| Tier | extension |
| Package | `@makaio/extension-review` |
| Defined in | [`extensions/review/src/storage/namespace.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/extensions/review/src/storage/namespace.ts) |

## Subjects

| Key | Wire | Type | Schema |
|-----|------|------|--------|
| `findings.get` | [`storage:extension:review.findings.get`](#storage:extension:review.findings.get) | rpc | — |
| `findings.list` | [`storage:extension:review.findings.list`](#storage:extension:review.findings.list) | rpc | — |
| `findings.upsert` | [`storage:extension:review.findings.upsert`](#storage:extension:review.findings.upsert) | rpc | — |
| `findings.upsertBatch` | [`storage:extension:review.findings.upsertBatch`](#storage:extension:review.findings.upsertBatch) | rpc | — |

## Subject Details

### <a id="storage:extension:review.findings.get"></a>`storage:extension:review.findings.get` (rpc)

Subject: `storage:extension:review.findings.get`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `id` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `finding` | `{ id: string; target: { repository: string; prNumber?: number \| undefined; branch?: string \| undefined; headSha?: string \| undefined; }; sourceId: string; reviewer: string; origin: "inline" \| "agent" \| "review-body" \| "issue-comment" \| "cli-output"; threadId: string \| null; severity: "critical" \| "major" \| "minor" \| "nitpick"; file: string \| null; startLine: number \| null; endLine: number \| null; message: string; agentPrompt: string \| null; suggestedChanges: { file: string; oldCode: string; newCode: string; }[]; status: "verified" \| "open" \| "addressed" \| "dismissed" \| "deferred"; addressedBy: string \| null; addressedAt: number \| null; verifiedAt: number \| null; dismissedReason: string \| null; createdAt: number; updatedAt: number; rawCommentId: number \| null; } \| null` | yes |

### <a id="storage:extension:review.findings.list"></a>`storage:extension:review.findings.list` (rpc)

Subject: `storage:extension:review.findings.list`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `status` | `"verified" \| "open" \| "addressed" \| "dismissed" \| "deferred" \| undefined` | no |
| `target` | `{ repository: string; prNumber?: number \| undefined; branch?: string \| undefined; headSha?: string \| undefined; }` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `findings` | `{ id: string; target: { repository: string; prNumber?: number \| undefined; branch?: string \| undefined; headSha?: string \| undefined; }; sourceId: string; reviewer: string; origin: "inline" \| "agent" \| "review-body" \| "issue-comment" \| "cli-output"; threadId: string \| null; severity: "critical" \| "major" \| "minor" \| "nitpick"; file: string \| null; startLine: number \| null; endLine: number \| null; message: string; agentPrompt: string \| null; suggestedChanges: { file: string; oldCode: string; newCode: string; }[]; status: "verified" \| "open" \| "addressed" \| "dismissed" \| "deferred"; addressedBy: string \| null; addressedAt: number \| null; verifiedAt: number \| null; dismissedReason: string \| null; createdAt: number; updatedAt: number; rawCommentId: number \| null; }[]` | yes |

### <a id="storage:extension:review.findings.upsert"></a>`storage:extension:review.findings.upsert` (rpc)

Subject: `storage:extension:review.findings.upsert`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `finding` | `{ id: string; target: { repository: string; prNumber?: number \| undefined; branch?: string \| undefined; headSha?: string \| undefined; }; sourceId: string; reviewer: string; origin: "inline" \| "agent" \| "review-body" \| "issue-comment" \| "cli-output"; threadId: string \| null; severity: "critical" \| "major" \| "minor" \| "nitpick"; file: string \| null; startLine: number \| null; endLine: number \| null; message: string; agentPrompt: string \| null; suggestedChanges: { file: string; oldCode: string; newCode: string; }[]; status: "verified" \| "open" \| "addressed" \| "dismissed" \| "deferred"; addressedBy: string \| null; addressedAt: number \| null; verifiedAt: number \| null; dismissedReason: string \| null; createdAt: number; updatedAt: number; rawCommentId: number \| null; }` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `id` | `string` | yes |

### <a id="storage:extension:review.findings.upsertBatch"></a>`storage:extension:review.findings.upsertBatch` (rpc)

Subject: `storage:extension:review.findings.upsertBatch`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `findings` | `{ id: string; target: { repository: string; prNumber?: number \| undefined; branch?: string \| undefined; headSha?: string \| undefined; }; sourceId: string; reviewer: string; origin: "inline" \| "agent" \| "review-body" \| "issue-comment" \| "cli-output"; threadId: string \| null; severity: "critical" \| "major" \| "minor" \| "nitpick"; file: string \| null; startLine: number \| null; endLine: number \| null; message: string; agentPrompt: string \| null; suggestedChanges: { file: string; oldCode: string; newCode: string; }[]; status: "verified" \| "open" \| "addressed" \| "dismissed" \| "deferred"; addressedBy: string \| null; addressedAt: number \| null; verifiedAt: number \| null; dismissedReason: string \| null; createdAt: number; updatedAt: number; rawCommentId: number \| null; }[]` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `upserted` | `number` | yes |

---

*Auto-generated by `yarn docs:bus`. Do not edit manually.*
