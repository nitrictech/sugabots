CREATE INDEX "thread_participant_thread_idx" ON "thread_participant" ("thread_id");--> statement-breakpoint
CREATE INDEX "thread_read_thread_idx" ON "thread_read" ("thread_id");--> statement-breakpoint
CREATE INDEX "tool_call_thread_approval_status_idx" ON "tool_call" ("thread_id","approval_status");