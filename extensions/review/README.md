# Makaio Review Findings

Persistent review findings management extension. It receives raw VCS data snapshots from pluggable reviewer sources (e.g., CodeRabbit, Copilot), delegates normalization to registered reviewer processors, reconciles the results against stored findings, and exposes everything through the `review_findings` AI tool and a set of typed `review.*` bus subjects.

## What It Provides

| Surface | Detail |
|---------|--------|
| Background service | `ReviewFindingsService` — handles all `review.*` bus subjects |
| AI tool | `review_findings` — list, fetch, start, update_status, submit, sources |
| Toolset | `review` |
| Storage | Drizzle-backed SQLite table `extension_review_findings` |

## Architecture

The service acts as a coordinator between three distinct extension roles:

- **Review sources** (`IReviewSource`) — extensions that know how to fetch or trigger reviews from a specific reviewer (CodeRabbit, Copilot, etc.). Registered via `CapabilityService`.
- **Reviewer processors** (`IReviewerProcessor`) — stateless transformers that convert raw VCS comment/review data into normalized `ReviewFinding` records. Registered via `CapabilityService` (see `reviewer-coderabbit` and `reviewer-copilot`).
- **Review extension (this package)** — discovers sources and processors dynamically, orchestrates fetch → process → reconcile → persist, and handles lifecycle status transitions.

## Reconciliation Rules

When findings are fetched from an external source and compared to stored state:

| Scenario | Action |
|----------|--------|
| New finding not in storage | Upserted as `open` |
| Open finding absent from fresh snapshot | Transitioned to `verified` (resolved externally) |
| Verified or addressed finding re-appears in fresh snapshot | Transitioned back to `open` (re-raised) |

A `review.findings.arrived` event is emitted on the bus whenever findings are created or updated.

## `review_findings` Tool

The tool accepts a discriminated union on `op`:

### `list` — list stored findings

```json
{ "op": "list", "pr": 42 }
{ "op": "list", "pr": 42, "status": "open" }
```

### `fetch` — pull fresh findings from external sources

Fetches snapshots from all registered sources with `canFetch` capability, runs the appropriate processor, and reconciles with storage.

```json
{ "op": "fetch", "pr": 42 }
```

### `start` — trigger a review

Posts a review trigger to the first available source with `canTrigger` capability, respecting rate limits.

```json
{ "op": "start", "pr": 42 }
{ "op": "start", "pr": 42, "sourceId": "coderabbit-source-id" }
```

### `update_status` — transition a finding's lifecycle

```json
{
  "op": "update_status",
  "findingId": "coderabbit:inline:12345",
  "pr": 42,
  "status": "addressed",
  "addressedBy": "Fix in commit abc123"
}
```

Valid statuses: `open`, `addressed`, `verified`, `dismissed`, `deferred`.

### `submit` — store an agent-produced finding

```json
{
  "op": "submit",
  "finding": {
    "id": "agent:unique-id",
    "target": { "repository": "/path/to/repo", "prNumber": 42 },
    "sourceId": "agent-source",
    "reviewer": "agent",
    "origin": "inline",
    "severity": "major",
    "file": "src/foo.ts",
    "startLine": 10,
    "message": "This function has no error handling."
  }
}
```

### `sources` — list available review sources

```json
{ "op": "sources" }
```

Returns each source's ID, reviewer family, display name, capabilities (`canTrigger`, `canFetch`, `isPush`), active processor key, and any shadowed (lower-priority) processor keys.

## Bus Subjects Handled

| Subject | Description |
|---------|-------------|
| `review.findings.list` | List stored findings, optionally filtered by status |
| `review.findings.fetch` | Fetch from sources and reconcile |
| `review.start` | Trigger a review on a source |
| `review.findings.submit` | Store an agent-produced finding |
| `review.finding.updateStatus` | Transition a finding's lifecycle status |
| `review.source.list` | List registered sources with rate limits |

## Bus Events Emitted

| Subject | When |
|---------|------|
| `review.findings.arrived` | After a fetch creates or updates findings |
| `review.finding.statusChanged` | After `update_status` transitions a finding |
| `review.started` | After a review is successfully triggered |

## Storage Schema

The `extension_review_findings` table stores one row per finding with the following key columns:

| Column | Description |
|--------|-------------|
| `id` | Stable deterministic ID (e.g. `coderabbit:inline:12345`) |
| `repository`, `pr_number` | Target identification |
| `source_id`, `reviewer` | Source and reviewer family |
| `origin` | `inline` or `review-body` |
| `severity` | `critical`, `major`, `minor`, `nitpick` |
| `file`, `start_line`, `end_line` | Code location |
| `message` | Normalized finding text |
| `agent_prompt` | Pre-formatted AI agent instruction (when available) |
| `suggested_changes` | JSON-serialized `SuggestedChange[]` |
| `status` | Lifecycle: `open`, `addressed`, `verified`, `dismissed`, `deferred` |

## Installation

```bash
makaio extension install ./extensions/review
```

Reviewer processor extensions must also be installed to actually receive findings from external services:

```bash
makaio extension install ./extensions/reviewer-coderabbit
makaio extension install ./extensions/reviewer-copilot
```
