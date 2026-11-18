ALTER TABLE "connection" DROP CONSTRAINT "connection_pod_workspace_fkey";--> statement-breakpoint
ALTER TABLE "sandbox" DROP CONSTRAINT "sandbox_pod_workspace_fkey";--> statement-breakpoint
ALTER TABLE "routine" DROP CONSTRAINT "routine_chat_id_thread_id_fkey";--> statement-breakpoint
DROP TABLE "sandbox_pod_allowed_host";--> statement-breakpoint
ALTER TABLE "routine" DROP CONSTRAINT "routine_results_valid";--> statement-breakpoint
ALTER TABLE "routine_execution" DROP CONSTRAINT "routine_execution_results_valid";--> statement-breakpoint
DROP INDEX "sandbox_pod_id_idx";--> statement-breakpoint
ALTER TABLE "connection" DROP COLUMN "pod_id";--> statement-breakpoint
ALTER TABLE "routine" DROP COLUMN "results";--> statement-breakpoint
ALTER TABLE "routine" DROP COLUMN "chat_id";--> statement-breakpoint
ALTER TABLE "routine_execution" DROP COLUMN "results";--> statement-breakpoint
ALTER TABLE "sandbox" DROP COLUMN "pod_id";--> statement-breakpoint
ALTER TABLE "connection" ALTER COLUMN "agent_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "sandbox" ALTER COLUMN "agent_id" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "connection_name_idx" ON "connection" ("agent_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "connection_handle_idx" ON "connection" ("agent_id","handle");--> statement-breakpoint
CREATE UNIQUE INDEX "connection_github_agent_idx" ON "connection" ("agent_id") WHERE "kind" = 'github';--> statement-breakpoint
CREATE UNIQUE INDEX "sandbox_agent_id_idx" ON "sandbox" ("agent_id");--> statement-breakpoint
ALTER TABLE "connection" ADD CONSTRAINT "connection_agent_workspace_fkey" FOREIGN KEY ("agent_id","workspace_id") REFERENCES "agent"("id","workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sandbox" ADD CONSTRAINT "sandbox_agent_workspace_fkey" FOREIGN KEY ("agent_id","workspace_id") REFERENCES "agent"("id","workspace_id") ON DELETE CASCADE;