CREATE TABLE "github_connection" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"workspace_id" uuid NOT NULL,
	"method" text NOT NULL,
	"api_base_url" text NOT NULL,
	"git_host" text NOT NULL,
	"token_encrypted" text NOT NULL,
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
CREATE UNIQUE INDEX "github_connection_workspace_idx" ON "github_connection" ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pod_repository_pod_name_idx" ON "pod_repository" ("pod_id","full_name");--> statement-breakpoint
ALTER TABLE "github_connection" ADD CONSTRAINT "github_connection_workspace_id_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "github_connection" ADD CONSTRAINT "github_connection_created_by_id_user_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "pod_repository" ADD CONSTRAINT "pod_repository_created_by_id_user_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "pod_repository" ADD CONSTRAINT "pod_repository_pod_workspace_fkey" FOREIGN KEY ("pod_id","workspace_id") REFERENCES "pod"("id","workspace_id") ON DELETE CASCADE;