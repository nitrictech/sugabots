CREATE TABLE "github_uninstall" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"workspace_id" uuid NOT NULL,
	"connector_id" uuid NOT NULL,
	"app_id" bigint NOT NULL,
	"installation_id" bigint NOT NULL,
	"app_credential_encrypted" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "automation" ADD COLUMN "pause_after_failures_pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "automation_pending_pause_idx" ON "automation" ("id") WHERE "pause_after_failures_pending";--> statement-breakpoint
CREATE INDEX "github_uninstall_due_idx" ON "github_uninstall" ("next_attempt_at","id");