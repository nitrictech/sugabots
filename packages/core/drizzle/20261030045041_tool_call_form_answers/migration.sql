CREATE TABLE "tool_call_form_answer" (
	"tool_call_id" uuid PRIMARY KEY,
	"answer" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tool_call_form_answer" ADD CONSTRAINT "tool_call_form_answer_tool_call_id_tool_call_id_fkey" FOREIGN KEY ("tool_call_id") REFERENCES "tool_call"("id") ON DELETE CASCADE;