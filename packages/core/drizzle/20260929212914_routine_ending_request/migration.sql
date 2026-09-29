CREATE TABLE "routine_ending_request" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"execution_id" uuid NOT NULL,
	"state" text NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "routine_ending_request_execution_idx" ON "routine_ending_request" ("execution_id");--> statement-breakpoint
ALTER TABLE "routine_ending_request" ADD CONSTRAINT "routine_ending_request_execution_id_routine_execution_id_fkey" FOREIGN KEY ("execution_id") REFERENCES "routine_execution"("id") ON DELETE CASCADE;