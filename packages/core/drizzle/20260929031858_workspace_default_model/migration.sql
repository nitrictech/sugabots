CREATE TABLE "workspace_default_model" (
	"workspace_id" uuid PRIMARY KEY,
	"model_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace_default_model" ADD CONSTRAINT "workspace_default_model_workspace_id_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE;--> statement-breakpoint

-- Every workspace that offers a model gets a default: the one its owner's Personal Assistant runs on, if the workspace offers it, or else the model it has offered longest. An embedding model cannot run an agent, so it is never the default.
INSERT INTO "workspace_default_model" ("workspace_id", "model_id")
SELECT DISTINCT ON ("model"."workspace_id") "model"."workspace_id", "model"."model_id"
FROM "provider_model" AS "model"
INNER JOIN "model_provider" AS "provider"
	ON "provider"."id" = "model"."provider_id" AND "provider"."workspace_id" = "model"."workspace_id"
LEFT JOIN "workspace_member" AS "owner"
	ON "owner"."workspace_id" = "model"."workspace_id" AND "owner"."role" = 'owner'
LEFT JOIN "agent" AS "assistant"
	ON "assistant"."workspace_id" = "model"."workspace_id"
		AND "assistant"."provisioned_key" = 'personal-assistant'
		AND "assistant"."created_by_id" = "owner"."user_id"
		AND "assistant"."model" = "model"."model_id"
WHERE "model"."enabled" AND "provider"."active"
	AND NOT ("model"."capabilities" @> '["embeddings"]' AND NOT "model"."disabled_capabilities" @> '["embeddings"]')
ORDER BY "model"."workspace_id", "assistant"."id" IS NULL, "model"."created_at", "model"."id";--> statement-breakpoint

-- A system agent always has a model once its workspace offers one, so one nobody set up runs on the default.
UPDATE "agent" SET "model" = "default"."model_id"
FROM "workspace_default_model" AS "default"
WHERE "agent"."workspace_id" = "default"."workspace_id"
	AND "agent"."system_agent_key" IS NOT NULL
	AND "agent"."model" IS NULL;
