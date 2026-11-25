ALTER TABLE "tool_call" ADD COLUMN "approval_computer_project_id" uuid;--> statement-breakpoint
ALTER TABLE "tool_call" ADD COLUMN "approval_connector_access" text;--> statement-breakpoint
ALTER TABLE "tool_call" ADD COLUMN "approval_asked_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "tool_call_pending_approval_age_idx" ON "tool_call" (coalesce("approval_asked_at", "started_at")) WHERE "approval_status" = 'pending';
--> statement-breakpoint
UPDATE "tool_call" AS call
SET "approval_computer_project_id" = placed."project_id"
FROM "placed_chat" AS placed
WHERE call."tool" = 'request_host'
	AND call."approval_id" IS NOT NULL
	AND placed."id" = call."chat_id";
--> statement-breakpoint
UPDATE "tool_call" SET "approval_asked_at" = "started_at"
WHERE "approval_id" IS NOT NULL;
