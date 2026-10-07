ALTER TABLE "message" ADD COLUMN "routine_execution_id" uuid;--> statement-breakpoint
ALTER TABLE "routine" ADD COLUMN "results" text DEFAULT 'keep_in_run' NOT NULL;--> statement-breakpoint
ALTER TABLE "routine_execution" ADD COLUMN "results" text DEFAULT 'keep_in_run' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "message_routine_execution_idx" ON "message" ("routine_execution_id") WHERE "routine_execution_id" is not null;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_routine_execution_id_routine_execution_id_fkey" FOREIGN KEY ("routine_execution_id") REFERENCES "routine_execution"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "routine" ADD CONSTRAINT "routine_results_valid" CHECK ("results" in ('keep_in_run', 'post_to_chat'));--> statement-breakpoint
ALTER TABLE "routine_execution" ADD CONSTRAINT "routine_execution_results_valid" CHECK ("results" in ('keep_in_run', 'post_to_chat'));