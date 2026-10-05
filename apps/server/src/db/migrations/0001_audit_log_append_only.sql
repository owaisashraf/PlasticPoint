-- The audit log is append-only (CLAUDE.md 8.14). The app has no update or
-- delete paths for it, and these triggers make the database refuse them too.
CREATE TRIGGER `audit_log_no_update` BEFORE UPDATE ON `audit_log`
BEGIN
	SELECT RAISE(ABORT, 'audit_log is append-only: rows cannot be changed');
END;
--> statement-breakpoint
CREATE TRIGGER `audit_log_no_delete` BEFORE DELETE ON `audit_log`
BEGIN
	SELECT RAISE(ABORT, 'audit_log is append-only: rows cannot be deleted');
END;
