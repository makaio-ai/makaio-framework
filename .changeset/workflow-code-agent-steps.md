---
"@makaio/framework": major
"@makaio/subsystem-workflow-engine": major
"@makaio/runtime-node": major
"@makaio/storage-pg": patch
"@makaio/extension-telemetry-otel": patch
---

Replace workflow stations and role delegation with explicit `codeStep` and `agentStep` APIs. Code steps require registered handlers; agent steps are the single path for role-based execution. Rename station and delegate-role schemas, types, handlers, contexts, factories, and builder methods without compatibility aliases. Remove `delegate-agent`, `delegateToAgent`, `AgentConfig`, resolved-agent schemas, `workflow.resolveAgent`, and the corresponding worker bus permission. Delegate-result finalization requests no longer accept `nodeType`.

Workflow definitions, step nodes, and block mappings now reject unknown keys. Blocks map to agent steps. Stored definitions are validated when saved and loaded; invalid definitions fail with `WORKFLOW_DEFINITION_INVALID`. Definition lists return readable workflows together with `rejected: { id, reason }[]`, preserving invalid rows and keeping readable workflows available. Historical run snapshots remain inspectable, while execution requires a valid definition snapshot.

Agent-step prompt substitution renders objects and arrays as formatted JSON and fails visibly on expression errors. Former role-based stations using `completion: 'turn'` without harness fields now use fresh context. Terminal `frame.completed` and `frame.failed` events require `nodeType`. OpenTelemetry emits `code-step` and `agent-step` node-type values and classifies role-based agent execution as client spans.

SQLite and PostgreSQL data migrations rewrite supported node positions in stored definitions, run snapshots, workflow attempt snapshots, execution frames, spans, WorkLog entries, and external settlement fingerprints. Role delegation becomes agent steps; stations without a string role become code steps; role-bearing stations become agent steps only where definition dispatch proves that no module handler was present. Opaque payloads and unrelated workloads remain unchanged. Removed `delegate-agent` nodes and ambiguous role-bearing stations from module sources remain stored and are visibly rejected until republished in the new form. Workflow source code stored as text is not rewritten.
