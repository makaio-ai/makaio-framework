-- Waiting removal, data part (paired with drizzle-postgres/0035_waiting-removal-data.sql).
-- Retain historical rows, gate tables and legacy columns. Fail waiting executions and live
-- executions with incompatible definition snapshots, then settle their frames, spans and summaries.
-- Clear gate-frame registration bindings, convert compatible loop checks and remove layout from
-- executable copies. Unconvertible trees are retained for explicit rejection when loaded.
UPDATE `workflow_executions` SET `external_registration_frame_id` = NULL WHERE `external_registration_frame_id` IN (SELECT `frame_id` FROM `worklog_frame_entries` WHERE `node_type` = 'gate') OR `external_registration_frame_id` IN (SELECT `frame_id` FROM `workflow_execution_frames` WHERE `node_type` = 'gate');--> statement-breakpoint
UPDATE `workflow_executions` SET `status` = 'failed', `error` = 'Workflow waits were removed; this execution was waiting for a gate response and can no longer continue.', `completed_at` = CAST(strftime('%s', 'now') AS INTEGER) * 1000 WHERE `status` IN ('pending', 'running', 'paused', 'finalizing') AND (`status` = 'paused' OR `id` IN (SELECT `execution_id` FROM `workflow_execution_frames` WHERE `status` = 'waiting') OR `id` IN (SELECT `execution_id` FROM `worklog_frame_entries` WHERE `status` = 'waiting') OR `id` IN (SELECT `execution_id` FROM `worklog_summaries` WHERE `status` = 'paused') OR `id` IN (SELECT `execution_id` FROM `workflow_gate_instances` WHERE `status` = 'waiting') OR `id` IN (SELECT `execution_id` FROM `worklog_gate_events` WHERE `status` = 'waiting'));--> statement-breakpoint
UPDATE `execution_attempt` SET `outcome_text` = json_object('executionId', json_extract(`outcome_text`, '$.executionId'), 'workflowId', json_extract(`outcome_text`, '$.workflowId'), 'status', 'failed', 'error', 'Workflow waits were removed; this execution was waiting for a gate response and can no longer continue.' || ' pausedAtGateId=' || json_quote(json_extract(`outcome_text`, '$.pausedAtGateId')) || ' pausedAtFrameId=' || json_quote(json_extract(`outcome_text`, '$.pausedAtFrameId'))) WHERE `outcome_text` IS NOT NULL AND CASE WHEN json_valid(`outcome_text`) THEN json_extract(`outcome_text`, '$.status') END = 'paused' AND CASE WHEN json_valid(`instruction`) THEN json_extract(`instruction`, '$.workload.kind') END = 'workflow';--> statement-breakpoint
-- Escaped spellings remain candidates even when the literal JSON key is absent.
CREATE TEMP TABLE waiting_removal_documents AS
SELECT 'definition' AS loc, id AS row_id, root AS doc, '$' AS base FROM workflow_definitions
WHERE (instr(root, '"gate"') > 0 OR instr(root, '\u') > 0)
  AND CASE WHEN json_valid(root) THEN json_type(root) END = 'object'
UNION ALL
SELECT 'snapshot', execution_id, definition_snapshot, '$.root' FROM workflow_run_contexts
WHERE (instr(definition_snapshot, '"gate"') > 0 OR instr(definition_snapshot, '"loop"') > 0
  OR instr(definition_snapshot, '\u') > 0)
  AND CASE WHEN json_valid(definition_snapshot) THEN json_type(definition_snapshot, '$.root') END = 'object'
UNION ALL
SELECT 'attempt', execution_attempt_id, instruction, '$.workload.input.definitionSnapshot.root' FROM execution_attempt
WHERE (instr(instruction, '"definitionSnapshot"') > 0 AND
  (instr(instruction, '"gate"') > 0 OR instr(instruction, '"loop"') > 0) OR instr(instruction, '\u') > 0)
  AND CASE WHEN json_valid(instruction) THEN json_extract(instruction, '$.workload.kind') = 'workflow'
    AND json_type(instruction, '$.workload.input.definitionSnapshot.root') = 'object' END;--> statement-breakpoint
-- Match object keys by their traversal order, then replace only the matching JSON key tokens
-- and insert the exhaustion policy once per converted loop.
-- An arbitrary branch key never becomes a JSON path, and all other JSON tokens retain their order and spelling.
CREATE TEMP TABLE waiting_removal_nodes AS
WITH RECURSIVE tree AS MATERIALIZED (
  SELECT d.loc, d.row_id, j.id, j.parent, j.key, j.type, j.value FROM waiting_removal_documents AS d, json_tree(d.doc, d.base) AS j
), walk AS (
  SELECT * FROM tree WHERE parent IS NULL UNION ALL
  SELECT c.* FROM walk AS w JOIN tree AS p ON p.loc = w.loc AND p.row_id = w.row_id AND p.parent = w.id
    AND p.key = CASE json_extract(CASE WHEN w.type = 'object' THEN w.value END, '$.type')
      WHEN 'sequence' THEN 'nodes' WHEN 'parallel' THEN 'branches' WHEN 'iterate' THEN 'body'
      WHEN 'iterate-chain' THEN 'body' WHEN 'loop' THEN 'body' END JOIN tree AS c ON c.loc = p.loc AND c.row_id = p.row_id AND (CASE WHEN p.key = 'body' THEN c.id = p.id ELSE c.parent = p.id END)
), flags AS (
  SELECT loc, row_id, id, json_extract(value, '$.type') AS node_type, json_type(value, '$.gate') AS gate_type,
    EXISTS (SELECT 1 FROM json_each(w.value) WHERE key NOT IN ('id', 'type', 'maxRounds', 'body', 'gate', 'check', 'onExhausted', 'when', 'skip', 'writes')) AS extra,
    COALESCE(json_type(value, '$.gate') = 'object' AND json_type(value, '$.check') IS NULL
      AND json_type(value, '$.onExhausted') IS NULL
      AND NOT EXISTS (SELECT 1 FROM json_each(w.value, '$.gate') WHERE key NOT IN ('handler', 'input', 'config'))
      AND json_type(value, '$.gate.handler') = 'text' AND json_extract(value, '$.gate.handler') <> ''
      AND (json_type(value, '$.gate.input') IS NULL OR (json_type(value, '$.gate.input') = 'text' AND json_extract(value, '$.gate.input') <> '')), 0) AS valid_gate
  FROM walk AS w WHERE type = 'object'
), keys AS (SELECT loc, row_id, parent, key, row_number() OVER (PARTITION BY loc, row_id ORDER BY id) AS ordinal FROM tree WHERE parent IS NOT NULL AND typeof(key) = 'text'
)
SELECT f.loc, f.row_id, f.id AS node_id, k.ordinal, f.node_type = 'loop' AND NOT f.extra AND f.valid_gate AS convertible,
  f.node_type = 'gate' OR (f.node_type = 'loop' AND (f.extra OR (f.gate_type IS NOT NULL AND NOT f.valid_gate))) AS blocked
FROM flags AS f LEFT JOIN keys AS k ON k.loc = f.loc AND k.row_id = f.row_id AND k.parent = f.id AND k.key = 'gate';--> statement-breakpoint
-- A live execution cannot continue with a blocked definition in either executable copy.
WITH incompatible AS (
  SELECT row_id AS execution_id FROM waiting_removal_nodes WHERE loc = 'snapshot' AND blocked
  UNION ALL
  SELECT attempt.execution_id FROM waiting_removal_nodes AS n
  JOIN execution_attempt AS attempt ON attempt.execution_attempt_id = n.row_id
  JOIN active_execution_attempt AS active USING (execution_id, execution_attempt_id)
  WHERE n.loc = 'attempt' AND n.blocked
)
UPDATE workflow_executions
SET status = 'failed', error = 'Workflow waits were removed; this execution has an incompatible definition snapshot and cannot continue.',
  completed_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE status IN ('pending', 'running') AND id IN (SELECT execution_id FROM incompatible);--> statement-breakpoint
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
  completed_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE frame.status = 'waiting' OR (frame.status IN ('pending', 'running') AND frame.execution_id IN (
  SELECT id FROM workflow_executions WHERE status = 'failed' AND error IN ('Workflow waits were removed; this execution was waiting for a gate response and can no longer continue.',
    'Workflow waits were removed; this execution has an incompatible definition snapshot and cannot continue.')
));--> statement-breakpoint
UPDATE worklog_frame_entries AS frame
SET status = 'failed',
  error = CASE WHEN frame.status = 'waiting' THEN 'Workflow waits were removed; this execution was waiting for a gate response and can no longer continue.'
    ELSE (SELECT e.error FROM workflow_executions AS e WHERE e.id = frame.execution_id) END,
  completed_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE frame.status = 'waiting' OR (frame.status IN ('pending', 'running') AND frame.execution_id IN (
  SELECT id FROM workflow_executions WHERE status = 'failed' AND error IN ('Workflow waits were removed; this execution was waiting for a gate response and can no longer continue.',
    'Workflow waits were removed; this execution has an incompatible definition snapshot and cannot continue.')
));--> statement-breakpoint
UPDATE worklog_summaries AS summary
SET status = 'failed', error = e.error, completed_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM workflow_executions AS e
WHERE summary.execution_id = e.id AND summary.status IN ('pending', 'running', 'paused', 'finalizing')
  AND e.status = 'failed' AND e.error IN ('Workflow waits were removed; this execution was waiting for a gate response and can no longer continue.',
    'Workflow waits were removed; this execution has an incompatible definition snapshot and cannot continue.');--> statement-breakpoint
UPDATE `worklog_summaries` SET `status` = (SELECT `e`.`status` FROM `workflow_executions` AS `e` WHERE `e`.`id` = `worklog_summaries`.`execution_id`), `completed_at` = COALESCE(`completed_at`, (SELECT `e`.`completed_at` FROM `workflow_executions` AS `e` WHERE `e`.`id` = `worklog_summaries`.`execution_id`)), `error` = COALESCE(`error`, (SELECT `e`.`error` FROM `workflow_executions` AS `e` WHERE `e`.`id` = `worklog_summaries`.`execution_id`)) WHERE `status` = 'paused';--> statement-breakpoint
UPDATE workflow_step_spans
SET status = 'failed', completed_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE status = 'running' AND execution_id IN (
  SELECT id FROM workflow_executions WHERE status = 'failed' AND error IN ('Workflow waits were removed; this execution was waiting for a gate response and can no longer continue.',
    'Workflow waits were removed; this execution has an incompatible definition snapshot and cannot continue.')
);--> statement-breakpoint
-- Scan each document in bounded pages. Only page boundaries fetch another slice of
-- the source BLOB. Keep quote and escape state across boundaries, including a closing
-- key quote followed by its colon in the next page.
CREATE TEMP TABLE waiting_removal_rewrites AS
WITH kept AS MATERIALIZED (
  SELECT d.*, CAST(json(d.doc -> d.base) AS BLOB) AS src FROM waiting_removal_documents AS d
  JOIN waiting_removal_nodes AS n USING (loc, row_id) GROUP BY d.loc, d.row_id HAVING max(n.convertible) = 1 AND max(n.blocked) = 0
)
SELECT d.loc, d.row_id, json_set(d.doc, d.base, (
  WITH RECURSIVE pages(start, bytes) AS MATERIALIZED (
    SELECT 1, substr(d.src, 1, 1024) UNION ALL
    SELECT start + 1024, substr(d.src, start + 1024, 1024)
    FROM pages WHERE start + 1024 <= length(d.src)
  ), scan(pos, bytes, slot, opening, escaped, closed) AS (
    SELECT 1, bytes, 1, 0, 0, 0 FROM pages WHERE start = 1 UNION ALL
    SELECT pos + 1,
      CASE WHEN slot = 1024 THEN (SELECT p.bytes FROM pages AS p WHERE p.start = pos + 1) ELSE bytes END,
      CASE WHEN slot = 1024 THEN 1 ELSE slot + 1 END,
      CASE WHEN NOT escaped AND substr(bytes, slot, 1) = x'22'
        THEN CASE WHEN opening = 0 THEN pos ELSE 0 END ELSE opening END,
      opening <> 0 AND NOT escaped AND substr(bytes, slot, 1) = x'5c',
      CASE WHEN NOT escaped AND substr(bytes, slot, 1) = x'22' THEN opening ELSE 0 END
    FROM scan WHERE slot <= length(bytes)
  ), keys AS (
    SELECT pos - 1 AS pos, closed AS opening, row_number() OVER (ORDER BY pos) AS ordinal
    FROM scan WHERE closed <> 0 AND substr(bytes, slot, 1) = x'3a'
  ), edits AS (
    SELECT k.*, lag(pos, 1, 0) OVER (ORDER BY pos) AS previous,
      row_number() OVER (PARTITION BY n.node_id ORDER BY pos) = 1 AS first_gate_key
    FROM keys AS k
    JOIN waiting_removal_nodes AS n ON n.loc = d.loc AND n.row_id = d.row_id AND n.ordinal = k.ordinal
    WHERE n.convertible
  )
  SELECT json(group_concat(CAST(substr(d.src, previous + 1, opening - previous - 1) AS TEXT)
    || CASE WHEN first_gate_key THEN '"onExhausted":"complete","check"' ELSE '"check"' END, '' ORDER BY pos)
    || CAST(substr(d.src, max(pos) + 1) AS TEXT)) FROM edits
)) AS doc FROM kept AS d;--> statement-breakpoint
UPDATE `workflow_definitions` SET `root` = (SELECT `r`.`doc` FROM `waiting_removal_rewrites` AS `r` WHERE `r`.`loc` = 'definition' AND `r`.`row_id` = `workflow_definitions`.`id`) WHERE `id` IN (SELECT `row_id` FROM `waiting_removal_rewrites` WHERE `loc` = 'definition');--> statement-breakpoint
UPDATE `workflow_run_contexts` SET `definition_snapshot` = (SELECT `r`.`doc` FROM `waiting_removal_rewrites` AS `r` WHERE `r`.`loc` = 'snapshot' AND `r`.`row_id` = `workflow_run_contexts`.`execution_id`) WHERE `execution_id` IN (SELECT `row_id` FROM `waiting_removal_rewrites` WHERE `loc` = 'snapshot');--> statement-breakpoint
UPDATE `execution_attempt` SET `instruction` = (SELECT `r`.`doc` FROM `waiting_removal_rewrites` AS `r` WHERE `r`.`loc` = 'attempt' AND `r`.`row_id` = `execution_attempt`.`execution_attempt_id`) WHERE `execution_attempt_id` IN (SELECT `row_id` FROM `waiting_removal_rewrites` WHERE `loc` = 'attempt');--> statement-breakpoint
-- Layout belongs to the stored definition, while these two copies are executable inputs.
UPDATE `workflow_run_contexts`
SET `definition_snapshot` = json_remove(`definition_snapshot`, '$.canvasLayout')
WHERE CASE WHEN json_valid(`definition_snapshot`) THEN json_type(`definition_snapshot`, '$.canvasLayout') END IS NOT NULL;--> statement-breakpoint
UPDATE `execution_attempt`
SET `instruction` = json_remove(`instruction`, '$.workload.input.definitionSnapshot.canvasLayout')
WHERE CASE WHEN (instr(instruction, '"definitionSnapshot"') > 0 OR instr(instruction, '\u') > 0)
  AND json_valid(instruction)
  THEN json_extract(`instruction`, '$.workload.kind') = 'workflow'
    AND json_type(`instruction`, '$.workload.input.definitionSnapshot.canvasLayout') IS NOT NULL
  ELSE false END;--> statement-breakpoint
DROP TABLE `waiting_removal_rewrites`;--> statement-breakpoint
DROP TABLE `waiting_removal_nodes`;--> statement-breakpoint
DROP TABLE `waiting_removal_documents`;
