CREATE TABLE "agent_summary" (
	"agent_id" uuid PRIMARY KEY,
	"content" text NOT NULL,
	"covers_through" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_summary" ADD CONSTRAINT "agent_summary_agent_id_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agent"("id") ON DELETE CASCADE;