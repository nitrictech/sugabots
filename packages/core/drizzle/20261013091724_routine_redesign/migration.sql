ALTER TABLE "routine" ADD COLUMN "schedule" jsonb;--> statement-breakpoint
ALTER TABLE "routine" ADD COLUMN "webhook_auth" jsonb;--> statement-breakpoint
ALTER TABLE "routine" ADD COLUMN "webhook_secret" text;--> statement-breakpoint
ALTER TABLE "routine" ADD COLUMN "created_by_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "routine" ADD CONSTRAINT "routine_created_by_agent_valid" CHECK ("created_by_agent_id" is null or "created_by_agent_id" = "agent_id");--> statement-breakpoint
-- Webhook routines made before auth was chosen take a bearer token, which their hashed secrets still admit.
UPDATE "routine" SET "webhook_auth" = '{"kind":"bearer"}'::jsonb WHERE "trigger_kind" = 'webhook';--> statement-breakpoint
ALTER TABLE "routine" DROP CONSTRAINT "routine_trigger_valid", ADD CONSTRAINT "routine_trigger_valid" CHECK ((
				"trigger_kind" = 'cron'
				and ("cron_expression" is null) <> ("schedule" is null)
				and "cron_timezone" is not null
				and "webhook_auth" is null
				and "webhook_secret" is null
				and "webhook_secret_digest" is null
			) or (
				"trigger_kind" = 'webhook'
				and "cron_expression" is null
				and "schedule" is null
				and "cron_timezone" is null
				and "next_scheduled_at" is null
				and "webhook_auth" is not null
				and ("webhook_secret" is null or "webhook_secret_digest" is null)
				and ("webhook_secret_digest" is null or "webhook_auth"->>'kind' = 'bearer')
			));