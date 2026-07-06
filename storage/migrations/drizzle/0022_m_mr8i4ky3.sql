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
SET edit_of = (
  SELECT keeper_message_id
  FROM ranked_messages
  WHERE ranked_messages.message_id = messages.edit_of
)
WHERE edit_of IN (
  SELECT message_id
  FROM ranked_messages
  WHERE duplicate_rank > 1
);--> statement-breakpoint
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
WHERE message_id IN (
  SELECT message_id
  FROM ranked_messages
  WHERE duplicate_rank > 1
);--> statement-breakpoint
DROP INDEX `idx_messages_adapter_message_id`;--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_messages_adapter_message_id_session` ON `messages` (`adapter_message_id`,`session_id`);
