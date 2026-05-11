# @makaio/services-core/tool-approval

Tool approval policy resolution service. Handles `agent.toolApprove` RPC requests and resolves an effective policy through a multi-layer cascade, optionally gated by `.makaioignore` file-access rules.

## Policy Cascade

```
agent.toolApprove request
         │
         ▼
┌──────────────────────────────────────────────────────────────────┐
│  1. .makaioignore file-access deny (absolute floor)              │
│  2. Session-level override (full-access / reject / always-ask)   │
│  3. Enriched policy RPC (persona / profile per-tool policy)      │
│  4. Harness per-tool override (toolApprovalOverrides[toolName])  │
│  5. Harness base policy (approvalPolicy)                         │
│  6. Capability overrides (most-restrictive-wins)                 │
│  7. System default: 'always-ask'                                 │
└──────────────────────────────────────────────────────────────────┘
         │
         ├─ full-access → allow
         ├─ reject      → deny
         └─ always-ask  → request approval.request RPC (wait for user)
                          auto-cancelled on agent.session.closed
```

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
| `@makaio/contracts` | Bus subjects (`AgentSubjects`, `ApprovalSubjects`, `HarnessSubjects`), policy types, capability meta-tags |
| `@makaio/tools-filesystem` | `extractToolFilePath`, `FileAccessRuleProvider` type |

Internal sibling import: `../session` for `AgentStorageSubjects` and `SessionStorageSubjects`.
