-- Standing "always allow" approvals are gone: a tool that changes things always asks.
DROP TABLE "tool_approval_rule";--> statement-breakpoint
ALTER TABLE "connection" ADD COLUMN "access" text DEFAULT 'allow' NOT NULL;--> statement-breakpoint
-- A connection that was switched off stays off. One that was on reads its read-only
-- tools freely, and now also offers the tools that change things, each of which asks.
UPDATE "connection" SET "access" = CASE WHEN "enabled" THEN 'allow' ELSE 'off' END;--> statement-breakpoint
ALTER TABLE "connection" DROP COLUMN "enabled";--> statement-breakpoint
ALTER TABLE "connection" DROP COLUMN "allow_mutating";
