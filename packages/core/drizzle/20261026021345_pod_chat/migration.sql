ALTER TABLE "thread" ADD COLUMN "origin_message_id" uuid;--> statement-breakpoint
ALTER TABLE "thread" ADD COLUMN "done_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "thread" ALTER COLUMN "host_agent_id" DROP NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "thread_origin_message_idx" ON "thread" ("origin_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "thread_pod_chat_idx" ON "thread" ("pod_id") WHERE "type" = 'pod_chat';--> statement-breakpoint
ALTER TABLE "thread" ADD CONSTRAINT "thread_origin_message_id_message_id_fkey" FOREIGN KEY ("origin_message_id") REFERENCES "message"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "thread" ADD CONSTRAINT "thread_host_valid" CHECK (case "type" when 'pod_chat' then "host_agent_id" is null when 'conversation' then true else "host_agent_id" is not null end);--> statement-breakpoint
ALTER TABLE "thread" DROP CONSTRAINT "thread_type_valid", ADD CONSTRAINT "thread_type_valid" CHECK ("type" in ('conversation', 'pod_chat', 'collaboration', 'routine', 'system_agent'));