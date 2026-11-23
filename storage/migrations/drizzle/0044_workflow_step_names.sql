CREATE TEMP TABLE workflow_step_names_trees (
  source TEXT NOT NULL,
  owner_key TEXT NOT NULL,
  root_path TEXT NOT NULL,
  definition_dispatched INTEGER NOT NULL,
  doc TEXT NOT NULL,
  PRIMARY KEY (source, owner_key)
);
--> statement-breakpoint
INSERT INTO workflow_step_names_trees (source, owner_key, root_path, definition_dispatched, doc)
SELECT 'definition', d.id, '$',
  CASE
    WHEN d.executable_source IS NULL THEN 1
    WHEN CASE WHEN json_valid(d.executable_source) THEN json_extract(d.executable_source, '$.kind') END = 'definition' THEN 1
    ELSE 0
  END,
  d.root
FROM workflow_definitions AS d
WHERE CASE WHEN json_valid(d.root) THEN json_type(d.root) = 'object' ELSE 0 END;
--> statement-breakpoint
INSERT INTO workflow_step_names_trees (source, owner_key, root_path, definition_dispatched, doc)
SELECT 'run', r.execution_id, '$.root', CASE WHEN r.source_kind = 'definition' THEN 1 ELSE 0 END, r.definition_snapshot
FROM workflow_run_contexts AS r
WHERE r.definition_snapshot IS NOT NULL
  AND CASE WHEN json_valid(r.definition_snapshot) THEN json_type(r.definition_snapshot, '$.root') = 'object' ELSE 0 END;
--> statement-breakpoint
INSERT INTO workflow_step_names_trees (source, owner_key, root_path, definition_dispatched, doc)
SELECT 'attempt', a.execution_attempt_id, '$.workload.input.definitionSnapshot.root',
  CASE WHEN json_extract(a.instruction, '$.workload.input.source.kind') = 'definition' THEN 1 ELSE 0 END,
  a.instruction
FROM execution_attempt AS a
WHERE CASE
  WHEN json_valid(a.instruction) THEN
    json_extract(a.instruction, '$.workload.kind') = 'workflow'
    AND json_type(a.instruction, '$.workload.input.definitionSnapshot.root') = 'object'
  ELSE 0
END;
--> statement-breakpoint
CREATE TEMP TABLE workflow_step_names_nodes (
  source TEXT NOT NULL,
  owner_key TEXT NOT NULL,
  node_path TEXT NOT NULL,
  node_id TEXT,
  node_type TEXT,
  new_type TEXT,
  PRIMARY KEY (source, owner_key, node_path)
);
--> statement-breakpoint
WITH RECURSIVE walk (source, owner_key, definition_dispatched, node_path, node) AS (
  SELECT t.source, t.owner_key, t.definition_dispatched, t.root_path, json_extract(t.doc, t.root_path)
  FROM workflow_step_names_trees AS t
  UNION ALL
  SELECT w.source, w.owner_key, w.definition_dispatched, w.node_path || substr(c.fullkey, 2), c.value
  FROM walk AS w, json_each(w.node, '$.nodes') AS c
  WHERE json_extract(w.node, '$.type') = 'sequence'
    AND json_type(w.node, '$.nodes') = 'array'
    AND c.type = 'object'
  UNION ALL
  SELECT w.source, w.owner_key, w.definition_dispatched, w.node_path || substr(c.fullkey, 2), c.value
  FROM walk AS w, json_each(w.node, '$.branches') AS c
  WHERE json_extract(w.node, '$.type') = 'parallel'
    AND json_type(w.node, '$.branches') = 'object'
    AND c.type = 'object'
  UNION ALL
  SELECT w.source, w.owner_key, w.definition_dispatched, w.node_path || '.body', json_extract(w.node, '$.body')
  FROM walk AS w
  WHERE json_extract(w.node, '$.type') IN ('iterate', 'iterate-chain', 'loop')
    AND json_type(w.node, '$.body') = 'object'
)
INSERT INTO workflow_step_names_nodes (source, owner_key, node_path, node_id, node_type, new_type)
SELECT w.source, w.owner_key, w.node_path, json_extract(w.node, '$.id'), json_extract(w.node, '$.type'),
  CASE
    WHEN json_extract(w.node, '$.type') = 'delegate-role' THEN 'agent-step'
    WHEN json_extract(w.node, '$.type') = 'station' AND json_type(w.node, '$.role') IS NOT 'text' THEN 'code-step'
    WHEN json_extract(w.node, '$.type') = 'station' AND w.definition_dispatched = 1 THEN 'agent-step'
  END
FROM walk AS w
WHERE json_type(w.node) = 'object';
--> statement-breakpoint
WITH RECURSIVE
  targets (source, owner_key, rn, node_path, new_type) AS (
    SELECT n.source, n.owner_key,
      ROW_NUMBER() OVER (PARTITION BY n.source, n.owner_key ORDER BY n.node_path),
      n.node_path, n.new_type
    FROM workflow_step_names_nodes AS n
    WHERE n.new_type IS NOT NULL
  ),
  folded (source, owner_key, rn, doc) AS (
    SELECT t.source, t.owner_key, 0, t.doc
    FROM workflow_step_names_trees AS t
    WHERE EXISTS (SELECT 1 FROM targets AS g WHERE g.source = t.source AND g.owner_key = t.owner_key)
    UNION ALL
    SELECT f.source, f.owner_key, f.rn + 1,
      CASE
        WHEN g.new_type = 'code-step' THEN
          json_remove(json_set(f.doc, g.node_path || '.type', g.new_type), g.node_path || '.prompt', g.node_path || '.completion')
        ELSE json_set(f.doc, g.node_path || '.type', g.new_type)
      END
    FROM folded AS f
    JOIN targets AS g ON g.source = f.source AND g.owner_key = f.owner_key AND g.rn = f.rn + 1
  ),
  final (source, owner_key, doc) AS (
    SELECT f.source, f.owner_key, f.doc
    FROM folded AS f
    WHERE f.rn = (SELECT MAX(g.rn) FROM folded AS g WHERE g.source = f.source AND g.owner_key = f.owner_key)
  )
UPDATE workflow_step_names_trees
SET doc = final.doc
FROM final
WHERE workflow_step_names_trees.source = final.source AND workflow_step_names_trees.owner_key = final.owner_key;
--> statement-breakpoint
UPDATE workflow_definitions
SET root = t.doc
FROM workflow_step_names_trees AS t
WHERE t.source = 'definition' AND t.owner_key = workflow_definitions.id AND t.doc <> workflow_definitions.root;
--> statement-breakpoint
UPDATE workflow_run_contexts
SET definition_snapshot = t.doc
FROM workflow_step_names_trees AS t
WHERE t.source = 'run' AND t.owner_key = workflow_run_contexts.execution_id AND t.doc <> workflow_run_contexts.definition_snapshot;
--> statement-breakpoint
UPDATE execution_attempt
SET instruction = t.doc
FROM workflow_step_names_trees AS t
WHERE t.source = 'attempt' AND t.owner_key = execution_attempt.execution_attempt_id AND t.doc <> execution_attempt.instruction;
--> statement-breakpoint
CREATE TEMP TABLE workflow_step_names_kinds (
  execution_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  step_type TEXT NOT NULL,
  PRIMARY KEY (execution_id, node_id)
);
--> statement-breakpoint
INSERT INTO workflow_step_names_kinds (execution_id, node_id, step_type)
SELECT n.owner_key, n.node_id, MIN(COALESCE(n.new_type, n.node_type))
FROM workflow_step_names_nodes AS n
WHERE n.source = 'run' AND n.node_id IS NOT NULL
GROUP BY n.owner_key, n.node_id
HAVING MIN(COALESCE(n.new_type, n.node_type)) = MAX(COALESCE(n.new_type, n.node_type))
  AND MIN(COALESCE(n.new_type, n.node_type)) IN ('code-step', 'agent-step');
--> statement-breakpoint
UPDATE workflow_execution_frames
SET node_type = (
  SELECT k.step_type FROM workflow_step_names_kinds AS k
  WHERE k.execution_id = workflow_execution_frames.execution_id AND k.node_id = workflow_execution_frames.node_id
)
WHERE node_type = 'station'
  AND EXISTS (
    SELECT 1 FROM workflow_step_names_kinds AS k
    WHERE k.execution_id = workflow_execution_frames.execution_id AND k.node_id = workflow_execution_frames.node_id
  );
--> statement-breakpoint
UPDATE workflow_execution_frames SET node_type = 'agent-step' WHERE node_type IN ('delegate-role', 'delegate-agent');
--> statement-breakpoint
UPDATE workflow_execution_frames SET node_type = 'code-step' WHERE node_type = 'station' AND substr(execution_id, 1, 8) = 'wfx-ext-';
--> statement-breakpoint
UPDATE workflow_step_spans
SET step_type = (
  SELECT k.step_type FROM workflow_step_names_kinds AS k
  WHERE k.execution_id = workflow_step_spans.execution_id AND k.node_id = workflow_step_spans.step_id
)
WHERE step_type = 'station'
  AND EXISTS (
    SELECT 1 FROM workflow_step_names_kinds AS k
    WHERE k.execution_id = workflow_step_spans.execution_id AND k.node_id = workflow_step_spans.step_id
  );
--> statement-breakpoint
UPDATE workflow_step_spans SET step_type = 'agent-step' WHERE step_type IN ('delegate-role', 'delegate-agent');
--> statement-breakpoint
UPDATE workflow_step_spans SET step_type = 'code-step' WHERE step_type = 'station' AND substr(execution_id, 1, 8) = 'wfx-ext-';
--> statement-breakpoint
UPDATE worklog_frame_entries
SET node_type = (
  SELECT k.step_type FROM workflow_step_names_kinds AS k
  WHERE k.execution_id = worklog_frame_entries.execution_id AND k.node_id = worklog_frame_entries.node_id
)
WHERE node_type = 'station'
  AND EXISTS (
    SELECT 1 FROM workflow_step_names_kinds AS k
    WHERE k.execution_id = worklog_frame_entries.execution_id AND k.node_id = worklog_frame_entries.node_id
  );
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
DROP TABLE workflow_step_names_kinds;
--> statement-breakpoint
DROP TABLE workflow_step_names_nodes;
--> statement-breakpoint
DROP TABLE workflow_step_names_trees;
