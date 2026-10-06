CREATE TABLE "sandbox_pod_package" (
	"workspace_id" uuid NOT NULL,
	"pod_id" uuid,
	"name" text,
	"channel" text,
	"nixpkgs_rev" text NOT NULL,
	"added_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sandbox_pod_package_pkey" PRIMARY KEY("pod_id","channel","name"),
	CONSTRAINT "sandbox_pod_package_channel_check" CHECK ("channel" in ('stable', 'unstable'))
);
--> statement-breakpoint
ALTER TABLE "sandbox_pod_package" ADD CONSTRAINT "sandbox_pod_package_added_by_id_user_id_fkey" FOREIGN KEY ("added_by_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "sandbox_pod_package" ADD CONSTRAINT "sandbox_pod_package_pod_workspace_fkey" FOREIGN KEY ("pod_id","workspace_id") REFERENCES "pod"("id","workspace_id") ON DELETE CASCADE;