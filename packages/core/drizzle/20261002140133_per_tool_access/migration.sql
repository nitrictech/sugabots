ALTER TABLE "connection" ADD COLUMN "tool_access" jsonb DEFAULT '{}' NOT NULL;--> statement-breakpoint
-- Each tool takes the setting its connection had, so every connection behaves as it did.
UPDATE "connection" SET "tool_access" = (
	SELECT coalesce(jsonb_object_agg(tool->>'name', "connection"."access"), '{}')
	FROM jsonb_array_elements("connection"."tools") AS tool
);--> statement-breakpoint
ALTER TABLE "connection" DROP COLUMN "access";
