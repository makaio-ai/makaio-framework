ALTER TABLE `sessions` ADD `context_inheritance` text CHECK (`context_inheritance` IN ('parent-history', 'none'));
