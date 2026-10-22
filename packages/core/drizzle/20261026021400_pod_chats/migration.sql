ALTER TABLE "routine" ADD COLUMN "chat_id" uuid;--> statement-breakpoint
ALTER TABLE "thread" ADD COLUMN "main" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "thread" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
-- Each pod had one chat, which becomes its first, called General until somebody renames it.
UPDATE "thread" SET "main" = true, "title" = 'General' WHERE "type" = 'pod_chat';--> statement-breakpoint
DROP INDEX "thread_pod_chat_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "thread_pod_chat_idx" ON "thread" ("pod_id") WHERE "main";--> statement-breakpoint
ALTER TABLE "routine" ADD CONSTRAINT "routine_chat_id_thread_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "thread"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "thread" ADD CONSTRAINT "thread_main_valid" CHECK (not "main" or "type" = 'pod_chat');--> statement-breakpoint
ALTER TABLE "thread" ADD CONSTRAINT "thread_archived_valid" CHECK ("archived_at" is null or ("type" = 'pod_chat' and not "main"));