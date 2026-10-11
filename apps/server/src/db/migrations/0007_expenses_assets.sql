CREATE TABLE `assets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`doc_no` text NOT NULL,
	`name` text NOT NULL,
	`category` text NOT NULL,
	`purchase_date` text NOT NULL,
	`cost_paisa` integer NOT NULL,
	`method` text NOT NULL,
	`vendor` text,
	`depreciation_method` text NOT NULL,
	`useful_life_months` integer,
	`salvage_value_paisa` integer DEFAULT 0 NOT NULL,
	`disposal_date` text,
	`disposal_amount_paisa` integer,
	`disposal_method` text,
	`disposal_reason` text,
	`status` text DEFAULT 'active' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`notes` text,
	`created_by` integer,
	`updated_by` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "assets_cost_ck" CHECK("assets"."cost_paisa" > 0),
	CONSTRAINT "assets_salvage_ck" CHECK("assets"."salvage_value_paisa" >= 0 AND "assets"."salvage_value_paisa" <= "assets"."cost_paisa"),
	CONSTRAINT "assets_life_ck" CHECK("assets"."useful_life_months" IS NULL OR "assets"."useful_life_months" > 0),
	CONSTRAINT "assets_disposal_ck" CHECK("assets"."disposal_amount_paisa" IS NULL OR "assets"."disposal_amount_paisa" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `assets_doc_no_uq` ON `assets` (`doc_no`);--> statement-breakpoint
CREATE INDEX `assets_purchase_date_idx` ON `assets` (`purchase_date`);--> statement-breakpoint
CREATE TABLE `expense_categories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `expense_categories_name_uq` ON `expense_categories` (lower("name"));--> statement-breakpoint
CREATE TABLE `expenses` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`doc_no` text NOT NULL,
	`date` text NOT NULL,
	`category_id` integer NOT NULL,
	`amount_paisa` integer NOT NULL,
	`method` text NOT NULL,
	`paid_to` text,
	`reference` text,
	`notes` text,
	`status` text DEFAULT 'posted' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_by` integer,
	`updated_by` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `expense_categories`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "expenses_amount_ck" CHECK("expenses"."amount_paisa" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `expenses_doc_no_uq` ON `expenses` (`doc_no`);--> statement-breakpoint
CREATE INDEX `expenses_date_idx` ON `expenses` (`date`);--> statement-breakpoint
CREATE INDEX `expenses_category_idx` ON `expenses` (`category_id`);--> statement-breakpoint
-- Default expense categories (CLAUDE.md 8.2); they can be renamed or deactivated in Settings.
INSERT INTO `expense_categories` (`name`) VALUES ('Rent'), ('Salaries & wages'), ('Electricity & gas'), ('Transport & freight'), ('Packing material'), ('Repairs & maintenance'), ('Phone & internet'), ('Bank charges'), ('Miscellaneous');
