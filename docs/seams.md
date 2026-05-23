# Architectural Seams

Extension points and future enhancement opportunities across the codebase.

> **SEAMS Principle:** Simple Extensions, Abstract Minimally, Ship.
> Build the socket, not the plug. Abstract where variation is inevitable, implement only what's immediate.

---

## Workflow Runtime Seams

| Seam | Current Socket | Next Plug |
|---|---|---|
| Workflow crash recovery | Persisted `ForEachExpansionSnapshot` and `rebuildSchedulerGraph()` reconstruct generated nodes and item/index context. | Boot scanner that loads running executions, rebuilds active execution state, and either resumes or terminalizes safely. |
| StepRunner isolation | `IStepRunner` executes `agent | shell | gate` through an injected runner contract. | Worker-thread, container, or remote runners with lifecycle/resource ownership. |
| Runtime step blocks | Workflow steps are contract-defined built-ins plus an injected runner seam. | Extension-contributed runtime step types with schemas, runner dispatch, and validation. |
| Context pull/push | Expression context uses workflow inputs, trigger payloads, step results, and for-each item/index overlays. | Declarative context resolution before steps and structured output publication after steps. |
| Agent-step telemetry | Span storage has duration/token/cost/tool-call columns; basic step spans are persisted. | Agent usage event ingestion that maps model usage into workflow step spans. |
| Same-agent resume | `contextMode: 'fresh' | 'fork'` controls child-session context inheritance. | Contract for continuing a previous agent/session across workflow steps. |
| Composite observation | Composite `for-each` state is persisted inside execution snapshots; public executable lifecycle remains `agent | shell | gate`. | Optional dedicated composite lifecycle subjects and UI visualization. |
| Host/product scoping | `WorkflowExecutionScope` supports `global | workspace | session | external`. | Product maps `projectId` to external scope or extends subjects at the host boundary. |
| Subagent execution target routing | SubagentService resolves execution targets but only local targets execute. | Remote/container execution targets for workflow agent steps. |
| Subagent child-session cleanup | Manager state is updated on completion/cancellation. | Explicit child-session close/termination policy tied to subagent lifecycle. |
