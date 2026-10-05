CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` text NOT NULL,
	`user_id` integer,
	`user_role` text,
	`action` text NOT NULL,
	`entity` text NOT NULL,
	`entity_id` integer,
	`doc_no` text,
	`version_before` integer,
	`version_after` integer,
	`before_json` text,
	`after_json` text,
	`summary_json` text,
	`flags` text DEFAULT '[]' NOT NULL,
	`reason` text,
	`prev_hash` text NOT NULL,
	`row_hash` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_log_entity_idx` ON `audit_log` (`entity`,`entity_id`);--> statement-breakpoint
CREATE INDEX `audit_log_at_idx` ON `audit_log` (`at`);--> statement-breakpoint
CREATE INDEX `audit_log_user_idx` ON `audit_log` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `audit_log_row_hash_uq` ON `audit_log` (`row_hash`);--> statement-breakpoint
CREATE TABLE `audit_reviews` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`audit_id` integer NOT NULL,
	`reviewed_by` integer NOT NULL,
	`reviewed_at` text NOT NULL,
	`note` text,
	FOREIGN KEY (`audit_id`) REFERENCES `audit_log`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reviewed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `audit_reviews_audit_idx` ON `audit_reviews` (`audit_id`);--> statement-breakpoint
CREATE TABLE `backup_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`file_name` text NOT NULL,
	`size_bytes` integer,
	`trigger` text NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`audit_last_id` integer,
	`audit_last_hash` text,
	`second_copy_status` text DEFAULT 'skipped' NOT NULL,
	`second_copy_error` text
);
--> statement-breakpoint
CREATE INDEX `backup_log_started_idx` ON `backup_log` (`started_at`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`created_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`ip` text,
	`user_agent` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value_json` text NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_by` integer,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`username` text NOT NULL,
	`display_name` text NOT NULL,
	`password_hash` text NOT NULL,
	`role` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_by` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_uq` ON `users` (`username`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_single_superuser_uq` ON `users` (`role`) WHERE role = 'superuser';