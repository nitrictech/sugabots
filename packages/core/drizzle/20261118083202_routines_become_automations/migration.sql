ALTER TABLE "routine" RENAME TO "automation";--> statement-breakpoint
ALTER TABLE "routine_execution" RENAME TO "run";--> statement-breakpoint
ALTER TABLE "routine_trigger" RENAME TO "automation_trigger";--> statement-breakpoint
ALTER TABLE "run" RENAME COLUMN "routine_id" TO "automation_id";--> statement-breakpoint
ALTER TABLE "run" RENAME COLUMN "routine_name" TO "automation_name";--> statement-breakpoint
ALTER TABLE "automation_trigger" RENAME COLUMN "routine_id" TO "automation_id";--> statement-breakpoint
ALTER TABLE "message" RENAME COLUMN "routine_trigger" TO "automation_trigger";--> statement-breakpoint
ALTER TABLE "message" RENAME COLUMN "routine_execution_id" TO "run_id";--> statement-breakpoint
ALTER TABLE "thread" RENAME COLUMN "routine_id" TO "automation_id";--> statement-breakpoint
ALTER TABLE "notification_settings" RENAME COLUMN "routine_runs" TO "automation_runs";--> statement-breakpoint
ALTER TABLE "automation" RENAME CONSTRAINT "routine_state_valid" TO "automation_state_valid";--> statement-breakpoint
ALTER TABLE "automation" RENAME CONSTRAINT "routine_paused_after_failures_valid" TO "automation_paused_after_failures_valid";--> statement-breakpoint
ALTER TABLE "automation" RENAME CONSTRAINT "routine_created_by_agent_valid" TO "automation_created_by_agent_valid";--> statement-breakpoint
ALTER TABLE "run" RENAME CONSTRAINT "routine_execution_trigger_valid" TO "run_trigger_valid";--> statement-breakpoint
ALTER TABLE "run" RENAME CONSTRAINT "routine_execution_state_valid" TO "run_state_valid";--> statement-breakpoint
ALTER TABLE "run" RENAME CONSTRAINT "routine_execution_pending_terminal_valid" TO "run_pending_terminal_valid";--> statement-breakpoint
ALTER TABLE "automation_trigger" RENAME CONSTRAINT "routine_trigger_secret_valid" TO "automation_trigger_secret_valid";--> statement-breakpoint
ALTER TABLE "automation_trigger" RENAME CONSTRAINT "routine_trigger_digest_valid" TO "automation_trigger_digest_valid";--> statement-breakpoint
ALTER TABLE "automation_trigger" RENAME CONSTRAINT "routine_trigger_schedule_valid" TO "automation_trigger_schedule_valid";--> statement-breakpoint
ALTER TABLE "thread" RENAME CONSTRAINT "thread_routine_valid" TO "thread_automation_valid";--> statement-breakpoint
ALTER TABLE "notification_settings" RENAME CONSTRAINT "notification_settings_routine_runs_valid" TO "notification_settings_automation_runs_valid";--> statement-breakpoint
ALTER INDEX "routine_agent_name_idx" RENAME TO "automation_agent_name_idx";--> statement-breakpoint
ALTER INDEX "routine_id_workspace_id_idx" RENAME TO "automation_id_workspace_id_idx";--> statement-breakpoint
ALTER INDEX "routine_execution_thread_idx" RENAME TO "run_thread_idx";--> statement-breakpoint
ALTER INDEX "routine_execution_trigger_identity_idx" RENAME TO "run_trigger_identity_idx";--> statement-breakpoint
ALTER INDEX "routine_execution_manual_identity_idx" RENAME TO "run_manual_identity_idx";--> statement-breakpoint
ALTER INDEX "routine_execution_running_idx" RENAME TO "run_running_idx";--> statement-breakpoint
ALTER INDEX "routine_execution_list_idx" RENAME TO "run_list_idx";--> statement-breakpoint
ALTER INDEX "routine_trigger_routine_idx" RENAME TO "automation_trigger_automation_idx";--> statement-breakpoint
ALTER INDEX "routine_trigger_due_idx" RENAME TO "automation_trigger_due_idx";--> statement-breakpoint
ALTER INDEX "message_routine_execution_idx" RENAME TO "message_run_idx";--> statement-breakpoint
ALTER INDEX "thread_routine_feed_idx" RENAME TO "thread_automation_feed_idx";--> statement-breakpoint
ALTER TABLE "automation" RENAME CONSTRAINT "routine_agent_workspace_fkey" TO "automation_agent_workspace_fkey";--> statement-breakpoint
ALTER TABLE "run" RENAME CONSTRAINT "routine_execution_agent_workspace_fkey" TO "run_agent_workspace_fkey";--> statement-breakpoint
ALTER TABLE "run" RENAME CONSTRAINT "routine_execution_routine_workspace_fkey" TO "run_automation_workspace_fkey";--> statement-breakpoint
ALTER TABLE "automation_trigger" RENAME CONSTRAINT "routine_trigger_routine_workspace_fkey" TO "automation_trigger_automation_workspace_fkey";--> statement-breakpoint
ALTER TABLE "automation_trigger" DROP CONSTRAINT "automation_trigger_schedule_valid";--> statement-breakpoint
-- A trigger of kind `cron` is now of kind `schedule`; `kind` follows `settings`.
UPDATE "automation_trigger" SET "settings" = jsonb_set("settings", '{kind}', '"schedule"') WHERE "settings"->>'kind' = 'cron';--> statement-breakpoint
ALTER TABLE "automation_trigger" ADD CONSTRAINT "automation_trigger_schedule_valid" CHECK ("kind" = 'schedule' or "next_scheduled_at" is null);--> statement-breakpoint
UPDATE "run" SET "trigger_kind" = 'schedule', "trigger" = jsonb_set("trigger", '{kind}', '"schedule"') WHERE "trigger_kind" = 'cron';--> statement-breakpoint
-- The message an automation's trigger posts names its author by the new words.
UPDATE "message" SET "automation_trigger" = ("automation_trigger" - 'kind' - 'executionId' - 'routineName' - 'triggerKind') || jsonb_build_object(
	'kind', 'automation_trigger',
	'runId', "automation_trigger"->'executionId',
	'automationName', "automation_trigger"->'routineName',
	'triggerKind', CASE WHEN "automation_trigger"->>'triggerKind' = 'cron' THEN to_jsonb('schedule'::text) ELSE "automation_trigger"->'triggerKind' END
) WHERE "automation_trigger" IS NOT NULL;--> statement-breakpoint
-- The built-in tools switched off as `routines` are now `automations`.
UPDATE "agent" SET "disabled_tools" = (
	SELECT jsonb_agg(CASE WHEN tool = 'routines' THEN 'automations' ELSE tool END ORDER BY position)
	FROM jsonb_array_elements_text("disabled_tools") WITH ORDINALITY AS listed(tool, position)
) WHERE "disabled_tools" ? 'routines';--> statement-breakpoint
-- Constraints Postgres named itself (primary keys, not-null constraints and the
-- foreign keys named for their columns) keep the old words in their names;
-- the ones a server has depend on its Postgres version, so each is renamed if it is there.
DO $$
DECLARE
	found record;
BEGIN
	FOR found IN
		SELECT conrelid::regclass AS on_table, conname AS name
		FROM pg_constraint
		WHERE connamespace = 'public'::regnamespace AND conname LIKE '%routine%'
	LOOP
		EXECUTE format(
			'ALTER TABLE %s RENAME CONSTRAINT %I TO %I',
			found.on_table,
			found.name,
			replace(replace(replace(found.name, 'routine_execution', 'run'), 'routine_trigger', 'automation_trigger'), 'routine', 'automation')
		);
	END LOOP;
END $$;--> statement-breakpoint
DROP INDEX "message_run_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "message_run_idx" ON "message" ("run_id","thread_id") WHERE "run_id" is not null;--> statement-breakpoint
ALTER TABLE "message" DROP CONSTRAINT "message_one_author", ADD CONSTRAINT "message_one_author" CHECK (num_nonnulls("author_user_id", "author_agent_id", "automation_trigger") = 1);--> statement-breakpoint
ALTER TABLE "thread" DROP CONSTRAINT "thread_automation_valid", ADD CONSTRAINT "thread_automation_valid" CHECK (("automation_id" is not null) = ("type" = 'routine_feed'));--> statement-breakpoint
ALTER TABLE "notification_settings" DROP CONSTRAINT "notification_settings_automation_runs_valid", ADD CONSTRAINT "notification_settings_automation_runs_valid" CHECK ("automation_runs" in ('failures', 'all', 'none'));