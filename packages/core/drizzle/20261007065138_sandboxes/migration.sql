CREATE TABLE "sandbox" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"workspace_id" uuid NOT NULL,
	"pod_id" uuid NOT NULL,
	"sandbox_provider_id" uuid NOT NULL,
	"provider_sandbox_id" text NOT NULL,
	"paused_at" timestamp with time zone,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sandbox_allowed_host" (
	"workspace_id" uuid,
	"host" text,
	"added_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sandbox_allowed_host_pkey" PRIMARY KEY("workspace_id","host")
);
--> statement-breakpoint
CREATE TABLE "sandbox_blocked_host" (
	"workspace_id" uuid,
	"host" text,
	"blocked_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sandbox_blocked_host_pkey" PRIMARY KEY("workspace_id","host")
);
--> statement-breakpoint
CREATE TABLE "sandbox_lease" (
	"sandbox_id" uuid,
	"holder_kind" text,
	"holder_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "sandbox_lease_pkey" PRIMARY KEY("sandbox_id","holder_kind","holder_id"),
	CONSTRAINT "sandbox_lease_holder_kind_check" CHECK ("holder_kind" in ('turn', 'viewer'))
);
--> statement-breakpoint
CREATE TABLE "sandbox_pod_allowed_host" (
	"workspace_id" uuid NOT NULL,
	"pod_id" uuid,
	"host" text,
	"added_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sandbox_pod_allowed_host_pkey" PRIMARY KEY("pod_id","host")
);
--> statement-breakpoint
CREATE TABLE "sandbox_provider" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"workspace_id" uuid NOT NULL,
	"preset" text GENERATED ALWAYS AS (settings->>'preset') STORED NOT NULL,
	"settings" jsonb NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"api_key_encrypted" text,
	"managed_resources" jsonb,
	"last_tested_at" timestamp with time zone,
	"last_test_error" text,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sandbox_provider_preset_check" CHECK ("preset" in ('opensandbox', 'e2b'))
);
--> statement-breakpoint
ALTER TABLE "agent" ADD COLUMN "uses_sandbox" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "sandbox_pod_id_idx" ON "sandbox" ("pod_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sandbox_provider_enabled_idx" ON "sandbox_provider" ("workspace_id") WHERE "enabled";--> statement-breakpoint
CREATE UNIQUE INDEX "sandbox_provider_id_workspace_id_idx" ON "sandbox_provider" ("id","workspace_id");--> statement-breakpoint
ALTER TABLE "sandbox" ADD CONSTRAINT "sandbox_pod_workspace_fkey" FOREIGN KEY ("pod_id","workspace_id") REFERENCES "pod"("id","workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sandbox" ADD CONSTRAINT "sandbox_provider_workspace_fkey" FOREIGN KEY ("sandbox_provider_id","workspace_id") REFERENCES "sandbox_provider"("id","workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sandbox_allowed_host" ADD CONSTRAINT "sandbox_allowed_host_workspace_id_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sandbox_allowed_host" ADD CONSTRAINT "sandbox_allowed_host_added_by_id_user_id_fkey" FOREIGN KEY ("added_by_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "sandbox_blocked_host" ADD CONSTRAINT "sandbox_blocked_host_workspace_id_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sandbox_blocked_host" ADD CONSTRAINT "sandbox_blocked_host_blocked_by_id_user_id_fkey" FOREIGN KEY ("blocked_by_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "sandbox_lease" ADD CONSTRAINT "sandbox_lease_sandbox_id_sandbox_id_fkey" FOREIGN KEY ("sandbox_id") REFERENCES "sandbox"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sandbox_pod_allowed_host" ADD CONSTRAINT "sandbox_pod_allowed_host_added_by_id_user_id_fkey" FOREIGN KEY ("added_by_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "sandbox_pod_allowed_host" ADD CONSTRAINT "sandbox_pod_allowed_host_pod_workspace_fkey" FOREIGN KEY ("pod_id","workspace_id") REFERENCES "pod"("id","workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sandbox_provider" ADD CONSTRAINT "sandbox_provider_workspace_id_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sandbox_provider" ADD CONSTRAINT "sandbox_provider_created_by_id_user_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "user"("id") ON DELETE SET NULL;