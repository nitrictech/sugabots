CREATE TABLE "thread_compaction" (
	"thread_id" uuid PRIMARY KEY,
	"summary" text NOT NULL,
	"history_starts_at" timestamp with time zone NOT NULL,
	"kept_from" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "message_content_search_idx" ON "message" USING gin (to_tsvector('english', "content")) WHERE "status" = 'complete';--> statement-breakpoint
ALTER TABLE "thread_compaction" ADD CONSTRAINT "thread_compaction_thread_id_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "thread"("id") ON DELETE CASCADE;--> statement-breakpoint
-- Every workspace gets the Compaction agent on the model its Scribe runs on, since the
-- Models page chooses one model for all the system agents.
INSERT INTO "agent" ("workspace_id", "name", "handle", "system_agent_key", "description", "color", "face", "model", "prompt", "created_by_id")
SELECT "workspace_id", 'Compaction', 'compaction', 'compact', 'Compacts long conversations so bots can keep reading them.', 'purple', 'square', "model", 'Summarize what a bot needs to carry on the conversation. Do not invent details.', "created_by_id"
FROM "agent"
WHERE "system_agent_key" = 'summarise'
ON CONFLICT ("workspace_id", "system_agent_key") DO NOTHING;--> statement-breakpoint
-- Drizzle does not manage extensions. pg_trgm is a trusted extension, so the
-- database owner can create it without being a superuser.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE INDEX "message_content_simple_search_idx" ON "message" USING gin (to_tsvector('simple', "content")) WHERE "status" = 'complete';--> statement-breakpoint
CREATE INDEX "message_content_trigram_idx" ON "message" USING gin ("content" gin_trgm_ops) WHERE "status" = 'complete';
