CREATE TABLE "blob_deletion" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"prefix" text NOT NULL,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "thread_file" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"thread_id" uuid NOT NULL,
	"tool_call_id" uuid,
	"content_type" text NOT NULL,
	"size" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "thread_file_thread_idx" ON "thread_file" ("thread_id");--> statement-breakpoint
ALTER TABLE "thread_file" ADD CONSTRAINT "thread_file_thread_id_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "thread"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "thread_file" ADD CONSTRAINT "thread_file_tool_call_id_tool_call_id_fkey" FOREIGN KEY ("tool_call_id") REFERENCES "tool_call"("id") ON DELETE SET NULL;--> statement-breakpoint

-- A thread is deleted by its workspace's, pod's or host agent's cascade as well as directly, and only the database sees every route. Queues the thread's blob folder, `threads/<id>` (see `thread-files.ts`), once per statement however many threads it deleted.
CREATE FUNCTION queue_deleted_thread_blobs() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	INSERT INTO "blob_deletion" ("prefix")
	SELECT 'threads/' || "id"::text FROM deleted_threads;
	RETURN NULL;
END;
$$;--> statement-breakpoint

CREATE TRIGGER thread_blob_deletion
AFTER DELETE ON "thread"
REFERENCING OLD TABLE AS deleted_threads
FOR EACH STATEMENT EXECUTE FUNCTION queue_deleted_thread_blobs();
