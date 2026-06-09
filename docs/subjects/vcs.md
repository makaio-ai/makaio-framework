---
title: "vcs"
editUrl: false
prev: false
next: false
---

# `vcs`

| Field | Value |
|-------|-------|
| Prefix | `vcs` |
| Namespace constant | `VCSNamespace` |
| Subjects constant | `VCSSubjects` |
| Kind | bus |
| Schema record | `VCSSchemas` |
| Tier | framework |
| Package | `@makaio/contracts` |
| Defined in | [`core/contracts/src/capabilities/vcs/namespace.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/capabilities/vcs/namespace.ts) |

## Subjects

| Key | Wire | Type | Schema |
|-----|------|------|--------|
| `capability.write` | [`vcs.capability.write`](#vcs.capability.write) | rpc | [`index.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/capabilities/vcs/schemas/index.ts) |
| `checks.get` | [`vcs.checks.get`](#vcs.checks.get) | rpc | [`index.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/capabilities/vcs/schemas/index.ts) |
| `comments.create` | [`vcs.comments.create`](#vcs.comments.create) | rpc | [`index.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/capabilities/vcs/schemas/index.ts) |
| `comments.list` | [`vcs.comments.list`](#vcs.comments.list) | rpc | [`index.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/capabilities/vcs/schemas/index.ts) |
| `comments.reply` | [`vcs.comments.reply`](#vcs.comments.reply) | rpc | [`index.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/capabilities/vcs/schemas/index.ts) |
| `comments.resolveThread` | [`vcs.comments.resolveThread`](#vcs.comments.resolveThread) | rpc | [`index.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/capabilities/vcs/schemas/index.ts) |
| `pr.get` | [`vcs.pr.get`](#vcs.pr.get) | rpc | [`index.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/capabilities/vcs/schemas/index.ts) |
| `pr.list` | [`vcs.pr.list`](#vcs.pr.list) | rpc | [`index.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/capabilities/vcs/schemas/index.ts) |
| `pr.listForFile` | [`vcs.pr.listForFile`](#vcs.pr.listForFile) | rpc | [`index.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/capabilities/vcs/schemas/index.ts) |
| `repository.get` | [`vcs.repository.get`](#vcs.repository.get) | rpc | [`index.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/capabilities/vcs/schemas/index.ts) |
| `statuses.get` | [`vcs.statuses.get`](#vcs.statuses.get) | rpc | [`index.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/capabilities/vcs/schemas/index.ts) |

## Subject Details

### <a id="vcs.capability.write"></a>`vcs.capability.write` (rpc)

Get write capability level for current user.

Subject: `vcs.capability.write`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `repoPath` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `canWrite` | `boolean` | yes |
| `level` | `"none" \| "read" \| "triage" \| "write" \| "maintain" \| "admin"` | yes |

### <a id="vcs.checks.get"></a>`vcs.checks.get` (rpc)

Get CI/CD check runs for a commit.

Subject: `vcs.checks.get`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `commitSha` | `string` | yes |
| `repoPath` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `checks` | `{ id: number; name: string; status: "completed" \| "queued" \| "in_progress"; conclusion: "success" \| "cancelled" \| "skipped" \| "neutral" \| "failure" \| "timed_out" \| "action_required" \| null; startedAt: string \| null; completedAt: string \| null; url: string; workflowName?: string \| undefined; jobName?: string \| undefined; }[]` | yes |

### <a id="vcs.comments.create"></a>`vcs.comments.create` (rpc)

Post a new inline comment on a file:line.

Subject: `vcs.comments.create`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `body` | `string` | yes |
| `commitId` | `string` | yes |
| `line` | `number` | yes |
| `path` | `string` | yes |
| `prNumber` | `number` | yes |
| `repoPath` | `string` | yes |
| `side` | `"LEFT" \| "RIGHT" \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `comment` | `{ id: number; author: string; body: string; path: string \| null; line: number \| null; createdAt: string; updatedAt: string; inReplyToId: number \| null; diffHunk?: string \| null \| undefined; threadId?: string \| null \| undefined; isResolved?: boolean \| null \| undefined; }` | yes |

### <a id="vcs.comments.list"></a>`vcs.comments.list` (rpc)

Get review comments for a pull request.

Subject: `vcs.comments.list`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `prNumber` | `number` | yes |
| `repoPath` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `comments` | `{ id: number; author: string; body: string; path: string \| null; line: number \| null; createdAt: string; updatedAt: string; inReplyToId: number \| null; diffHunk?: string \| null \| undefined; threadId?: string \| null \| undefined; isResolved?: boolean \| null \| undefined; }[]` | yes |

### <a id="vcs.comments.reply"></a>`vcs.comments.reply` (rpc)

Reply to an existing review comment.

Subject: `vcs.comments.reply`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `body` | `string` | yes |
| `commentId` | `number` | yes |
| `prNumber` | `number` | yes |
| `repoPath` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `comment` | `{ id: number; author: string; body: string; path: string \| null; line: number \| null; createdAt: string; updatedAt: string; inReplyToId: number \| null; diffHunk?: string \| null \| undefined; threadId?: string \| null \| undefined; isResolved?: boolean \| null \| undefined; }` | yes |

### <a id="vcs.comments.resolveThread"></a>`vcs.comments.resolveThread` (rpc)

Resolve a review thread.

Subject: `vcs.comments.resolveThread`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `prNumber` | `number` | yes |
| `repoPath` | `string` | yes |
| `threadId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `success` | `boolean` | yes |

### <a id="vcs.pr.get"></a>`vcs.pr.get` (rpc)

Get detailed information about a specific pull request.

Subject: `vcs.pr.get`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `prNumber` | `number` | yes |
| `repoPath` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `pullRequest` | `{ id: string; number: number; title: string; state: "closed" \| "merged" \| "open"; draft: boolean; author: string; branch: string; baseBranch: string; url: string; createdAt: string; updatedAt: string; mergedAt: string \| null; body: string \| null; reviews: { id: number; author: string; state: "APPROVED" \| "CHANGES_REQUESTED" \| "COMMENTED" \| "PENDING" \| "DISMISSED"; body: string \| null; submittedAt: string \| null; }[]; labels: string[]; assignees: string[]; requestedReviewers: string[]; mergeable: boolean \| null; head?: { ref: string; sha: string; } \| null \| undefined; additions?: number \| undefined; deletions?: number \| undefined; changedFiles?: number \| undefined; commentCount?: number \| undefined; reviewCount?: number \| undefined; mergeableState?: string \| undefined; } \| null` | yes |

### <a id="vcs.pr.list"></a>`vcs.pr.list` (rpc)

List pull requests for a repository branch.

Subject: `vcs.pr.list`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `branch` | `string` | yes |
| `repoPath` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `pullRequests` | `{ id: string; number: number; title: string; state: "closed" \| "merged" \| "open"; draft: boolean; author: string; branch: string; baseBranch: string; url: string; createdAt: string; updatedAt: string; mergedAt: string \| null; head?: { ref: string; sha: string; } \| null \| undefined; additions?: number \| undefined; deletions?: number \| undefined; changedFiles?: number \| undefined; commentCount?: number \| undefined; reviewCount?: number \| undefined; }[]` | yes |

### <a id="vcs.pr.listForFile"></a>`vcs.pr.listForFile` (rpc)

List PRs affecting a specific file.

Subject: `vcs.pr.listForFile`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `filePath` | `string` | yes |
| `repoPath` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `pullRequests` | `{ id: string; number: number; title: string; state: "closed" \| "merged" \| "open"; draft: boolean; author: string; branch: string; baseBranch: string; url: string; createdAt: string; updatedAt: string; mergedAt: string \| null; head?: { ref: string; sha: string; } \| null \| undefined; }[]` | yes |

### <a id="vcs.repository.get"></a>`vcs.repository.get` (rpc)

Get repository information for a given path.

Subject: `vcs.repository.get`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `repoPath` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `repository` | `{ provider: string; owner: string; repo: string; url: string; defaultBranch?: string \| undefined; } \| null` | yes |

### <a id="vcs.statuses.get"></a>`vcs.statuses.get` (rpc)

Get commit statuses for a commit (legacy status API).

Subject: `vcs.statuses.get`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `commitSha` | `string` | yes |
| `repoPath` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `statuses` | `{ id: number; state: "success" \| "error" \| "failure" \| "pending"; description: string \| null; targetUrl: string \| null; context: string; createdAt: string; updatedAt: string; creator: string \| null; }[]` | yes |

---

*Auto-generated by `yarn docs:bus`. Do not edit manually.*
