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
-- Each connection goes to one bot of its `pod`, which keeps its id, so tool
-- calls and GitHub triggers still name it: the oldest bot whose automations
-- trigger on it, or else the `pod`'s oldest bot. Never a Personal Assistant:
-- Sugabots manages it, so it has no automations for a GitHub app to start, and
-- the other bots are the ones whose calls name the connection. A `pod` whose
-- only bot is its Personal Assistant keeps no original; the assistant gets a
-- copy below.
WITH "keeper" AS (
	SELECT DISTINCT ON ("connection"."id") "connection"."id" AS "connection_id", "agent"."id" AS "agent_id"
	FROM "connection"
	JOIN "agent" ON "agent"."pod_id" = "connection"."pod_id"
	WHERE "agent"."provisioned_key" IS DISTINCT FROM 'personal-assistant'
	ORDER BY "connection"."id",
		EXISTS (
			SELECT 1 FROM "routine"
			JOIN "routine_trigger" ON "routine_trigger"."routine_id" = "routine"."id"
			WHERE "routine"."agent_id" = "agent"."id"
				AND "routine"."deleted_at" IS NULL
				AND "routine_trigger"."settings"->>'connectionId' = "connection"."id"::text
		) DESC,
		"agent"."created_at", "agent"."id"
)
UPDATE "connection" SET "agent_id" = "keeper"."agent_id"
FROM "keeper" WHERE "connection"."id" = "keeper"."connection_id";--> statement-breakpoint
-- A GitHub connection is its own GitHub App, so it went to that one bot. The
-- other bots' automations that it started can't be started by it any
-- more, so they're paused, showing as paused rather than silently never running,
-- until their bot has its own GitHub app and someone points the trigger at it.
UPDATE "routine" SET "state" = 'paused'
WHERE "state" = 'enabled' AND EXISTS (
	SELECT 1 FROM "routine_trigger"
	JOIN "connection" ON "connection"."id"::text = "routine_trigger"."settings"->>'connectionId'
	WHERE "routine_trigger"."routine_id" = "routine"."id"
		AND "routine_trigger"."kind" = 'github'
		AND "connection"."agent_id" IS DISTINCT FROM "routine"."agent_id"
);--> statement-breakpoint
-- A paused automation's routines have no next time.
UPDATE "routine_trigger" SET "next_scheduled_at" = NULL
FROM "routine"
WHERE "routine"."id" = "routine_trigger"."routine_id" AND "routine"."state" = 'paused'
	AND "routine_trigger"."next_scheduled_at" IS NOT NULL;--> statement-breakpoint
-- The `pod`'s other bots get copies of its MCP and HTTP connections. A GitHub
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
JOIN "agent" ON "agent"."pod_id" = "connection"."pod_id" AND "agent"."id" IS DISTINCT FROM "connection"."agent_id"
WHERE "connection"."kind" <> 'github';--> statement-breakpoint
-- A turn waiting for approvals is bound to the connections it asked to call,
-- by id. A bot that got a copy has its calls bound to the copy instead, which
-- is the same connection at the same revision, so they still run once allowed.
UPDATE "tool_call" SET "connection_id" = "copy"."id"
FROM "turn", "connection" AS "original", "connection" AS "copy"
WHERE "turn"."id" = "tool_call"."turn_id" AND "turn"."status" = 'waiting'
	AND "tool_call"."status" = 'awaiting_approval'
	AND "original"."id" = "tool_call"."connection_id"
	AND "original"."agent_id" IS DISTINCT FROM "turn"."agent_id"
	AND "copy"."agent_id" = "turn"."agent_id" AND "copy"."pod_id" = "original"."pod_id"
	AND "copy"."handle" = "original"."handle"
	AND "copy"."configuration_revision" = "tool_call"."connection_revision";--> statement-breakpoint
UPDATE "turn" SET "checkpoint" = jsonb_set("checkpoint", '{approvals}', (
	SELECT jsonb_agg(
		CASE WHEN "copy"."id" IS NULL THEN "element"."binding"
			ELSE jsonb_set("element"."binding", '{connectionId}', to_jsonb("copy"."id"::text)) END
		ORDER BY "element"."position"
	)
	FROM jsonb_array_elements("turn"."checkpoint"->'approvals') WITH ORDINALITY AS "element"("binding", "position")
	LEFT JOIN "connection" AS "original" ON "original"."id"::text = "element"."binding"->>'connectionId'
		AND "original"."agent_id" IS DISTINCT FROM "turn"."agent_id"
	LEFT JOIN "connection" AS "copy" ON "copy"."agent_id" = "turn"."agent_id"
		AND "copy"."pod_id" = "original"."pod_id" AND "copy"."handle" = "original"."handle"
		AND "copy"."configuration_revision" = ("element"."binding"->>'connectionRevision')::integer
))
WHERE "status" = 'waiting' AND jsonb_array_length(coalesce("checkpoint"->'approvals', '[]'::jsonb)) > 0;--> statement-breakpoint
-- A waiting turn still bound to a connection its bot no longer has, such as
-- another bot's GitHub app, could only fail once its calls were allowed. It is
-- cancelled now, its calls not run, saying why; the turns' cancel sweep tells
-- its workflow, which then stops waiting.
WITH "stranded" AS (
	SELECT "turn"."id" FROM "turn"
	WHERE "turn"."status" = 'waiting' AND EXISTS (
		SELECT 1 FROM jsonb_array_elements(coalesce("turn"."checkpoint"->'approvals', '[]'::jsonb)) AS "binding"
		WHERE "binding" ? 'connectionId' AND NOT EXISTS (
			SELECT 1 FROM "connection"
			WHERE "connection"."id"::text = "binding"->>'connectionId' AND "connection"."agent_id" = "turn"."agent_id"
		)
	)
), "abandoned_calls" AS (
	UPDATE "tool_call" SET
		"status" = 'failed',
		"approval_status" = CASE WHEN "approval_status" = 'pending' THEN 'denied' ELSE "approval_status" END,
		"error" = 'Not run: when channels replaced pods, this connection went to another bot. Ask again once this bot has a connection of its own.',
		"finished_at" = now(),
		"updated_at" = now()
	WHERE "turn_id" IN (SELECT "id" FROM "stranded") AND "status" IN ('running', 'awaiting_approval')
), "cancelled_replies" AS (
	UPDATE "message" SET "status" = 'cancelled'
	WHERE "turn_id" IN (SELECT "id" FROM "stranded")
)
UPDATE "turn" SET "status" = 'cancelled', "cancel_requested" = true, "checkpoint" = NULL,
	"finished_at" = now(), "updated_at" = now()
WHERE "id" IN (SELECT "id" FROM "stranded");--> statement-breakpoint
-- Copied OAuth tokens would refresh each other away, so every OAuth connection
-- signs in again, the kept one too.
UPDATE "connection" SET "oauth_encrypted" = NULL, "oauth_state" = NULL WHERE "auth_kind" = 'oauth';--> statement-breakpoint
-- A `pod` with no bots leaves its connections nobody to belong to.
DELETE FROM "connection" WHERE "agent_id" IS NULL;--> statement-breakpoint
INSERT INTO "sandbox_agent_allowed_host" ("workspace_id", "agent_id", "host", "added_by_id", "created_at")
SELECT "host"."workspace_id", "agent"."id", "host"."host", "host"."added_by_id", "host"."created_at"
FROM "sandbox_pod_allowed_host" AS "host"
JOIN "agent" ON "agent"."pod_id" = "host"."pod_id";