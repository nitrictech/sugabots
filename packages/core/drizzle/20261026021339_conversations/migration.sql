ALTER TABLE "thread" ADD COLUMN "conversation_id" uuid;--> statement-breakpoint
-- A chat's main thread becomes the conversation, and every thread that was in the chat is in it.
UPDATE "thread" SET "conversation_id" = "chat"."main_thread_id" FROM "chat" WHERE "thread"."chat_id" = "chat"."id";--> statement-breakpoint
ALTER TABLE "thread" DROP CONSTRAINT "thread_type_valid";--> statement-breakpoint
UPDATE "thread" SET "type" = 'conversation', "title" = 'Conversation with ' || "agent"."name" FROM "agent" WHERE "thread"."type" = 'chat' AND "agent"."id" = "thread"."host_agent_id";--> statement-breakpoint
ALTER TABLE "thread" ADD CONSTRAINT "thread_type_valid" CHECK ("type" in ('conversation', 'collaboration', 'routine', 'system_agent'));--> statement-breakpoint
ALTER TABLE "thread" DROP CONSTRAINT "thread_chat_id_chat_id_fkey";--> statement-breakpoint
DROP TABLE "chat";--> statement-breakpoint
DROP INDEX "thread_chat_updated_at_idx";--> statement-breakpoint
ALTER TABLE "thread" DROP COLUMN "chat_id";--> statement-breakpoint
CREATE INDEX "thread_conversation_updated_at_idx" ON "thread" ("conversation_id","updated_at");--> statement-breakpoint
ALTER TABLE "thread" ADD CONSTRAINT "thread_conversation_id_thread_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "thread"("id") ON DELETE CASCADE;--> statement-breakpoint
-- Clients read these as hints to refetch; the ones kept name chats that are gone.
DELETE FROM "event" WHERE "type" = 'chat.thread_changed';
