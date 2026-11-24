-- Columns named by the glossary: compacted history is a condensed account, a
-- turn is interrupted, its workflow is its execution, and a bot has instructions.
ALTER TABLE "compaction" RENAME COLUMN "summary" TO "condensed";--> statement-breakpoint
ALTER TABLE "turn" RENAME COLUMN "owner" TO "execution_id";--> statement-breakpoint
ALTER TABLE "turn" RENAME COLUMN "cancel_requested" TO "interrupt_requested";--> statement-breakpoint
ALTER TABLE "bot" RENAME COLUMN "prompt" TO "instructions";--> statement-breakpoint
ALTER TABLE "message" DROP COLUMN "kind";--> statement-breakpoint
ALTER TABLE "workspace" DROP COLUMN "logo";--> statement-breakpoint
DROP INDEX "message_run_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "message_run_idx" ON "message" ("run_id") WHERE "run_id" is not null;--> statement-breakpoint
ALTER TABLE "model_request" ADD CONSTRAINT "model_request_bot_valid" CHECK (("purpose" = 'bot-turn') = ("bot_id" is not null));--> statement-breakpoint
ALTER TABLE "turn" ADD CONSTRAINT "turn_failure_has_error" CHECK ("status" <> 'failed' or "error" is not null);--> statement-breakpoint
ALTER TABLE "run" DROP CONSTRAINT "run_pending_terminal_valid", ADD CONSTRAINT "run_pending_terminal_valid" CHECK (("pending_terminal_state" is null and "pending_terminal_error" is null)
				or ("state" = 'running' and "pending_terminal_state" = 'cancelled' and "pending_terminal_error" is null)
				or ("state" = 'running' and "pending_terminal_state" = 'failed' and "pending_terminal_error" is not null));--> statement-breakpoint
-- A written Markdown file's kind is `markdown`, and a person's file is an
-- `attachment`. The versions' key carries the kind and has no ON UPDATE, so it
-- is dropped while the rows move, and their checks are made again.
ALTER TABLE "file_version" DROP CONSTRAINT "file_version_file_fkey";--> statement-breakpoint
ALTER TABLE "file_version" DROP CONSTRAINT "file_version_file_kind_valid";--> statement-breakpoint
ALTER TABLE "file" DROP CONSTRAINT "file_kind_valid";--> statement-breakpoint
ALTER TABLE "file" DROP CONSTRAINT "file_source_valid";--> statement-breakpoint
UPDATE "file" SET "kind" = 'markdown' WHERE "kind" = 'document';--> statement-breakpoint
UPDATE "file" SET "kind" = 'attachment' WHERE "kind" = 'upload';--> statement-breakpoint
UPDATE "file_version" SET "file_kind" = 'markdown' WHERE "file_kind" = 'document';--> statement-breakpoint
ALTER TABLE "file" ADD CONSTRAINT "file_kind_valid" CHECK ("kind" in ('markdown', 'html', 'attachment', 'bot_attachment', 'tool_result'));--> statement-breakpoint
ALTER TABLE "file" ADD CONSTRAINT "file_source_valid" CHECK (case "kind"
				when 'attachment' then "name" is not null and "content_type" is not null
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
ALTER TABLE "file_version" ADD CONSTRAINT "file_version_file_kind_valid" CHECK ("file_kind" in ('markdown', 'html'));--> statement-breakpoint
ALTER TABLE "file_version" ADD CONSTRAINT "file_version_file_fkey" FOREIGN KEY ("file_id","file_kind") REFERENCES "file"("id","kind") ON DELETE CASCADE;--> statement-breakpoint
-- The blob deletion names the written kinds in its body, so it is made again.
CREATE OR REPLACE FUNCTION queue_deleted_file_blobs() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	INSERT INTO "blob_deletion" ("prefix")
	SELECT 'files/' || "id"::text FROM deleted_files WHERE "kind" IN ('markdown', 'html');
	RETURN NULL;
END;
$$;