CREATE TABLE "artifact" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"workspace_id" uuid NOT NULL,
	"pod_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"current_version" integer DEFAULT 1 NOT NULL,
	"created_by_agent_id" uuid,
	"created_in_thread_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifact_kind_valid" CHECK ("kind" in ('document', 'html'))
);
--> statement-breakpoint
CREATE TABLE "artifact_version" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"artifact_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"content_type" text NOT NULL,
	"size" integer NOT NULL,
	"author_agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "artifact_pod_updated_at_idx" ON "artifact" ("pod_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "artifact_version_number_idx" ON "artifact_version" ("artifact_id","number");--> statement-breakpoint
ALTER TABLE "artifact" ADD CONSTRAINT "artifact_workspace_id_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "artifact" ADD CONSTRAINT "artifact_created_by_agent_id_agent_id_fkey" FOREIGN KEY ("created_by_agent_id") REFERENCES "agent"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "artifact" ADD CONSTRAINT "artifact_created_in_thread_id_thread_id_fkey" FOREIGN KEY ("created_in_thread_id") REFERENCES "thread"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "artifact" ADD CONSTRAINT "artifact_pod_workspace_fkey" FOREIGN KEY ("pod_id","workspace_id") REFERENCES "pod"("id","workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "artifact_version" ADD CONSTRAINT "artifact_version_artifact_id_artifact_id_fkey" FOREIGN KEY ("artifact_id") REFERENCES "artifact"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "artifact_version" ADD CONSTRAINT "artifact_version_author_agent_id_agent_id_fkey" FOREIGN KEY ("author_agent_id") REFERENCES "agent"("id") ON DELETE SET NULL;--> statement-breakpoint

-- An artifact is deleted by its workspace's or pod's cascade as well as directly, and only the database sees every route. Queues the artifact's blob folder, `artifacts/<id>` (see `artifacts.ts`), once per statement however many artifacts it deleted.
CREATE FUNCTION queue_deleted_artifact_blobs() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	INSERT INTO "blob_deletion" ("prefix")
	SELECT 'artifacts/' || "id"::text FROM deleted_artifacts;
	RETURN NULL;
END;
$$;--> statement-breakpoint

CREATE TRIGGER artifact_blob_deletion
AFTER DELETE ON "artifact"
REFERENCING OLD TABLE AS deleted_artifacts
FOR EACH STATEMENT EXECUTE FUNCTION queue_deleted_artifact_blobs();
