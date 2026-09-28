# @makaio/services-core/tool-approval

Tool approval policy resolution service. Handles `agent.toolApprove` RPC requests and resolves an effective policy through a multi-layer cascade, optionally gated by `.makaioignore` file-access rules.

## Check Order

```
agent.toolApprove request
         │
         ▼
┌──────────────────────────────────────────────────────────────────┐
│  1. .makaioignore file-access deny (absolute floor)              │
│  2. Session override 'reject'           → deny                   │
│  3. Agent tool lists (evaluateToolGrant): deny → deny            │
│  4. Session override 'full-access'      → allow                  │
│  5. Policy cascade:                                              │
│     a. Enriched policy RPC (persona / profile per-tool policy)   │
│     b. Harness per-tool override (toolApprovalOverrides[tool])   │
│     c. Harness base policy (approvalPolicy)                      │
│     d. Capability overrides (most-restrictive-wins)              │
│     e. System default: 'always-ask'                              │
│     A tool-list grant turns a cascade 'always-ask' into allow.   │
│     A session 'always-ask' override replaces the cascade result. │
└──────────────────────────────────────────────────────────────────┘
         │
         ├─ full-access → allow
         ├─ reject      → deny
         └─ always-ask  → request approval.request RPC
                          (wait for user; auto-cancelled on
                          agent.session.closed)
```

### Tool-list grant

`evaluateToolGrant` reads `allowedTools` / `disallowedTools` from the agent record
(Makaio tool names, see `@makaio/contracts` `tool-names`) and checks the call in the
adapter's tool vocabulary (`toolVocabularyForAdapter`, adapter from the agent record).
Verdicts:

- `deny` — an invalid list entry, a denylist match, or a call not on the allowlist
  (`[]` allows nothing).
- `granted` — an allowlist exists and covers the call. It turns a cascade `always-ask`
  into `full-access` before the session override is merged, so a listed tool runs
  headless; a cascade `reject` and a session `always-ask` override still win.
  Under a directory allowlist (`agent.allowedDirectories`, else the profile's) the grant
  applies only to a call whose target path (`Glob`/`Grep` without `path`: the cwd) lies
  inside it; any other call gets `none`.
- `none` — no lists, no vocabulary for the adapter (e.g. `codex-app-server`), or a
  denylist-only pass. The cascade decides unchanged.

When the agent row lookup fails (a thrown storage request, not a missing row or an
unregistered storage handler), the call is decided as `always-ask`: the session
`full-access` override and any allowing cascade result do not apply, and only a cascade
`reject` still wins.

## Exports

**`index.ts`** re-exports:

| Export | Source | Description |
|--------|--------|-------------|
| `ToolApprovalService` | `tool-approval-service.ts` | Main service class (extends `BaseService`) |

Supporting types and helpers consumed internally or by tests:

| Symbol | Source | Description |
|--------|--------|-------------|
| `HarnessResolution` | `tool-approval-types.ts` | Subset of `HarnessDefinition` needed for approval |
| `PolicyResolutionResult` | `tool-approval-types.ts` | Resolved policy context with harness/agent data |
| `EnrichedApprovalRequest` | `tool-approval-types.ts` | Display-enriched payload sent via `approval.request` RPC |
| `FileAccessContext` | `tool-approval-types.ts` | CWD and directory constraints for rule evaluation |
| `POLICY_RANK` | `tool-approval-types.ts` | Restrictiveness rank map used for most-restrictive-wins |
| `generateRequestId` | `tool-approval-types.ts` | Prefixed UUID generator for approval correlation |
| `ToolApprovalServiceOptions` | `tool-approval-types.ts` | Constructor config (file-access rule provider) |

**`tool-approval-rules.ts`** — pure functions for policy resolution logic:

- `mapActionToPolicy` — RPC action to internal `ApprovalPolicy`
- `deriveRiskLevel` — capability set to `safe` / `neutral` / `destructive`
- `resolveHarnessLevelPolicy` — per-tool override or harness base
- `applyCapabilityOverrides` — most-restrictive-wins across capabilities
- `resolveFileAccessContext` — builds CWD/directory context for ignore rules
- `resolveEnrichedBasePolicy` — extracts policy from enriched-policy RPC result
- `resolveProfileAllowedDirectories` — directory allowlist from profile RPC
- `evaluateToolGrant` — agent tool lists to a `ToolGrantVerdict` (`deny` / `granted` / `none`)
- `enrichApprovalRequest` — builds the display-enriched request payload

## Usage

```typescript
import { ToolApprovalService } from '@makaio/services-core';

const service = new ToolApprovalService(bus, {
  fileAccessRuleProvider: myIgnoreRuleProvider, // optional
});
await service.init();
```

## Dependencies

| Package | Purpose |
|---------|---------|
| `@makaio/bus-core` | `IMakaioBus` for request/subscribe |
| `@makaio/service-base` | `BaseService` lifecycle and handler registration |
| `@makaio/contracts` | Bus subjects (`AgentSubjects`, `ApprovalSubjects`, `HarnessSubjects`), policy types, capability meta-tags, tool-name policy (`resolveToolPolicy`, `toolVocabularyForAdapter`) |
| `@makaio/tools-core` | `extractToolFilePath`, `FileAccessRuleProvider` type |

Internal sibling import: `../session` for `AgentStorageSubjects` and `SessionStorageSubjects`.
