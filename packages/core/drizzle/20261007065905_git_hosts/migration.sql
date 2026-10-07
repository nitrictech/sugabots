CREATE TABLE "git_host" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"account" text,
	"credential_encrypted" text NOT NULL,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "git_host_kind_check" CHECK ("kind" in ('github'))
);
--> statement-breakpoint
CREATE TABLE "pod_repository" (
	"workspace_id" uuid NOT NULL,
	"pod_id" uuid,
	"git_host_id" uuid,
	"repository" text,
	"added_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pod_repository_pkey" PRIMARY KEY("pod_id","git_host_id","repository")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "git_host_id_workspace_id_idx" ON "git_host" ("id","workspace_id");--> statement-breakpoint
ALTER TABLE "git_host" ADD CONSTRAINT "git_host_workspace_id_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "git_host" ADD CONSTRAINT "git_host_created_by_id_user_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "pod_repository" ADD CONSTRAINT "pod_repository_added_by_id_user_id_fkey" FOREIGN KEY ("added_by_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "pod_repository" ADD CONSTRAINT "pod_repository_pod_workspace_fkey" FOREIGN KEY ("pod_id","workspace_id") REFERENCES "pod"("id","workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "pod_repository" ADD CONSTRAINT "pod_repository_git_host_workspace_fkey" FOREIGN KEY ("git_host_id","workspace_id") REFERENCES "git_host"("id","workspace_id") ON DELETE CASCADE;