CREATE TABLE `whatsapp_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`user_id` integer,
	`customer_id` integer NOT NULL,
	`kind` text NOT NULL,
	`sale_id` integer,
	`doc_no` text,
	`mode` text NOT NULL,
	`status` text NOT NULL,
	`phone` text,
	`pdf_file` text,
	`message_id` text,
	`error` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sale_id`) REFERENCES `sales`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `whatsapp_log_sale_idx` ON `whatsapp_log` (`sale_id`);--> statement-breakpoint
CREATE INDEX `whatsapp_log_customer_idx` ON `whatsapp_log` (`customer_id`,`at`);