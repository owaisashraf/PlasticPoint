-- Customer quick search (CLAUDE.md 8.2 / 10.1). FTS5 with the trigram tokenizer
-- matches any part of a word ("hmed" finds "Ahmed"). Phones are indexed both as
-- stored (+923001234567) and in local form (03001234567).
-- rowid = customers.id. Customers are never deleted, so there is no delete trigger.
CREATE VIRTUAL TABLE `customers_fts` USING fts5(
	code, name, business_name, phones, city, area,
	tokenize = 'trigram'
);
--> statement-breakpoint
CREATE TRIGGER `customers_fts_ai` AFTER INSERT ON `customers`
BEGIN
	INSERT INTO customers_fts (rowid, code, name, business_name, phones, city, area)
	VALUES (
		new.id, new.code, new.name, coalesce(new.business_name, ''),
		trim(
			coalesce(new.phone, '') || ' ' ||
			CASE WHEN new.phone LIKE '+92%' THEN '0' || substr(new.phone, 4) ELSE '' END || ' ' ||
			coalesce(new.alt_phone, '') || ' ' ||
			CASE WHEN new.alt_phone LIKE '+92%' THEN '0' || substr(new.alt_phone, 4) ELSE '' END
		),
		coalesce(new.city, ''), coalesce(new.area, '')
	);
END;
--> statement-breakpoint
CREATE TRIGGER `customers_fts_au` AFTER UPDATE ON `customers`
BEGIN
	DELETE FROM customers_fts WHERE rowid = old.id;
	INSERT INTO customers_fts (rowid, code, name, business_name, phones, city, area)
	VALUES (
		new.id, new.code, new.name, coalesce(new.business_name, ''),
		trim(
			coalesce(new.phone, '') || ' ' ||
			CASE WHEN new.phone LIKE '+92%' THEN '0' || substr(new.phone, 4) ELSE '' END || ' ' ||
			coalesce(new.alt_phone, '') || ' ' ||
			CASE WHEN new.alt_phone LIKE '+92%' THEN '0' || substr(new.alt_phone, 4) ELSE '' END
		),
		coalesce(new.city, ''), coalesce(new.area, '')
	);
END;
--> statement-breakpoint
-- Index any customers that already exist.
INSERT INTO customers_fts (rowid, code, name, business_name, phones, city, area)
SELECT
	id, code, name, coalesce(business_name, ''),
	trim(
		coalesce(phone, '') || ' ' ||
		CASE WHEN phone LIKE '+92%' THEN '0' || substr(phone, 4) ELSE '' END || ' ' ||
		coalesce(alt_phone, '') || ' ' ||
		CASE WHEN alt_phone LIKE '+92%' THEN '0' || substr(alt_phone, 4) ELSE '' END
	),
	coalesce(city, ''), coalesce(area, '')
FROM customers;
