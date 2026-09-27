CREATE TABLE "github_connection" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"workspace_id" uuid NOT NULL,
	"method" text NOT NULL,
	"api_base_url" text NOT NULL,
	"git_host" text NOT NULL,
	"token_encrypted" text,
	"app_id" text,
	"app_slug" text,
	"app_private_key_encrypted" text,
	"app_installation_id" text,
	"account_login" text,
	"last_tested_at" timestamp with time zone,
	"last_test_error" text,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pod_repository" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"workspace_id" uuid NOT NULL,
	"pod_id" uuid NOT NULL,
	"full_name" text NOT NULL,
	"default_branch" text NOT NULL,
	"private" boolean NOT NULL,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sandbox_provider" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"workspace_id" uuid NOT NULL,
	"preset" text NOT NULL,
	"base_url" text NOT NULL,
	"api_key_encrypted" text,
	"image" text NOT NULL,
	"isolation" text NOT NULL,
	"allowed_hosts" jsonb NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"last_tested_at" timestamp with time zone,
	"last_test_error" text,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pod_sandbox" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"workspace_id" uuid NOT NULL,
	"pod_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_sandbox_id" text NOT NULL,
	"status" text NOT NULL,
	"isolation" text NOT NULL,
	"last_lease_ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sandbox_lease" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"pod_sandbox_id" uuid NOT NULL,
	"turn_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tool_call" ADD COLUMN "approval_summary" jsonb;--> statement-breakpoint
ALTER TABLE "agent" ADD COLUMN "sandbox_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "github_connection_workspace_idx" ON "github_connection" ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pod_repository_pod_name_idx" ON "pod_repository" ("pod_id","full_name");--> statement-breakpoint
CREATE UNIQUE INDEX "sandbox_provider_workspace_idx" ON "sandbox_provider" ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pod_sandbox_pod_idx" ON "pod_sandbox" ("pod_id");--> statement-breakpoint
CREATE INDEX "sandbox_lease_pod_sandbox_idx" ON "sandbox_lease" ("pod_sandbox_id","expires_at");--> statement-breakpoint
ALTER TABLE "github_connection" ADD CONSTRAINT "github_connection_workspace_id_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "github_connection" ADD CONSTRAINT "github_connection_created_by_id_user_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "pod_repository" ADD CONSTRAINT "pod_repository_created_by_id_user_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "pod_repository" ADD CONSTRAINT "pod_repository_pod_workspace_fkey" FOREIGN KEY ("pod_id","workspace_id") REFERENCES "pod"("id","workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sandbox_provider" ADD CONSTRAINT "sandbox_provider_workspace_id_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sandbox_provider" ADD CONSTRAINT "sandbox_provider_created_by_id_user_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "pod_sandbox" ADD CONSTRAINT "pod_sandbox_pod_workspace_fkey" FOREIGN KEY ("pod_id","workspace_id") REFERENCES "pod"("id","workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sandbox_lease" ADD CONSTRAINT "sandbox_lease_pod_sandbox_id_pod_sandbox_id_fkey" FOREIGN KEY ("pod_sandbox_id") REFERENCES "pod_sandbox"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sandbox_lease" ADD CONSTRAINT "sandbox_lease_turn_id_turn_id_fkey" FOREIGN KEY ("turn_id") REFERENCES "turn"("id") ON DELETE CASCADE;