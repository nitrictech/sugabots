ALTER TABLE "message" ADD COLUMN "retry_key" uuid;--> statement-breakpoint
ALTER TABLE "project_chat" ADD COLUMN "start_retry_key" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "message_retry_idx" ON "message" ("chat_id","author_member_id","retry_key") WHERE "retry_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "project_chat_start_retry_idx" ON "project_chat" ("project_id","started_by_id","start_retry_key") WHERE "start_retry_key" is not null;