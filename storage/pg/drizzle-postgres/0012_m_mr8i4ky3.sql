WITH ranked_messages AS (
  SELECT
    message_id,
    FIRST_VALUE(message_id) OVER (
      PARTITION BY adapter_message_id, session_id
      ORDER BY timestamp, message_id
    ) AS keeper_message_id,
    ROW_NUMBER() OVER (
      PARTITION BY adapter_message_id, session_id
      ORDER BY timestamp, message_id
    ) AS duplicate_rank
  FROM messages
  WHERE adapter_message_id IS NOT NULL
)
UPDATE messages
SET edit_of = ranked_messages.keeper_message_id
FROM ranked_messages
WHERE messages.edit_of = ranked_messages.message_id
  AND ranked_messages.duplicate_rank > 1;--> statement-breakpoint
WITH ranked_messages AS (
  SELECT
    message_id,
    ROW_NUMBER() OVER (
      PARTITION BY adapter_message_id, session_id
      ORDER BY timestamp, message_id
    ) AS duplicate_rank
  FROM messages
  WHERE adapter_message_id IS NOT NULL
)
DELETE FROM messages
USING ranked_messages
WHERE messages.message_id = ranked_messages.message_id
  AND ranked_messages.duplicate_rank > 1;--> statement-breakpoint
DROP INDEX "idx_messages_adapter_message_id";--> statement-breakpoint
-- Migrations run transactionally during startup before bus handlers accept writes,
-- so rollback safety is preferred over CREATE INDEX CONCURRENTLY here.
CREATE UNIQUE INDEX "uniq_messages_adapter_message_id_session" ON "messages" USING btree ("adapter_message_id","session_id");
