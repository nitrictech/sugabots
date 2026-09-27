CREATE TABLE "workflow_outbox" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"kind" text NOT NULL,
	"workflow" text NOT NULL,
	"execution_id" text NOT NULL,
	"deferred" text,
	"exit" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_outbox_kind_check" CHECK ("kind" in ('signal', 'interrupt')),
	CONSTRAINT "workflow_outbox_signal_check" CHECK (("kind" = 'signal') = ("deferred" is not null and "exit" is not null))
);
--> statement-breakpoint
CREATE INDEX "workflow_outbox_age_idx" ON "workflow_outbox" ("created_at");