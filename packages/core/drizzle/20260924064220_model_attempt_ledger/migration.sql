CREATE TABLE "model_attempt" (
	"attempt_id" text PRIMARY KEY,
	"execution_id" text NOT NULL,
	"retry_of_attempt_id" text,
	"workspace_id" uuid NOT NULL,
	"activity" text,
	"pod_id" uuid,
	"agent_id" uuid,
	"thread_id" uuid,
	"connection_id" text NOT NULL,
	"provider" text NOT NULL,
	"requested_model" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"intent" jsonb NOT NULL,
	"dispatch" jsonb,
	"pricing_snapshot" jsonb,
	"cost_estimate" jsonb,
	"estimated_cost" numeric(18,10),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_attempt_observation" (
	"observation_id" text PRIMARY KEY,
	"attempt_id" text NOT NULL,
	"type" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"supersedes_observation_id" text,
	"observation" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "model_attempt_workspace_started_at_idx" ON "model_attempt" ("workspace_id","started_at");--> statement-breakpoint
CREATE INDEX "model_attempt_thread_idx" ON "model_attempt" ("thread_id") WHERE "thread_id" is not null;--> statement-breakpoint
CREATE INDEX "model_attempt_execution_idx" ON "model_attempt" ("execution_id");--> statement-breakpoint
CREATE INDEX "model_attempt_observation_attempt_idx" ON "model_attempt_observation" ("attempt_id","type");--> statement-breakpoint
ALTER TABLE "model_attempt_observation" ADD CONSTRAINT "model_attempt_observation_attempt_fk" FOREIGN KEY ("attempt_id") REFERENCES "model_attempt"("attempt_id");