CREATE TABLE "routine_trigger" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"workspace_id" uuid NOT NULL,
	"routine_id" uuid NOT NULL,
	"kind" text GENERATED ALWAYS AS (settings->>'kind') STORED NOT NULL,
	"settings" jsonb NOT NULL,
	"secret_encrypted" text,
	"secret_digest" text,
	"next_scheduled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "routine_trigger_secret_valid" CHECK (("secret_encrypted" is null and "secret_digest" is null)
				or ("kind" = 'webhook' and ("secret_encrypted" is null or "secret_digest" is null))),
	CONSTRAINT "routine_trigger_digest_valid" CHECK ("secret_digest" is null or "settings"->'auth'->>'kind' = 'bearer'),
	CONSTRAINT "routine_trigger_schedule_valid" CHECK ("kind" = 'cron' or "next_scheduled_at" is null)
);
--> statement-breakpoint
ALTER TABLE "routine" DROP CONSTRAINT "routine_trigger_valid";--> statement-breakpoint
ALTER TABLE "routine" DROP CONSTRAINT "routine_schedule_state_valid";--> statement-breakpoint
DROP INDEX "routine_due_idx";--> statement-breakpoint
ALTER TABLE "routine_execution" ADD COLUMN "trigger_id" uuid;--> statement-breakpoint
-- Each routine's one trigger becomes its first row in "routine_trigger", with the routine's id, so a webhook keeps its address.
INSERT INTO "routine_trigger" ("id", "workspace_id", "routine_id", "settings", "secret_encrypted", "secret_digest", "next_scheduled_at", "created_at")
SELECT
	"id",
	"workspace_id",
	"id",
	CASE "trigger_kind"
		WHEN 'cron' THEN jsonb_build_object(
			'kind', 'cron',
			'schedule', coalesce("schedule", jsonb_build_object('repeat', 'cron', 'expression', "cron_expression")),
			'timezone', "cron_timezone"
		)
		ELSE jsonb_build_object('kind', 'webhook', 'auth', "webhook_auth")
	END,
	CASE WHEN "trigger_kind" = 'webhook' THEN "webhook_secret" END,
	CASE WHEN "trigger_kind" = 'webhook' THEN "webhook_secret_digest" END,
	CASE WHEN "trigger_kind" = 'cron' AND "state" = 'enabled' AND "deleted_at" IS NULL THEN "next_scheduled_at" END,
	"created_at"
FROM "routine";--> statement-breakpoint
-- A run its routine's trigger started, of the kind the routine has now, was started by that trigger.
UPDATE "routine_execution" SET "trigger_id" = "routine_execution"."routine_id"
FROM "routine"
WHERE "routine"."id" = "routine_execution"."routine_id"
	AND "routine_execution"."trigger_kind" = "routine"."trigger_kind";--> statement-breakpoint
ALTER TABLE "connection" ADD COLUMN "kind" text DEFAULT 'mcp' NOT NULL;--> statement-breakpoint
ALTER TABLE "connection" ADD COLUMN "settings" jsonb;--> statement-breakpoint
ALTER TABLE "connection" ADD COLUMN "app_credential_encrypted" text;--> statement-breakpoint
ALTER TABLE "routine" DROP COLUMN "trigger_kind";--> statement-breakpoint
ALTER TABLE "routine" DROP COLUMN "cron_expression";--> statement-breakpoint
ALTER TABLE "routine" DROP COLUMN "schedule";--> statement-breakpoint
ALTER TABLE "routine" DROP COLUMN "cron_timezone";--> statement-breakpoint
ALTER TABLE "routine" DROP COLUMN "next_scheduled_at";--> statement-breakpoint
ALTER TABLE "routine" DROP COLUMN "webhook_auth";--> statement-breakpoint
ALTER TABLE "routine" DROP COLUMN "webhook_secret";--> statement-breakpoint
ALTER TABLE "routine" DROP COLUMN "webhook_secret_digest";--> statement-breakpoint
DROP INDEX "routine_execution_trigger_identity_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "routine_execution_trigger_identity_idx" ON "routine_execution" ("trigger_id","trigger_identity") WHERE "trigger_id" is not null and "trigger_identity" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "routine_execution_manual_identity_idx" ON "routine_execution" ("routine_id","trigger_identity") WHERE "trigger_kind" = 'manual';--> statement-breakpoint
CREATE INDEX "routine_trigger_routine_idx" ON "routine_trigger" ("routine_id","created_at");--> statement-breakpoint
CREATE INDEX "routine_trigger_due_idx" ON "routine_trigger" ("next_scheduled_at","id") WHERE "next_scheduled_at" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "connection_github_pod_idx" ON "connection" ("pod_id") WHERE "kind" = 'github';--> statement-breakpoint
ALTER TABLE "routine_execution" ADD CONSTRAINT "routine_execution_trigger_id_routine_trigger_id_fkey" FOREIGN KEY ("trigger_id") REFERENCES "routine_trigger"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "routine_trigger" ADD CONSTRAINT "routine_trigger_routine_workspace_fkey" FOREIGN KEY ("routine_id","workspace_id") REFERENCES "routine"("id","workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "connection" ADD CONSTRAINT "connection_kind_check" CHECK ("kind" in ('mcp', 'github'));--> statement-breakpoint
ALTER TABLE "connection" ADD CONSTRAINT "connection_settings_kind_check" CHECK (("kind" = 'github') = ("settings" is not null)
				and ("settings" is null or "settings"->>'kind' = "kind"));--> statement-breakpoint
ALTER TABLE "connection" ADD CONSTRAINT "connection_app_credential_kind_check" CHECK (("kind" = 'github') = ("app_credential_encrypted" is not null));--> statement-breakpoint
ALTER TABLE "routine_execution" DROP CONSTRAINT "routine_execution_trigger_valid", ADD CONSTRAINT "routine_execution_trigger_valid" CHECK ("trigger"->>'kind' = "trigger_kind"
				and ("trigger_kind" = 'webhook' or "trigger_identity" is not null)
				and ("trigger_kind" <> 'manual' or "trigger_id" is null));