# Makaio PR Entity

Stateless aggregation extension that assembles a rich `PullRequestState` on demand by combining raw VCS data (PR metadata, check runs, commit statuses) with review findings from the review extension. Provides the `pr_status` AI tool for direct agent interaction and handles the `vcs:pr.*` bus subjects for service-to-service calls.

## What It Provides

| Surface | Detail |
|---------|--------|
| Background service | `VCSPRAggregationService` — handles `vcs:pr.get`, `vcs:pr.list`, `vcs:pr.sync` |
| AI tool | `pr_status` — get, list, or force-sync enriched PR state |
| Toolset | `pr-entity` |

There is no database table. All state is computed per-request with an in-memory LRU cache (64 entries, 2-minute TTL) to avoid redundant fetches during list operations.

## What Gets Aggregated

For each PR, the service fetches the following in parallel and merges them into a single `PullRequestState`:

| Data | Source subject |
|------|----------------|
| PR metadata (title, branch, author, reviews, labels, mergeable) | `vcs.pr.get` |
| GitHub check runs | `vcs.checks.get` |
| Legacy commit statuses | `vcs.statuses.get` |
| Repository identity (owner/repo) | `vcs.repository.get` |
| Review findings (optional) | `review.findings.list` (best-effort via `requestOptional`) |

Derived summaries are computed from the raw data:

- **Checks summary** — unified pass/fail/pending/skipped counts across check runs and commit statuses.
- **Reviews summary** — per-reviewer latest state, approval and changes-requested counts.
- **Findings summary** — open/addressed/verified counts broken down by severity (critical, major, minor, nitpick).
- **Label classification** — semantic categories (priority, status, type, size, review, automation).
- **Readiness assessment** — `ready`, `needs-attention`, or `blocked` with explicit blockers and warnings.

## `pr_status` Tool

The tool supports three operations via a discriminated union on `op`:

### `get` — fetch a single PR

```json
{ "op": "get", "pr": 42 }
{ "op": "get", "pr": 42, "repoPath": "/path/to/repo" }
```

### `list` — list all open PRs

```json
{ "op": "list" }
{ "op": "list", "branch": "feature/my-branch" }
```

### `sync` — force re-fetch, bypassing the cache

```json
{ "op": "sync", "pr": 42 }
```

`repoPath` is optional in all operations and defaults to the tool's execution working directory (`cwd`).

## Bus Subjects Handled

| Subject | Request | Response |
|---------|---------|----------|
| `vcs:pr.get` | `{ repoPath, prNumber }` | `{ pr: PullRequestState }` |
| `vcs:pr.list` | `{ repoPath, branch? }` | `{ prs: PullRequestState[] }` |
| `vcs:pr.sync` | `{ repoPath, prNumber }` | `{ pr: PullRequestState }` (cache bypassed) |

## Installation

```bash
makaio extension install ./extensions/pr-entity
```
