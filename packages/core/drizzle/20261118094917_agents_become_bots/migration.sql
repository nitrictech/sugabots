ALTER TABLE "agent_allowed_host" RENAME TO "bot_allowed_host";--> statement-breakpoint
ALTER TABLE "agent_summary" RENAME TO "bot_summary";--> statement-breakpoint
ALTER TABLE "agent" RENAME TO "bot";--> statement-breakpoint
ALTER TABLE "pinned_agent" RENAME TO "pinned_bot";--> statement-breakpoint
ALTER TABLE "model_request" RENAME COLUMN "agent_id" TO "bot_id";--> statement-breakpoint
ALTER TABLE "bot_allowed_host" RENAME COLUMN "agent_id" TO "bot_id";--> statement-breakpoint
ALTER TABLE "computer" RENAME COLUMN "agent_id" TO "bot_id";--> statement-breakpoint
ALTER TABLE "automation" RENAME COLUMN "agent_id" TO "bot_id";--> statement-breakpoint
ALTER TABLE "automation" RENAME COLUMN "created_by_agent_id" TO "created_by_bot_id";--> statement-breakpoint
ALTER TABLE "run" RENAME COLUMN "agent_id" TO "bot_id";--> statement-breakpoint
ALTER TABLE "bot_summary" RENAME COLUMN "agent_id" TO "bot_id";--> statement-breakpoint
ALTER TABLE "collaboration" RENAME COLUMN "collaborator_agent_id" TO "collaborator_bot_id";--> statement-breakpoint
ALTER TABLE "message" RENAME COLUMN "author_agent_id" TO "author_bot_id";--> statement-breakpoint
ALTER TABLE "thread" RENAME COLUMN "host_agent_id" TO "host_bot_id";--> statement-breakpoint
ALTER TABLE "thread" RENAME COLUMN "system_agent_key" TO "system_bot_key";--> statement-breakpoint
ALTER TABLE "thread_participant" RENAME COLUMN "agent_id" TO "bot_id";--> statement-breakpoint
ALTER TABLE "turn" RENAME COLUMN "agent_id" TO "bot_id";--> statement-breakpoint
ALTER TABLE "file" RENAME COLUMN "created_by_agent_id" TO "created_by_bot_id";--> statement-breakpoint
ALTER TABLE "file_version" RENAME COLUMN "author_agent_id" TO "author_bot_id";--> statement-breakpoint
ALTER TABLE "notification_override" RENAME COLUMN "agent_id" TO "bot_id";--> statement-breakpoint
ALTER TABLE "connection" RENAME COLUMN "agent_id" TO "bot_id";--> statement-breakpoint
ALTER TABLE "bot" RENAME COLUMN "system_agent_key" TO "system_bot_key";--> statement-breakpoint
ALTER TABLE "channel_bot" RENAME COLUMN "agent_id" TO "bot_id";--> statement-breakpoint
ALTER TABLE "pinned_bot" RENAME COLUMN "agent_id" TO "bot_id";--> statement-breakpoint
ALTER TABLE "automation" RENAME CONSTRAINT "automation_created_by_agent_valid" TO "automation_created_by_bot_valid";--> statement-breakpoint
ALTER TABLE "bot" RENAME CONSTRAINT "agent_visibility_check" TO "bot_visibility_check";--> statement-breakpoint
ALTER INDEX "computer_agent_id_idx" RENAME TO "computer_bot_id_idx";--> statement-breakpoint
ALTER INDEX "automation_agent_name_idx" RENAME TO "automation_bot_name_idx";--> statement-breakpoint
ALTER INDEX "thread_system_agent_key_idx" RENAME TO "thread_system_bot_key_idx";--> statement-breakpoint
ALTER INDEX "thread_participant_agent_idx" RENAME TO "thread_participant_bot_idx";--> statement-breakpoint
ALTER INDEX "turn_trigger_agent_idx" RENAME TO "turn_trigger_bot_idx";--> statement-breakpoint
ALTER INDEX "notification_override_agent_idx" RENAME TO "notification_override_bot_idx";--> statement-breakpoint
ALTER INDEX "connection_github_agent_idx" RENAME TO "connection_github_bot_idx";--> statement-breakpoint
ALTER INDEX "agent_name_idx" RENAME TO "bot_name_idx";--> statement-breakpoint
ALTER INDEX "agent_handle_idx" RENAME TO "bot_handle_idx";--> statement-breakpoint
ALTER INDEX "agent_assistant_idx" RENAME TO "bot_assistant_idx";--> statement-breakpoint
ALTER INDEX "agent_system_agent_key_idx" RENAME TO "bot_system_bot_key_idx";--> statement-breakpoint
ALTER INDEX "agent_id_workspace_id_idx" RENAME TO "bot_id_workspace_id_idx";--> statement-breakpoint
ALTER INDEX "channel_bot_agent_id_idx" RENAME TO "channel_bot_bot_id_idx";--> statement-breakpoint
ALTER INDEX "pinned_agent_agent_id_idx" RENAME TO "pinned_bot_bot_id_idx";--> statement-breakpoint
ALTER TABLE "bot_allowed_host" RENAME CONSTRAINT "agent_allowed_host_agent_workspace_fkey" TO "bot_allowed_host_bot_workspace_fkey";--> statement-breakpoint
ALTER TABLE "computer" RENAME CONSTRAINT "computer_agent_workspace_fkey" TO "computer_bot_workspace_fkey";--> statement-breakpoint
ALTER TABLE "automation" RENAME CONSTRAINT "automation_agent_workspace_fkey" TO "automation_bot_workspace_fkey";--> statement-breakpoint
ALTER TABLE "run" RENAME CONSTRAINT "run_agent_workspace_fkey" TO "run_bot_workspace_fkey";--> statement-breakpoint
ALTER TABLE "thread" RENAME CONSTRAINT "thread_host_agent_workspace_fkey" TO "thread_host_bot_workspace_fkey";--> statement-breakpoint
ALTER TABLE "connection" RENAME CONSTRAINT "connection_agent_workspace_fkey" TO "connection_bot_workspace_fkey";--> statement-breakpoint
ALTER TABLE "bot" RENAME CONSTRAINT "agent_assistant_workspace_member_fkey" TO "bot_assistant_workspace_member_fkey";--> statement-breakpoint
ALTER TABLE "channel_bot" RENAME CONSTRAINT "channel_bot_agent_workspace_fkey" TO "channel_bot_bot_workspace_fkey";--> statement-breakpoint
ALTER TABLE "pinned_bot" RENAME CONSTRAINT "pinned_agent_workspace_member_fkey" TO "pinned_bot_workspace_member_fkey";--> statement-breakpoint
ALTER TABLE "pinned_bot" RENAME CONSTRAINT "pinned_agent_agent_workspace_fkey" TO "pinned_bot_bot_workspace_fkey";--> statement-breakpoint
DROP INDEX "thread_participant_bot_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "thread_participant_bot_idx" ON "thread_participant" ("thread_id","bot_id") WHERE "bot_id" is not null;--> statement-breakpoint
DROP INDEX "notification_override_bot_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "notification_override_bot_idx" ON "notification_override" ("user_id","bot_id") WHERE "bot_id" is not null;--> statement-breakpoint
DROP INDEX "bot_name_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "bot_name_idx" ON "bot" ("workspace_id",lower("name")) WHERE "system_bot_key" is null and "assistant_of" is null;--> statement-breakpoint
DROP INDEX "bot_handle_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "bot_handle_idx" ON "bot" ("workspace_id","handle") WHERE "system_bot_key" is null and "assistant_of" is null;--> statement-breakpoint
-- A bot's turn's model requests, by the purpose's new name.
ALTER TABLE "model_request" DROP CONSTRAINT "model_request_purpose_valid";--> statement-breakpoint
UPDATE "model_request" SET "purpose" = 'bot-turn' WHERE "purpose" = 'agent-turn';--> statement-breakpoint
ALTER TABLE "model_request" ADD CONSTRAINT "model_request_purpose_valid" CHECK ("purpose" in ('bot-turn', 'facilitation', 'summary', 'compaction', 'trial', 'provider-check'));--> statement-breakpoint
ALTER TABLE "message" DROP CONSTRAINT "message_one_author", ADD CONSTRAINT "message_one_author" CHECK (num_nonnulls("author_user_id", "author_bot_id", "automation_trigger") = 1);--> statement-breakpoint
ALTER TABLE "thread_participant" DROP CONSTRAINT "thread_participant_one_identity", ADD CONSTRAINT "thread_participant_one_identity" CHECK (num_nonnulls("user_id", "bot_id") = 1);--> statement-breakpoint
ALTER TABLE "automation" DROP CONSTRAINT "automation_created_by_bot_valid", ADD CONSTRAINT "automation_created_by_bot_valid" CHECK ("created_by_bot_id" is null or "created_by_bot_id" = "bot_id");--> statement-breakpoint
ALTER TABLE "thread" DROP CONSTRAINT "thread_host_valid", ADD CONSTRAINT "thread_host_valid" CHECK (("type" in ('pod_chat', 'direct')) = ("host_bot_id" is null));--> statement-breakpoint
ALTER TABLE "notification_override" DROP CONSTRAINT "notification_override_one_place", ADD CONSTRAINT "notification_override_one_place" CHECK (num_nonnulls("channel_id", "bot_id") = 1);--> statement-breakpoint
-- The files bots attach to their replies, by the kind's new name.
ALTER TABLE "file" DROP CONSTRAINT "file_kind_valid";--> statement-breakpoint
ALTER TABLE "file" DROP CONSTRAINT "file_source_valid";--> statement-breakpoint
UPDATE "file" SET "kind" = 'bot_attachment' WHERE "kind" = 'agent_attachment';--> statement-breakpoint
ALTER TABLE "file" ADD CONSTRAINT "file_kind_valid" CHECK ("kind" in ('document', 'html', 'upload', 'bot_attachment', 'tool_result'));--> statement-breakpoint
ALTER TABLE "file" ADD CONSTRAINT "file_source_valid" CHECK (case "kind"
				when 'upload' then "name" is not null and "content_type" is not null
					and "size" is not null and "tool_call_id" is null
					and ("message_id" is null) = ("position" is null)
					and "created_by_bot_id" is null and "current_version" is null
				when 'bot_attachment' then "name" is not null and "content_type" is not null
					and "size" is not null and "tool_call_id" is null
					and "uploader_id" is null and "message_id" is not null
					and "position" is not null
					and "created_by_bot_id" is null and "current_version" is null
				when 'tool_result' then "name" is null and "content_type" is not null
					and "size" is not null and "uploader_id" is null
					and "message_id" is null and "position" is null
					and "created_by_bot_id" is null and "current_version" is null
				else "name" is not null and "current_version" is not null
					and "content_type" is null and "size" is null
					and "tool_call_id" is null and "uploader_id" is null
					and "message_id" is null and "position" is null
			end);--> statement-breakpoint
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
		WHERE connamespace = 'public'::regnamespace AND conname LIKE '%agent%'
			AND conname NOT LIKE '%user_agent%'
	LOOP
		EXECUTE format(
			'ALTER TABLE %s RENAME CONSTRAINT %I TO %I',
			found.on_table,
			found.name,
			replace(found.name, 'agent', 'bot')
		);
	END LOOP;
END $$;--> statement-breakpoint
-- The system bot that writes summaries is the Summariser now, where it still has its old name.
UPDATE "bot" SET "name" = 'Summariser', "handle" = 'summariser'
WHERE "system_bot_key" = 'summarise' AND "name" = 'Scribe' AND "handle" = 'scribe';--> statement-breakpoint
-- The folders a computer's disk was last measured with name each home's bot as `botId`.
UPDATE "computer" SET "disk_usage" = jsonb_set(
	"disk_usage",
	'{folders}',
	(
		SELECT jsonb_agg(
			CASE WHEN folder ? 'agentId'
				THEN (folder - 'agentId') || jsonb_build_object('botId', folder -> 'agentId')
				ELSE folder
			END ORDER BY position
		)
		FROM jsonb_array_elements("disk_usage" -> 'folders') WITH ORDINALITY AS listed(folder, position)
	)
)
WHERE jsonb_typeof("disk_usage" -> 'folders') = 'array' AND jsonb_array_length("disk_usage" -> 'folders') > 0;--> statement-breakpoint
-- The events kept for clients that reconnect name bots by the old word throughout
-- (their fields, kinds and types), and clients only read the new one. A client
-- whose last event is gone gets a reset and fetches everything again, so they go.
DELETE FROM "event";
