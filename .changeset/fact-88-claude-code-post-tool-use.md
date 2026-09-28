---
"@makaio/client-claude-code": minor
---

Bump the tool-response contract to 1.5.0, declare `context.append` on
`PostToolUse`, and stop context-only `PreToolUse` responses from implying
`allow`.

`PostToolUse` now declares `responseCapabilities: ['context.append']`. It moves
onto the `hook handle` lane as a non-blockable, context-only interaction with
the 1000 ms context-only timeout. Native output is
`hookSpecificOutput.additionalContext`, which Claude Code adds to the model's
context alongside the tool result. The tool has already run, so nothing can be
refused. Consumer-visible effect: every Claude tool call now performs one
synchronous `makaio hook handle` round-trip after the tool. While the server is
down, each tool call can stall for up to 1 s.

Security fix: a `PreToolUse` response in which contributors only appended
context (no approve or deny) no longer renders `permissionDecision: "allow"`.
It renders `additionalContext` alone, so Claude Code applies its normal
permission flow. Previously a context-only hint hook silently skipped the
user's permission prompt.

The claims are backed by live probes against the pinned binary: PostToolUse
context append after a native `Read` (`post-tool-use-context-append`), after an
MCP tool on a stdio probe server (`post-tool-use-mcp-context-append`, matcher
`mcp__probe__.*`), and after a `Bash` call inside a subagent
(`post-tool-use-subagent-context-append`, where the hook fires only in the
subagent and the payload carries `agent_id`). `pre-tool-use-context-append` is
now a context-only scenario.

BREAKING for installs below 2.1.283: `binary.supportedVersions` moves `^2.1.0`
→ `^2.1.283`, and the managed-install pin moves 2.1.219 → 2.1.283. Wiring is
derived statically from `responseCapabilities`, so declaring `PostToolUse`
context installs `hook handle` for every accepted binary. Upstream has no
changelog entry for `PostToolUse` `additionalContext`, so the floor is raised
to the probed pin by maintainer decision. All probe fixtures were recaptured
against 2.1.283.

BREAKING for contributors that pinned the contract catalog entry by exact
version: `claude-code.tool-response` moves 1.4.0 → 1.5.0. The change is
additive: `PostToolUse` joins `supportedInteractions` and `blockability`
(non-blockable), and every 1.4.0 contributor remains valid.
