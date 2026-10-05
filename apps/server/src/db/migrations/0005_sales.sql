CREATE TABLE `payment_allocations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_type` text NOT NULL,
	`source_id` integer NOT NULL,
	`sale_id` integer NOT NULL,
	`amount_paisa` integer NOT NULL,
	`is_manual` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`sale_id`) REFERENCES `sales`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "payment_allocations_amount_ck" CHECK("payment_allocations"."amount_paisa" > 0)
);
--> statement-breakpoint
CREATE INDEX `payment_allocations_sale_idx` ON `payment_allocations` (`sale_id`);--> statement-breakpoint
CREATE INDEX `payment_allocations_source_idx` ON `payment_allocations` (`source_type`,`source_id`);--> statement-breakpoint
CREATE TABLE `payments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`doc_no` text NOT NULL,
	`party_type` text NOT NULL,
	`party_id` integer NOT NULL,
	`date` text NOT NULL,
	`amount_paisa` integer NOT NULL,
	`method` text NOT NULL,
	`reference` text,
	`cheque_no` text,
	`cheque_bank` text,
	`cheque_date` text,
	`status` text DEFAULT 'posted' NOT NULL,
	`sale_id` integer,
	`version` integer DEFAULT 1 NOT NULL,
	`notes` text,
	`created_by` integer,
	`updated_by` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`sale_id`) REFERENCES `sales`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "payments_amount_ck" CHECK("payments"."amount_paisa" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payments_doc_no_uq` ON `payments` (`doc_no`);--> statement-breakpoint
CREATE INDEX `payments_party_idx` ON `payments` (`party_type`,`party_id`,`date`);--> statement-breakpoint
CREATE INDEX `payments_date_idx` ON `payments` (`date`);--> statement-breakpoint
CREATE TABLE `sale_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`sale_id` integer NOT NULL,
	`line_no` integer NOT NULL,
	`variant_id` integer NOT NULL,
	`qty` integer NOT NULL,
	`list_price_paisa` integer NOT NULL,
	`default_discount_bp` integer NOT NULL,
	`discount_bp` integer NOT NULL,
	`discount_overridden` integer DEFAULT false NOT NULL,
	`line_gross_paisa` integer NOT NULL,
	`line_discount_paisa` integer NOT NULL,
	`line_net_paisa` integer NOT NULL,
	`unit_cost_paisa` integer NOT NULL,
	`cost_source` text NOT NULL,
	`line_cost_paisa` integer NOT NULL,
	`profit_paisa` integer NOT NULL,
	FOREIGN KEY (`sale_id`) REFERENCES `sales`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`variant_id`) REFERENCES `product_variants`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "sale_items_qty_ck" CHECK("sale_items"."qty" > 0),
	CONSTRAINT "sale_items_discount_ck" CHECK("sale_items"."discount_bp" BETWEEN 0 AND 10000 AND "sale_items"."default_discount_bp" BETWEEN 0 AND 10000)
);
--> statement-breakpoint
CREATE INDEX `sale_items_sale_idx` ON `sale_items` (`sale_id`);--> statement-breakpoint
CREATE INDEX `sale_items_variant_idx` ON `sale_items` (`variant_id`);--> statement-breakpoint
CREATE TABLE `sales` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`doc_no` text NOT NULL,
	`customer_id` integer NOT NULL,
	`date` text NOT NULL,
	`payment_terms_days` integer NOT NULL,
	`due_date` text NOT NULL,
	`gross_paisa` integer NOT NULL,
	`line_discount_paisa` integer NOT NULL,
	`extra_discount_paisa` integer DEFAULT 0 NOT NULL,
	`tax_paisa` integer DEFAULT 0 NOT NULL,
	`total_paisa` integer NOT NULL,
	`status` text DEFAULT 'posted' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`notes` text,
	`approved_by` integer,
	`created_by` integer,
	`updated_by` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`approved_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "sales_amounts_ck" CHECK("sales"."total_paisa" >= 0 AND "sales"."extra_discount_paisa" >= 0 AND "sales"."tax_paisa" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sales_doc_no_uq` ON `sales` (`doc_no`);--> statement-breakpoint
CREATE INDEX `sales_customer_idx` ON `sales` (`customer_id`,`status`,`due_date`);--> statement-breakpoint
CREATE INDEX `sales_date_idx` ON `sales` (`date`);