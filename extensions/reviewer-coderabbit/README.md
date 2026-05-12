# Makaio Reviewer — CodeRabbit

Reviewer processor extension for CodeRabbit. Registers the `codeRabbitProcessor` with the capability bus so the `review` extension can normalize raw CodeRabbit VCS data into `ReviewFinding` records.

## What It Provides

| Surface | Detail |
|---------|--------|
| Background service | Registers `codeRabbitProcessor` with the capability bus on `init` |
| Capability | `reviewer-processor` with key `makaio/coderabbit`, reviewer family `coderabbit` |

This extension contributes no CLI commands, tools, or storage of its own. All findings management is handled by the `review` extension.

## How CodeRabbit Findings Are Processed

CodeRabbit posts findings in two tiers:

**1. Inline comments** (`coderabbitai[bot]` author, file-level diff comments)

Each comment is parsed for:
- **Severity** — detected from emoji markers: `🔴`/`🚨` → `critical`, `⚠️`/`Potential issue` → `major`, `🟡`/`Minor` → `minor`, `🧹`/`Nitpick` → `nitpick`.
- **Summary** — first bold Markdown sentence.
- **Explanation** — prose paragraph following the summary, before the first `<details>` block.
- **Suggested fix** — unified diff inside a `🔧 Suggested fix` details block, parsed into structured `SuggestedChange` entries.
- **Agent prompt** — content from the `🤖 Prompt for AI Agents` details block, stripped of HTML and ready for direct AI agent use.
- **Stable ID** — `<sourceId>:inline:<commentId>` (or path+line composite fallback).

Reply comments and general PR comments (no file path) are skipped.

**2. Review body nitpicks** (consolidated in the review body, not posted inline)

Nitpick findings are extracted from the `🧹 Nitpick comments` `<details>` block in review bodies. Each file has its own nested `<details>` section; findings are split on `---` separators. IDs use a content hash for stability since there is no raw comment ID anchor.

**Rate limit parsing**

CodeRabbit embeds rate limit state in HTML comment markers (`<!-- review_rate_limit_status_start -->`). The processor exposes `parseRateLimitFromBody(body)` so review sources can surface remaining request counts and reset times.

**HTML metadata stripping**

HTML comments used for CodeRabbit's internal fingerprinting and base64 state blobs are stripped before any parsing so they do not contaminate message text.

## Finding ID Format

| Origin | ID pattern |
|--------|-----------|
| Inline comment (with ID) | `<sourceId>:inline:<commentId>` |
| Inline comment (no ID) | `<sourceId>:inline:<threadId>:<path>:<line>` |
| Review-body nitpick | `<sourceId>:review-body:<reviewId>:<file>:<line>:<contentHash>` |

IDs are stable across fetches: the same comment always produces the same ID so reconciliation can detect resolved findings without false re-opens.

## Dependency

Requires the `review` extension to be loaded and running. The processor is registered via `CapabilityService` — if `review` is not loaded, the processor registration silently succeeds but has no effect.

## Installation

```bash
makaio extension install ./extensions/reviewer-coderabbit
makaio extension install ./extensions/review
```
