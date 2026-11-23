CREATE FUNCTION pg_temp.workflow_step_names_rewrite(node jsonb, definition_dispatched boolean) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  result jsonb := node;
  node_type text;
BEGIN
  IF jsonb_typeof(node) IS DISTINCT FROM 'object' THEN
    RETURN node;
  END IF;
  node_type := node ->> 'type';
  IF node_type = 'delegate-role' THEN
    result := jsonb_set(result, '{type}', '"agent-step"');
  ELSIF node_type = 'station' THEN
    IF jsonb_typeof(node -> 'role') IS DISTINCT FROM 'string' THEN
      result := jsonb_set(result, '{type}', '"code-step"') - 'prompt' - 'completion';
    ELSIF definition_dispatched THEN
      result := jsonb_set(result, '{type}', '"agent-step"');
    END IF;
  END IF;
  IF node_type = 'sequence' AND jsonb_typeof(node -> 'nodes') = 'array' THEN
    result := jsonb_set(result, '{nodes}', (
      SELECT COALESCE(jsonb_agg(pg_temp.workflow_step_names_rewrite(e.value, definition_dispatched) ORDER BY e.ordinality), '[]'::jsonb)
      FROM jsonb_array_elements(node -> 'nodes') WITH ORDINALITY AS e(value, ordinality)
    ));
  ELSIF node_type = 'parallel' AND jsonb_typeof(node -> 'branches') = 'object' THEN
    result := jsonb_set(result, '{branches}', (
      SELECT COALESCE(jsonb_object_agg(b.key, pg_temp.workflow_step_names_rewrite(b.value, definition_dispatched)), '{}'::jsonb)
      FROM jsonb_each(node -> 'branches') AS b
    ));
  ELSIF node_type IN ('iterate', 'iterate-chain', 'loop') AND jsonb_typeof(node -> 'body') = 'object' THEN
    result := jsonb_set(result, '{body}', pg_temp.workflow_step_names_rewrite(node -> 'body', definition_dispatched));
  END IF;
  RETURN result;
END
$$;
--> statement-breakpoint
-- A guarded cast. `instruction::jsonb` throws for ANY row whose text contains an escape
-- PostgreSQL's jsonb input function cannot decode (for example `\u0000`, which cannot be
-- represented in `text`); that throw aborts the whole statement while it scans every row for the 'workflow'
-- kind, not just the rows it would rewrite. Foreign, non-'workflow' rows must stay fully untouched instead.
CREATE FUNCTION pg_temp.workflow_step_names_try_jsonb(value text) RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  RETURN value::jsonb;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END
$$;
--> statement-breakpoint
UPDATE workflow_definitions
SET root = pg_temp.workflow_step_names_rewrite(root, executable_source IS NULL OR executable_source ->> 'kind' = 'definition')
WHERE jsonb_typeof(root) = 'object'
  AND root IS DISTINCT FROM pg_temp.workflow_step_names_rewrite(
    root, executable_source IS NULL OR executable_source ->> 'kind' = 'definition');
--> statement-breakpoint
UPDATE workflow_run_contexts
SET definition_snapshot = jsonb_set(
  definition_snapshot, '{root}',
  pg_temp.workflow_step_names_rewrite(definition_snapshot -> 'root', source_kind = 'definition'))
WHERE jsonb_typeof(definition_snapshot -> 'root') = 'object'
  AND definition_snapshot -> 'root' IS DISTINCT FROM
    pg_temp.workflow_step_names_rewrite(definition_snapshot -> 'root', source_kind = 'definition');
--> statement-breakpoint
UPDATE execution_attempt
SET instruction = jsonb_set(
  pg_temp.workflow_step_names_try_jsonb(instruction), '{workload,input,definitionSnapshot,root}',
  pg_temp.workflow_step_names_rewrite(
    pg_temp.workflow_step_names_try_jsonb(instruction) #> '{workload,input,definitionSnapshot,root}',
    (pg_temp.workflow_step_names_try_jsonb(instruction) #>> '{workload,input,source,kind}') = 'definition'))::text
WHERE pg_temp.workflow_step_names_try_jsonb(instruction) IS NOT NULL
  AND pg_temp.workflow_step_names_try_jsonb(instruction) #>> '{workload,kind}' = 'workflow'
  AND jsonb_typeof(pg_temp.workflow_step_names_try_jsonb(instruction) #> '{workload,input,definitionSnapshot,root}') = 'object'
  AND pg_temp.workflow_step_names_try_jsonb(instruction) #> '{workload,input,definitionSnapshot,root}' IS DISTINCT FROM
    pg_temp.workflow_step_names_rewrite(
      pg_temp.workflow_step_names_try_jsonb(instruction) #> '{workload,input,definitionSnapshot,root}',
      (pg_temp.workflow_step_names_try_jsonb(instruction) #>> '{workload,input,source,kind}') = 'definition');
--> statement-breakpoint
CREATE TEMP TABLE workflow_step_names_kinds (
  execution_id text NOT NULL,
  node_id text NOT NULL,
  step_type text NOT NULL,
  PRIMARY KEY (execution_id, node_id)
) ON COMMIT DROP;
--> statement-breakpoint
WITH RECURSIVE
  roots (execution_id, root) AS (
    SELECT r.execution_id, r.definition_snapshot -> 'root'
    FROM workflow_run_contexts AS r
    WHERE jsonb_typeof(r.definition_snapshot -> 'root') = 'object'
  ),
  walk (execution_id, node) AS (
    SELECT execution_id, root FROM roots
    UNION ALL
    SELECT w.execution_id, c.value
    FROM walk AS w
    CROSS JOIN LATERAL (
      SELECT e.value
      FROM jsonb_array_elements(
        CASE WHEN w.node ->> 'type' = 'sequence' AND jsonb_typeof(w.node -> 'nodes') = 'array'
          THEN w.node -> 'nodes' ELSE '[]'::jsonb END) AS e(value)
      UNION ALL
      SELECT b.value
      FROM jsonb_each(
        CASE WHEN w.node ->> 'type' = 'parallel' AND jsonb_typeof(w.node -> 'branches') = 'object'
          THEN w.node -> 'branches' ELSE '{}'::jsonb END) AS b
      UNION ALL
      SELECT w.node -> 'body'
      WHERE w.node ->> 'type' IN ('iterate', 'iterate-chain', 'loop') AND jsonb_typeof(w.node -> 'body') = 'object'
    ) AS c(value)
    WHERE jsonb_typeof(c.value) = 'object'
  )
INSERT INTO workflow_step_names_kinds (execution_id, node_id, step_type)
SELECT execution_id, node ->> 'id', MIN(node ->> 'type')
FROM walk
WHERE node ->> 'id' IS NOT NULL
GROUP BY execution_id, node ->> 'id'
HAVING MIN(node ->> 'type') = MAX(node ->> 'type') AND MIN(node ->> 'type') IN ('code-step', 'agent-step');
--> statement-breakpoint
UPDATE workflow_execution_frames AS f
SET node_type = k.step_type
FROM workflow_step_names_kinds AS k
WHERE f.node_type = 'station' AND k.execution_id = f.execution_id AND k.node_id = f.node_id;
--> statement-breakpoint
UPDATE workflow_execution_frames SET node_type = 'agent-step' WHERE node_type IN ('delegate-role', 'delegate-agent');
--> statement-breakpoint
UPDATE workflow_execution_frames SET node_type = 'code-step' WHERE node_type = 'station' AND substr(execution_id, 1, 8) = 'wfx-ext-';
--> statement-breakpoint
UPDATE workflow_step_spans AS s
SET step_type = k.step_type
FROM workflow_step_names_kinds AS k
WHERE s.step_type = 'station' AND k.execution_id = s.execution_id AND k.node_id = s.step_id;
--> statement-breakpoint
UPDATE workflow_step_spans SET step_type = 'agent-step' WHERE step_type IN ('delegate-role', 'delegate-agent');
--> statement-breakpoint
UPDATE workflow_step_spans SET step_type = 'code-step' WHERE step_type = 'station' AND substr(execution_id, 1, 8) = 'wfx-ext-';
--> statement-breakpoint
UPDATE worklog_frame_entries AS w
SET node_type = k.step_type
FROM workflow_step_names_kinds AS k
WHERE w.node_type = 'station' AND k.execution_id = w.execution_id AND k.node_id = w.node_id;
--> statement-breakpoint
UPDATE worklog_frame_entries SET node_type = 'agent-step' WHERE node_type IN ('delegate-role', 'delegate-agent');
--> statement-breakpoint
UPDATE worklog_frame_entries SET node_type = 'code-step' WHERE node_type = 'station' AND substr(execution_id, 1, 8) = 'wfx-ext-';
--> statement-breakpoint
UPDATE workflow_executions
SET external_settlement_fingerprint = replace(
  replace(
    replace(external_settlement_fingerprint, '"nodeType":"station"', '"nodeType":"code-step"'),
    '"nodeType":"delegate-role"', '"nodeType":"agent-step"'),
  '"nodeType":"delegate-agent"', '"nodeType":"agent-step"')
WHERE substr(id, 1, 8) = 'wfx-ext-'
  AND (external_settlement_fingerprint LIKE '%"nodeType":"station"%'
    OR external_settlement_fingerprint LIKE '%"nodeType":"delegate-role"%'
    OR external_settlement_fingerprint LIKE '%"nodeType":"delegate-agent"%');
--> statement-breakpoint
DROP FUNCTION pg_temp.workflow_step_names_rewrite(jsonb, boolean);
--> statement-breakpoint
DROP FUNCTION pg_temp.workflow_step_names_try_jsonb(text);
