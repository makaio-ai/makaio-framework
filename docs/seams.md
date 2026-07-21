---
title: Architectural Seams
---

# Architectural Seams

Extension points and future enhancement opportunities across the codebase.

> **SEAMS Principle:** Simple Extensions, Abstract Minimally, Ship.
> Build the socket, not the plug. Abstract where variation is inevitable, implement only what's immediate.

---

## Workflow Runtime Seams

| Seam | Current Socket | Next Plug |
|---|---|---|
| Workflow crash recovery | Persisted `ForEachExpansionSnapshot` and `rebuildSchedulerGraph()` reconstruct generated nodes and item/index context. | Boot scanner that loads running executions, rebuilds active execution state, and either resumes or terminalizes safely. |
| StepRunner isolation | `IStepRunner` executes runner-owned `agent | shell` steps; gates remain scheduler-owned coordination points. Node runtime can compose in-process, Piscina, child-process, or Docker runners. | Remote runners with lifecycle/resource ownership beyond the Node host. |
| Runtime step blocks | Workflow steps are contract-defined built-ins plus an injected runner seam. | Extension-contributed runtime step types with schemas, runner dispatch, and validation. |
| Context pull/push | Expression context uses workflow inputs, trigger payloads, step results, and for-each item/index overlays. | Declarative context resolution before steps and structured output publication after steps. |
| Agent-step telemetry | Worker telemetry collection maps token usage and tool-call counts into workflow step spans. | Provider-specific cost/pricing attribution for workflow agent spans. |
| Worker MCP bridge | Isolated workers boot a local tool registry and MCP HTTP bridge for adapter tool routing. | Remote/container deployments may need explicit MCP endpoint publication and lifecycle policy beyond loopback workers. |
| MCP shared HTTP server | `McpServerBridgeService` starts its own HTTP server on demand for adapter sessions. | Attach MCP routing to a host-owned shared HTTP server when the host wants one network listener. |
| Same-agent resume | `contextMode: 'fresh' | 'fork'` controls child-session context inheritance. | Contract for continuing a previous agent/session across workflow steps. |
| Composite observation | Composite `for-each` state is persisted inside execution snapshots; public executable lifecycle remains `agent | shell | gate`. | Optional dedicated composite lifecycle subjects and UI visualization. |
| Host/product scoping | `WorkflowExecutionScope` supports `global | workspace | session | external`. | Product maps `projectId` to external scope or extends subjects at the host boundary. |
| Subagent execution target routing | Workflow agent steps execute through SubagentService for local targets; isolated workflow runners are covered by the StepRunner seam. | Decide whether non-local interactive subagent targets belong in SubagentService or only in workflow StepRunner implementations. |
