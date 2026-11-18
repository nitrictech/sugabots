-- Every bot starts with a new computer, so the pods' computers are destroyed at
-- their providers first, by `destroy-pod-sandboxes` run against this database
-- before upgrading. A `sandbox` row is the only way anything finds a machine at
-- its provider, so this stops while any is left rather than lose them.
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM "sandbox") THEN
		RAISE EXCEPTION 'The pods'' computers are still recorded in the "sandbox" table. Stop Sugabots and run `node packages/core/src/sandboxes/destroy-pod-sandboxes.ts` (in the Docker image: `docker compose run --rm -e SUGABOTS_SKIP_MIGRATIONS=true sugabots node packages/core/src/sandboxes/destroy-pod-sandboxes.ts`) to destroy them at their providers, then start the new version. For a computer it reports it could not destroy, delete the machine in its provider''s console, then its row with DELETE FROM "sandbox" WHERE "provider_sandbox_id" = ''<id>''.';
	END IF;
END $$;--> statement-breakpoint
CREATE TABLE "sandbox_agent_allowed_host" (
	"workspace_id" uuid NOT NULL,
	"agent_id" uuid,
	"host" text,
	"added_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sandbox_agent_allowed_host_pkey" PRIMARY KEY("agent_id","host")
);
--> statement-breakpoint
DROP INDEX "connection_name_idx";--> statement-breakpoint
DROP INDEX "connection_handle_idx";--> statement-breakpoint
DROP INDEX "connection_id_pod_id_idx";--> statement-breakpoint
DROP INDEX "connection_github_pod_idx";--> statement-breakpoint
ALTER TABLE "connection" ADD COLUMN "agent_id" uuid;--> statement-breakpoint
ALTER TABLE "sandbox" ADD COLUMN "agent_id" uuid;--> statement-breakpoint
ALTER TABLE "sandbox_agent_allowed_host" ADD CONSTRAINT "sandbox_agent_allowed_host_added_by_id_user_id_fkey" FOREIGN KEY ("added_by_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "sandbox_agent_allowed_host" ADD CONSTRAINT "sandbox_agent_allowed_host_agent_workspace_fkey" FOREIGN KEY ("agent_id","workspace_id") REFERENCES "agent"("id","workspace_id") ON DELETE CASCADE;--> statement-breakpoint
-- Each connection goes to one bot of its pod, which keeps its id, so tool calls
-- and GitHub triggers still name it: the oldest bot whose automations trigger
-- on it, or else the pod's oldest bot.
WITH "keeper" AS (
	SELECT DISTINCT ON ("connection"."id") "connection"."id" AS "connection_id", "agent"."id" AS "agent_id"
	FROM "connection"
	JOIN "agent" ON "agent"."pod_id" = "connection"."pod_id"
	ORDER BY "connection"."id",
		EXISTS (
			SELECT 1 FROM "routine"
			JOIN "routine_trigger" ON "routine_trigger"."routine_id" = "routine"."id"
			WHERE "routine"."agent_id" = "agent"."id"
				AND "routine_trigger"."settings"->>'connectionId' = "connection"."id"::text
		) DESC,
		"agent"."created_at", "agent"."id"
)
UPDATE "connection" SET "agent_id" = "keeper"."agent_id"
FROM "keeper" WHERE "connection"."id" = "keeper"."connection_id";--> statement-breakpoint
-- A GitHub connection is its own GitHub App, so it went to that one bot. The
-- pod's other bots' automations that it started can't be started by it any
-- more, so they're paused, showing as paused rather than silently never running,
-- until their bot has its own GitHub app and someone points the trigger at it.
UPDATE "routine" SET "state" = 'paused'
WHERE "state" = 'enabled' AND EXISTS (
	SELECT 1 FROM "routine_trigger"
	JOIN "connection" ON "connection"."id"::text = "routine_trigger"."settings"->>'connectionId'
	WHERE "routine_trigger"."routine_id" = "routine"."id"
		AND "routine_trigger"."kind" = 'github'
		AND "connection"."agent_id" <> "routine"."agent_id"
);--> statement-breakpoint
-- A paused automation's schedules have no next time.
UPDATE "routine_trigger" SET "next_scheduled_at" = NULL
FROM "routine"
WHERE "routine"."id" = "routine_trigger"."routine_id" AND "routine"."state" = 'paused'
	AND "routine_trigger"."next_scheduled_at" IS NOT NULL;--> statement-breakpoint
-- The pod's other bots get copies of its MCP and HTTP connections. A GitHub
-- connection is its own GitHub App, which can't be copied: they set up their own.
INSERT INTO "connection" (
	"workspace_id", "pod_id", "agent_id", "name", "handle", "kind", "url", "settings",
	"app_credential_encrypted", "auth_kind", "secret_header", "secret_encrypted",
	"configuration_revision", "tools", "tool_access", "last_tested_at", "last_test_error",
	"created_by_id", "created_at", "updated_at"
)
SELECT
	"connection"."workspace_id", "connection"."pod_id", "agent"."id", "connection"."name",
	"connection"."handle", "connection"."kind", "connection"."url", "connection"."settings",
	"connection"."app_credential_encrypted", "connection"."auth_kind", "connection"."secret_header",
	"connection"."secret_encrypted", "connection"."configuration_revision", "connection"."tools",
	"connection"."tool_access", "connection"."last_tested_at", "connection"."last_test_error",
	"connection"."created_by_id", "connection"."created_at", "connection"."updated_at"
FROM "connection"
JOIN "agent" ON "agent"."pod_id" = "connection"."pod_id" AND "agent"."id" <> "connection"."agent_id"
WHERE "connection"."kind" <> 'github';--> statement-breakpoint
-- Copied OAuth tokens would refresh each other away, so every OAuth connection
-- signs in again, the kept one too.
UPDATE "connection" SET "oauth_encrypted" = NULL, "oauth_state" = NULL WHERE "auth_kind" = 'oauth';--> statement-breakpoint
-- A pod with no bots leaves its connections nobody to belong to.
DELETE FROM "connection" WHERE "agent_id" IS NULL;--> statement-breakpoint
INSERT INTO "sandbox_agent_allowed_host" ("workspace_id", "agent_id", "host", "added_by_id", "created_at")
SELECT "host"."workspace_id", "agent"."id", "host"."host", "host"."added_by_id", "host"."created_at"
FROM "sandbox_pod_allowed_host" AS "host"
JOIN "agent" ON "agent"."pod_id" = "host"."pod_id";