# Client Hook Response Pipeline

The hook response pipeline allows extensions to influence how AI client tools
behave at runtime. When a client binary fires a hook event that supports
response capabilities (e.g., Claude Code `PreToolUse`), the pipeline collects
contributions from all matching extension contributors, reduces them into a
single response, and serializes it back to the client binary on stdout.

This document covers the full pipeline architecture: capability-derived wiring,
contributor authoring, deterministic ordering, timeout/deadline behavior,
capability-bound fail-closed validation, and per-provider response composition.

---

## Evidence Status Matrix

The committed manifests separate source-backed candidate evidence from live
observations. Source evidence determines the currently declared contract; a
credentialed probe records whether the pinned binary actually fired and
consumed the response without rewriting history into a placeholder capture.

| Status          | Meaning |
|-----------------|---------|
| `supported`     | Pinned source or official documentation establishes a synchronous response contract. |
| `observer-only` | A live probe observed the event but established no synchronous response contract. |
| `unobserved`    | Available evidence does not establish a synchronous response contract. |

### Claude Code (CLI v2.1.143)

| Event             | Source Candidate | Capabilities             | Expected Stdout | Blocking | Framework Subject                          |
|-------------------|-----------------|--------------------------|-----------------|----------|--------------------------------------------|
| `SessionStart`    | unobserved      | *(none)*                 | No              | No       | `client.session.started`                   |
| `UserPromptSubmit`| unobserved      | *(none)*                 | No              | No       | `client.session.userPrompt.submitted`      |
| `PreToolUse`      | supported       | `claude-code.tool-response.approve`, `claude-code.tool-response.deny`, `context.append` | Yes | Yes | `client.session.tool.pre` |
| `PostToolUse`     | unobserved      | *(none)*                 | No              | No       | `client.session.tool.post`                 |
| `Stop`            | unobserved      | *(none)*                 | No              | No       | `client.session.turn.completed`            |
| `SubagentStop`    | unobserved      | *(none)*                 | No              | No       | *(none --- raw space only)*                |
| `Notification`    | unobserved      | *(none)*                 | No              | No       | *(none --- raw space only)*                |
| `MCPServerStart`  | unobserved      | *(none)*                 | No              | No       | *(none --- raw space only)*                |
| `MCPServerStop`   | unobserved      | *(none)*                 | No              | No       | *(none --- raw space only)*                |

#### Claude Code Notes

- Only `PreToolUse` declares `responseCapabilities` in the client definition.
  The wiring layer installs `makaio hook handle claude-code` for events with
  capabilities and `makaio hook received claude-code` for events without.
- `SubagentStop`, `Notification`, `MCPServerStart`, and `MCPServerStop` have
  no `frameworkSubject` --- they remain in the `client:claude-code` raw namespace
  and are not normalized into `client.session.*` observations.
- `UserPromptSubmit` is unique in producing two normalized events:
  `client.session.turn.started` followed by `client.session.userPrompt.submitted`.

### Codex (CLI v0.144.1)

| Event             | Source Candidate | Capabilities | Expected Stdout | Blocking | Framework Subject                          |
|-------------------|-----------------|--------------|-----------------|----------|--------------------------------------------|
| `SessionStart`    | supported       | `context.append`, `openai.codex-hook-response.block` | Yes | Yes | `client.session.started` |
| `UserPromptSubmit`| supported       | `context.append`, `openai.codex-hook-response.block` | Yes | Yes | `client.session.userPrompt.submitted` |
| `PreToolUse`      | supported       | `context.append`, `openai.codex-hook-response.block`, `openai.codex-hook-response.permission.deny`, `openai.codex-hook-response.input.update` | Yes | Yes | `client.session.tool.pre` |
| `PostToolUse`     | supported       | `context.append`, `openai.codex-hook-response.block` | Yes | Yes | `client.session.tool.post` |
| `Stop`            | supported       | `openai.codex-hook-response.block` | Yes | Yes | `client.session.turn.completed` |

#### Codex Notes

- The pinned upstream source tag `rust-v0.144.1` and the captured live binary
  probes verify synchronous JSON parsing for all five events. The contract
  intentionally excludes fields the parser rejects,
  including `PostToolUse.updatedMCPToolOutput`, `PreToolUse.permissionDecision: "ask"`,
  and `PreToolUse.permissionDecision: "allow"` without `updatedInput`.
- Codex `0.144.1` uses `tool_use_id` for pre/post tool correlation and carries
  the native result in `tool_response`. The generic observed event therefore
  leaves `success` unset rather than guessing from a provider-native value.
- Codex extracts session identity from `session_id` with fallback to
  `thread_id`.

### Evidence Metadata

| Field             | Value              |
|-------------------|--------------------|
| Fixture version   | 0.2.0              |
| Live probe status | captured            |
| Claude Code CLI   | 2.1.143            |
| Codex CLI         | 0.144.1            |

Paid probes against both pinned CLI binaries completed on 2026-07-21. The
provider manifests record their exact capture timestamps and event-level
observations. Claude confirmed `PreToolUse` response consumption, observed five
additional lifecycle hooks without response capabilities, and did not induce
`Notification`, `MCPServerStart`, or `MCPServerStop`. Codex confirmed every
declared effect for all five events.

---

## Pipeline Architecture

### Data flow

```
Native CLI binary
  |
  |  fires hook command (shell)
  v
Managed hook command (`makaio hook received|handle <clientId>`)
  |
  |  parses stdin as JSON, emits on bus
  v
Bus subject (`client:<id>.hook.received` or `client:<id>.hook.handle`)
  |
  |  normalizer transforms raw payload
  v
Normalized `client.session.*` observation
  |
  |  (for response-capable hooks only)
  v
ContributorDefinition[] snapshot (selector matching, priority sort)
  |
  |  concurrent collect with per-contributor timeout
  v
CanonicalEffect[] + ProviderContributionEnvelope[] reduction
  |
  |  provider-specific composer serializes native format
  v
Response on stdout (exitCode + stdout + stderr)
  |
  v
Native CLI binary reads stdout, applies decision
```

For **fire-and-forget** hooks (events with no `responseCapabilities`), the
managed command exits immediately after bus emission. The CLI does not wait
for or read stdout.

For **response-capable** hooks (events with `responseCapabilities`), the
managed command blocks until the bus request completes, then writes the
response JSON to stdout and exits. The CLI reads stdout and applies the
decision (e.g., approve/deny a tool use for `PreToolUse`).

### Capability-derived wiring

Hook events declare their transport mode through `responseCapabilities` on
the `ClientHookEventDeclaration` schema:

```ts
// From @makaio/contracts/client — ClientHookEventDeclarationSchema
{
  name: 'PreToolUse',
  frameworkSubject: 'client.session.tool.pre',
  responseCapabilities: [
    'claude-code.tool-response.approve',
    'claude-code.tool-response.deny',
    'context.append',
  ],
}
```

An empty `responseCapabilities` array (the default) means fire-and-forget.
A non-empty array activates request/response mode. The wiring layer uses
this to decide whether to install `makaio hook received` or
`makaio hook handle` for each event. No mode enum is necessary --- the
capabilities list is the single source of truth.

### Atomic activation

Contributors are registered atomically at extension activation time. The
`ExtensionClientHookResponsesContribution.createContributors()` factory is
called once per extension activation. Returned definitions are validated
against the active provider contract catalog before installation:

1. Contributor IDs must be non-empty strings (namespaced as
   `<extensionName>/<id>` at registration time).
2. Timeout values must be positive and finite.
3. At least one `InteractionSelector` must be provided.
4. `failurePolicy: 'closed'` is only permitted when the provider contract
   declares the interaction as blockable. The validation checks both that
   the interaction exists in `supportedInteractions` and that
   `blockability` records it as `blockable: true`.

If any contributor in the batch fails validation, none from that extension
are installed. Errors are reported as `ActivationValidationError` values
with typed error codes.

### Deterministic ordering

Contributors execute in a deterministic order within each hook event
invocation:

1. **Priority** (descending) --- higher `priority` values execute first.
2. **Registration order** (ascending) --- when priorities are equal, the
   contributor registered earlier executes first. Registration order is
   determined by a monotonically increasing ordinal assigned at install
   time.

The runtime takes a frozen snapshot of matching contributors before each
invocation. Mutations to the registry after snapshot creation do not affect
the current invocation.

### Timeout and deadline behavior

The pipeline uses a layered timeout model:

```
CLI --timeout flag (default 5000ms, relative)
  |
  +--> bridge emits hook.received (bounded by timeout)
  |       time consumed: ~Xms
  |
  +--> bridge issues hook.handle request (timeout = remaining)
  |       bus mints absolute deadline = Date.now() + remainingTimeout
  |       handler receives RequestContext.deadline
  |
  +--> per-contributor effective deadline =
  |       min(requestDeadline, callbackStartMs + contributor.timeoutMs)
  |
  +--> ContributorCallbackContext exposes:
           deadline     (absolute epoch-ms)
           remainingBudgetMs (snapshot at context creation)
           signal       (AbortSignal, fires at deadline)
```

Each contributor's `timeoutMs` is a per-callback ceiling. When the overall
request deadline is tighter than the contributor's timeout, the request
deadline wins. The `ContributorCallbackContext.signal` fires when whichever
deadline is reached first.

If the overall request deadline has already passed when collection begins,
all contributors are immediately marked as timed out without invocation.

### Routing via hostLocalRequest

The `hook.handle` bus subject is wrapped with `hostLocalRequest()`. This
instructs the bus to accept the request at the local host but never forward
it further across the bus topology. Response-hook round-trips must not
cross transport boundaries where caller cancellation cannot propagate.

### Fail-open and fail-closed semantics

Each contributor declares a `failurePolicy` (default: `'open'`):

| Policy | On failure (timeout, error, rejection) |
|--------|---------------------------------------|
| `'open'` | Omit this contributor's result, record the failure, continue collecting others. |
| `'closed'` | Discard all contributor results for this hook event and render a blocking response. |

`'closed'` is capability-bound: it requires the provider contract to
declare the interaction as `blockable: true`. This is validated at
activation time, not at runtime. For Claude Code `PreToolUse`, a
closed-failure causes the composer to emit a `deny` decision.

---

## Authoring Contributors

Extensions declare hook response contributors on the `clientHookResponses`
surface of `MakaioExtension`:

```ts
import {
  type ContributorDefinition,
  type ExtensionClientHookResponsesContribution,
  createAppendEffect,
} from '@makaio/contracts/client';

// On your MakaioExtension:
const clientHookResponses: ExtensionClientHookResponsesContribution = {
  createContributors: (ctx) => {
    const contributor: ContributorDefinition = {
      id: 'my-context-enricher',
      priority: 100,
      timeoutMs: 3000,
      failurePolicy: 'open',
      selectors: [{ kind: 'event-name', name: 'PreToolUse' }],
      respond: async (callbackCtx) => ({
        canonicalEffects: [createAppendEffect('Additional context from my extension')],
      }),
    };
    return [contributor];
  },
};
```

### Selectors

Selectors determine which hook events a contributor responds to. A
contributor is invoked when any of its selectors match the incoming event:

| Selector kind | Matches when |
|--------------|-------------|
| `event-name` | `eventName === selector.name` |
| `capability` | `eventCapabilities.includes(selector.capability)` |

Event-name selectors target specific events (e.g., `PreToolUse`).
Capability selectors target any event that declares a given capability
(e.g., `context.append`), allowing a contributor to respond to future
events without code changes.

### Canonical effects

Canonical effects are portable, provider-agnostic effects that work across
all client providers:

| Effect | Factory | Description |
|--------|---------|-------------|
| `context.append` | `createAppendEffect(value)` | Appends a string to the hook event's context. Multiple appends from different contributors are concatenated with newlines. |

### Provider contribution envelopes

For provider-specific behavior, contributors return a
`ProviderContributionEnvelope` alongside (or instead of) canonical effects.
Provider packages export typed builder functions:

```ts
import { createDenyEffect } from '@makaio/client-claude-code/runtime';

// In a contributor's respond callback:
respond: async (ctx) => ({
  providerEnvelope: createDenyEffect('File is read-only'),
}),
```

Provider envelopes are validated at runtime by the provider contract's
`validate` function. Invalid envelopes are treated as failures and handled
according to the contributor's `failurePolicy`.

### Activation context

The `createContributors` factory receives a `ContributorActivationContext`
with:

- `extensionName` --- the activating extension's name.
- `getProviderContract(contractId)` --- looks up a
  `ProviderContractCatalogEntry` by contract ID. Use this to check whether
  a provider contract is active before returning provider-specific
  contributors.

---

## Provider Contracts

Each client provider registers a `ProviderContractCatalogEntry` that
defines the interactions it supports and how contributions are validated.

### Claude Code (`claude-code.tool-response@1`)

| Field | Value |
|-------|-------|
| `clientId` | `claude-code` |
| `contractId` | `claude-code.tool-response` |
| `version` | `1.0.0` |
| `supportedInteractions` | `PreToolUse`, `approve`, `deny`, `context.append` |

**Blockability:**

| Interaction | Blockable |
|-------------|-----------|
| `PreToolUse` | Yes |
| `approve` | Yes |
| `deny` | Yes |
| `context.append` | No |

**Effect builders** (from `@makaio/client-claude-code/runtime`):

| Builder | Result |
|---------|--------|
| `createApproveEffect(reason?)` | Envelope with `decision: 'allow'` |
| `createDenyEffect(reason?)` | Envelope with `decision: 'deny'` |

**Composition rules:**

- Deny wins over allow (restrictive precedence).
- Multiple `context.append` effects are concatenated with newlines.
- Reasons from multiple contributors are joined with `'; '`.
- When only `context.append` effects are present (no explicit decision),
  the default decision is `allow`.
- Closed-failure causes a `deny` decision with the failure detail as the
  reason.

**Native output format** (written to stdout for `PreToolUse`):

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "permissionDecisionReason": "optional reason"
  }
}
```

### Codex (`openai.codex-hook-response@1`)

| Field | Value |
|-------|-------|
| `clientId` | `codex` |
| `contractId` | `openai.codex-hook-response` |
| `version` | `1.1.0` |
| `supportedInteractions` | five events plus `context.append` and the namespaced `block`, `permission.deny`, and `input.update` capabilities |

**Blockability:** All five events support a blocking outcome. SessionStart renders it through the native `continue: false` and `stopReason` fields; the other events use their event-specific block form.

**Response capabilities:** The pinned upstream `rust-v0.144.1` source parses
synchronous JSON responses for all five events. The composer renders context,
block, permission-deny, and input-update forms while preserving request
deadlines. Live CLI probes confirm these effects, and parser-rejected fields
are not advertised.

---

## Testing

### Unit and integration tests

Run with `yarn test`:

```bash
# Test the contribution processor
yarn test framework/subsystems/client

# Test Claude Code provider contracts and composer
yarn test framework/clients/claude-code

# Test Codex provider contracts and composer
yarn test framework/clients/codex

# Test the client-hooks bridge extension
yarn test framework/extensions/client-hooks
```

### Agent client probe (`yarn test:agent-clients`)

The `yarn test:agent-clients` script spawns real CLI binaries, makes paid
networked API calls, captures native hook events, and records normalized
fixture evidence. This test suite is:

- **Networked** --- requires internet access to reach provider APIs.
- **Credentialed** --- defaults to the locally inferred client login (including
  macOS Keychain-backed sessions); one explicit API key or OAuth token may
  override it.
- **Potentially costly** --- each run consumes API tokens.

It is never part of `yarn validate`, `test:framework`, or `test:unit`.

**When to run:**

- After upgrading the pinned Claude Code or Codex CLI version.
- After changing hook event declarations or response capabilities.
- After modifying the hook normalization or wiring layer.
- Before updating evidence status in the matrix above.

```bash
# Verify Claude Code fixtures through the local client login (costs API tokens):
yarn test:agent-clients --provider claude-code

# Update Codex fixtures through the local client login:
yarn test:agent-clients --provider codex --update-fixtures

# Optional explicit override; exactly one provider credential may be set:
ANTHROPIC_API_KEY=sk-... yarn test:agent-clients --provider claude-code
```

---

## Package Map

| Package | Role |
|---------|------|
| `@makaio/contracts` (`./client`) | Canonical types: `ContributorDefinition`, `CanonicalEffect`, `ProviderContractCatalogEntry`, selectors, failure policies, validation helpers |
| `@makaio/core` | `hostLocalRequest()` schema wrapper, `HostLocalRequestSubjectSchema` type |
| `@makaio/bus-core` | Deadline minting, `hostLocalRequest` enforcement during dispatch, `RequestContext.deadline` exposure |
| `@makaio/subsystem-client` | `ClientHookResponseRegistry`, `collectContributions` collector, `ClientHookResponseContributionProcessor`, `ClientHookHandleResponseSchema` |
| `@makaio/extension-client-hooks` | CLI bridge (`makaio hook received`, `makaio hook handle`), deadline-aware timeout budget management |
| `@makaio/client-claude-code` (`./runtime`) | `claudeCodeToolResponseContract`, `createApproveEffect`, `createDenyEffect`, `composeHookResponse` |
| `@makaio/client-codex` (`./runtime`) | `codexProviderContractCatalog`, `composeCodexHookResponse` |
