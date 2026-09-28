CREATE TABLE "model_request" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"workspace_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"pod_id" uuid,
	"agent_id" uuid,
	"thread_id" uuid,
	"turn_id" uuid,
	"step" integer NOT NULL,
	"provider_id" uuid NOT NULL,
	"preset" text,
	"model" text NOT NULL,
	"outcome" text NOT NULL,
	"input_tokens" integer,
	"cache_read_tokens" integer,
	"cache_write_tokens" integer,
	"output_tokens" integer,
	"reasoning_tokens" integer,
	"cost_usd" numeric(18,10),
	"cost_source" text,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "model_request_purpose_valid" CHECK ("purpose" in ('agent-turn', 'facilitation', 'summary', 'compaction', 'trial', 'probe')),
	CONSTRAINT "model_request_outcome_valid" CHECK ("outcome" in ('started', 'completed', 'failed', 'aborted')),
	CONSTRAINT "model_request_ended_valid" CHECK (("outcome" = 'started') = ("ended_at" is null)),
	CONSTRAINT "model_request_cost_valid" CHECK (("cost_usd" is null) = ("cost_source" is null) and ("cost_usd" is null or "cost_usd" >= 0))
);
--> statement-breakpoint
CREATE INDEX "model_request_workspace_started_at_idx" ON "model_request" ("workspace_id","started_at");--> statement-breakpoint
CREATE INDEX "model_request_thread_idx" ON "model_request" ("thread_id") WHERE "thread_id" is not null;