# Makaio Reviewer — Copilot

Reviewer processor extension for GitHub Copilot code review. Registers the `copilotProcessor` with the capability bus so the `review` extension can normalize raw Copilot VCS comment data into `ReviewFinding` records.

## What It Provides

| Surface | Detail |
|---------|--------|
| Background service | Registers `copilotProcessor` with the capability bus on `init` |
| Capability | `reviewer-processor` with key `makaio/copilot`, reviewer family `copilot` |

This extension contributes no CLI commands, tools, or storage of its own. All findings management is handled by the `review` extension.

## How Copilot Findings Are Processed

Copilot posts inline review comments under the `copilot-pull-request-reviewer[bot]` author.

**Inline comments**

Each file-level, non-reply comment is converted to a `ReviewFinding` with:
- **Severity** — always `minor`. Copilot does not signal severity tiers.
- **Suggestion block** — fenced ` ```suggestion ` blocks are extracted as a structured `SuggestedChange` (old code left empty; new code is the suggestion content). The suggestion block is stripped from the `message` field so the text is prose-only.
- **Stable ID** — `<sourceId>:inline:<commentId>` (with thread ID when present, path+line composite otherwise).

Comments without a file path and reply comments are skipped, as they are not actionable findings.

**Review bodies**

Copilot review bodies contain summary tables and walkthrough prose but no per-line actionable findings. `processReviewBody` always returns an empty array.

## Finding ID Format

| Scenario | ID pattern |
|----------|-----------|
| Comment with thread ID | `<sourceId>:inline:<commentId>` |
| Comment without thread ID | `<sourceId>:inline:<commentId>:<path>:<line>` |

IDs are stable across fetches so reconciliation correctly detects resolved comments without false re-opens.

## Dependency

Requires the `review` extension to be loaded and running. The processor is registered via `CapabilityService` — if `review` is not loaded, the processor registration silently succeeds but has no effect.

## Installation

```bash
makaio extension install ./extensions/reviewer-copilot
makaio extension install ./extensions/review
```

---

*Part of the [Makaio AI Framework](../../README.md)*
