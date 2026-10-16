-- Edited by hand, keep when regenerating: `kind` has no default in the schema,
-- so drizzle-kit writes this column without one, which fails on a table that
-- already has rows. The DEFAULT here fills in the rows already there, all tool
-- results, and the last statement drops it again.
ALTER TABLE "thread_file" ADD COLUMN "kind" text DEFAULT 'tool_result' NOT NULL;--> statement-breakpoint
ALTER TABLE "thread_file" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "thread_file" ADD COLUMN "uploader_id" uuid;--> statement-breakpoint
ALTER TABLE "thread_file" ADD COLUMN "message_id" uuid;--> statement-breakpoint
ALTER TABLE "thread_file" ADD COLUMN "position" integer;--> statement-breakpoint
CREATE INDEX "thread_file_message_idx" ON "thread_file" ("message_id");--> statement-breakpoint
ALTER TABLE "thread_file" ADD CONSTRAINT "thread_file_uploader_id_user_id_fkey" FOREIGN KEY ("uploader_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "thread_file" ADD CONSTRAINT "thread_file_message_id_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "message"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "thread_file" ADD CONSTRAINT "thread_file_kind_valid" CHECK ("kind" in ('tool_result', 'upload', 'agent_attachment'));--> statement-breakpoint
ALTER TABLE "thread_file" ADD CONSTRAINT "thread_file_source_valid" CHECK (case "kind"
				when 'upload' then "name" is not null and "tool_call_id" is null
					and ("message_id" is null) = ("position" is null)
				when 'agent_attachment' then "name" is not null and "tool_call_id" is null
					and "uploader_id" is null and "message_id" is not null
					and "position" is not null
				else "name" is null and "uploader_id" is null and "message_id" is null
					and "position" is null
			end);--> statement-breakpoint
-- Edited by hand, keep when regenerating: drops the DEFAULT the first statement
-- added to fill in existing rows, so every new row says its kind.
ALTER TABLE "thread_file" ALTER COLUMN "kind" DROP DEFAULT;