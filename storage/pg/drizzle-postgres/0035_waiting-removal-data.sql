-- Waiting removal, data part (paired with migrations/drizzle/0045_waiting-removal-data.sql).
-- Retain historical rows, gate tables and legacy columns. Fail waiting executions and live
-- executions with incompatible definition snapshots, then settle their frames, spans and summaries.
-- Clear gate-frame registration bindings, convert compatible loop checks and remove layout from
-- executable copies. Unconvertible trees are retained for explicit rejection when loaded.
-- `instruction` and `outcome_text` are text columns holding hand-serialized JSON. A valid stored
-- document can contain the literal 6-character escape `\u0000`, which
-- `JSON.parse` accepts but which `::jsonb` always rejects, because the decoded NUL byte cannot be represented
-- in Postgres text at all, regardless of position. A whole-document cast therefore blocks conversion when
-- any opaque leaf contains this escape. A fixed sentinel would corrupt U+E000 payloads and cannot handle
-- lone UTF-16 surrogates. `pg_temp.waiting_removal_has_nul_escape` scans raw text with backslash parity and reports
-- true only for a genuine, unescaped `\u0000` escape token (never for an escaped backslash followed by the
-- literal text `u0000`, and never for an unrelated character). `pg_temp.waiting_removal_parse_jsonb` returns NULL whenever
-- the text carries such a token or is otherwise malformed JSON, including a lone UTF-16 surrogate, which
-- `jsonb` also rejects on input; both failures leave the ROW untouched by every statement below, regardless of
-- where in the document the token sits. Two distinct
-- row classes can be left behind this way, each with its own actual rejection reader, named separately because
-- they are read by different code and neither is "the outcome codec" in general: (1) an `instruction` of
-- `workload.kind = 'workflow'` whose embedded `definitionSnapshot` still contains a stored `gate` node or loop
-- `gate` is rejected only when that instruction is later parsed as an executable workflow instruction, i.e. when
-- an outcome for this attempt is accepted (`WorkflowInvocationInputSchema`,
-- `framework/subsystems/workflow-engine/src/workflow-attempt-instruction.ts`; the parse runs at
-- `framework/subsystems/workflow-engine/src/workflow-attempt-outcome.ts`); this row's own `status` need not be `paused` and it may
-- carry no `outcome_text` at all. (2) an `outcome_text` of `workload.kind = 'workflow'` with its OWN recorded
-- `status: 'paused'` keeps that superseded status and is rejected visibly when read, because the outcome codec
-- no longer accepts it once this migration ships
-- (`framework/subsystems/workflow-engine/src/execution-attempt-owner-recovery.ts`,
-- `framework/storage/pg/src/execution-attempt-control.ts`). The conformance suite counts both classes separately
-- by owner and remaining legacy structure or status (unlike SQLite, which
-- has no such whole-document restriction). No fixed sentinel of any kind is introduced: valid
-- JSON containing U+E000, or an escaped backslash in front of the literal text `u0000`, casts and round-trips
-- exactly like every other value.
CREATE FUNCTION pg_temp.waiting_removal_has_nul_escape(value text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(value ~ $nul$(^|[^\\])(\\\\)*\\u0000$nul$, false)
$$;--> statement-breakpoint
CREATE FUNCTION pg_temp.waiting_removal_parse_jsonb(value text) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF value IS NULL OR pg_temp.waiting_removal_has_nul_escape(value) THEN
    RETURN NULL;
  END IF;
  RETURN value::jsonb;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END
$$;--> statement-breakpoint
UPDATE "workflow_executions" SET "external_registration_frame_id" = NULL WHERE "external_registration_frame_id" IN (SELECT "frame_id" FROM "worklog_frame_entries" WHERE "node_type" = 'gate') OR "external_registration_frame_id" IN (SELECT "frame_id" FROM "workflow_execution_frames" WHERE "node_type" = 'gate');--> statement-breakpoint
UPDATE "workflow_executions" SET "status" = 'failed', "error" = 'Workflow waits were removed; this execution was waiting for a gate response and can no longer continue.', "completed_at" = (extract(epoch FROM clock_timestamp()) * 1000)::bigint WHERE "status" IN ('pending', 'running', 'paused', 'finalizing') AND ("status" = 'paused' OR "id" IN (SELECT "execution_id" FROM "workflow_execution_frames" WHERE "status" = 'waiting') OR "id" IN (SELECT "execution_id" FROM "worklog_frame_entries" WHERE "status" = 'waiting') OR "id" IN (SELECT "execution_id" FROM "worklog_summaries" WHERE "status" = 'paused') OR "id" IN (SELECT "execution_id" FROM "workflow_gate_instances" WHERE "status" = 'waiting') OR "id" IN (SELECT "execution_id" FROM "worklog_gate_events" WHERE "status" = 'waiting'));--> statement-breakpoint
WITH candidates AS MATERIALIZED (
  SELECT execution_attempt_id, pg_temp.waiting_removal_parse_jsonb(outcome_text) AS outcome,
    pg_temp.waiting_removal_parse_jsonb(instruction) AS instruction
  FROM execution_attempt
  WHERE strpos(outcome_text, '"paused"') > 0 OR strpos(outcome_text, '\u') > 0
)
UPDATE execution_attempt AS attempt
SET outcome_text = jsonb_build_object(
  'executionId', c.outcome ->> 'executionId', 'workflowId', c.outcome ->> 'workflowId', 'status', 'failed',
  'error', 'Workflow waits were removed; this execution was waiting for a gate response and can no longer continue.'
    || ' pausedAtGateId=' || (c.outcome -> 'pausedAtGateId')::text
    || ' pausedAtFrameId=' || (c.outcome -> 'pausedAtFrameId')::text)::text
FROM candidates AS c
WHERE attempt.execution_attempt_id = c.execution_attempt_id
  AND c.outcome ->> 'status' = 'paused' AND c.instruction #>> '{workload,kind}' = 'workflow';--> statement-breakpoint
CREATE FUNCTION pg_temp.waiting_removal_node_blocked(node jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE child jsonb;
BEGIN
  IF jsonb_typeof(node) IS DISTINCT FROM 'object' THEN
    RETURN false;
  END IF;
  CASE node ->> 'type'
    WHEN 'gate' THEN
      RETURN true;
    WHEN 'sequence' THEN
      IF jsonb_typeof(node -> 'nodes') = 'array' THEN
        FOR child IN SELECT "value" FROM jsonb_array_elements(node -> 'nodes') LOOP
          IF pg_temp.waiting_removal_node_blocked(child) THEN RETURN true; END IF;
        END LOOP;
      END IF;
    WHEN 'parallel' THEN
      IF jsonb_typeof(node -> 'branches') = 'object' THEN
        FOR child IN SELECT "value" FROM jsonb_each(node -> 'branches') LOOP
          IF pg_temp.waiting_removal_node_blocked(child) THEN RETURN true; END IF;
        END LOOP;
      END IF;
    WHEN 'iterate', 'iterate-chain' THEN
      RETURN pg_temp.waiting_removal_node_blocked(node -> 'body');
    WHEN 'loop' THEN
      IF EXISTS (SELECT 1 FROM jsonb_object_keys(node) AS "lk" WHERE "lk" NOT IN ('id', 'type', 'maxRounds', 'body', 'gate', 'check', 'onExhausted', 'when', 'skip', 'writes')) THEN
        RETURN true;
      END IF;
      IF node ? 'gate' AND NOT (
        jsonb_typeof(node -> 'gate') = 'object'
        AND NOT (node ? 'check')
        AND NOT (node ? 'onExhausted')
        AND NOT EXISTS (SELECT 1 FROM jsonb_object_keys(node -> 'gate') AS "k" WHERE "k" NOT IN ('handler', 'input', 'config'))
        AND COALESCE(jsonb_typeof(node -> 'gate' -> 'handler') = 'string', false)
        AND COALESCE(length(node -> 'gate' ->> 'handler') > 0, false)
        AND (
          NOT (node -> 'gate' ? 'input')
          OR (COALESCE(jsonb_typeof(node -> 'gate' -> 'input') = 'string', false) AND COALESCE(length(node -> 'gate' ->> 'input') > 0, false))
        )
      ) THEN
        RETURN true;
      END IF;
      RETURN pg_temp.waiting_removal_node_blocked(node -> 'body');
    ELSE
      NULL;
  END CASE;
  RETURN false;
END
$$;--> statement-breakpoint
-- A live execution cannot continue with a blocked definition in either executable copy.
WITH live_attempts AS MATERIALIZED (
  SELECT e.id, pg_temp.waiting_removal_parse_jsonb(attempt.instruction) AS doc
  FROM workflow_executions AS e
  JOIN active_execution_attempt AS active ON active.execution_id = e.id
  JOIN execution_attempt AS attempt USING (execution_id, execution_attempt_id)
  WHERE e.status IN ('pending', 'running') AND (strpos(attempt.instruction, '"definitionSnapshot"') > 0 OR strpos(attempt.instruction, '\u') > 0)
), incompatible AS (
  SELECT e.id
  FROM workflow_executions AS e
  JOIN workflow_run_contexts AS ctx ON ctx.execution_id = e.id
  WHERE e.status IN ('pending', 'running') AND pg_temp.waiting_removal_node_blocked(ctx.definition_snapshot -> 'root')
  UNION ALL
  SELECT id FROM live_attempts
  WHERE doc #>> '{workload,kind}' = 'workflow'
    AND pg_temp.waiting_removal_node_blocked(doc #> '{workload,input,definitionSnapshot,root}')
)
UPDATE workflow_executions
SET status = 'failed', error = 'Workflow waits were removed; this execution has an incompatible definition snapshot and cannot continue.',
  completed_at = (extract(epoch FROM clock_timestamp()) * 1000)::bigint
WHERE status IN ('pending', 'running') AND id IN (SELECT id FROM incompatible);--> statement-breakpoint
-- Close only the current attempt belonging to a failed workflow. Existing outcomes are
-- still evidence, and provider-operation recovery retains its own durable obligations.
UPDATE execution_attempt AS attempt
SET status = 'settled',
  settlement_kind = CASE WHEN attempt.outcome_text IS NULL THEN 'abandoned' ELSE 'outcome' END,
  claimable = 0, operation_start_gate = 'closed'
FROM workflow_executions AS execution
JOIN active_execution_attempt AS active ON active.execution_id = execution.id
WHERE attempt.execution_id = active.execution_id AND attempt.execution_attempt_id = active.execution_attempt_id
  AND attempt.settlement_kind IS NULL AND execution.status = 'failed'
  AND execution.error IN ('Workflow waits were removed; this execution was waiting for a gate response and can no longer continue.',
    'Workflow waits were removed; this execution has an incompatible definition snapshot and cannot continue.');--> statement-breakpoint
-- Detach settled attempts from active ownership. Keep the attempts and their historical evidence.
DELETE FROM active_execution_attempt AS active
WHERE EXISTS (
  SELECT 1 FROM workflow_executions AS execution
  JOIN execution_attempt AS attempt ON attempt.execution_id = execution.id
  WHERE active.execution_id = execution.id AND active.execution_attempt_id = attempt.execution_attempt_id
    AND attempt.status = 'settled' AND attempt.settlement_kind IS NOT NULL AND execution.status = 'failed'
    AND execution.error IN ('Workflow waits were removed; this execution was waiting for a gate response and can no longer continue.',
      'Workflow waits were removed; this execution has an incompatible definition snapshot and cannot continue.')
);--> statement-breakpoint
UPDATE workflow_execution_frames AS frame
SET status = 'failed',
  error = CASE WHEN frame.status = 'waiting' THEN 'Workflow waits were removed; this execution was waiting for a gate response and can no longer continue.'
    ELSE (SELECT e.error FROM workflow_executions AS e WHERE e.id = frame.execution_id) END,
  completed_at = (extract(epoch FROM clock_timestamp()) * 1000)::bigint
WHERE frame.status = 'waiting' OR (frame.status IN ('pending', 'running') AND frame.execution_id IN (
  SELECT id FROM workflow_executions WHERE status = 'failed' AND error IN ('Workflow waits were removed; this execution was waiting for a gate response and can no longer continue.',
    'Workflow waits were removed; this execution has an incompatible definition snapshot and cannot continue.')
));--> statement-breakpoint
UPDATE worklog_frame_entries AS frame
SET status = 'failed',
  error = CASE WHEN frame.status = 'waiting' THEN 'Workflow waits were removed; this execution was waiting for a gate response and can no longer continue.'
    ELSE (SELECT e.error FROM workflow_executions AS e WHERE e.id = frame.execution_id) END,
  completed_at = (extract(epoch FROM clock_timestamp()) * 1000)::bigint
WHERE frame.status = 'waiting' OR (frame.status IN ('pending', 'running') AND frame.execution_id IN (
  SELECT id FROM workflow_executions WHERE status = 'failed' AND error IN ('Workflow waits were removed; this execution was waiting for a gate response and can no longer continue.',
    'Workflow waits were removed; this execution has an incompatible definition snapshot and cannot continue.')
));--> statement-breakpoint
UPDATE worklog_summaries AS summary
SET status = 'failed', error = e.error, completed_at = (extract(epoch FROM clock_timestamp()) * 1000)::bigint
FROM workflow_executions AS e
WHERE summary.execution_id = e.id AND summary.status IN ('pending', 'running', 'paused', 'finalizing')
  AND e.status = 'failed' AND e.error IN ('Workflow waits were removed; this execution was waiting for a gate response and can no longer continue.',
    'Workflow waits were removed; this execution has an incompatible definition snapshot and cannot continue.');--> statement-breakpoint
UPDATE "worklog_summaries" AS "s" SET "status" = "e"."status", "completed_at" = COALESCE("s"."completed_at", "e"."completed_at"), "error" = COALESCE("s"."error", "e"."error") FROM "workflow_executions" AS "e" WHERE "e"."id" = "s"."execution_id" AND "s"."status" = 'paused';--> statement-breakpoint
UPDATE workflow_step_spans
SET status = 'failed', completed_at = (extract(epoch FROM clock_timestamp()) * 1000)::bigint
WHERE status = 'running' AND execution_id IN (
  SELECT id FROM workflow_executions WHERE status = 'failed' AND error IN ('Workflow waits were removed; this execution was waiting for a gate response and can no longer continue.',
    'Workflow waits were removed; this execution has an incompatible definition snapshot and cannot continue.')
);--> statement-breakpoint
CREATE FUNCTION pg_temp.waiting_removal_convert_loops(node jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF jsonb_typeof(node) IS DISTINCT FROM 'object' THEN
    RETURN node;
  END IF;
  CASE node ->> 'type'
    WHEN 'sequence' THEN
      IF jsonb_typeof(node -> 'nodes') = 'array' THEN
        RETURN jsonb_set(node, '{nodes}', COALESCE((SELECT jsonb_agg(pg_temp.waiting_removal_convert_loops("e") ORDER BY "ord") FROM jsonb_array_elements(node -> 'nodes') WITH ORDINALITY AS "t"("e", "ord")), '[]'::jsonb));
      END IF;
    WHEN 'parallel' THEN
      IF jsonb_typeof(node -> 'branches') = 'object' THEN
        RETURN jsonb_set(node, '{branches}', COALESCE((SELECT jsonb_object_agg("k", pg_temp.waiting_removal_convert_loops("v")) FROM jsonb_each(node -> 'branches') AS "t"("k", "v")), '{}'::jsonb));
      END IF;
    WHEN 'iterate', 'iterate-chain' THEN
      IF node ? 'body' THEN
        RETURN jsonb_set(node, '{body}', pg_temp.waiting_removal_convert_loops(node -> 'body'));
      END IF;
    WHEN 'loop' THEN
      node := CASE WHEN node ? 'body' THEN jsonb_set(node, '{body}', pg_temp.waiting_removal_convert_loops(node -> 'body')) ELSE node END;
      IF jsonb_typeof(node -> 'gate') = 'object' AND NOT (node ? 'check') THEN
        RETURN (node - 'gate') || jsonb_build_object('onExhausted', 'complete', 'check', node -> 'gate');
      END IF;
      RETURN node;
    ELSE
      NULL;
  END CASE;
  RETURN node;
END
$$;--> statement-breakpoint
WITH rewrites AS MATERIALIZED (
  SELECT id, pg_temp.waiting_removal_convert_loops(root) AS root FROM workflow_definitions
  WHERE strpos(root::text, '"gate"') > 0 AND NOT pg_temp.waiting_removal_node_blocked(root)
)
UPDATE workflow_definitions AS definition
SET root = r.root FROM rewrites AS r
WHERE definition.id = r.id AND definition.root IS DISTINCT FROM r.root;--> statement-breakpoint
WITH rewrites AS MATERIALIZED (
  SELECT execution_id, pg_temp.waiting_removal_convert_loops(definition_snapshot -> 'root') AS root
  FROM workflow_run_contexts
  WHERE strpos((definition_snapshot -> 'root')::text, '"gate"') > 0
    AND NOT pg_temp.waiting_removal_node_blocked(definition_snapshot -> 'root')
)
UPDATE workflow_run_contexts AS context
SET definition_snapshot = jsonb_set(context.definition_snapshot, '{root}', r.root)
FROM rewrites AS r
WHERE context.execution_id = r.execution_id AND context.definition_snapshot -> 'root' IS DISTINCT FROM r.root;--> statement-breakpoint
-- Layout belongs to the stored definition, while these two copies are executable inputs.
UPDATE workflow_run_contexts
SET definition_snapshot = definition_snapshot - 'canvasLayout'
WHERE jsonb_typeof(definition_snapshot) = 'object' AND definition_snapshot ? 'canvasLayout';--> statement-breakpoint
-- Parse the text instruction once per candidate. Keep its original text when the snapshot is unchanged.
WITH candidates AS MATERIALIZED (
  SELECT execution_attempt_id, pg_temp.waiting_removal_parse_jsonb(instruction) AS doc
  FROM execution_attempt
  WHERE strpos(instruction, '"definitionSnapshot"') > 0 OR strpos(instruction, '\u') > 0
), snapshots AS (
  SELECT execution_attempt_id, doc, doc #> '{workload,input,definitionSnapshot}' AS snapshot
  FROM candidates
  WHERE doc #>> '{workload,kind}' = 'workflow'
), rewrites AS MATERIALIZED (
  SELECT execution_attempt_id, doc, snapshot,
    CASE WHEN strpos((snapshot -> 'root')::text, '"gate"') > 0 AND NOT pg_temp.waiting_removal_node_blocked(snapshot -> 'root')
      THEN jsonb_set(snapshot - 'canvasLayout', '{root}', pg_temp.waiting_removal_convert_loops(snapshot -> 'root'))
      ELSE snapshot - 'canvasLayout' END AS rewritten
  FROM snapshots WHERE jsonb_typeof(snapshot) = 'object'
)
UPDATE execution_attempt AS attempt
SET instruction = jsonb_set(r.doc, '{workload,input,definitionSnapshot}', r.rewritten)::text
FROM rewrites AS r
WHERE attempt.execution_attempt_id = r.execution_attempt_id AND r.snapshot IS DISTINCT FROM r.rewritten;--> statement-breakpoint
DROP FUNCTION pg_temp.waiting_removal_convert_loops(jsonb);--> statement-breakpoint
DROP FUNCTION pg_temp.waiting_removal_node_blocked(jsonb);--> statement-breakpoint
DROP FUNCTION pg_temp.waiting_removal_parse_jsonb(text);--> statement-breakpoint
DROP FUNCTION pg_temp.waiting_removal_has_nul_escape(text);
