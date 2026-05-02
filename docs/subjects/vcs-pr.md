---
title: "vcs:pr"
editUrl: false
prev: false
next: false
---

# `vcs:pr`

| Field | Value |
|-------|-------|
| Prefix | `vcs:pr` |
| Namespace constant | `VCSPRNamespace` |
| Subjects constant | `VCSPRSubjects` |
| Kind | bus |
| Schema record | `VCSPRSchemas` |
| Tier | framework |
| Package | `@makaio/contracts` |
| Defined in | [`packages/contracts/src/capabilities/vcs-pr/namespace.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/contracts/src/capabilities/vcs-pr/namespace.ts) |

## Subjects

| Key | Wire | Type | Schema |
|-----|------|------|--------|
| `checks.changed` | [`vcs:pr.checks.changed`](#vcs:pr.checks.changed) | event | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/contracts/src/capabilities/vcs-pr/schemas.ts) |
| `conflicted` | [`vcs:pr.conflicted`](#vcs:pr.conflicted) | event | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/contracts/src/capabilities/vcs-pr/schemas.ts) |
| `get` | [`vcs:pr.get`](#vcs:pr.get) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/contracts/src/capabilities/vcs-pr/schemas.ts) |
| `labels.changed` | [`vcs:pr.labels.changed`](#vcs:pr.labels.changed) | event | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/contracts/src/capabilities/vcs-pr/schemas.ts) |
| `list` | [`vcs:pr.list`](#vcs:pr.list) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/contracts/src/capabilities/vcs-pr/schemas.ts) |
| `reviews.changed` | [`vcs:pr.reviews.changed`](#vcs:pr.reviews.changed) | event | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/contracts/src/capabilities/vcs-pr/schemas.ts) |
| `stateChanged` | [`vcs:pr.stateChanged`](#vcs:pr.stateChanged) | event | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/contracts/src/capabilities/vcs-pr/schemas.ts) |
| `sync` | [`vcs:pr.sync`](#vcs:pr.sync) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/contracts/src/capabilities/vcs-pr/schemas.ts) |

## Subject Details

### <a id="vcs:pr.checks.changed"></a>`vcs:pr.checks.changed` (event)

Checks changed. Subject: `vcs:pr.checks.changed`

Type: Event

| Field | Type | Required |
|-------|------|----------|
| `checks` | `{ status: "pending" \| "passing" \| "failing" \| "mixed"; total: number; passed: number; failed: number; pending: number; skipped: number; failedChecks: { id: number; name: string; workflowName: string; conclusion: string; failedStep: string \| null; detailsUrl: string \| null; completedAt: string \| null; source: "check-run" \| "commit-status"; }[]; summary: string; }` | yes |
| `target` | `{ repository: string; prNumber: number; branch?: string \| undefined; headSha?: string \| undefined; }` | yes |

### <a id="vcs:pr.conflicted"></a>`vcs:pr.conflicted` (event)

Merge conflict detected. Subject: `vcs:pr.conflicted`

Type: Event

| Field | Type | Required |
|-------|------|----------|
| `target` | `{ repository: string; prNumber: number; branch?: string \| undefined; headSha?: string \| undefined; }` | yes |

### <a id="vcs:pr.get"></a>`vcs:pr.get` (rpc)

Get enriched PR state. Subject: `vcs:pr.get`

Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `prNumber` | `number` | yes |
| `repoPath` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `pr` | `{ repository: string; number: number; title: string; branch: string; baseBranch: string; author: string; url: string; state: "closed" \| "merged" \| "open"; draft: boolean; mergeable: boolean \| null; checks: { status: "pending" \| "passing" \| "failing" \| "mixed"; total: number; passed: number; failed: number; pending: number; skipped: number; failedChecks: { id: number; name: string; workflowName: string; conclusion: string; failedStep: string \| null; detailsUrl: string \| null; completedAt: string \| null; source: "check-run" \| "commit-status"; }[]; summary: string; }; reviews: { status: "pending" \| "approved" \| "changes-requested"; approvals: number; changesRequested: number; commented: number; reviewers: { reviewer: string; state: "APPROVED" \| "CHANGES_REQUESTED" \| "COMMENTED" \| "PENDING" \| "DISMISSED"; submittedAt: string \| null; }[]; summary: string; }; findings: { total: number; open: number; addressed: number; verified: number; dismissed: number; openBySeverity: { critical: number; major: number; minor: number; nitpick: number; }; summary: string; }; labels: { name: string; semantic: "custom" \| "type" \| "status" \| "priority" \| "size" \| "review" \| "automation" \| null; }[]; readiness: { status: "ready" \| "blocked" \| "needs-attention"; blockers: string[]; warnings: string[]; }; syncedAt: number; headSha: string; }` | yes |

### <a id="vcs:pr.labels.changed"></a>`vcs:pr.labels.changed` (event)

Labels changed. Subject: `vcs:pr.labels.changed`

Type: Event

| Field | Type | Required |
|-------|------|----------|
| `labels` | `{ name: string; semantic: "custom" \| "type" \| "status" \| "priority" \| "size" \| "review" \| "automation" \| null; }[]` | yes |
| `target` | `{ repository: string; prNumber: number; branch?: string \| undefined; headSha?: string \| undefined; }` | yes |

### <a id="vcs:pr.list"></a>`vcs:pr.list` (rpc)

List enriched PR states. Subject: `vcs:pr.list`

Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `branch` | `string \| undefined` | no |
| `repoPath` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `prs` | `{ repository: string; number: number; title: string; branch: string; baseBranch: string; author: string; url: string; state: "closed" \| "merged" \| "open"; draft: boolean; mergeable: boolean \| null; checks: { status: "pending" \| "passing" \| "failing" \| "mixed"; total: number; passed: number; failed: number; pending: number; skipped: number; failedChecks: { id: number; name: string; workflowName: string; conclusion: string; failedStep: string \| null; detailsUrl: string \| null; completedAt: string \| null; source: "check-run" \| "commit-status"; }[]; summary: string; }; reviews: { status: "pending" \| "approved" \| "changes-requested"; approvals: number; changesRequested: number; commented: number; reviewers: { reviewer: string; state: "APPROVED" \| "CHANGES_REQUESTED" \| "COMMENTED" \| "PENDING" \| "DISMISSED"; submittedAt: string \| null; }[]; summary: string; }; findings: { total: number; open: number; addressed: number; verified: number; dismissed: number; openBySeverity: { critical: number; major: number; minor: number; nitpick: number; }; summary: string; }; labels: { name: string; semantic: "custom" \| "type" \| "status" \| "priority" \| "size" \| "review" \| "automation" \| null; }[]; readiness: { status: "ready" \| "blocked" \| "needs-attention"; blockers: string[]; warnings: string[]; }; syncedAt: number; headSha: string; }[]` | yes |

### <a id="vcs:pr.reviews.changed"></a>`vcs:pr.reviews.changed` (event)

Reviews changed. Subject: `vcs:pr.reviews.changed`

Type: Event

| Field | Type | Required |
|-------|------|----------|
| `reviews` | `{ status: "pending" \| "approved" \| "changes-requested"; approvals: number; changesRequested: number; commented: number; reviewers: { reviewer: string; state: "APPROVED" \| "CHANGES_REQUESTED" \| "COMMENTED" \| "PENDING" \| "DISMISSED"; submittedAt: string \| null; }[]; summary: string; }` | yes |
| `target` | `{ repository: string; prNumber: number; branch?: string \| undefined; headSha?: string \| undefined; }` | yes |

### <a id="vcs:pr.stateChanged"></a>`vcs:pr.stateChanged` (event)

Any sub-state changed. Subject: `vcs:pr.stateChanged`

Type: Event

| Field | Type | Required |
|-------|------|----------|
| `pr` | `{ repository: string; number: number; title: string; branch: string; baseBranch: string; author: string; url: string; state: "closed" \| "merged" \| "open"; draft: boolean; mergeable: boolean \| null; checks: { status: "pending" \| "passing" \| "failing" \| "mixed"; total: number; passed: number; failed: number; pending: number; skipped: number; failedChecks: { id: number; name: string; workflowName: string; conclusion: string; failedStep: string \| null; detailsUrl: string \| null; completedAt: string \| null; source: "check-run" \| "commit-status"; }[]; summary: string; }; reviews: { status: "pending" \| "approved" \| "changes-requested"; approvals: number; changesRequested: number; commented: number; reviewers: { reviewer: string; state: "APPROVED" \| "CHANGES_REQUESTED" \| "COMMENTED" \| "PENDING" \| "DISMISSED"; submittedAt: string \| null; }[]; summary: string; }; findings: { total: number; open: number; addressed: number; verified: number; dismissed: number; openBySeverity: { critical: number; major: number; minor: number; nitpick: number; }; summary: string; }; labels: { name: string; semantic: "custom" \| "type" \| "status" \| "priority" \| "size" \| "review" \| "automation" \| null; }[]; readiness: { status: "ready" \| "blocked" \| "needs-attention"; blockers: string[]; warnings: string[]; }; syncedAt: number; headSha: string; }` | yes |
| `target` | `{ repository: string; prNumber: number; branch?: string \| undefined; headSha?: string \| undefined; }` | yes |

### <a id="vcs:pr.sync"></a>`vcs:pr.sync` (rpc)

Force re-sync PR state. Subject: `vcs:pr.sync`

Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `prNumber` | `number` | yes |
| `repoPath` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `pr` | `{ repository: string; number: number; title: string; branch: string; baseBranch: string; author: string; url: string; state: "closed" \| "merged" \| "open"; draft: boolean; mergeable: boolean \| null; checks: { status: "pending" \| "passing" \| "failing" \| "mixed"; total: number; passed: number; failed: number; pending: number; skipped: number; failedChecks: { id: number; name: string; workflowName: string; conclusion: string; failedStep: string \| null; detailsUrl: string \| null; completedAt: string \| null; source: "check-run" \| "commit-status"; }[]; summary: string; }; reviews: { status: "pending" \| "approved" \| "changes-requested"; approvals: number; changesRequested: number; commented: number; reviewers: { reviewer: string; state: "APPROVED" \| "CHANGES_REQUESTED" \| "COMMENTED" \| "PENDING" \| "DISMISSED"; submittedAt: string \| null; }[]; summary: string; }; findings: { total: number; open: number; addressed: number; verified: number; dismissed: number; openBySeverity: { critical: number; major: number; minor: number; nitpick: number; }; summary: string; }; labels: { name: string; semantic: "custom" \| "type" \| "status" \| "priority" \| "size" \| "review" \| "automation" \| null; }[]; readiness: { status: "ready" \| "blocked" \| "needs-attention"; blockers: string[]; warnings: string[]; }; syncedAt: number; headSha: string; }` | yes |

---

*Auto-generated by `yarn docs:bus`. Do not edit manually.*
