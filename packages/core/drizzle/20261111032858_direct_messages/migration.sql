CREATE TABLE "direct_member" (
	"thread_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "thread" ADD COLUMN "direct_key" text;--> statement-breakpoint
ALTER TABLE "thread" ALTER COLUMN "pod_id" DROP NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "direct_member_thread_user_idx" ON "direct_member" ("thread_id","user_id");--> statement-breakpoint
CREATE INDEX "direct_member_user_idx" ON "direct_member" ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "thread_direct_key_idx" ON "thread" ("workspace_id","direct_key") WHERE "type" = 'direct';--> statement-breakpoint
ALTER TABLE "direct_member" ADD CONSTRAINT "direct_member_thread_id_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "thread"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "direct_member" ADD CONSTRAINT "direct_member_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "thread" ADD CONSTRAINT "thread_direct_valid" CHECK (case when "type" = 'direct' then "pod_id" is null and "direct_key" is not null else "pod_id" is not null and "direct_key" is null end);--> statement-breakpoint
ALTER TABLE "thread" DROP CONSTRAINT "thread_type_valid", ADD CONSTRAINT "thread_type_valid" CHECK ("type" in ('conversation', 'pod_chat', 'bot_channel', 'collaboration', 'routine', 'routine_feed', 'system_agent', 'direct'));--> statement-breakpoint
ALTER TABLE "thread" DROP CONSTRAINT "thread_host_valid", ADD CONSTRAINT "thread_host_valid" CHECK (case "type" when 'pod_chat' then "host_agent_id" is null when 'direct' then "host_agent_id" is null when 'conversation' then true else "host_agent_id" is not null end);