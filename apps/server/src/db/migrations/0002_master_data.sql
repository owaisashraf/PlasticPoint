CREATE TABLE `customers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`business_name` text,
	`type` text NOT NULL,
	`phone` text,
	`alt_phone` text,
	`city` text,
	`area` text,
	`address` text,
	`ntn` text,
	`credit_limit_paisa` integer DEFAULT 0 NOT NULL,
	`payment_terms_days` integer NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`bad_debt_marked_at` text,
	`bad_debt_reason` text,
	`notes` text,
	`created_by` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "customers_credit_limit_ck" CHECK("customers"."credit_limit_paisa" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `customers_code_uq` ON `customers` (`code`);--> statement-breakpoint
CREATE INDEX `customers_status_idx` ON `customers` (`status`);--> statement-breakpoint
CREATE INDEX `customers_city_idx` ON `customers` (`city`);--> statement-breakpoint
CREATE TABLE `ledger_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`party_type` text NOT NULL,
	`party_id` integer NOT NULL,
	`date` text NOT NULL,
	`debit_paisa` integer DEFAULT 0 NOT NULL,
	`credit_paisa` integer DEFAULT 0 NOT NULL,
	`entry_type` text NOT NULL,
	`source_type` text NOT NULL,
	`source_id` integer NOT NULL,
	`narration` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	CONSTRAINT "ledger_entries_amounts_ck" CHECK("ledger_entries"."debit_paisa" >= 0 AND "ledger_entries"."credit_paisa" >= 0),
	CONSTRAINT "ledger_entries_one_side_ck" CHECK(("ledger_entries"."debit_paisa" = 0) <> ("ledger_entries"."credit_paisa" = 0))
);
--> statement-breakpoint
CREATE INDEX `ledger_entries_party_idx` ON `ledger_entries` (`party_type`,`party_id`,`date`);--> statement-breakpoint
CREATE INDEX `ledger_entries_source_idx` ON `ledger_entries` (`source_type`,`source_id`);--> statement-breakpoint
CREATE TABLE `product_price_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`product_id` integer NOT NULL,
	`effective_date` text NOT NULL,
	`list_price_paisa` integer NOT NULL,
	`supplier_margin_bp` integer NOT NULL,
	`default_customer_discount_bp` integer NOT NULL,
	`changed_by` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`changed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `product_price_history_product_idx` ON `product_price_history` (`product_id`,`id`);--> statement-breakpoint
CREATE TABLE `product_variants` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`product_id` integer NOT NULL,
	`color` text DEFAULT '' NOT NULL,
	`size` text DEFAULT '' NOT NULL,
	`sku` text NOT NULL,
	`avg_cost_paisa` integer,
	`low_stock_threshold` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `product_variants_sku_uq` ON `product_variants` (`sku`);--> statement-breakpoint
CREATE UNIQUE INDEX `product_variants_combo_uq` ON `product_variants` (`product_id`,`color`,`size`);--> statement-breakpoint
CREATE TABLE `products` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`item_code` text NOT NULL,
	`name` text NOT NULL,
	`category` text,
	`unit` text DEFAULT 'pcs' NOT NULL,
	`sizes` text DEFAULT '[]' NOT NULL,
	`colors` text DEFAULT '[]' NOT NULL,
	`list_price_paisa` integer NOT NULL,
	`supplier_margin_bp` integer NOT NULL,
	`default_customer_discount_bp` integer NOT NULL,
	`max_customer_discount_bp` integer,
	`active` integer DEFAULT true NOT NULL,
	`created_by` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "products_price_ck" CHECK("products"."list_price_paisa" > 0),
	CONSTRAINT "products_margin_ck" CHECK("products"."supplier_margin_bp" BETWEEN 0 AND 10000),
	CONSTRAINT "products_discount_ck" CHECK("products"."default_customer_discount_bp" BETWEEN 0 AND 10000),
	CONSTRAINT "products_max_discount_ck" CHECK("products"."max_customer_discount_bp" IS NULL OR "products"."max_customer_discount_bp" BETWEEN 0 AND 10000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `products_item_code_uq` ON `products` (`item_code`);--> statement-breakpoint
CREATE INDEX `products_category_idx` ON `products` (`category`);--> statement-breakpoint
CREATE TABLE `sequences` (
	`name` text PRIMARY KEY NOT NULL,
	`last_value` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `stock_movements` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`variant_id` integer NOT NULL,
	`date` text NOT NULL,
	`qty_change` integer NOT NULL,
	`unit_cost_paisa` integer,
	`source_type` text NOT NULL,
	`source_id` integer NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`variant_id`) REFERENCES `product_variants`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "stock_movements_qty_ck" CHECK("stock_movements"."qty_change" <> 0)
);
--> statement-breakpoint
CREATE INDEX `stock_movements_variant_idx` ON `stock_movements` (`variant_id`);--> statement-breakpoint
CREATE INDEX `stock_movements_source_idx` ON `stock_movements` (`source_type`,`source_id`);--> statement-breakpoint
CREATE TABLE `suppliers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`phone` text,
	`address` text,
	`ntn` text,
	`notes` text,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
