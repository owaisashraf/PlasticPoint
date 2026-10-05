CREATE TABLE `purchase_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`purchase_id` integer NOT NULL,
	`line_no` integer NOT NULL,
	`variant_id` integer NOT NULL,
	`qty` integer NOT NULL,
	`list_price_paisa` integer NOT NULL,
	`supplier_margin_bp` integer NOT NULL,
	`line_gross_paisa` integer NOT NULL,
	`line_margin_paisa` integer NOT NULL,
	`line_cost_paisa` integer NOT NULL,
	`unit_cost_paisa` integer NOT NULL,
	FOREIGN KEY (`purchase_id`) REFERENCES `purchases`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`variant_id`) REFERENCES `product_variants`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "purchase_items_qty_ck" CHECK("purchase_items"."qty" > 0),
	CONSTRAINT "purchase_items_margin_ck" CHECK("purchase_items"."supplier_margin_bp" BETWEEN 0 AND 10000)
);
--> statement-breakpoint
CREATE INDEX `purchase_items_purchase_idx` ON `purchase_items` (`purchase_id`);--> statement-breakpoint
CREATE INDEX `purchase_items_variant_idx` ON `purchase_items` (`variant_id`);--> statement-breakpoint
CREATE TABLE `purchase_return_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`return_id` integer NOT NULL,
	`purchase_item_id` integer NOT NULL,
	`variant_id` integer NOT NULL,
	`qty` integer NOT NULL,
	`unit_cost_paisa` integer NOT NULL,
	`line_cost_paisa` integer NOT NULL,
	FOREIGN KEY (`return_id`) REFERENCES `purchase_returns`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`purchase_item_id`) REFERENCES `purchase_items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`variant_id`) REFERENCES `product_variants`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "purchase_return_items_qty_ck" CHECK("purchase_return_items"."qty" > 0)
);
--> statement-breakpoint
CREATE INDEX `purchase_return_items_return_idx` ON `purchase_return_items` (`return_id`);--> statement-breakpoint
CREATE INDEX `purchase_return_items_item_idx` ON `purchase_return_items` (`purchase_item_id`);--> statement-breakpoint
CREATE TABLE `purchase_returns` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`doc_no` text NOT NULL,
	`purchase_id` integer NOT NULL,
	`supplier_id` integer NOT NULL,
	`date` text NOT NULL,
	`reason` text NOT NULL,
	`total_cost_paisa` integer NOT NULL,
	`status` text DEFAULT 'posted' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_by` integer,
	`updated_by` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`purchase_id`) REFERENCES `purchases`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `purchase_returns_doc_no_uq` ON `purchase_returns` (`doc_no`);--> statement-breakpoint
CREATE INDEX `purchase_returns_purchase_idx` ON `purchase_returns` (`purchase_id`);--> statement-breakpoint
CREATE INDEX `purchase_returns_date_idx` ON `purchase_returns` (`date`);--> statement-breakpoint
CREATE TABLE `purchases` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`doc_no` text NOT NULL,
	`supplier_id` integer NOT NULL,
	`date` text NOT NULL,
	`supplier_ref` text,
	`notes` text,
	`gross_paisa` integer NOT NULL,
	`margin_paisa` integer NOT NULL,
	`total_cost_paisa` integer NOT NULL,
	`status` text DEFAULT 'posted' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_by` integer,
	`updated_by` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `purchases_doc_no_uq` ON `purchases` (`doc_no`);--> statement-breakpoint
CREATE INDEX `purchases_date_idx` ON `purchases` (`date`);--> statement-breakpoint
CREATE INDEX `purchases_supplier_idx` ON `purchases` (`supplier_id`,`status`);