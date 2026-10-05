CREATE TABLE `sales_return_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`return_id` integer NOT NULL,
	`sale_item_id` integer NOT NULL,
	`variant_id` integer NOT NULL,
	`qty` integer NOT NULL,
	`unit_cost_paisa` integer NOT NULL,
	`line_net_paisa` integer NOT NULL,
	`line_cost_paisa` integer NOT NULL,
	`profit_reversed_paisa` integer NOT NULL,
	FOREIGN KEY (`return_id`) REFERENCES `sales_returns`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sale_item_id`) REFERENCES `sale_items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`variant_id`) REFERENCES `product_variants`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "sales_return_items_qty_ck" CHECK("sales_return_items"."qty" > 0)
);
--> statement-breakpoint
CREATE INDEX `sales_return_items_return_idx` ON `sales_return_items` (`return_id`);--> statement-breakpoint
CREATE INDEX `sales_return_items_item_idx` ON `sales_return_items` (`sale_item_id`);--> statement-breakpoint
CREATE TABLE `sales_returns` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`doc_no` text NOT NULL,
	`sale_id` integer NOT NULL,
	`customer_id` integer NOT NULL,
	`date` text NOT NULL,
	`reason` text NOT NULL,
	`total_paisa` integer NOT NULL,
	`status` text DEFAULT 'posted' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_by` integer,
	`updated_by` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`sale_id`) REFERENCES `sales`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sales_returns_doc_no_uq` ON `sales_returns` (`doc_no`);--> statement-breakpoint
CREATE INDEX `sales_returns_sale_idx` ON `sales_returns` (`sale_id`);--> statement-breakpoint
CREATE INDEX `sales_returns_customer_idx` ON `sales_returns` (`customer_id`);--> statement-breakpoint
CREATE INDEX `sales_returns_date_idx` ON `sales_returns` (`date`);--> statement-breakpoint
CREATE TABLE `write_off_reversals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`write_off_id` integer NOT NULL,
	`customer_id` integer NOT NULL,
	`date` text NOT NULL,
	`amount_paisa` integer NOT NULL,
	`reason` text NOT NULL,
	`created_by` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`write_off_id`) REFERENCES `write_offs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "write_off_reversals_amount_ck" CHECK("write_off_reversals"."amount_paisa" > 0)
);
--> statement-breakpoint
CREATE INDEX `write_off_reversals_write_off_idx` ON `write_off_reversals` (`write_off_id`);--> statement-breakpoint
CREATE INDEX `write_off_reversals_date_idx` ON `write_off_reversals` (`date`);--> statement-breakpoint
CREATE TABLE `write_offs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`doc_no` text NOT NULL,
	`customer_id` integer NOT NULL,
	`date` text NOT NULL,
	`amount_paisa` integer NOT NULL,
	`reason` text NOT NULL,
	`status` text DEFAULT 'posted' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_by` integer,
	`updated_by` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "write_offs_amount_ck" CHECK("write_offs"."amount_paisa" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `write_offs_doc_no_uq` ON `write_offs` (`doc_no`);--> statement-breakpoint
CREATE INDEX `write_offs_customer_idx` ON `write_offs` (`customer_id`);--> statement-breakpoint
CREATE INDEX `write_offs_date_idx` ON `write_offs` (`date`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_payment_allocations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`customer_id` integer NOT NULL,
	`source_type` text NOT NULL,
	`source_id` integer NOT NULL,
	`sale_id` integer,
	`amount_paisa` integer NOT NULL,
	`is_manual` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sale_id`) REFERENCES `sales`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "payment_allocations_amount_ck" CHECK("__new_payment_allocations"."amount_paisa" > 0)
);
--> statement-breakpoint
INSERT INTO `__new_payment_allocations`("id", "customer_id", "source_type", "source_id", "sale_id", "amount_paisa", "is_manual", "created_at") SELECT pa."id", (SELECT s."customer_id" FROM `sales` s WHERE s."id" = pa."sale_id"), pa."source_type", pa."source_id", pa."sale_id", pa."amount_paisa", pa."is_manual", pa."created_at" FROM `payment_allocations` pa;--> statement-breakpoint
DROP TABLE `payment_allocations`;--> statement-breakpoint
ALTER TABLE `__new_payment_allocations` RENAME TO `payment_allocations`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `payment_allocations_sale_idx` ON `payment_allocations` (`sale_id`);--> statement-breakpoint
CREATE INDEX `payment_allocations_customer_idx` ON `payment_allocations` (`customer_id`);--> statement-breakpoint
CREATE INDEX `payment_allocations_source_idx` ON `payment_allocations` (`source_type`,`source_id`);--> statement-breakpoint
ALTER TABLE `payments` ADD `kind` text DEFAULT 'receipt' NOT NULL;--> statement-breakpoint
ALTER TABLE `payments` ADD `sales_return_id` integer REFERENCES sales_returns(id);--> statement-breakpoint
ALTER TABLE `payments` ADD `bounced_at` text;--> statement-breakpoint
ALTER TABLE `payments` ADD `bounce_reason` text;