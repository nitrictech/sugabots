CREATE TABLE "tool_call_form" (
	"tool_call_id" uuid PRIMARY KEY,
	"request" json NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_call_form_response" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"tool_call_id" uuid NOT NULL,
	"responder_id" uuid,
	"answer" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "tool_call_form_response_form_idx" ON "tool_call_form_response" ("tool_call_id");--> statement-breakpoint
ALTER TABLE "tool_call_form" ADD CONSTRAINT "tool_call_form_tool_call_id_tool_call_id_fkey" FOREIGN KEY ("tool_call_id") REFERENCES "tool_call"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tool_call_form_response" ADD CONSTRAINT "tool_call_form_response_YXXoQW5UmNp1_fkey" FOREIGN KEY ("tool_call_id") REFERENCES "tool_call_form"("tool_call_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tool_call_form_response" ADD CONSTRAINT "tool_call_form_response_responder_id_user_id_fkey" FOREIGN KEY ("responder_id") REFERENCES "user"("id") ON DELETE SET NULL;