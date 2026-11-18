CREATE TABLE "file" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"thread_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text,
	"content_type" text,
	"size" integer,
	"tool_call_id" uuid,
	"uploader_id" uuid,
	"message_id" uuid,
	"position" integer,
	"created_by_agent_id" uuid,
	"current_version" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "file_kind_valid" CHECK ("kind" in ('document', 'html', 'upload', 'agent_attachment', 'tool_result')),
	CONSTRAINT "file_source_valid" CHECK (case "kind"
				when 'upload' then "name" is not null and "content_type" is not null
					and "size" is not null and "tool_call_id" is null
					and ("message_id" is null) = ("position" is null)
					and "created_by_agent_id" is null and "current_version" is null
				when 'agent_attachment' then "name" is not null and "content_type" is not null
					and "size" is not null and "tool_call_id" is null
					and "uploader_id" is null and "message_id" is not null
					and "position" is not null
					and "created_by_agent_id" is null and "current_version" is null
				when 'tool_result' then "name" is null and "content_type" is not null
					and "size" is not null and "uploader_id" is null
					and "message_id" is null and "position" is null
					and "created_by_agent_id" is null and "current_version" is null
				else "name" is not null and "current_version" is not null
					and "content_type" is null and "size" is null
					and "tool_call_id" is null and "uploader_id" is null
					and "message_id" is null and "position" is null
			end)
);
--> statement-breakpoint
CREATE TABLE "file_version" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"file_id" uuid NOT NULL,
	"file_kind" text NOT NULL,
	"number" integer NOT NULL,
	"content_type" text NOT NULL,
	"size" integer NOT NULL,
	"author_agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "file_version_file_kind_valid" CHECK ("file_kind" in ('document', 'html'))
);
--> statement-breakpoint
CREATE INDEX "file_thread_updated_at_idx" ON "file" ("thread_id","updated_at");--> statement-breakpoint
CREATE INDEX "file_message_idx" ON "file" ("message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "file_id_kind_idx" ON "file" ("id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "file_version_number_idx" ON "file_version" ("file_id","number");--> statement-breakpoint
ALTER TABLE "file" ADD CONSTRAINT "file_thread_id_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "thread"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "file" ADD CONSTRAINT "file_tool_call_id_tool_call_id_fkey" FOREIGN KEY ("tool_call_id") REFERENCES "tool_call"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "file" ADD CONSTRAINT "file_uploader_id_user_id_fkey" FOREIGN KEY ("uploader_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "file" ADD CONSTRAINT "file_message_id_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "message"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "file" ADD CONSTRAINT "file_created_by_agent_id_agent_id_fkey" FOREIGN KEY ("created_by_agent_id") REFERENCES "agent"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "file_version" ADD CONSTRAINT "file_version_author_agent_id_agent_id_fkey" FOREIGN KEY ("author_agent_id") REFERENCES "agent"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "file_version" ADD CONSTRAINT "file_version_file_fkey" FOREIGN KEY ("file_id","file_kind") REFERENCES "file"("id","kind") ON DELETE CASCADE;--> statement-breakpoint
-- The files kept whole in a conversation move across as they are: tool
-- results, uploads and bots' attachments, under the same ids, so their blobs,
-- kept by id under their conversation's folder, are still theirs. A file on a
-- message was last changed when the message was sent.
INSERT INTO "file" ("id", "thread_id", "kind", "name", "content_type", "size", "tool_call_id", "uploader_id", "message_id", "position", "created_at", "updated_at")
SELECT "thread_file"."id", "thread_file"."thread_id", "thread_file"."kind", "thread_file"."name",
	"thread_file"."content_type", "thread_file"."size", "thread_file"."tool_call_id", "thread_file"."uploader_id",
	"thread_file"."message_id", "thread_file"."position", "thread_file"."created_at",
	greatest("thread_file"."created_at", coalesce("message"."created_at", "thread_file"."created_at"))
FROM "thread_file" LEFT JOIN "message" ON "message"."id" = "thread_file"."message_id";--> statement-breakpoint
-- The files bots wrote move across under the same ids, so their versions'
-- blobs, under `artifacts/<id>`, are still theirs; the title is the name.
INSERT INTO "file" ("id", "thread_id", "kind", "name", "created_by_agent_id", "current_version", "created_at", "updated_at")
SELECT "id", "created_in_thread_id", "kind", "title", "created_by_agent_id", "current_version", "created_at", "updated_at"
FROM "artifact";--> statement-breakpoint
INSERT INTO "file_version" ("id", "file_id", "file_kind", "number", "content_type", "size", "author_agent_id", "created_at")
SELECT "artifact_version"."id", "artifact_version"."artifact_id", "artifact"."kind", "artifact_version"."number",
	"artifact_version"."content_type", "artifact_version"."size", "artifact_version"."author_agent_id", "artifact_version"."created_at"
FROM "artifact_version" JOIN "artifact" ON "artifact"."id" = "artifact_version"."artifact_id";--> statement-breakpoint
-- Dropping a table deletes no rows, so no blob is queued here: every blob now belongs to a `file`.
DROP TABLE "artifact_version";--> statement-breakpoint
DROP TABLE "artifact";--> statement-breakpoint
DROP TABLE "thread_file";--> statement-breakpoint
DROP FUNCTION queue_deleted_artifact_blobs();--> statement-breakpoint

-- A file is deleted by its conversation's cascade as well as directly, and only the database sees every route. Queues a written file's blob folder, which keeps the name it was first stored under, `artifacts/<id>` (see `files.ts`), once per statement however many files it deleted. Any other file's blob is in its conversation's folder, which its own code removes.
CREATE FUNCTION queue_deleted_file_blobs() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	INSERT INTO "blob_deletion" ("prefix")
	SELECT 'artifacts/' || "id"::text FROM deleted_files WHERE "kind" IN ('document', 'html');
	RETURN NULL;
END;
$$;--> statement-breakpoint

CREATE TRIGGER file_blob_deletion
AFTER DELETE ON "file"
REFERENCING OLD TABLE AS deleted_files
FOR EACH STATEMENT EXECUTE FUNCTION queue_deleted_file_blobs();--> statement-breakpoint

-- A written file an automation run's posted result shows is now a part of type `written_file`, naming its `fileId`.
UPDATE "message" SET "parts" = (
	SELECT jsonb_agg(
		CASE WHEN part->>'type' = 'artifact'
			THEN (part - 'type' - 'artifactId') || jsonb_build_object('type', 'written_file', 'fileId', part->'artifactId')
			ELSE part
		END
		ORDER BY position
	)
	FROM jsonb_array_elements("parts") WITH ORDINALITY AS listed(part, position)
) WHERE "parts" @> '[{"type": "artifact"}]';--> statement-breakpoint
-- The file tools are now `file_list`, `file_read`, `file_write` and `file_edit`,
-- taking and giving `fileId`, and listing `files`. Their recorded calls follow,
-- as a reply's file cards and an automation's posted result are read from them.
UPDATE "tool_call" SET
	"tool" = 'file_' || substring("tool" from 10),
	"input" = replace("input"::text, '"artifactId"', '"fileId"')::jsonb,
	"execution_input" = replace("execution_input"::text, '"artifactId"', '"fileId"')::jsonb,
	"output" = replace(replace("output"::text, '"artifactId"', '"fileId"'), '"artifacts"', '"files"')::jsonb
WHERE "tool" IN ('artifact_list', 'artifact_read', 'artifact_write', 'artifact_edit');--> statement-breakpoint
-- The file tools a bot has switched off, by their new names.
UPDATE "agent" SET "disabled_tools" = (
	SELECT jsonb_agg(
		CASE WHEN tool IN ('artifact_list', 'artifact_read', 'artifact_write', 'artifact_edit')
			THEN 'file_' || substring(tool from 10)
			ELSE tool
		END
		ORDER BY position
	)
	FROM jsonb_array_elements_text("disabled_tools") WITH ORDINALITY AS listed(tool, position)
) WHERE "disabled_tools" ?| array['artifact_list', 'artifact_read', 'artifact_write', 'artifact_edit'];
