-- Moves an installation from pods, agents, threads, routines, sandboxes and
-- artifacts to projects, bots, chats, automations, computers and files, by
-- their glossary names, keeping what members made. Each section is one step,
-- run in order in the same transaction: a later one reads what an earlier one
-- wrote, and the names a statement uses are the ones its step's tables had.
--
-- Some bytes move with the rows. A migration can't reach a filesystem store's
-- disk, so it queues their folders in `blob_folder_move`, which the blob store
-- moves before it serves anything.
--> statement-breakpoint
-- ## Direct messages go
-- People talk in projects' chats, or with bots, so direct messages between
-- people go, with everything in them, before anything else moves. Deleting
-- each thread takes its members, messages, reads and files by their foreign
-- keys, and `thread_blob_deletion` queues its folder, `threads/<id>`, which
-- follows every chat's folder to `chats/<id>` below.
DELETE FROM "thread" WHERE "type" = 'direct';--> statement-breakpoint
DROP TABLE "direct_member";--> statement-breakpoint
ALTER TABLE "thread" DROP CONSTRAINT "thread_direct_valid";--> statement-breakpoint
DROP INDEX "thread_direct_key_idx";--> statement-breakpoint
ALTER TABLE "thread" DROP COLUMN "direct_key";--> statement-breakpoint
-- ## Summaries go
-- Bots no longer summarise their chats, so the summaries go. Their lanes go
-- with the routines' below. The model requests that wrote them stay in the
-- usage members have seen, as what they were: a system bot's work on a
-- chat, which is compaction's purpose, as `summary` is no longer one.
DROP TABLE "thread_summary";--> statement-breakpoint
UPDATE "model_request" SET "purpose" = 'compaction' WHERE "purpose" = 'summary';--> statement-breakpoint
-- ## Bots own resources
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
-- A `personal` `pod` with no bots leaves its connections nobody to belong to.
-- A `shared` one's stay with their `pod`, which becomes a project under the
-- same id and takes them over (see "Projects own resources" below), as its
-- computer does.
DELETE FROM "connection" USING "pod"
WHERE "connection"."agent_id" IS NULL AND "pod"."id" = "connection"."pod_id"
	AND "pod"."kind" = 'personal';--> statement-breakpoint
ALTER TABLE "connection" ALTER COLUMN "pod_id" DROP NOT NULL;--> statement-breakpoint
UPDATE "connection" SET "pod_id" = NULL WHERE "agent_id" IS NOT NULL;--> statement-breakpoint
INSERT INTO "sandbox_agent_allowed_host" ("workspace_id", "agent_id", "host", "added_by_id", "created_at")
SELECT "host"."workspace_id", "agent"."id", "host"."host", "host"."added_by_id", "host"."created_at"
FROM "sandbox_pod_allowed_host" AS "host"
JOIN "agent" ON "agent"."pod_id" = "host"."pod_id";--> statement-breakpoint
-- A `pod`'s computer keeps its provider's id and its work, which is named by
-- the computer's id. A `shared` one's stays with its `pod`, which becomes a
-- project under the same id and takes it over (see "Projects own resources"
-- below). A `personal` one's goes to the
-- bot its threads were with: the oldest bot of the `pod` other than its
-- Personal Assistant, or the assistant when it is the only one.
ALTER TABLE "sandbox" ALTER COLUMN "pod_id" DROP NOT NULL;--> statement-breakpoint
UPDATE "sandbox" SET "agent_id" = (
	SELECT "agent"."id" FROM "agent"
	WHERE "agent"."pod_id" = "sandbox"."pod_id"
	ORDER BY "agent"."provisioned_key" IS NOT NULL, "agent"."created_at", "agent"."id"
	LIMIT 1
), "pod_id" = NULL
FROM "pod" WHERE "pod"."id" = "sandbox"."pod_id" AND "pod"."kind" = 'personal';--> statement-breakpoint
-- A `personal` `pod` with no bots leaves its computer nothing to work for. It
-- is kept aside until `computer_destruction` is made, which destroys it at its
-- provider once the server starts (see "Computer destructions" below).
CREATE TABLE "sandbox_left_over" AS
SELECT "id", "workspace_id", "sandbox_provider_id", "provider_sandbox_id" FROM "sandbox"
WHERE "agent_id" IS NULL AND "pod_id" IS NULL;--> statement-breakpoint
DELETE FROM "sandbox" WHERE "agent_id" IS NULL AND "pod_id" IS NULL;
--> statement-breakpoint
-- ## Bots own resources: keys
ALTER TABLE "connection" DROP CONSTRAINT "connection_pod_workspace_fkey";--> statement-breakpoint
ALTER TABLE "sandbox" DROP CONSTRAINT "sandbox_pod_workspace_fkey";--> statement-breakpoint
ALTER TABLE "routine" DROP CONSTRAINT "routine_chat_id_thread_id_fkey";--> statement-breakpoint
ALTER TABLE "routine" DROP CONSTRAINT "routine_results_valid";--> statement-breakpoint
ALTER TABLE "routine_execution" DROP CONSTRAINT "routine_execution_results_valid";--> statement-breakpoint
DROP INDEX "sandbox_pod_id_idx";--> statement-breakpoint
ALTER TABLE "routine" DROP COLUMN "results";--> statement-breakpoint
ALTER TABLE "routine" DROP COLUMN "chat_id";--> statement-breakpoint
ALTER TABLE "routine_execution" DROP COLUMN "results";--> statement-breakpoint
-- A connection belongs to a bot, or, until its `pod` becomes a project, to its `shared` `pod`.
ALTER TABLE "connection" ADD CONSTRAINT "connection_owner_check" CHECK (num_nonnulls("agent_id", "pod_id") = 1);--> statement-breakpoint
-- A computer belongs to a bot, or, until its `pod` becomes a project, to its `shared` `pod`.
ALTER TABLE "sandbox" ADD CONSTRAINT "sandbox_owner_check" CHECK (num_nonnulls("agent_id", "pod_id") = 1);--> statement-breakpoint
CREATE UNIQUE INDEX "connection_name_idx" ON "connection" ("agent_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "connection_handle_idx" ON "connection" ("agent_id","handle");--> statement-breakpoint
CREATE UNIQUE INDEX "connection_github_agent_idx" ON "connection" ("agent_id") WHERE "kind" = 'github';--> statement-breakpoint
CREATE UNIQUE INDEX "sandbox_agent_id_idx" ON "sandbox" ("agent_id");--> statement-breakpoint
ALTER TABLE "connection" ADD CONSTRAINT "connection_agent_workspace_fkey" FOREIGN KEY ("agent_id","workspace_id") REFERENCES "agent"("id","workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sandbox" ADD CONSTRAINT "sandbox_agent_workspace_fkey" FOREIGN KEY ("agent_id","workspace_id") REFERENCES "agent"("id","workspace_id") ON DELETE CASCADE;
--> statement-breakpoint
-- ## Bots leave pods
CREATE TABLE "pinned_agent" (
	"workspace_id" uuid NOT NULL,
	"user_id" uuid,
	"agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pinned_agent_pkey" PRIMARY KEY("user_id","agent_id")
);
--> statement-breakpoint
CREATE TABLE "pod_agent" (
	"workspace_id" uuid NOT NULL,
	"pod_id" uuid,
	"agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pod_agent_pkey" PRIMARY KEY("pod_id","agent_id")
);
--> statement-breakpoint
ALTER TABLE "agent" DROP CONSTRAINT "agent_placement_check";--> statement-breakpoint
DROP INDEX "agent_name_idx";--> statement-breakpoint
DROP INDEX "agent_handle_idx";--> statement-breakpoint
DROP INDEX "agent_provisioned_key_idx";--> statement-breakpoint
ALTER TABLE "agent" ADD COLUMN "visibility" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent" ADD COLUMN "assistant_of" uuid;--> statement-breakpoint
ALTER TABLE "pod" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "pod" ADD COLUMN "visibility" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
-- Only its people reached a `pod`, so each one kept is a private project,
-- whose members they stay.
UPDATE "pod" SET "visibility" = 'private';--> statement-breakpoint
-- Only its people reached a `shared` `pod`'s bots, so each becomes a private
-- bot, with them as its members. Marked here, while a bot still names its
-- `pod`; "Private bots" below makes them private, once private bots exist.
ALTER TABLE "agent" ADD COLUMN "in_shared_pod" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "agent" SET "in_shared_pod" = true
FROM "pod" WHERE "pod"."id" = "agent"."pod_id" AND "pod"."kind" = 'shared';--> statement-breakpoint
CREATE INDEX "pinned_agent_agent_id_idx" ON "pinned_agent" ("agent_id");--> statement-breakpoint
CREATE INDEX "pod_agent_agent_id_idx" ON "pod_agent" ("agent_id");--> statement-breakpoint
ALTER TABLE "pinned_agent" ADD CONSTRAINT "pinned_agent_workspace_member_fkey" FOREIGN KEY ("workspace_id","user_id") REFERENCES "workspace_member"("workspace_id","user_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "pinned_agent" ADD CONSTRAINT "pinned_agent_agent_workspace_fkey" FOREIGN KEY ("agent_id","workspace_id") REFERENCES "agent"("id","workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "pod_agent" ADD CONSTRAINT "pod_agent_pod_workspace_fkey" FOREIGN KEY ("pod_id","workspace_id") REFERENCES "pod"("id","workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "pod_agent" ADD CONSTRAINT "pod_agent_agent_workspace_fkey" FOREIGN KEY ("agent_id","workspace_id") REFERENCES "agent"("id","workspace_id") ON DELETE CASCADE;--> statement-breakpoint
-- The bots of a `pod` of kind `personal` become its owner's private bots, and
-- its Personal Assistant becomes theirs by `assistant_of`.
UPDATE "agent" SET "visibility" = 'private'
FROM "pod" WHERE "pod"."id" = "agent"."pod_id" AND "pod"."kind" = 'personal';--> statement-breakpoint
UPDATE "agent" SET "assistant_of" = "pod"."owner_id"
FROM "pod"
WHERE "pod"."id" = "agent"."pod_id" AND "pod"."kind" = 'personal'
	AND "agent"."provisioned_key" = 'personal-assistant';--> statement-breakpoint
-- A Personal Assistant's automations become its person's to manage. Any an
-- assistant had are paused, with no next time, until its person resumes them.
UPDATE "routine" SET "state" = 'paused'
FROM "agent"
WHERE "agent"."id" = "routine"."agent_id" AND "agent"."assistant_of" IS NOT NULL
	AND "routine"."state" = 'enabled';--> statement-breakpoint
UPDATE "routine_trigger" SET "next_scheduled_at" = NULL
FROM "routine", "agent"
WHERE "routine"."id" = "routine_trigger"."routine_id" AND "agent"."id" = "routine"."agent_id"
	AND "agent"."assistant_of" IS NOT NULL AND "routine_trigger"."next_scheduled_at" IS NOT NULL;--> statement-breakpoint
-- Handles and names become unique across the workspace, among the bots people
-- address: the oldest keeps its own, and each other gets the lowest number from
-- 2 that no bot has taken, shortened to fit (handles 48 characters, names 64).
-- `personal-assistant` is every Personal Assistant's handle now, so no other
-- bot keeps it.
DO $$
DECLARE
	clashing record;
	suffix_number integer;
	candidate text;
BEGIN
	FOR clashing IN
		SELECT "id", "workspace_id", "handle" FROM (
			SELECT "id", "workspace_id", "handle", "created_at", row_number() OVER (
				PARTITION BY "workspace_id", "handle" ORDER BY "created_at", "id"
			) AS "rank"
			FROM "agent" WHERE "system_agent_key" IS NULL AND "assistant_of" IS NULL
		) AS "ranked"
		WHERE "rank" > 1 OR "handle" = 'personal-assistant' ORDER BY "created_at", "id"
	LOOP
		suffix_number := 2;
		LOOP
			candidate := rtrim(left(clashing.handle, 48 - length('-' || suffix_number)), '-') || '-' || suffix_number;
			EXIT WHEN NOT EXISTS (
				SELECT 1 FROM "agent"
				WHERE "workspace_id" = clashing.workspace_id AND "handle" = candidate
					AND "system_agent_key" IS NULL AND "assistant_of" IS NULL
			);
			suffix_number := suffix_number + 1;
		END LOOP;
		UPDATE "agent" SET "handle" = candidate WHERE "id" = clashing.id;
	END LOOP;
	FOR clashing IN
		SELECT "id", "workspace_id", "name" FROM (
			SELECT "id", "workspace_id", "name", "created_at", row_number() OVER (
				PARTITION BY "workspace_id", lower("name") ORDER BY "created_at", "id"
			) AS "rank"
			FROM "agent" WHERE "system_agent_key" IS NULL AND "assistant_of" IS NULL
		) AS "ranked"
		WHERE "rank" > 1 ORDER BY "created_at", "id"
	LOOP
		suffix_number := 2;
		LOOP
			candidate := rtrim(left(clashing.name, 64 - length(' ' || suffix_number))) || ' ' || suffix_number;
			EXIT WHEN NOT EXISTS (
				SELECT 1 FROM "agent"
				WHERE "workspace_id" = clashing.workspace_id AND lower("name") = lower(candidate)
					AND "system_agent_key" IS NULL AND "assistant_of" IS NULL
			);
			suffix_number := suffix_number + 1;
		END LOOP;
		UPDATE "agent" SET "name" = candidate WHERE "id" = clashing.id;
	END LOOP;
END $$;--> statement-breakpoint
-- A `pod` of kind `shared` keeps its people and gains its bots, as projects
-- have them.
INSERT INTO "pod_agent" ("workspace_id", "pod_id", "agent_id")
SELECT "agent"."workspace_id", "agent"."pod_id", "agent"."id"
FROM "agent" JOIN "pod" ON "pod"."id" = "agent"."pod_id"
WHERE "pod"."kind" = 'shared';--> statement-breakpoint
-- Everyone keeps the bots they saw in their sidebar: each `pod_member` pins
-- the bots of that `pod`, and the owner of a `personal` one pins its bots.
INSERT INTO "pinned_agent" ("workspace_id", "user_id", "agent_id")
SELECT "agent"."workspace_id", "pod_member"."user_id", "agent"."id"
FROM "agent"
JOIN "pod_member" ON "pod_member"."pod_id" = "agent"."pod_id"
WHERE "agent"."assistant_of" IS NULL
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "pinned_agent" ("workspace_id", "user_id", "agent_id")
SELECT "agent"."workspace_id", "pod"."owner_id", "agent"."id"
FROM "agent"
JOIN "pod" ON "pod"."id" = "agent"."pod_id"
JOIN "workspace_member" ON "workspace_member"."workspace_id" = "pod"."workspace_id"
	AND "workspace_member"."user_id" = "pod"."owner_id"
WHERE "pod"."kind" = 'personal' AND "agent"."assistant_of" IS NULL
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- A `conversation` row between people with a `pod_id` stays with that `pod`,
-- as a thread of the project it becomes; every conversation a bot hosts
-- becomes one of that bot's threads, outside any project.
UPDATE "thread" SET "type" = 'pod_chat'
WHERE "type" = 'conversation' AND "host_agent_id" IS NULL AND "pod_id" IS NOT NULL;--> statement-breakpoint
UPDATE "thread" SET "type" = 'conversation', "pod_id" = NULL WHERE "type" = 'bot_channel';--> statement-breakpoint
UPDATE "thread" SET "pod_id" = NULL WHERE "type" <> 'pod_chat';--> statement-breakpoint
-- A file is reached through the thread it was made in. A file whose thread
-- is gone, which its `pod`'s Files still listed, moves to a thread there: a
-- `shared` one's goes to the `pod_chat` row marked `main`, which is opened for
-- it, titled General, if the `pod` never opened one.
INSERT INTO "thread" ("id", "workspace_id", "pod_id", "conversation_id", "type", "main", "title")
SELECT "opened"."id", "opened"."workspace_id", "opened"."pod_id", "opened"."id", 'pod_chat', true, 'General'
FROM (
	SELECT uuidv7() AS "id", "pod"."workspace_id", "pod"."id" AS "pod_id"
	FROM "pod"
	WHERE "pod"."kind" = 'shared'
		AND EXISTS (
			SELECT 1 FROM "artifact"
			WHERE "artifact"."pod_id" = "pod"."id" AND "artifact"."created_in_thread_id" IS NULL
		)
		AND NOT EXISTS (SELECT 1 FROM "thread" WHERE "thread"."pod_id" = "pod"."id" AND "thread"."main")
) AS "opened";--> statement-breakpoint
UPDATE "artifact" SET "created_in_thread_id" = "main_chat"."id"
FROM "thread" AS "main_chat"
JOIN "pod" ON "pod"."id" = "main_chat"."pod_id"
WHERE "main_chat"."main" AND "pod"."kind" = 'shared'
	AND "artifact"."pod_id" = "pod"."id" AND "artifact"."created_in_thread_id" IS NULL;--> statement-breakpoint
-- A `personal` one's goes to a thread of the bot that made it, or else of the
-- `pod`'s oldest bot other than its Personal Assistant, which only when it is
-- its only bot: the bot's latest thread, or a new one with the `pod`'s owner
-- when it has none. A `personal` `pod` with no bots left is given a Personal
-- Assistant for its owner, on no model until they choose one, to keep their
-- files where only they reach them. One whose owner has left the workspace
-- has nobody to keep them for, so they're deleted with it.
INSERT INTO "agent" ("workspace_id", "pod_id", "name", "handle", "provisioned_key", "color", "face", "visibility", "assistant_of", "created_by_id")
SELECT "pod"."workspace_id", "pod"."id", 'Personal Assistant', 'personal-assistant', 'personal-assistant',
	'teal', 'arc', 'private', "pod"."owner_id", "pod"."owner_id"
FROM "pod"
JOIN "workspace_member" ON "workspace_member"."workspace_id" = "pod"."workspace_id"
	AND "workspace_member"."user_id" = "pod"."owner_id"
WHERE "pod"."kind" = 'personal'
	AND EXISTS (
		SELECT 1 FROM "artifact"
		WHERE "artifact"."pod_id" = "pod"."id" AND "artifact"."created_in_thread_id" IS NULL
	)
	AND NOT EXISTS (SELECT 1 FROM "agent" WHERE "agent"."pod_id" = "pod"."id");--> statement-breakpoint
DO $$
DECLARE
	orphan record;
	chosen_bot uuid;
	task uuid;
BEGIN
	FOR orphan IN
		SELECT "artifact"."id", "artifact"."workspace_id", "artifact"."pod_id",
			"artifact"."created_by_agent_id", "pod"."owner_id"
		FROM "artifact" JOIN "pod" ON "pod"."id" = "artifact"."pod_id"
		WHERE "pod"."kind" = 'personal' AND "artifact"."created_in_thread_id" IS NULL
	LOOP
		SELECT "id" INTO chosen_bot FROM "agent"
		WHERE "pod_id" = orphan.pod_id
		ORDER BY "id" = orphan.created_by_agent_id DESC NULLS LAST, "assistant_of" IS NOT NULL,
			"created_at", "id"
		LIMIT 1;
		CONTINUE WHEN chosen_bot IS NULL;
		SELECT "id" INTO task FROM "thread"
		WHERE "host_agent_id" = chosen_bot AND "type" = 'conversation'
		ORDER BY "updated_at" DESC, "id" DESC
		LIMIT 1;
		IF task IS NULL THEN
			task := uuidv7();
			INSERT INTO "thread" ("id", "workspace_id", "host_agent_id", "conversation_id", "type", "title", "initiator_user_id")
			VALUES (task, orphan.workspace_id, chosen_bot, task, 'conversation', 'Files', orphan.owner_id);
			INSERT INTO "thread_participant" ("thread_id", "agent_id") VALUES (task, chosen_bot);
			IF orphan.owner_id IS NOT NULL THEN
				INSERT INTO "thread_participant" ("thread_id", "user_id") VALUES (task, orphan.owner_id);
			END IF;
		END IF;
		UPDATE "artifact" SET "created_in_thread_id" = task WHERE "id" = orphan.id;
	END LOOP;
END $$;--> statement-breakpoint
DELETE FROM "artifact" WHERE "created_in_thread_id" IS NULL;--> statement-breakpoint
UPDATE "agent" SET "pod_id" = NULL;--> statement-breakpoint
-- A `personal` `pod` admitted its owner alone; projects have no such rule.
DROP TRIGGER "personal_pod_owner_membership" ON "pod_member";--> statement-breakpoint
DROP FUNCTION enforce_personal_pod_owner_membership();--> statement-breakpoint
DROP TRIGGER "shared_pod_administrators" ON "pod";--> statement-breakpoint
CREATE TRIGGER shared_pod_administrators
AFTER INSERT ON "pod"
FOR EACH ROW EXECUTE FUNCTION add_administrators_to_new_shared_pod();
--> statement-breakpoint
-- ## Bots leave pods: keys
ALTER TABLE "agent" DROP CONSTRAINT "agent_pod_workspace_fkey";--> statement-breakpoint
ALTER TABLE "pod" DROP CONSTRAINT "pod_owner_workspace_member_fkey";--> statement-breakpoint
ALTER TABLE "artifact" DROP CONSTRAINT "artifact_pod_workspace_fkey";--> statement-breakpoint
ALTER TABLE "thread" DROP CONSTRAINT "thread_origin_message_id_message_id_fkey";--> statement-breakpoint
ALTER TABLE "pod" DROP CONSTRAINT "pod_kind_check";--> statement-breakpoint
ALTER TABLE "pod" DROP CONSTRAINT "pod_personal_owner_check";--> statement-breakpoint
ALTER TABLE "pod" DROP CONSTRAINT "pod_personal_slug_check";--> statement-breakpoint
DROP INDEX "artifact_pod_updated_at_idx";--> statement-breakpoint
DROP INDEX "thread_pod_host_created_at_idx";--> statement-breakpoint
DROP INDEX "thread_pod_host_updated_at_idx";--> statement-breakpoint
DROP INDEX "thread_origin_message_idx";--> statement-breakpoint
DROP INDEX "thread_bot_channel_idx";--> statement-breakpoint
DROP INDEX "agent_pod_id_idx";--> statement-breakpoint
DROP INDEX "personal_pod_owner_idx";--> statement-breakpoint
DROP INDEX "pod_workspace_id_idx";--> statement-breakpoint
-- Their bots have left them, so a Personal pod has nothing left in it.
DELETE FROM "pod" WHERE "kind" = 'personal';--> statement-breakpoint
ALTER TABLE "model_request" DROP COLUMN "pod_id";--> statement-breakpoint
ALTER TABLE "agent" DROP COLUMN "pod_id";--> statement-breakpoint
ALTER TABLE "agent" DROP COLUMN "provisioned_key";--> statement-breakpoint
ALTER TABLE "pod" DROP COLUMN "owner_id";--> statement-breakpoint
ALTER TABLE "pod" DROP COLUMN "kind";--> statement-breakpoint
ALTER TABLE "artifact" DROP COLUMN "pod_id";--> statement-breakpoint
ALTER TABLE "thread" DROP COLUMN "origin_message_id";--> statement-breakpoint
ALTER TABLE "artifact" ALTER COLUMN "created_in_thread_id" SET NOT NULL;--> statement-breakpoint
-- Dropping `kind` took the partial index that named it.
DROP INDEX IF EXISTS "pod_slug_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "pod_slug_idx" ON "pod" ("workspace_id","slug");--> statement-breakpoint
CREATE INDEX "artifact_thread_updated_at_idx" ON "artifact" ("created_in_thread_id","updated_at");--> statement-breakpoint
CREATE INDEX "thread_pod_updated_at_idx" ON "thread" ("pod_id","updated_at");--> statement-breakpoint
CREATE INDEX "thread_host_updated_at_idx" ON "thread" ("host_agent_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_name_idx" ON "agent" ("workspace_id",lower("name")) WHERE "system_agent_key" is null and "assistant_of" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_handle_idx" ON "agent" ("workspace_id","handle") WHERE "system_agent_key" is null and "assistant_of" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_assistant_handle_idx" ON "agent" ("workspace_id","assistant_of","handle") WHERE "assistant_of" is not null;--> statement-breakpoint
ALTER TABLE "agent" ADD CONSTRAINT "agent_assistant_workspace_member_fkey" FOREIGN KEY ("workspace_id","assistant_of") REFERENCES "workspace_member"("workspace_id","user_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "artifact" DROP CONSTRAINT "artifact_created_in_thread_id_thread_id_fkey", ADD CONSTRAINT "artifact_created_in_thread_id_thread_id_fkey" FOREIGN KEY ("created_in_thread_id") REFERENCES "thread"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "thread" ADD CONSTRAINT "thread_pod_valid" CHECK (("type" = 'pod_chat') = ("pod_id" is not null));--> statement-breakpoint
ALTER TABLE "agent" ADD CONSTRAINT "agent_visibility_check" CHECK ("visibility" in ('public', 'private'));--> statement-breakpoint
ALTER TABLE "pod" ADD CONSTRAINT "pod_visibility_check" CHECK ("visibility" in ('public', 'private'));--> statement-breakpoint
ALTER TABLE "thread" DROP CONSTRAINT "thread_type_valid", ADD CONSTRAINT "thread_type_valid" CHECK ("type" in ('conversation', 'pod_chat', 'collaboration', 'routine', 'routine_feed', 'system_agent'));--> statement-breakpoint
ALTER TABLE "thread" DROP CONSTRAINT "thread_host_valid", ADD CONSTRAINT "thread_host_valid" CHECK (("type" = 'pod_chat') = ("host_agent_id" is null));--> statement-breakpoint
-- Every pod is a channel now, so a new owner or admin joins every one.
CREATE OR REPLACE FUNCTION add_new_administrator_to_shared_pods() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	PERFORM lock_pod_membership(NEW."workspace_id");
	INSERT INTO "pod_member" ("workspace_id", "pod_id", "user_id")
	SELECT NEW."workspace_id", "id", NEW."user_id"
	FROM "pod"
	WHERE "workspace_id" = NEW."workspace_id"
	ON CONFLICT ("pod_id", "user_id") DO NOTHING;
	RETURN NULL;
END;
$$;
--> statement-breakpoint
-- ## Routines become automations
ALTER TABLE "routine" RENAME TO "automation";--> statement-breakpoint
ALTER TABLE "routine_execution" RENAME TO "run";--> statement-breakpoint
ALTER TABLE "routine_trigger" RENAME TO "automation_trigger";--> statement-breakpoint
ALTER TABLE "run" RENAME COLUMN "routine_id" TO "automation_id";--> statement-breakpoint
ALTER TABLE "run" RENAME COLUMN "routine_name" TO "automation_name";--> statement-breakpoint
ALTER TABLE "automation_trigger" RENAME COLUMN "routine_id" TO "automation_id";--> statement-breakpoint
ALTER TABLE "message" RENAME COLUMN "routine_trigger" TO "automation_trigger";--> statement-breakpoint
ALTER TABLE "message" RENAME COLUMN "routine_execution_id" TO "run_id";--> statement-breakpoint
ALTER TABLE "thread" RENAME COLUMN "routine_id" TO "automation_id";--> statement-breakpoint
ALTER TABLE "notification_settings" RENAME COLUMN "routine_runs" TO "automation_runs";--> statement-breakpoint
ALTER TABLE "automation" RENAME CONSTRAINT "routine_state_valid" TO "automation_state_valid";--> statement-breakpoint
ALTER TABLE "automation" RENAME CONSTRAINT "routine_paused_after_failures_valid" TO "automation_paused_after_failures_valid";--> statement-breakpoint
ALTER TABLE "automation" RENAME CONSTRAINT "routine_created_by_agent_valid" TO "automation_created_by_agent_valid";--> statement-breakpoint
ALTER TABLE "run" RENAME CONSTRAINT "routine_execution_trigger_valid" TO "run_trigger_valid";--> statement-breakpoint
ALTER TABLE "run" RENAME CONSTRAINT "routine_execution_state_valid" TO "run_state_valid";--> statement-breakpoint
ALTER TABLE "run" RENAME CONSTRAINT "routine_execution_pending_terminal_valid" TO "run_pending_terminal_valid";--> statement-breakpoint
ALTER TABLE "automation_trigger" RENAME CONSTRAINT "routine_trigger_secret_valid" TO "automation_trigger_secret_valid";--> statement-breakpoint
ALTER TABLE "automation_trigger" RENAME CONSTRAINT "routine_trigger_digest_valid" TO "automation_trigger_digest_valid";--> statement-breakpoint
ALTER TABLE "automation_trigger" RENAME CONSTRAINT "routine_trigger_schedule_valid" TO "automation_trigger_schedule_valid";--> statement-breakpoint
ALTER TABLE "thread" RENAME CONSTRAINT "thread_routine_valid" TO "thread_automation_valid";--> statement-breakpoint
ALTER TABLE "notification_settings" RENAME CONSTRAINT "notification_settings_routine_runs_valid" TO "notification_settings_automation_runs_valid";--> statement-breakpoint
ALTER INDEX "routine_agent_name_idx" RENAME TO "automation_agent_name_idx";--> statement-breakpoint
ALTER INDEX "routine_id_workspace_id_idx" RENAME TO "automation_id_workspace_id_idx";--> statement-breakpoint
ALTER INDEX "routine_execution_thread_idx" RENAME TO "run_thread_idx";--> statement-breakpoint
ALTER INDEX "routine_execution_trigger_identity_idx" RENAME TO "run_trigger_identity_idx";--> statement-breakpoint
ALTER INDEX "routine_execution_manual_identity_idx" RENAME TO "run_manual_identity_idx";--> statement-breakpoint
ALTER INDEX "routine_execution_running_idx" RENAME TO "run_running_idx";--> statement-breakpoint
ALTER INDEX "routine_execution_list_idx" RENAME TO "run_list_idx";--> statement-breakpoint
ALTER INDEX "routine_trigger_routine_idx" RENAME TO "automation_trigger_automation_idx";--> statement-breakpoint
ALTER INDEX "routine_trigger_due_idx" RENAME TO "automation_trigger_due_idx";--> statement-breakpoint
ALTER INDEX "message_routine_execution_idx" RENAME TO "message_run_idx";--> statement-breakpoint
ALTER INDEX "thread_routine_feed_idx" RENAME TO "thread_automation_feed_idx";--> statement-breakpoint
ALTER TABLE "automation" RENAME CONSTRAINT "routine_agent_workspace_fkey" TO "automation_agent_workspace_fkey";--> statement-breakpoint
ALTER TABLE "run" RENAME CONSTRAINT "routine_execution_agent_workspace_fkey" TO "run_agent_workspace_fkey";--> statement-breakpoint
ALTER TABLE "run" RENAME CONSTRAINT "routine_execution_routine_workspace_fkey" TO "run_automation_workspace_fkey";--> statement-breakpoint
ALTER TABLE "automation_trigger" RENAME CONSTRAINT "routine_trigger_routine_workspace_fkey" TO "automation_trigger_automation_workspace_fkey";--> statement-breakpoint
ALTER TABLE "automation_trigger" DROP CONSTRAINT "automation_trigger_schedule_valid";--> statement-breakpoint
-- A trigger of kind `cron` is now of kind `schedule`; `kind` follows `settings`.
UPDATE "automation_trigger" SET "settings" = jsonb_set("settings", '{kind}', '"schedule"') WHERE "settings"->>'kind' = 'cron';--> statement-breakpoint
ALTER TABLE "automation_trigger" ADD CONSTRAINT "automation_trigger_schedule_valid" CHECK ("kind" = 'schedule' or "next_scheduled_at" is null);--> statement-breakpoint
UPDATE "run" SET "trigger_kind" = 'schedule', "trigger" = jsonb_set("trigger", '{kind}', '"schedule"') WHERE "trigger_kind" = 'cron';--> statement-breakpoint
-- The message an automation's trigger posts names its author by the new words.
UPDATE "message" SET "automation_trigger" = ("automation_trigger" - 'kind' - 'executionId' - 'routineName' - 'triggerKind') || jsonb_build_object(
	'kind', 'automation_trigger',
	'runId', "automation_trigger"->'executionId',
	'automationName', "automation_trigger"->'routineName',
	'triggerKind', CASE WHEN "automation_trigger"->>'triggerKind' = 'cron' THEN to_jsonb('schedule'::text) ELSE "automation_trigger"->'triggerKind' END
) WHERE "automation_trigger" IS NOT NULL;--> statement-breakpoint
-- The built-in tools switched off as `routines` are now `automations`.
UPDATE "agent" SET "disabled_tools" = (
	SELECT jsonb_agg(CASE WHEN tool = 'routines' THEN 'automations' ELSE tool END ORDER BY position)
	FROM jsonb_array_elements_text("disabled_tools") WITH ORDINALITY AS listed(tool, position)
) WHERE "disabled_tools" ? 'routines';--> statement-breakpoint
-- Constraints Postgres named itself (primary keys, not-null constraints and the
-- foreign keys named for their columns) keep the old words in their names;
-- the ones a server has depend on its Postgres version, so each is renamed if it is there.
DO $$
DECLARE
	found record;
BEGIN
	FOR found IN
		SELECT conrelid::regclass AS on_table, conname AS name
		FROM pg_constraint
		WHERE connamespace = 'public'::regnamespace AND conname LIKE '%routine%'
	LOOP
		EXECUTE format(
			'ALTER TABLE %s RENAME CONSTRAINT %I TO %I',
			found.on_table,
			found.name,
			replace(replace(replace(found.name, 'routine_execution', 'run'), 'routine_trigger', 'automation_trigger'), 'routine', 'automation')
		);
	END LOOP;
END $$;--> statement-breakpoint
DROP INDEX "message_run_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "message_run_idx" ON "message" ("run_id","thread_id") WHERE "run_id" is not null;--> statement-breakpoint
ALTER TABLE "message" DROP CONSTRAINT "message_one_author", ADD CONSTRAINT "message_one_author" CHECK (num_nonnulls("author_user_id", "author_agent_id", "automation_trigger") = 1);--> statement-breakpoint
ALTER TABLE "thread" DROP CONSTRAINT "thread_automation_valid", ADD CONSTRAINT "thread_automation_valid" CHECK (("automation_id" is not null) = ("type" = 'routine_feed'));--> statement-breakpoint
ALTER TABLE "notification_settings" DROP CONSTRAINT "notification_settings_automation_runs_valid", ADD CONSTRAINT "notification_settings_automation_runs_valid" CHECK ("automation_runs" in ('failures', 'all', 'none'));
--> statement-breakpoint
-- ## Sandboxes become computers
ALTER TABLE "sandbox_agent_allowed_host" RENAME TO "agent_allowed_host";--> statement-breakpoint
ALTER TABLE "sandbox_allowed_host" RENAME TO "allowed_host";--> statement-breakpoint
ALTER TABLE "sandbox_blocked_host" RENAME TO "blocked_host";--> statement-breakpoint
ALTER TABLE "sandbox" RENAME TO "computer";--> statement-breakpoint
ALTER TABLE "sandbox_lease" RENAME TO "computer_lease";--> statement-breakpoint
ALTER TABLE "sandbox_provider" RENAME TO "computer_provider";--> statement-breakpoint
ALTER TABLE "computer" RENAME COLUMN "sandbox_provider_id" TO "computer_provider_id";--> statement-breakpoint
ALTER TABLE "computer" RENAME COLUMN "provider_sandbox_id" TO "provider_computer_id";--> statement-breakpoint
ALTER TABLE "computer_lease" RENAME COLUMN "sandbox_id" TO "computer_id";--> statement-breakpoint
ALTER TABLE "agent" RENAME COLUMN "uses_sandbox" TO "uses_computer";--> statement-breakpoint
ALTER TABLE "computer" RENAME CONSTRAINT "sandbox_disk_measured_check" TO "computer_disk_measured_check";--> statement-breakpoint
ALTER TABLE "computer_lease" RENAME CONSTRAINT "sandbox_lease_holder_kind_check" TO "computer_lease_holder_kind_check";--> statement-breakpoint
ALTER TABLE "computer_provider" RENAME CONSTRAINT "sandbox_provider_preset_check" TO "computer_provider_preset_check";--> statement-breakpoint
ALTER INDEX "sandbox_agent_id_idx" RENAME TO "computer_agent_id_idx";--> statement-breakpoint
ALTER INDEX "sandbox_provider_enabled_idx" RENAME TO "computer_provider_enabled_idx";--> statement-breakpoint
ALTER INDEX "sandbox_provider_id_workspace_id_idx" RENAME TO "computer_provider_id_workspace_id_idx";--> statement-breakpoint
ALTER TABLE "agent_allowed_host" RENAME CONSTRAINT "sandbox_agent_allowed_host_agent_workspace_fkey" TO "agent_allowed_host_agent_workspace_fkey";--> statement-breakpoint
ALTER TABLE "computer" RENAME CONSTRAINT "sandbox_agent_workspace_fkey" TO "computer_agent_workspace_fkey";--> statement-breakpoint
ALTER TABLE "computer" RENAME CONSTRAINT "sandbox_provider_workspace_fkey" TO "computer_provider_workspace_fkey";--> statement-breakpoint
-- Constraints Postgres named itself (primary keys, not-null constraints and the
-- foreign keys named for their columns) keep the old words in their names;
-- the ones a server has depend on its Postgres version, so each is renamed if it is there.
DO $$
DECLARE
	found record;
BEGIN
	FOR found IN
		SELECT conrelid::regclass AS on_table, conname AS name
		FROM pg_constraint
		WHERE connamespace = 'public'::regnamespace AND conname LIKE '%sandbox%'
	LOOP
		EXECUTE format(
			'ALTER TABLE %s RENAME CONSTRAINT %I TO %I',
			found.on_table,
			found.name,
			replace(replace(replace(replace(found.name, 'sandbox_agent_allowed_host', 'agent_allowed_host'), 'sandbox_allowed_host', 'allowed_host'), 'sandbox_blocked_host', 'blocked_host'), 'sandbox', 'computer')
		);
	END LOOP;
END $$;
--> statement-breakpoint
-- ## Artifacts and thread files become files
CREATE TABLE "file" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"thread_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text,
	"content_type" text,
	"size" integer,
	"tool_call_id" uuid,
	"uploader_id" uuid,
	"message_id" uuid,
	"position" integer,
	"created_by_agent_id" uuid,
	"current_version" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "file_kind_valid" CHECK ("kind" in ('document', 'html', 'upload', 'agent_attachment', 'tool_result')),
	CONSTRAINT "file_source_valid" CHECK (case "kind"
				when 'upload' then "name" is not null and "content_type" is not null
					and "size" is not null and "tool_call_id" is null
					and ("message_id" is null) = ("position" is null)
					and "created_by_agent_id" is null and "current_version" is null
				when 'agent_attachment' then "name" is not null and "content_type" is not null
					and "size" is not null and "tool_call_id" is null
					and "uploader_id" is null and "message_id" is not null
					and "position" is not null
					and "created_by_agent_id" is null and "current_version" is null
				when 'tool_result' then "name" is null and "content_type" is not null
					and "size" is not null and "uploader_id" is null
					and "message_id" is null and "position" is null
					and "created_by_agent_id" is null and "current_version" is null
				else "name" is not null and "current_version" is not null
					and "content_type" is null and "size" is null
					and "tool_call_id" is null and "uploader_id" is null
					and "message_id" is null and "position" is null
			end)
);
--> statement-breakpoint
CREATE TABLE "file_version" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"file_id" uuid NOT NULL,
	"file_kind" text NOT NULL,
	"number" integer NOT NULL,
	"content_type" text NOT NULL,
	"size" integer NOT NULL,
	"author_agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "file_version_file_kind_valid" CHECK ("file_kind" in ('document', 'html'))
);
--> statement-breakpoint
CREATE INDEX "file_thread_updated_at_idx" ON "file" ("thread_id","updated_at");--> statement-breakpoint
CREATE INDEX "file_message_idx" ON "file" ("message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "file_id_kind_idx" ON "file" ("id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "file_version_number_idx" ON "file_version" ("file_id","number");--> statement-breakpoint
ALTER TABLE "file" ADD CONSTRAINT "file_thread_id_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "thread"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "file" ADD CONSTRAINT "file_tool_call_id_tool_call_id_fkey" FOREIGN KEY ("tool_call_id") REFERENCES "tool_call"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "file" ADD CONSTRAINT "file_uploader_id_user_id_fkey" FOREIGN KEY ("uploader_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "file" ADD CONSTRAINT "file_message_id_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "message"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "file" ADD CONSTRAINT "file_created_by_agent_id_agent_id_fkey" FOREIGN KEY ("created_by_agent_id") REFERENCES "agent"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "file_version" ADD CONSTRAINT "file_version_author_agent_id_agent_id_fkey" FOREIGN KEY ("author_agent_id") REFERENCES "agent"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "file_version" ADD CONSTRAINT "file_version_file_fkey" FOREIGN KEY ("file_id","file_kind") REFERENCES "file"("id","kind") ON DELETE CASCADE;--> statement-breakpoint
-- The files kept whole in a conversation move across as they are: tool
-- results, uploads and bots' attachments, under the same ids, so their blobs,
-- kept by id under their conversation's folder, are still theirs. A file on a
-- message was last changed when the message was sent.
INSERT INTO "file" ("id", "thread_id", "kind", "name", "content_type", "size", "tool_call_id", "uploader_id", "message_id", "position", "created_at", "updated_at")
SELECT "thread_file"."id", "thread_file"."thread_id", "thread_file"."kind", "thread_file"."name",
	"thread_file"."content_type", "thread_file"."size", "thread_file"."tool_call_id", "thread_file"."uploader_id",
	"thread_file"."message_id", "thread_file"."position", "thread_file"."created_at",
	greatest("thread_file"."created_at", coalesce("message"."created_at", "thread_file"."created_at"))
FROM "thread_file" LEFT JOIN "message" ON "message"."id" = "thread_file"."message_id";--> statement-breakpoint
-- The files bots wrote move across under the same ids, so their versions'
-- blobs, under `artifacts/<id>`, are still theirs; the title is the name.
INSERT INTO "file" ("id", "thread_id", "kind", "name", "created_by_agent_id", "current_version", "created_at", "updated_at")
SELECT "id", "created_in_thread_id", "kind", "title", "created_by_agent_id", "current_version", "created_at", "updated_at"
FROM "artifact";--> statement-breakpoint
INSERT INTO "file_version" ("id", "file_id", "file_kind", "number", "content_type", "size", "author_agent_id", "created_at")
SELECT "artifact_version"."id", "artifact_version"."artifact_id", "artifact"."kind", "artifact_version"."number",
	"artifact_version"."content_type", "artifact_version"."size", "artifact_version"."author_agent_id", "artifact_version"."created_at"
FROM "artifact_version" JOIN "artifact" ON "artifact"."id" = "artifact_version"."artifact_id";--> statement-breakpoint
-- Dropping the old tables fires none of their DELETE triggers, so no blob is queued for deletion here: the copied `file` rows keep every blob.
DROP TABLE "artifact_version";--> statement-breakpoint
DROP TABLE "artifact";--> statement-breakpoint
DROP TABLE "thread_file";--> statement-breakpoint
DROP FUNCTION queue_deleted_artifact_blobs();--> statement-breakpoint

-- A file is deleted by its conversation's cascade as well as directly, and only the database sees every route. Queues a written file's blob folder, which keeps the name it was first stored under, `artifacts/<id>` (see `files.ts`), once per statement however many files it deleted. Any other file's blob is in its conversation's folder, which its own code removes.
CREATE FUNCTION queue_deleted_file_blobs() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	INSERT INTO "blob_deletion" ("prefix")
	SELECT 'artifacts/' || "id"::text FROM deleted_files WHERE "kind" IN ('document', 'html');
	RETURN NULL;
END;
$$;--> statement-breakpoint

CREATE TRIGGER file_blob_deletion
AFTER DELETE ON "file"
REFERENCING OLD TABLE AS deleted_files
FOR EACH STATEMENT EXECUTE FUNCTION queue_deleted_file_blobs();--> statement-breakpoint

-- A written file an automation run's posted result shows is now a part of type `written_file`, naming its `fileId`.
UPDATE "message" SET "parts" = (
	SELECT jsonb_agg(
		CASE WHEN part->>'type' = 'artifact'
			THEN (part - 'type' - 'artifactId') || jsonb_build_object('type', 'written_file', 'fileId', part->'artifactId')
			ELSE part
		END
		ORDER BY position
	)
	FROM jsonb_array_elements("parts") WITH ORDINALITY AS listed(part, position)
) WHERE "parts" @> '[{"type": "artifact"}]';--> statement-breakpoint
-- The file tools are now `file_list`, `file_read`, `file_write` and `file_edit`,
-- taking and giving `fileId`, and listing `files`. Their recorded calls follow,
-- as a reply's file cards and an automation's posted result are read from them.
UPDATE "tool_call" SET
	"tool" = 'file_' || substring("tool" from 10),
	"input" = replace("input"::text, '"artifactId"', '"fileId"')::jsonb,
	"execution_input" = replace("execution_input"::text, '"artifactId"', '"fileId"')::jsonb,
	"output" = replace(replace("output"::text, '"artifactId"', '"fileId"'), '"artifacts"', '"files"')::jsonb
WHERE "tool" IN ('artifact_list', 'artifact_read', 'artifact_write', 'artifact_edit');--> statement-breakpoint
-- The file tools a bot has switched off, by their new names.
UPDATE "agent" SET "disabled_tools" = (
	SELECT jsonb_agg(
		CASE WHEN tool IN ('artifact_list', 'artifact_read', 'artifact_write', 'artifact_edit')
			THEN 'file_' || substring(tool from 10)
			ELSE tool
		END
		ORDER BY position
	)
	FROM jsonb_array_elements_text("disabled_tools") WITH ORDINALITY AS listed(tool, position)
) WHERE "disabled_tools" ?| array['artifact_list', 'artifact_read', 'artifact_write', 'artifact_edit'];
--> statement-breakpoint
-- ## Pods become channels
ALTER TABLE "pod" RENAME TO "channel";--> statement-breakpoint
ALTER TABLE "pod_agent" RENAME TO "channel_bot";--> statement-breakpoint
ALTER TABLE "pod_member" RENAME TO "channel_member";--> statement-breakpoint
ALTER TABLE "thread" RENAME COLUMN "pod_id" TO "channel_id";--> statement-breakpoint
ALTER TABLE "notification_override" RENAME COLUMN "pod_id" TO "channel_id";--> statement-breakpoint
ALTER TABLE "channel_bot" RENAME COLUMN "pod_id" TO "channel_id";--> statement-breakpoint
ALTER TABLE "channel_member" RENAME COLUMN "pod_id" TO "channel_id";--> statement-breakpoint
ALTER TABLE "thread" RENAME CONSTRAINT "thread_pod_valid" TO "thread_channel_valid";--> statement-breakpoint
ALTER TABLE "channel" RENAME CONSTRAINT "pod_visibility_check" TO "channel_visibility_check";--> statement-breakpoint
ALTER INDEX "thread_pod_updated_at_idx" RENAME TO "thread_channel_updated_at_idx";--> statement-breakpoint
ALTER INDEX "thread_pod_chat_idx" RENAME TO "thread_channel_main_idx";--> statement-breakpoint
ALTER INDEX "notification_override_pod_idx" RENAME TO "notification_override_channel_idx";--> statement-breakpoint
ALTER INDEX "pod_slug_idx" RENAME TO "channel_slug_idx";--> statement-breakpoint
ALTER INDEX "pod_id_workspace_id_idx" RENAME TO "channel_id_workspace_id_idx";--> statement-breakpoint
ALTER INDEX "pod_agent_agent_id_idx" RENAME TO "channel_bot_agent_id_idx";--> statement-breakpoint
ALTER INDEX "pod_member_idx" RENAME TO "channel_member_idx";--> statement-breakpoint
ALTER INDEX "pod_member_user_id_idx" RENAME TO "channel_member_user_id_idx";--> statement-breakpoint
ALTER TABLE "thread" RENAME CONSTRAINT "thread_pod_workspace_fkey" TO "thread_channel_workspace_fkey";--> statement-breakpoint
ALTER TABLE "channel_bot" RENAME CONSTRAINT "pod_agent_pod_workspace_fkey" TO "channel_bot_channel_workspace_fkey";--> statement-breakpoint
ALTER TABLE "channel_bot" RENAME CONSTRAINT "pod_agent_agent_workspace_fkey" TO "channel_bot_agent_workspace_fkey";--> statement-breakpoint
ALTER TABLE "channel_member" RENAME CONSTRAINT "pod_member_pod_workspace_fkey" TO "channel_member_channel_workspace_fkey";--> statement-breakpoint
ALTER TABLE "channel_member" RENAME CONSTRAINT "pod_member_workspace_member_fkey" TO "channel_member_workspace_member_fkey";--> statement-breakpoint
DROP INDEX "notification_override_channel_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "notification_override_channel_idx" ON "notification_override" ("user_id","channel_id") WHERE "channel_id" is not null;--> statement-breakpoint
ALTER TABLE "notification_override" DROP CONSTRAINT "notification_override_one_place", ADD CONSTRAINT "notification_override_one_place" CHECK (num_nonnulls("channel_id", "agent_id") = 1);--> statement-breakpoint
ALTER TABLE "thread" DROP CONSTRAINT "thread_channel_valid", ADD CONSTRAINT "thread_channel_valid" CHECK (("type" = 'pod_chat') = ("channel_id" is not null));--> statement-breakpoint
-- Constraints Postgres named itself (primary keys, not-null constraints and the
-- foreign keys named for their columns) keep the old words in their names;
-- the ones a server has depend on its Postgres version, so each is renamed if it is there.
DO $$
DECLARE
	found record;
BEGIN
	FOR found IN
		SELECT conrelid::regclass AS on_table, conname AS name
		FROM pg_constraint
		WHERE connamespace = 'public'::regnamespace AND conname LIKE '%pod%'
	LOOP
		EXECUTE format(
			'ALTER TABLE %s RENAME CONSTRAINT %I TO %I',
			found.on_table,
			found.name,
			replace(replace(found.name, 'pod_agent', 'channel_bot'), 'pod', 'channel')
		);
	END LOOP;
END $$;--> statement-breakpoint
-- The triggers that make every owner and admin a project member, and the lock
-- they share, read the tables by their old names, so they are made again.
DROP TRIGGER "shared_pod_administrators" ON "channel";--> statement-breakpoint
DROP TRIGGER "administrator_shared_pods" ON "workspace_member";--> statement-breakpoint
DROP FUNCTION add_administrators_to_new_shared_pod();--> statement-breakpoint
DROP FUNCTION add_new_administrator_to_shared_pods();--> statement-breakpoint
DROP FUNCTION lock_pod_membership(uuid);--> statement-breakpoint
-- Serialises every write that decides whether an administrator is a project member. Without it, a project made while somebody is promoted is missed by both: each insert runs before the other commits.
CREATE FUNCTION lock_channel_membership(workspace uuid) RETURNS void
LANGUAGE sql AS $$
	SELECT pg_advisory_xact_lock(hashtext('channel_membership:' || workspace::text));
$$;--> statement-breakpoint
-- The owner and admins are members of every project, so `channel_member` is the whole list of a project's people.
CREATE FUNCTION add_administrators_to_new_channel() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	PERFORM lock_channel_membership(NEW."workspace_id");
	INSERT INTO "channel_member" ("workspace_id", "channel_id", "user_id")
	SELECT NEW."workspace_id", NEW."id", "user_id"
	FROM "workspace_member"
	WHERE "workspace_id" = NEW."workspace_id" AND "role" IN ('owner', 'admin')
	ON CONFLICT ("channel_id", "user_id") DO NOTHING;
	RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER channel_administrators
AFTER INSERT ON "channel"
FOR EACH ROW EXECUTE FUNCTION add_administrators_to_new_channel();--> statement-breakpoint
-- Only adds: somebody demoted stays in their projects, and leaves them one at a time.
CREATE FUNCTION add_new_administrator_to_channels() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	PERFORM lock_channel_membership(NEW."workspace_id");
	INSERT INTO "channel_member" ("workspace_id", "channel_id", "user_id")
	SELECT NEW."workspace_id", "id", NEW."user_id"
	FROM "channel"
	WHERE "workspace_id" = NEW."workspace_id"
	ON CONFLICT ("channel_id", "user_id") DO NOTHING;
	RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER administrator_channels
AFTER INSERT OR UPDATE OF "role" ON "workspace_member"
FOR EACH ROW WHEN (NEW."role" IN ('owner', 'admin'))
EXECUTE FUNCTION add_new_administrator_to_channels();--> statement-breakpoint
-- The `pod.updated` events kept for clients that reconnect, renamed `channel.updated`.
UPDATE "event" SET "type" = 'channel.updated', "payload" = jsonb_set("payload", '{type}', '"channel.updated"')
WHERE "type" = 'pod.updated';
--> statement-breakpoint
-- A tool call's approval decided where it was raised is `conversation`'s to decide now.
UPDATE "event" SET "payload" = jsonb_set("payload", '{toolCall,approval,deciders}', '"conversation"')
WHERE "payload" #>> '{toolCall,approval,deciders}' = 'pod';
--> statement-breakpoint
-- ## Agents become bots
ALTER TABLE "agent_allowed_host" RENAME TO "bot_allowed_host";--> statement-breakpoint
ALTER TABLE "agent" RENAME TO "bot";--> statement-breakpoint
ALTER TABLE "pinned_agent" RENAME TO "pinned_bot";--> statement-breakpoint
ALTER TABLE "model_request" RENAME COLUMN "agent_id" TO "bot_id";--> statement-breakpoint
ALTER TABLE "bot_allowed_host" RENAME COLUMN "agent_id" TO "bot_id";--> statement-breakpoint
ALTER TABLE "computer" RENAME COLUMN "agent_id" TO "bot_id";--> statement-breakpoint
ALTER TABLE "automation" RENAME COLUMN "agent_id" TO "bot_id";--> statement-breakpoint
ALTER TABLE "automation" RENAME COLUMN "created_by_agent_id" TO "created_by_bot_id";--> statement-breakpoint
ALTER TABLE "run" RENAME COLUMN "agent_id" TO "bot_id";--> statement-breakpoint
ALTER TABLE "collaboration" RENAME COLUMN "collaborator_agent_id" TO "collaborator_bot_id";--> statement-breakpoint
ALTER TABLE "message" RENAME COLUMN "author_agent_id" TO "author_bot_id";--> statement-breakpoint
ALTER TABLE "thread" RENAME COLUMN "host_agent_id" TO "host_bot_id";--> statement-breakpoint
ALTER TABLE "thread" RENAME COLUMN "system_agent_key" TO "system_bot_key";--> statement-breakpoint
ALTER TABLE "thread_participant" RENAME COLUMN "agent_id" TO "bot_id";--> statement-breakpoint
ALTER TABLE "turn" RENAME COLUMN "agent_id" TO "bot_id";--> statement-breakpoint
ALTER TABLE "file" RENAME COLUMN "created_by_agent_id" TO "created_by_bot_id";--> statement-breakpoint
ALTER TABLE "file_version" RENAME COLUMN "author_agent_id" TO "author_bot_id";--> statement-breakpoint
ALTER TABLE "notification_override" RENAME COLUMN "agent_id" TO "bot_id";--> statement-breakpoint
ALTER TABLE "connection" RENAME COLUMN "agent_id" TO "bot_id";--> statement-breakpoint
ALTER TABLE "bot" RENAME COLUMN "system_agent_key" TO "system_bot_key";--> statement-breakpoint
ALTER TABLE "channel_bot" RENAME COLUMN "agent_id" TO "bot_id";--> statement-breakpoint
ALTER TABLE "pinned_bot" RENAME COLUMN "agent_id" TO "bot_id";--> statement-breakpoint
ALTER TABLE "automation" RENAME CONSTRAINT "automation_created_by_agent_valid" TO "automation_created_by_bot_valid";--> statement-breakpoint
ALTER TABLE "bot" RENAME CONSTRAINT "agent_visibility_check" TO "bot_visibility_check";--> statement-breakpoint
ALTER INDEX "computer_agent_id_idx" RENAME TO "computer_bot_id_idx";--> statement-breakpoint
ALTER INDEX "automation_agent_name_idx" RENAME TO "automation_bot_name_idx";--> statement-breakpoint
ALTER INDEX "thread_system_agent_key_idx" RENAME TO "thread_system_bot_key_idx";--> statement-breakpoint
ALTER INDEX "thread_participant_agent_idx" RENAME TO "thread_participant_bot_idx";--> statement-breakpoint
ALTER INDEX "turn_trigger_agent_idx" RENAME TO "turn_trigger_bot_idx";--> statement-breakpoint
ALTER INDEX "notification_override_agent_idx" RENAME TO "notification_override_bot_idx";--> statement-breakpoint
ALTER INDEX "connection_github_agent_idx" RENAME TO "connection_github_bot_idx";--> statement-breakpoint
ALTER INDEX "agent_name_idx" RENAME TO "bot_name_idx";--> statement-breakpoint
ALTER INDEX "agent_handle_idx" RENAME TO "bot_handle_idx";--> statement-breakpoint
ALTER INDEX "agent_assistant_handle_idx" RENAME TO "bot_assistant_handle_idx";--> statement-breakpoint
ALTER INDEX "agent_system_agent_key_idx" RENAME TO "bot_system_bot_key_idx";--> statement-breakpoint
ALTER INDEX "agent_id_workspace_id_idx" RENAME TO "bot_id_workspace_id_idx";--> statement-breakpoint
ALTER INDEX "channel_bot_agent_id_idx" RENAME TO "channel_bot_bot_id_idx";--> statement-breakpoint
ALTER INDEX "pinned_agent_agent_id_idx" RENAME TO "pinned_bot_bot_id_idx";--> statement-breakpoint
ALTER TABLE "bot_allowed_host" RENAME CONSTRAINT "agent_allowed_host_agent_workspace_fkey" TO "bot_allowed_host_bot_workspace_fkey";--> statement-breakpoint
ALTER TABLE "computer" RENAME CONSTRAINT "computer_agent_workspace_fkey" TO "computer_bot_workspace_fkey";--> statement-breakpoint
ALTER TABLE "automation" RENAME CONSTRAINT "automation_agent_workspace_fkey" TO "automation_bot_workspace_fkey";--> statement-breakpoint
ALTER TABLE "run" RENAME CONSTRAINT "run_agent_workspace_fkey" TO "run_bot_workspace_fkey";--> statement-breakpoint
ALTER TABLE "thread" RENAME CONSTRAINT "thread_host_agent_workspace_fkey" TO "thread_host_bot_workspace_fkey";--> statement-breakpoint
ALTER TABLE "connection" RENAME CONSTRAINT "connection_agent_workspace_fkey" TO "connection_bot_workspace_fkey";--> statement-breakpoint
ALTER TABLE "bot" RENAME CONSTRAINT "agent_assistant_workspace_member_fkey" TO "bot_assistant_workspace_member_fkey";--> statement-breakpoint
ALTER TABLE "channel_bot" RENAME CONSTRAINT "channel_bot_agent_workspace_fkey" TO "channel_bot_bot_workspace_fkey";--> statement-breakpoint
ALTER TABLE "pinned_bot" RENAME CONSTRAINT "pinned_agent_workspace_member_fkey" TO "pinned_bot_workspace_member_fkey";--> statement-breakpoint
ALTER TABLE "pinned_bot" RENAME CONSTRAINT "pinned_agent_agent_workspace_fkey" TO "pinned_bot_bot_workspace_fkey";--> statement-breakpoint
DROP INDEX "thread_participant_bot_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "thread_participant_bot_idx" ON "thread_participant" ("thread_id","bot_id") WHERE "bot_id" is not null;--> statement-breakpoint
DROP INDEX "notification_override_bot_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "notification_override_bot_idx" ON "notification_override" ("user_id","bot_id") WHERE "bot_id" is not null;--> statement-breakpoint
DROP INDEX "bot_name_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "bot_name_idx" ON "bot" ("workspace_id",lower("name")) WHERE "system_bot_key" is null and "assistant_of" is null;--> statement-breakpoint
DROP INDEX "bot_handle_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "bot_handle_idx" ON "bot" ("workspace_id","handle") WHERE "system_bot_key" is null and "assistant_of" is null;--> statement-breakpoint
ALTER TABLE "model_request" DROP CONSTRAINT "model_request_purpose_valid";--> statement-breakpoint
UPDATE "model_request" SET "purpose" = 'bot-turn' WHERE "purpose" = 'agent-turn';--> statement-breakpoint
ALTER TABLE "model_request" ADD CONSTRAINT "model_request_purpose_valid" CHECK ("purpose" in ('bot-turn', 'facilitation', 'compaction', 'trial', 'provider-check'));--> statement-breakpoint
ALTER TABLE "message" DROP CONSTRAINT "message_one_author", ADD CONSTRAINT "message_one_author" CHECK (num_nonnulls("author_user_id", "author_bot_id", "automation_trigger") = 1);--> statement-breakpoint
ALTER TABLE "thread_participant" DROP CONSTRAINT "thread_participant_one_identity", ADD CONSTRAINT "thread_participant_one_identity" CHECK (num_nonnulls("user_id", "bot_id") = 1);--> statement-breakpoint
ALTER TABLE "automation" DROP CONSTRAINT "automation_created_by_bot_valid", ADD CONSTRAINT "automation_created_by_bot_valid" CHECK ("created_by_bot_id" is null or "created_by_bot_id" = "bot_id");--> statement-breakpoint
ALTER TABLE "thread" DROP CONSTRAINT "thread_host_valid", ADD CONSTRAINT "thread_host_valid" CHECK (("type" = 'pod_chat') = ("host_bot_id" is null));--> statement-breakpoint
ALTER TABLE "notification_override" DROP CONSTRAINT "notification_override_one_place", ADD CONSTRAINT "notification_override_one_place" CHECK (num_nonnulls("channel_id", "bot_id") = 1);--> statement-breakpoint
ALTER TABLE "file" DROP CONSTRAINT "file_kind_valid";--> statement-breakpoint
ALTER TABLE "file" DROP CONSTRAINT "file_source_valid";--> statement-breakpoint
UPDATE "file" SET "kind" = 'bot_attachment' WHERE "kind" = 'agent_attachment';--> statement-breakpoint
ALTER TABLE "file" ADD CONSTRAINT "file_kind_valid" CHECK ("kind" in ('document', 'html', 'upload', 'bot_attachment', 'tool_result'));--> statement-breakpoint
ALTER TABLE "file" ADD CONSTRAINT "file_source_valid" CHECK (case "kind"
				when 'upload' then "name" is not null and "content_type" is not null
					and "size" is not null and "tool_call_id" is null
					and ("message_id" is null) = ("position" is null)
					and "created_by_bot_id" is null and "current_version" is null
				when 'bot_attachment' then "name" is not null and "content_type" is not null
					and "size" is not null and "tool_call_id" is null
					and "uploader_id" is null and "message_id" is not null
					and "position" is not null
					and "created_by_bot_id" is null and "current_version" is null
				when 'tool_result' then "name" is null and "content_type" is not null
					and "size" is not null and "uploader_id" is null
					and "message_id" is null and "position" is null
					and "created_by_bot_id" is null and "current_version" is null
				else "name" is not null and "current_version" is not null
					and "content_type" is null and "size" is null
					and "tool_call_id" is null and "uploader_id" is null
					and "message_id" is null and "position" is null
			end);--> statement-breakpoint
-- Constraints Postgres named itself (primary keys, not-null constraints and the
-- foreign keys named for their columns) keep the old words in their names;
-- the ones a server has depend on its Postgres version, so each is renamed if it is there.
DO $$
DECLARE
	found record;
BEGIN
	FOR found IN
		SELECT conrelid::regclass AS on_table, conname AS name
		FROM pg_constraint
		WHERE connamespace = 'public'::regnamespace AND conname LIKE '%agent%'
			AND conname NOT LIKE '%user_agent%'
	LOOP
		EXECUTE format(
			'ALTER TABLE %s RENAME CONSTRAINT %I TO %I',
			found.on_table,
			found.name,
			replace(found.name, 'agent', 'bot')
		);
	END LOOP;
END $$;--> statement-breakpoint
-- A Summariser someone renamed keeps the name they gave it.
UPDATE "bot" SET "name" = 'Summariser', "handle" = 'summariser'
WHERE "system_bot_key" = 'summarise' AND "name" = 'Scribe' AND "handle" = 'scribe';--> statement-breakpoint
-- The folders a computer's disk was last measured with name each home's bot as `botId`.
UPDATE "computer" SET "disk_usage" = jsonb_set(
	"disk_usage",
	'{folders}',
	(
		SELECT jsonb_agg(
			CASE WHEN folder ? 'agentId'
				THEN (folder - 'agentId') || jsonb_build_object('botId', folder -> 'agentId')
				ELSE folder
			END ORDER BY position
		)
		FROM jsonb_array_elements("disk_usage" -> 'folders') WITH ORDINALITY AS listed(folder, position)
	)
)
WHERE jsonb_typeof("disk_usage" -> 'folders') = 'array' AND jsonb_array_length("disk_usage" -> 'folders') > 0;--> statement-breakpoint
-- The events kept for clients that reconnect name bots by the old word throughout
-- (their fields, kinds and types), and clients only read the new one. A client
-- whose last event is gone gets a reset and fetches everything again, so they go.
DELETE FROM "event";
--> statement-breakpoint
-- ## Conversations by kind
-- Each kind of conversation gets its own table, keyed by the conversation's id,
-- holding what makes it that kind; `thread` becomes `conversation`, holding
-- only what every kind has.
CREATE TABLE "automation_feed" (
	"conversation_id" uuid PRIMARY KEY,
	"kind" text GENERATED ALWAYS AS ('automation_feed') STORED NOT NULL,
	"workspace_id" uuid NOT NULL,
	"automation_id" uuid NOT NULL
);--> statement-breakpoint
CREATE TABLE "channel_conversation" (
	"conversation_id" uuid PRIMARY KEY,
	"kind" text GENERATED ALWAYS AS ('channel_conversation') STORED NOT NULL,
	"workspace_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"main" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"started_by_id" uuid,
	CONSTRAINT "channel_conversation_archived_valid" CHECK ("archived_at" is null or not "main")
);--> statement-breakpoint
CREATE TABLE "system_conversation" (
	"conversation_id" uuid PRIMARY KEY,
	"kind" text GENERATED ALWAYS AS ('system') STORED NOT NULL,
	"workspace_id" uuid NOT NULL,
	"bot_id" uuid NOT NULL,
	"system_bot_key" text NOT NULL,
	"served_conversation_id" uuid NOT NULL
);--> statement-breakpoint
CREATE TABLE "task" (
	"conversation_id" uuid PRIMARY KEY,
	"kind" text GENERATED ALWAYS AS ('task') STORED NOT NULL,
	"workspace_id" uuid NOT NULL,
	"bot_id" uuid NOT NULL,
	"started_by_id" uuid,
	"done_at" timestamp with time zone
);--> statement-breakpoint
ALTER TABLE "thread" RENAME TO "conversation";--> statement-breakpoint
ALTER TABLE "thread_compaction" RENAME TO "compaction";--> statement-breakpoint
ALTER TABLE "thread_participant" RENAME TO "conversation_participant";--> statement-breakpoint
ALTER TABLE "thread_read" RENAME TO "conversation_read";--> statement-breakpoint
-- Named for the tables it was made between, which earlier migrations renamed.
ALTER TABLE "run" DROP CONSTRAINT IF EXISTS "routine_execution_thread_id_thread_id_fkey", DROP CONSTRAINT IF EXISTS "run_thread_id_thread_id_fkey";--> statement-breakpoint
ALTER TABLE "collaboration" DROP CONSTRAINT "collaboration_child_thread_id_thread_id_fkey";--> statement-breakpoint
ALTER TABLE "conversation" DROP CONSTRAINT "thread_parent_thread_id_thread_id_fkey";--> statement-breakpoint
ALTER TABLE "conversation" DROP CONSTRAINT "thread_initiator_user_id_user_id_fkey";--> statement-breakpoint
ALTER TABLE "conversation" DROP CONSTRAINT "thread_channel_workspace_fkey";--> statement-breakpoint
ALTER TABLE "conversation" DROP CONSTRAINT "thread_host_bot_workspace_fkey";--> statement-breakpoint
ALTER TABLE "conversation" DROP CONSTRAINT "thread_conversation_id_thread_id_fkey";--> statement-breakpoint
ALTER TABLE "conversation" DROP CONSTRAINT IF EXISTS "thread_routine_id_routine_id_fkey", DROP CONSTRAINT IF EXISTS "thread_automation_id_automation_id_fkey";--> statement-breakpoint
ALTER TABLE "model_request" RENAME COLUMN "thread_id" TO "conversation_id";--> statement-breakpoint
ALTER TABLE "run" RENAME COLUMN "thread_id" TO "conversation_id";--> statement-breakpoint
ALTER TABLE "collaboration" RENAME COLUMN "child_thread_id" TO "conversation_id";--> statement-breakpoint
ALTER TABLE "collaboration" RENAME COLUMN "parent_thread_id" TO "parent_conversation_id";--> statement-breakpoint
ALTER TABLE "conversation" RENAME COLUMN "type" TO "kind";--> statement-breakpoint
ALTER TABLE "compaction" RENAME COLUMN "thread_id" TO "conversation_id";--> statement-breakpoint
ALTER TABLE "conversation_participant" RENAME COLUMN "thread_id" TO "conversation_id";--> statement-breakpoint
ALTER TABLE "conversation_read" RENAME COLUMN "thread_id" TO "conversation_id";--> statement-breakpoint
ALTER TABLE "message" RENAME COLUMN "thread_id" TO "conversation_id";--> statement-breakpoint
ALTER TABLE "tool_call" RENAME COLUMN "thread_id" TO "conversation_id";--> statement-breakpoint
ALTER TABLE "turn" RENAME COLUMN "thread_id" TO "conversation_id";--> statement-breakpoint
ALTER TABLE "file" RENAME COLUMN "thread_id" TO "conversation_id";--> statement-breakpoint
ALTER TABLE "conversation" DROP CONSTRAINT "thread_type_valid";--> statement-breakpoint
ALTER TABLE "conversation" DROP CONSTRAINT "thread_host_valid";--> statement-breakpoint
ALTER TABLE "conversation" DROP CONSTRAINT "thread_automation_valid";--> statement-breakpoint
ALTER TABLE "conversation" DROP CONSTRAINT "thread_main_valid";--> statement-breakpoint
ALTER TABLE "conversation" DROP CONSTRAINT "thread_archived_valid";--> statement-breakpoint
ALTER TABLE "conversation" DROP CONSTRAINT "thread_channel_valid";--> statement-breakpoint
ALTER TABLE "conversation_participant" RENAME CONSTRAINT "thread_participant_one_identity" TO "conversation_participant_one_identity";--> statement-breakpoint
ALTER INDEX "model_request_thread_idx" RENAME TO "model_request_conversation_idx";--> statement-breakpoint
ALTER INDEX "run_thread_idx" RENAME TO "run_conversation_idx";--> statement-breakpoint
ALTER INDEX "collaboration_child_thread_idx" RENAME TO "collaboration_conversation_idx";--> statement-breakpoint
ALTER INDEX "thread_workspace_created_at_idx" RENAME TO "conversation_workspace_created_at_idx";--> statement-breakpoint
ALTER INDEX "thread_workspace_updated_at_idx" RENAME TO "conversation_workspace_updated_at_idx";--> statement-breakpoint
ALTER INDEX "thread_participant_user_idx" RENAME TO "conversation_participant_user_idx";--> statement-breakpoint
ALTER INDEX "thread_participant_bot_idx" RENAME TO "conversation_participant_bot_idx";--> statement-breakpoint
ALTER INDEX "thread_read_user_thread_idx" RENAME TO "conversation_read_user_conversation_idx";--> statement-breakpoint
ALTER INDEX "message_thread_created_at_idx" RENAME TO "message_conversation_created_at_idx";--> statement-breakpoint
ALTER INDEX "turn_thread_started_at_idx" RENAME TO "turn_conversation_started_at_idx";--> statement-breakpoint
ALTER INDEX "file_thread_updated_at_idx" RENAME TO "file_conversation_updated_at_idx";--> statement-breakpoint
UPDATE "conversation" SET "kind" = CASE "kind"
	WHEN 'conversation' THEN 'task'
	WHEN 'pod_chat' THEN 'channel_conversation'
	WHEN 'routine' THEN 'run'
	WHEN 'routine_feed' THEN 'automation_feed'
	WHEN 'system_agent' THEN 'system'
	ELSE "kind"
END;
--> statement-breakpoint
ALTER TABLE "run" ADD COLUMN "kind" text GENERATED ALWAYS AS ('run') STORED NOT NULL;
--> statement-breakpoint
ALTER TABLE "collaboration" ADD COLUMN "kind" text GENERATED ALWAYS AS ('collaboration') STORED NOT NULL;
--> statement-breakpoint
ALTER TABLE "collaboration" ADD COLUMN "root_conversation_id" uuid;
--> statement-breakpoint
-- What made each conversation its kind moves to its kind's table, before
-- the columns that held it go.
INSERT INTO "task" ("conversation_id", "workspace_id", "bot_id", "started_by_id", "done_at")
SELECT "id", "workspace_id", "host_bot_id", "initiator_user_id", "done_at"
FROM "conversation" WHERE "kind" = 'task';
--> statement-breakpoint
INSERT INTO "channel_conversation" ("conversation_id", "workspace_id", "channel_id", "main", "archived_at", "started_by_id")
SELECT "id", "workspace_id", "channel_id", "main", "archived_at", "initiator_user_id"
FROM "conversation" WHERE "kind" = 'channel_conversation';
--> statement-breakpoint
INSERT INTO "automation_feed" ("conversation_id", "workspace_id", "automation_id")
SELECT "id", "workspace_id", "automation_id"
FROM "conversation" WHERE "kind" = 'automation_feed';
--> statement-breakpoint
INSERT INTO "system_conversation" ("conversation_id", "workspace_id", "bot_id", "system_bot_key", "served_conversation_id")
SELECT "id", "workspace_id", "host_bot_id", "system_bot_key", "parent_thread_id"
FROM "conversation" WHERE "kind" = 'system';
--> statement-breakpoint
-- A collaboration's root was its conversation's; the one it was asked from stands in where none was kept.
UPDATE "collaboration" SET "root_conversation_id" = coalesce(c."conversation_id", "collaboration"."parent_conversation_id")
FROM "conversation" c WHERE c."id" = "collaboration"."conversation_id";
--> statement-breakpoint
UPDATE "collaboration" SET "root_conversation_id" = "parent_conversation_id" WHERE "root_conversation_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "collaboration" ALTER COLUMN "root_conversation_id" SET NOT NULL;
--> statement-breakpoint
DROP INDEX "thread_system_bot_key_idx";--> statement-breakpoint
DROP INDEX "thread_conversation_updated_at_idx";--> statement-breakpoint
DROP INDEX "thread_channel_main_idx";--> statement-breakpoint
DROP INDEX "thread_automation_feed_idx";--> statement-breakpoint
DROP INDEX "thread_channel_updated_at_idx";--> statement-breakpoint
DROP INDEX "thread_host_updated_at_idx";--> statement-breakpoint
ALTER TABLE "conversation" DROP COLUMN "channel_id";--> statement-breakpoint
ALTER TABLE "conversation" DROP COLUMN "host_bot_id";--> statement-breakpoint
ALTER TABLE "conversation" DROP COLUMN "system_bot_key";--> statement-breakpoint
ALTER TABLE "conversation" DROP COLUMN "parent_thread_id";--> statement-breakpoint
ALTER TABLE "conversation" DROP COLUMN "initiator_user_id";--> statement-breakpoint
ALTER TABLE "conversation" DROP COLUMN "conversation_id";--> statement-breakpoint
ALTER TABLE "conversation" DROP COLUMN "done_at";--> statement-breakpoint
ALTER TABLE "conversation" DROP COLUMN "automation_id";--> statement-breakpoint
ALTER TABLE "conversation" DROP COLUMN "main";--> statement-breakpoint
ALTER TABLE "conversation" DROP COLUMN "archived_at";--> statement-breakpoint
DROP INDEX "model_request_conversation_idx";--> statement-breakpoint
CREATE INDEX "model_request_conversation_idx" ON "model_request" ("conversation_id") WHERE "conversation_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "automation_feed_automation_idx" ON "automation_feed" ("automation_id");--> statement-breakpoint
CREATE INDEX "channel_conversation_channel_idx" ON "channel_conversation" ("channel_id");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_conversation_main_idx" ON "channel_conversation" ("channel_id") WHERE "main";--> statement-breakpoint
CREATE INDEX "collaboration_root_idx" ON "collaboration" ("root_conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_id_kind_idx" ON "conversation" ("id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_id_kind_workspace_idx" ON "conversation" ("id","kind","workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "system_conversation_served_key_idx" ON "system_conversation" ("served_conversation_id","system_bot_key");--> statement-breakpoint
CREATE INDEX "task_bot_idx" ON "task" ("bot_id");--> statement-breakpoint
ALTER TABLE "automation_feed" ADD CONSTRAINT "automation_feed_conversation_fkey" FOREIGN KEY ("conversation_id","kind","workspace_id") REFERENCES "conversation"("id","kind","workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "automation_feed" ADD CONSTRAINT "automation_feed_automation_workspace_fkey" FOREIGN KEY ("automation_id","workspace_id") REFERENCES "automation"("id","workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_conversation_fkey" FOREIGN KEY ("conversation_id","kind","workspace_id") REFERENCES "conversation"("id","kind","workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "channel_conversation" ADD CONSTRAINT "channel_conversation_started_by_id_user_id_fkey" FOREIGN KEY ("started_by_id") REFERENCES "user"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "channel_conversation" ADD CONSTRAINT "channel_conversation_conversation_fkey" FOREIGN KEY ("conversation_id","kind","workspace_id") REFERENCES "conversation"("id","kind","workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "channel_conversation" ADD CONSTRAINT "channel_conversation_channel_workspace_fkey" FOREIGN KEY ("channel_id","workspace_id") REFERENCES "channel"("id","workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "collaboration" ADD CONSTRAINT "collaboration_root_conversation_id_conversation_id_fkey" FOREIGN KEY ("root_conversation_id") REFERENCES "conversation"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "collaboration" ADD CONSTRAINT "collaboration_conversation_fkey" FOREIGN KEY ("conversation_id","kind") REFERENCES "conversation"("id","kind") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "system_conversation" ADD CONSTRAINT "system_conversation_served_conversation_id_conversation_id_fkey" FOREIGN KEY ("served_conversation_id") REFERENCES "conversation"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "system_conversation" ADD CONSTRAINT "system_conversation_conversation_fkey" FOREIGN KEY ("conversation_id","kind","workspace_id") REFERENCES "conversation"("id","kind","workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "system_conversation" ADD CONSTRAINT "system_conversation_bot_workspace_fkey" FOREIGN KEY ("bot_id","workspace_id") REFERENCES "bot"("id","workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_started_by_id_user_id_fkey" FOREIGN KEY ("started_by_id") REFERENCES "user"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_conversation_fkey" FOREIGN KEY ("conversation_id","kind","workspace_id") REFERENCES "conversation"("id","kind","workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_bot_workspace_fkey" FOREIGN KEY ("bot_id","workspace_id") REFERENCES "bot"("id","workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_kind_valid" CHECK ("kind" in ('task', 'channel_conversation', 'collaboration', 'run', 'automation_feed', 'system'));--> statement-breakpoint
-- Constraints Postgres named itself (primary keys, not-null constraints and the
-- foreign keys named for their columns) keep the old words in their names;
-- the ones a server has depend on its Postgres version, so each is renamed if it is there.
DO $$
DECLARE
	found record;
BEGIN
	FOR found IN
		SELECT conrelid::regclass AS on_table, conname AS name
		FROM pg_constraint
		WHERE connamespace = 'public'::regnamespace
			AND conname LIKE '%thread%'
	LOOP
		EXECUTE format(
			'ALTER TABLE %s RENAME CONSTRAINT %I TO %I',
			found.on_table,
			found.name,
			replace(replace(replace(replace(replace(found.name,
				'thread_participant', 'conversation_participant'),
				'thread_read', 'conversation_read'),
				'thread_compaction', 'compaction'),
				'thread_id', 'conversation_id'),
				'thread', 'conversation')
		);
	END LOOP;
END $$;
--> statement-breakpoint
-- Deleting a conversation still queues its blobs, kept under the folder they
-- were first stored in, `threads/<id>`; the trigger is made again by its new names.
DROP TRIGGER "thread_blob_deletion" ON "conversation";
--> statement-breakpoint
DROP FUNCTION queue_deleted_thread_blobs();
--> statement-breakpoint
CREATE FUNCTION queue_deleted_conversation_blobs() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	INSERT INTO "blob_deletion" ("prefix")
	SELECT 'threads/' || "id"::text FROM deleted_conversations;
	RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER conversation_blob_deletion
AFTER DELETE ON "conversation"
REFERENCING OLD TABLE AS deleted_conversations
FOR EACH STATEMENT EXECUTE FUNCTION queue_deleted_conversation_blobs();
--> statement-breakpoint
-- Every conversation has exactly the kind row its kind says. A kind row can
-- only name a conversation of its kind, through `(id, kind)`, whose foreign key
-- is checked at once, so the conversation is written first; this refuses, at
-- commit, a conversation still without its kind row, so its kind row may follow
-- in a later statement of the same transaction. One deleted again before
-- commit, as one that lost a race for its kind row is, needs none.
CREATE FUNCTION conversation_has_kind_row() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	has_kind_row boolean;
BEGIN
	IF NOT EXISTS (SELECT 1 FROM "conversation" WHERE "id" = NEW."id") THEN
		RETURN NULL;
	END IF;
	has_kind_row := CASE NEW."kind"
		WHEN 'task' THEN EXISTS (SELECT 1 FROM "task" WHERE "conversation_id" = NEW."id")
		WHEN 'channel_conversation' THEN EXISTS (SELECT 1 FROM "channel_conversation" WHERE "conversation_id" = NEW."id")
		WHEN 'collaboration' THEN EXISTS (SELECT 1 FROM "collaboration" WHERE "conversation_id" = NEW."id")
		WHEN 'run' THEN EXISTS (SELECT 1 FROM "run" WHERE "conversation_id" = NEW."id")
		WHEN 'automation_feed' THEN EXISTS (SELECT 1 FROM "automation_feed" WHERE "conversation_id" = NEW."id")
		WHEN 'system' THEN EXISTS (SELECT 1 FROM "system_conversation" WHERE "conversation_id" = NEW."id")
		ELSE false
	END;
	IF NOT has_kind_row THEN
		RAISE EXCEPTION 'conversation % is a % with no % row', NEW."id", NEW."kind", NEW."kind"
			USING ERRCODE = 'foreign_key_violation';
	END IF;
	RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER conversation_has_kind_row
AFTER INSERT ON "conversation"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION conversation_has_kind_row();
--> statement-breakpoint
-- A kind row goes with its conversation, by its foreign key; the conversation
-- goes with its kind row, however that is deleted, by this.
CREATE FUNCTION delete_conversation_of_kind_row() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	DELETE FROM "conversation" WHERE "id" = OLD."conversation_id";
	RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER task_conversation_deletion
AFTER DELETE ON "task"
FOR EACH ROW EXECUTE FUNCTION delete_conversation_of_kind_row();
--> statement-breakpoint
CREATE TRIGGER channel_conversation_conversation_deletion
AFTER DELETE ON "channel_conversation"
FOR EACH ROW EXECUTE FUNCTION delete_conversation_of_kind_row();
--> statement-breakpoint
CREATE TRIGGER collaboration_conversation_deletion
AFTER DELETE ON "collaboration"
FOR EACH ROW EXECUTE FUNCTION delete_conversation_of_kind_row();
--> statement-breakpoint
CREATE TRIGGER run_conversation_deletion
AFTER DELETE ON "run"
FOR EACH ROW EXECUTE FUNCTION delete_conversation_of_kind_row();
--> statement-breakpoint
CREATE TRIGGER automation_feed_conversation_deletion
AFTER DELETE ON "automation_feed"
FOR EACH ROW EXECUTE FUNCTION delete_conversation_of_kind_row();
--> statement-breakpoint
CREATE TRIGGER system_conversation_conversation_deletion
AFTER DELETE ON "system_conversation"
FOR EACH ROW EXECUTE FUNCTION delete_conversation_of_kind_row();
--> statement-breakpoint
-- The trigger checks only conversations written from now on. One an earlier
-- version left without what makes it its kind, such as a collaboration nested
-- under one whose record was deleted, nothing can reach any more: it goes, with
-- what is in it, and its own nested collaborations by the triggers above.
DELETE FROM "conversation" AS c WHERE NOT CASE c."kind"
	WHEN 'task' THEN EXISTS (SELECT 1 FROM "task" WHERE "conversation_id" = c."id")
	WHEN 'channel_conversation' THEN EXISTS (SELECT 1 FROM "channel_conversation" WHERE "conversation_id" = c."id")
	WHEN 'collaboration' THEN EXISTS (SELECT 1 FROM "collaboration" WHERE "conversation_id" = c."id")
	WHEN 'run' THEN EXISTS (SELECT 1 FROM "run" WHERE "conversation_id" = c."id")
	WHEN 'automation_feed' THEN EXISTS (SELECT 1 FROM "automation_feed" WHERE "conversation_id" = c."id")
	WHEN 'system' THEN EXISTS (SELECT 1 FROM "system_conversation" WHERE "conversation_id" = c."id")
	ELSE false
END;
--> statement-breakpoint
CREATE VIEW "placed_conversation" AS (select
	c.id, c.workspace_id, c.kind, c.title, c.created_at, c.updated_at,
	coalesce(t.bot_id, co.collaborator_bot_id, r.bot_id, fa.bot_id, sc.bot_id) as bot_id,
	cc.channel_id,
	case c.kind
		when 'collaboration' then co.root_conversation_id
		when 'run' then rf.conversation_id
		when 'system' then null
		else c.id
	end as root_conversation_id,
	coalesce(co.parent_conversation_id, sc.served_conversation_id) as parent_conversation_id,
	coalesce(t.started_by_id, cc.started_by_id) as started_by_id,
	sc.system_bot_key,
	t.done_at,
	f.automation_id,
	coalesce(cc.main, false) as main,
	cc.archived_at
from "conversation" c
left join "task" t on t.conversation_id = c.id
left join "channel_conversation" cc on cc.conversation_id = c.id
left join "collaboration" co on co.conversation_id = c.id
left join "run" r on r.conversation_id = c.id
left join "automation_feed" rf on rf.automation_id = r.automation_id
left join "automation_feed" f on f.conversation_id = c.id
left join "automation" fa on fa.id = f.automation_id
left join "system_conversation" sc on sc.conversation_id = c.id);
--> statement-breakpoint
-- ## Events in the old words go
-- The events kept for clients that reconnect name conversations by the old
-- word: the `thread.*` and `conversation.thread_changed` types, `threadId` in
-- their payloads, and `audienceThreadId` on those for the workspace's lists.
-- A client whose last event is gone gets a reset and fetches everything
-- again, so they go.
DELETE FROM "event";
--> statement-breakpoint
-- ## Channels become projects
-- Channels become projects, a bot's tasks and a project's conversations
-- become threads (`bot_thread` and `project_thread`), and an automation's
-- schedules become routines.
DROP VIEW "placed_conversation";--> statement-breakpoint
ALTER TABLE "task" RENAME TO "bot_thread";--> statement-breakpoint
ALTER TABLE "channel_conversation" RENAME TO "project_thread";--> statement-breakpoint
ALTER TABLE "channel" RENAME TO "project";--> statement-breakpoint
ALTER TABLE "channel_bot" RENAME TO "project_bot";--> statement-breakpoint
ALTER TABLE "channel_member" RENAME TO "project_member";--> statement-breakpoint
ALTER TABLE "project_thread" RENAME COLUMN "channel_id" TO "project_id";--> statement-breakpoint
ALTER TABLE "notification_override" RENAME COLUMN "channel_id" TO "project_id";--> statement-breakpoint
ALTER TABLE "project_bot" RENAME COLUMN "channel_id" TO "project_id";--> statement-breakpoint
ALTER TABLE "project_member" RENAME COLUMN "channel_id" TO "project_id";--> statement-breakpoint
ALTER TABLE "project_thread" RENAME CONSTRAINT "channel_conversation_archived_valid" TO "project_thread_archived_valid";--> statement-breakpoint
ALTER TABLE "project" RENAME CONSTRAINT "channel_visibility_check" TO "project_visibility_check";--> statement-breakpoint
ALTER INDEX "task_bot_idx" RENAME TO "bot_thread_bot_idx";--> statement-breakpoint
ALTER INDEX "channel_conversation_channel_idx" RENAME TO "project_thread_project_idx";--> statement-breakpoint
ALTER INDEX "channel_conversation_main_idx" RENAME TO "project_thread_main_idx";--> statement-breakpoint
ALTER INDEX "notification_override_channel_idx" RENAME TO "notification_override_project_idx";--> statement-breakpoint
ALTER INDEX "channel_slug_idx" RENAME TO "project_slug_idx";--> statement-breakpoint
ALTER INDEX "channel_id_workspace_id_idx" RENAME TO "project_id_workspace_id_idx";--> statement-breakpoint
ALTER INDEX "channel_bot_bot_id_idx" RENAME TO "project_bot_bot_id_idx";--> statement-breakpoint
ALTER INDEX "channel_member_idx" RENAME TO "project_member_idx";--> statement-breakpoint
ALTER INDEX "channel_member_user_id_idx" RENAME TO "project_member_user_id_idx";--> statement-breakpoint
ALTER TABLE "bot_thread" RENAME CONSTRAINT "task_bot_workspace_fkey" TO "bot_thread_bot_workspace_fkey";--> statement-breakpoint
ALTER TABLE "project_thread" RENAME CONSTRAINT "channel_conversation_channel_workspace_fkey" TO "project_thread_project_workspace_fkey";--> statement-breakpoint
ALTER TABLE "project_bot" RENAME CONSTRAINT "channel_bot_channel_workspace_fkey" TO "project_bot_project_workspace_fkey";--> statement-breakpoint
ALTER TABLE "project_bot" RENAME CONSTRAINT "channel_bot_bot_workspace_fkey" TO "project_bot_bot_workspace_fkey";--> statement-breakpoint
ALTER TABLE "project_member" RENAME CONSTRAINT "channel_member_channel_workspace_fkey" TO "project_member_project_workspace_fkey";--> statement-breakpoint
ALTER TABLE "project_member" RENAME CONSTRAINT "channel_member_workspace_member_fkey" TO "project_member_workspace_member_fkey";--> statement-breakpoint
DROP INDEX "notification_override_project_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "notification_override_project_idx" ON "notification_override" ("user_id","project_id") WHERE "project_id" is not null;--> statement-breakpoint
ALTER TABLE "notification_override" DROP CONSTRAINT "notification_override_one_place", ADD CONSTRAINT "notification_override_one_place" CHECK (num_nonnulls("project_id", "bot_id") = 1);--> statement-breakpoint
-- The two kinds by their new names. Each kind row names its conversation by
-- `(id, kind)`, so its foreign key and its `kind`, which is always its own kind,
-- go while the conversations' kinds change, and come back by the new name.
ALTER TABLE "project_thread" DROP CONSTRAINT "channel_conversation_conversation_fkey";--> statement-breakpoint
ALTER TABLE "bot_thread" DROP CONSTRAINT "task_conversation_fkey";--> statement-breakpoint
ALTER TABLE "project_thread" DROP COLUMN "kind";--> statement-breakpoint
ALTER TABLE "bot_thread" DROP COLUMN "kind";--> statement-breakpoint
ALTER TABLE "conversation" DROP CONSTRAINT "conversation_kind_valid";--> statement-breakpoint
UPDATE "conversation" SET "kind" = CASE "kind"
	WHEN 'task' THEN 'bot_thread'
	WHEN 'channel_conversation' THEN 'project_thread'
	ELSE "kind"
END
WHERE "kind" IN ('task', 'channel_conversation');--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_kind_valid" CHECK ("kind" in ('bot_thread', 'project_thread', 'collaboration', 'run', 'automation_feed', 'system'));--> statement-breakpoint
ALTER TABLE "project_thread" ADD COLUMN "kind" text GENERATED ALWAYS AS ('project_thread') STORED NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_thread" ADD COLUMN "kind" text GENERATED ALWAYS AS ('bot_thread') STORED NOT NULL;--> statement-breakpoint
ALTER TABLE "project_thread" ADD CONSTRAINT "project_thread_conversation_fkey" FOREIGN KEY ("conversation_id","kind","workspace_id") REFERENCES "conversation"("id","kind","workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "bot_thread" ADD CONSTRAINT "bot_thread_conversation_fkey" FOREIGN KEY ("conversation_id","kind","workspace_id") REFERENCES "conversation"("id","kind","workspace_id") ON DELETE CASCADE;--> statement-breakpoint
-- An automation's schedule triggers are its routines: in their settings, which
-- `kind` follows, in the runs they started, and on the messages those runs posted.
ALTER TABLE "automation_trigger" DROP CONSTRAINT "automation_trigger_schedule_valid";--> statement-breakpoint
UPDATE "automation_trigger" SET "settings" = jsonb_set("settings", '{kind}', '"routine"')
WHERE "settings"->>'kind' = 'schedule';--> statement-breakpoint
ALTER TABLE "automation_trigger" ADD CONSTRAINT "automation_trigger_routine_valid" CHECK ("kind" = 'routine' or "next_scheduled_at" is null);--> statement-breakpoint
UPDATE "run" SET "trigger_kind" = 'routine', "trigger" = jsonb_set("trigger", '{kind}', '"routine"')
WHERE "trigger_kind" = 'schedule';--> statement-breakpoint
UPDATE "message" SET "automation_trigger" = jsonb_set("automation_trigger", '{triggerKind}', '"routine"')
WHERE "automation_trigger"->>'triggerKind' = 'schedule';--> statement-breakpoint
CREATE VIEW "placed_conversation" AS (select
	c.id, c.workspace_id, c.kind, c.title, c.created_at, c.updated_at,
	coalesce(t.bot_id, co.collaborator_bot_id, r.bot_id, fa.bot_id, sc.bot_id) as bot_id,
	cc.project_id,
	case c.kind
		when 'collaboration' then co.root_conversation_id
		when 'run' then rf.conversation_id
		when 'system' then null
		else c.id
	end as root_conversation_id,
	coalesce(co.parent_conversation_id, sc.served_conversation_id) as parent_conversation_id,
	coalesce(t.started_by_id, cc.started_by_id) as started_by_id,
	sc.system_bot_key,
	t.done_at,
	f.automation_id,
	coalesce(cc.main, false) as main,
	cc.archived_at
from "conversation" c
left join "bot_thread" t on t.conversation_id = c.id
left join "project_thread" cc on cc.conversation_id = c.id
left join "collaboration" co on co.conversation_id = c.id
left join "run" r on r.conversation_id = c.id
left join "automation_feed" rf on rf.automation_id = r.automation_id
left join "automation_feed" f on f.conversation_id = c.id
left join "automation" fa on fa.id = f.automation_id
left join "system_conversation" sc on sc.conversation_id = c.id);--> statement-breakpoint
-- Constraints Postgres named itself (primary keys, not-null constraints and the
-- foreign keys named for their columns) keep the old words in their names;
-- the ones a server has depend on its Postgres version, so each is renamed if it is there.
DO $$
DECLARE
	found record;
BEGIN
	FOR found IN
		SELECT conrelid::regclass AS on_table, conname AS name
		FROM pg_constraint
		WHERE connamespace = 'public'::regnamespace
			AND (conname LIKE '%channel%' OR conname LIKE 'task\_%')
			-- An event's `channel` is the stream it is published on, not a project.
			AND conrelid <> '"event"'::regclass
	LOOP
		EXECUTE format(
			'ALTER TABLE %s RENAME CONSTRAINT %I TO %I',
			found.on_table,
			found.name,
			regexp_replace(
				replace(replace(found.name, 'channel_conversation', 'project_thread'), 'channel', 'project'),
				'^task_',
				'bot_thread_'
			)
		);
	END LOOP;
END $$;--> statement-breakpoint
-- The triggers that tell a conversation and its kind row together, and those
-- that put every owner and admin in every project, name the tables they read
-- by their old names, so they are made again.
ALTER TRIGGER "task_conversation_deletion" ON "bot_thread" RENAME TO "bot_thread_conversation_deletion";--> statement-breakpoint
ALTER TRIGGER "channel_conversation_conversation_deletion" ON "project_thread" RENAME TO "project_thread_conversation_deletion";--> statement-breakpoint
CREATE OR REPLACE FUNCTION conversation_has_kind_row() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	has_kind_row boolean;
BEGIN
	IF NOT EXISTS (SELECT 1 FROM "conversation" WHERE "id" = NEW."id") THEN
		RETURN NULL;
	END IF;
	has_kind_row := CASE NEW."kind"
		WHEN 'bot_thread' THEN EXISTS (SELECT 1 FROM "bot_thread" WHERE "conversation_id" = NEW."id")
		WHEN 'project_thread' THEN EXISTS (SELECT 1 FROM "project_thread" WHERE "conversation_id" = NEW."id")
		WHEN 'collaboration' THEN EXISTS (SELECT 1 FROM "collaboration" WHERE "conversation_id" = NEW."id")
		WHEN 'run' THEN EXISTS (SELECT 1 FROM "run" WHERE "conversation_id" = NEW."id")
		WHEN 'automation_feed' THEN EXISTS (SELECT 1 FROM "automation_feed" WHERE "conversation_id" = NEW."id")
		WHEN 'system' THEN EXISTS (SELECT 1 FROM "system_conversation" WHERE "conversation_id" = NEW."id")
		ELSE false
	END;
	IF NOT has_kind_row THEN
		RAISE EXCEPTION 'conversation % is a % with no % row', NEW."id", NEW."kind", NEW."kind"
			USING ERRCODE = 'foreign_key_violation';
	END IF;
	RETURN NULL;
END;
$$;--> statement-breakpoint
DROP TRIGGER "channel_administrators" ON "project";--> statement-breakpoint
DROP TRIGGER "administrator_channels" ON "workspace_member";--> statement-breakpoint
DROP FUNCTION add_administrators_to_new_channel();--> statement-breakpoint
DROP FUNCTION add_new_administrator_to_channels();--> statement-breakpoint
DROP FUNCTION lock_channel_membership(uuid);--> statement-breakpoint
-- Serialises every write that decides whether an administrator is in a project. Without it, a project made while somebody is promoted is missed by both: each insert runs before the other commits.
CREATE FUNCTION lock_project_membership(workspace uuid) RETURNS void
LANGUAGE sql AS $$
	SELECT pg_advisory_xact_lock(hashtext('project_membership:' || workspace::text));
$$;--> statement-breakpoint
-- The owner and admins are members of every project, so `project_member` is the whole list of who is in a project.
CREATE FUNCTION add_administrators_to_new_project() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	PERFORM lock_project_membership(NEW."workspace_id");
	INSERT INTO "project_member" ("workspace_id", "project_id", "user_id")
	SELECT NEW."workspace_id", NEW."id", "user_id"
	FROM "workspace_member"
	WHERE "workspace_id" = NEW."workspace_id" AND "role" IN ('owner', 'admin')
	ON CONFLICT ("project_id", "user_id") DO NOTHING;
	RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER project_administrators
AFTER INSERT ON "project"
FOR EACH ROW EXECUTE FUNCTION add_administrators_to_new_project();--> statement-breakpoint
-- Only adds: somebody demoted keeps the projects they are in, and leaves them one at a time.
CREATE FUNCTION add_new_administrator_to_projects() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	PERFORM lock_project_membership(NEW."workspace_id");
	INSERT INTO "project_member" ("workspace_id", "project_id", "user_id")
	SELECT NEW."workspace_id", "id", NEW."user_id"
	FROM "project"
	WHERE "workspace_id" = NEW."workspace_id"
	ON CONFLICT ("project_id", "user_id") DO NOTHING;
	RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER administrator_projects
AFTER INSERT OR UPDATE OF "role" ON "workspace_member"
FOR EACH ROW WHEN (NEW."role" IN ('owner', 'admin'))
EXECUTE FUNCTION add_new_administrator_to_projects();--> statement-breakpoint
-- The events kept for clients that reconnect name channels, tasks and
-- schedules by their old words. A client whose last event is gone gets a reset
-- and fetches everything again, so they go.
DELETE FROM "event";
--> statement-breakpoint
-- ## Projects are their threads
-- A project is made of its threads and has no chat of its own: the thread
-- each project had as its own becomes an ordinary thread, keeping its title and
-- its messages, and like any other may now be archived.
DROP VIEW "placed_conversation";--> statement-breakpoint
ALTER TABLE "project_thread" DROP CONSTRAINT "project_thread_archived_valid";--> statement-breakpoint
DROP INDEX "project_thread_main_idx";--> statement-breakpoint
ALTER TABLE "project_thread" DROP COLUMN "main";--> statement-breakpoint
CREATE VIEW "placed_conversation" AS (select
	c.id, c.workspace_id, c.kind, c.title, c.created_at, c.updated_at,
	coalesce(t.bot_id, co.collaborator_bot_id, r.bot_id, fa.bot_id, sc.bot_id) as bot_id,
	cc.project_id,
	case c.kind
		when 'collaboration' then co.root_conversation_id
		when 'run' then rf.conversation_id
		when 'system' then null
		else c.id
	end as root_conversation_id,
	coalesce(co.parent_conversation_id, sc.served_conversation_id) as parent_conversation_id,
	coalesce(t.started_by_id, cc.started_by_id) as started_by_id,
	sc.system_bot_key,
	t.done_at,
	f.automation_id,
	cc.archived_at
from "conversation" c
left join "bot_thread" t on t.conversation_id = c.id
left join "project_thread" cc on cc.conversation_id = c.id
left join "collaboration" co on co.conversation_id = c.id
left join "run" r on r.conversation_id = c.id
left join "automation_feed" rf on rf.automation_id = r.automation_id
left join "automation_feed" f on f.conversation_id = c.id
left join "automation" fa on fa.id = f.automation_id
left join "system_conversation" sc on sc.conversation_id = c.id);
--> statement-breakpoint
-- ## Default projects and lead bots
-- Every bot gets a hidden default project, which it leads alone and where its
-- own threads live; every other project gets a lead bot; and a bot's threads
-- become threads of its default project, keeping their ids, so `bot_thread`
-- goes. A bot may now react to a message, with 👀 when it reads one on an
-- optional turn and stays silent.
DROP VIEW "placed_conversation";--> statement-breakpoint
ALTER TABLE "message_reaction" ADD COLUMN "bot_id" uuid;--> statement-breakpoint
ALTER TABLE "project_thread" ADD COLUMN "done_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "lead_bot_id" uuid;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "default_of_bot_id" uuid;--> statement-breakpoint
ALTER TABLE "message_reaction" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
DROP INDEX "project_slug_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "project_slug_idx" ON "project" ("workspace_id","slug") WHERE "default_of_bot_id" is null;--> statement-breakpoint
DROP INDEX "message_reaction_message_user_emoji_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "message_reaction_message_user_emoji_idx" ON "message_reaction" ("message_id","user_id","emoji") WHERE "user_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "message_reaction_message_bot_emoji_idx" ON "message_reaction" ("message_id","bot_id","emoji") WHERE "bot_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "project_default_of_bot_idx" ON "project" ("default_of_bot_id");--> statement-breakpoint
CREATE INDEX "project_lead_bot_idx" ON "project" ("lead_bot_id");--> statement-breakpoint
ALTER TABLE "message_reaction" ADD CONSTRAINT "message_reaction_bot_id_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "bot"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_lead_bot_id_bot_id_fkey" FOREIGN KEY ("lead_bot_id") REFERENCES "bot"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_default_of_bot_id_bot_id_fkey" FOREIGN KEY ("default_of_bot_id") REFERENCES "bot"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "message_reaction" ADD CONSTRAINT "message_reaction_one_reactor" CHECK (num_nonnulls("user_id", "bot_id") = 1);--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_default_led_by_its_bot" CHECK ("default_of_bot_id" is null or "lead_bot_id" = "default_of_bot_id");--> statement-breakpoint
-- Each project is led by the first public bot added to it that is still there.
UPDATE "project" AS p SET "lead_bot_id" = (
	SELECT pb."bot_id"
	FROM "project_bot" pb
	INNER JOIN "bot" b ON b."id" = pb."bot_id"
	WHERE pb."project_id" = p."id"
		AND b."visibility" = 'public'
		AND b."system_bot_key" IS NULL
		AND b."assistant_of" IS NULL
	ORDER BY pb."created_at", pb."bot_id"
	LIMIT 1
);--> statement-breakpoint
-- A project with no bot that could lead it, such as a `shared` `pod` people
-- talked in without bots, is led by a bot made for it, one per workspace,
-- with no model, so it answers nobody: those chats go on as they were until
-- someone gives it a model or chooses another lead. Its name and handle are
-- `Lead` and `lead`, or the lowest number from 2 that no bot has taken.
DO $$
DECLARE
	leaderless record;
	suffix_number integer;
	made uuid;
BEGIN
	FOR leaderless IN
		SELECT DISTINCT "workspace_id" FROM "project" WHERE "lead_bot_id" IS NULL ORDER BY "workspace_id"
	LOOP
		suffix_number := 1;
		WHILE EXISTS (
			SELECT 1 FROM "bot"
			WHERE "workspace_id" = leaderless.workspace_id
				AND "system_bot_key" IS NULL AND "assistant_of" IS NULL
				AND (lower("name") = lower(CASE WHEN suffix_number = 1 THEN 'Lead' ELSE 'Lead ' || suffix_number END)
					OR "handle" = CASE WHEN suffix_number = 1 THEN 'lead' ELSE 'lead-' || suffix_number END)
		) LOOP
			suffix_number := suffix_number + 1;
		END LOOP;
		INSERT INTO "bot" ("workspace_id", "name", "handle", "description", "color", "face", "visibility")
		VALUES (
			leaderless.workspace_id,
			CASE WHEN suffix_number = 1 THEN 'Lead' ELSE 'Lead ' || suffix_number END,
			CASE WHEN suffix_number = 1 THEN 'lead' ELSE 'lead-' || suffix_number END,
			'Leads the projects that had no bots when they were made. Give it a model, or choose another lead in each project''s settings.',
			'indigo', 'pill', 'public'
		)
		RETURNING "id" INTO made;
		INSERT INTO "project_bot" ("workspace_id", "project_id", "bot_id")
		SELECT "workspace_id", "id", made FROM "project"
		WHERE "workspace_id" = leaderless.workspace_id AND "lead_bot_id" IS NULL;
		UPDATE "project" SET "lead_bot_id" = made
		WHERE "workspace_id" = leaderless.workspace_id AND "lead_bot_id" IS NULL;
	END LOOP;
END $$;--> statement-breakpoint
-- Nobody is a member of a default project, administrators included: whoever
-- reaches its bot reaches it.
CREATE OR REPLACE FUNCTION add_administrators_to_new_project() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF NEW."default_of_bot_id" IS NOT NULL THEN
		RETURN NULL;
	END IF;
	PERFORM lock_project_membership(NEW."workspace_id");
	INSERT INTO "project_member" ("workspace_id", "project_id", "user_id")
	SELECT NEW."workspace_id", NEW."id", "user_id"
	FROM "workspace_member"
	WHERE "workspace_id" = NEW."workspace_id" AND "role" IN ('owner', 'admin')
	ON CONFLICT ("project_id", "user_id") DO NOTHING;
	RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION add_new_administrator_to_projects() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	PERFORM lock_project_membership(NEW."workspace_id");
	INSERT INTO "project_member" ("workspace_id", "project_id", "user_id")
	SELECT NEW."workspace_id", "id", NEW."user_id"
	FROM "project"
	WHERE "workspace_id" = NEW."workspace_id" AND "default_of_bot_id" IS NULL
	ON CONFLICT ("project_id", "user_id") DO NOTHING;
	RETURN NULL;
END;
$$;--> statement-breakpoint
-- Every bot but a system bot has a default project from the moment it is
-- made, with itself as its lead and only bot. Its name, slug and visibility
-- are placeholders: it is never listed or addressed by them.
CREATE FUNCTION add_default_project_to_new_bot() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	made uuid;
BEGIN
	INSERT INTO "project" ("workspace_id", "name", "slug", "visibility", "created_by_id", "lead_bot_id", "default_of_bot_id")
	VALUES (NEW."workspace_id", NEW."name", 'bot-' || NEW."id"::text, 'private', NEW."created_by_id", NEW."id", NEW."id")
	RETURNING "id" INTO made;
	INSERT INTO "project_bot" ("workspace_id", "project_id", "bot_id")
	VALUES (NEW."workspace_id", made, NEW."id");
	RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER bot_default_project
AFTER INSERT ON "bot"
FOR EACH ROW WHEN (NEW."system_bot_key" IS NULL)
EXECUTE FUNCTION add_default_project_to_new_bot();--> statement-breakpoint
INSERT INTO "project" ("workspace_id", "name", "slug", "visibility", "created_by_id", "lead_bot_id", "default_of_bot_id", "created_at")
SELECT "workspace_id", "name", 'bot-' || "id"::text, 'private', "created_by_id", "id", "id", "created_at"
FROM "bot"
WHERE "system_bot_key" IS NULL;--> statement-breakpoint
INSERT INTO "project_bot" ("workspace_id", "project_id", "bot_id", "created_at")
SELECT p."workspace_id", p."id", p."default_of_bot_id", p."created_at"
FROM "project" p
WHERE p."default_of_bot_id" IS NOT NULL;--> statement-breakpoint
-- A bot's threads become its default project's, keeping their ids, so every
-- message, turn, file and link to them stays as it was. `bot_thread` names its
-- conversation by `(id, kind)`, and deleting its row would delete the
-- conversation, so both go before the conversations change kind.
DROP TRIGGER "bot_thread_conversation_deletion" ON "bot_thread";--> statement-breakpoint
ALTER TABLE "bot_thread" DROP CONSTRAINT "bot_thread_conversation_fkey";--> statement-breakpoint
ALTER TABLE "conversation" DROP CONSTRAINT "conversation_kind_valid";--> statement-breakpoint
UPDATE "conversation" SET "kind" = 'project_thread' WHERE "kind" = 'bot_thread';--> statement-breakpoint
INSERT INTO "project_thread" ("conversation_id", "workspace_id", "project_id", "started_by_id", "done_at")
SELECT t."conversation_id", t."workspace_id", p."id", t."started_by_id", t."done_at"
FROM "bot_thread" t
INNER JOIN "project" p ON p."default_of_bot_id" = t."bot_id";--> statement-breakpoint
DROP TABLE "bot_thread";--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_kind_valid" CHECK ("kind" in ('project_thread', 'collaboration', 'run', 'automation_feed', 'system'));--> statement-breakpoint
CREATE OR REPLACE FUNCTION conversation_has_kind_row() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	has_kind_row boolean;
BEGIN
	IF NOT EXISTS (SELECT 1 FROM "conversation" WHERE "id" = NEW."id") THEN
		RETURN NULL;
	END IF;
	has_kind_row := CASE NEW."kind"
		WHEN 'project_thread' THEN EXISTS (SELECT 1 FROM "project_thread" WHERE "conversation_id" = NEW."id")
		WHEN 'collaboration' THEN EXISTS (SELECT 1 FROM "collaboration" WHERE "conversation_id" = NEW."id")
		WHEN 'run' THEN EXISTS (SELECT 1 FROM "run" WHERE "conversation_id" = NEW."id")
		WHEN 'automation_feed' THEN EXISTS (SELECT 1 FROM "automation_feed" WHERE "conversation_id" = NEW."id")
		WHEN 'system' THEN EXISTS (SELECT 1 FROM "system_conversation" WHERE "conversation_id" = NEW."id")
		ELSE false
	END;
	IF NOT has_kind_row THEN
		RAISE EXCEPTION 'conversation % is a % with no % row', NEW."id", NEW."kind", NEW."kind"
			USING ERRCODE = 'foreign_key_violation';
	END IF;
	RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE VIEW "placed_conversation" AS (select
	c.id, c.workspace_id, c.kind, c.title, c.created_at, c.updated_at,
	coalesce(p.default_of_bot_id, co.collaborator_bot_id, r.bot_id, fa.bot_id, sc.bot_id) as bot_id,
	cc.project_id,
	case c.kind
		when 'collaboration' then co.root_conversation_id
		when 'run' then rf.conversation_id
		when 'system' then null
		else c.id
	end as root_conversation_id,
	coalesce(co.parent_conversation_id, sc.served_conversation_id) as parent_conversation_id,
	cc.started_by_id,
	sc.system_bot_key,
	cc.done_at,
	f.automation_id,
	cc.archived_at
from "conversation" c
left join "project_thread" cc on cc.conversation_id = c.id
left join "project" p on p.id = cc.project_id
left join "collaboration" co on co.conversation_id = c.id
left join "run" r on r.conversation_id = c.id
left join "automation_feed" rf on rf.automation_id = r.automation_id
left join "automation_feed" f on f.conversation_id = c.id
left join "automation" fa on fa.id = f.automation_id
left join "system_conversation" sc on sc.conversation_id = c.id);
--> statement-breakpoint
-- ## Projects own resources
-- A bot's computer, connections (its GitHub app among them), automations and
-- allowed hosts become its default project's, keeping their ids. Nothing is
-- made again: each computer keeps its provider's id and its folders, so no
-- machine or work is lost; tool calls, waiting approvals and GitHub triggers
-- still name their connections; and OAuth sign-ins carry on as they were.
CREATE TABLE "project_allowed_host" (
	"workspace_id" uuid NOT NULL,
	"project_id" uuid,
	"host" text,
	"added_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_allowed_host_pkey" PRIMARY KEY("project_id","host")
);
--> statement-breakpoint
ALTER TABLE "computer" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "automation" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "connection" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "project_allowed_host" ADD CONSTRAINT "project_allowed_host_added_by_id_user_id_fkey" FOREIGN KEY ("added_by_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "project_allowed_host" ADD CONSTRAINT "project_allowed_host_project_workspace_fkey" FOREIGN KEY ("project_id","workspace_id") REFERENCES "project"("id","workspace_id") ON DELETE CASCADE;--> statement-breakpoint
UPDATE "computer" SET "project_id" = "project"."id"
FROM "project" WHERE "project"."default_of_bot_id" = "computer"."bot_id";--> statement-breakpoint
-- A `shared` `pod`'s computer, which waited for its `pod` to become a project,
-- is that project's, with the hosts the `pod` allowed it.
UPDATE "computer" SET "project_id" = "pod_id" WHERE "pod_id" IS NOT NULL;--> statement-breakpoint
INSERT INTO "project_allowed_host" ("workspace_id", "project_id", "host", "added_by_id", "created_at")
SELECT "workspace_id", "pod_id", "host", "added_by_id", "created_at" FROM "sandbox_pod_allowed_host";--> statement-breakpoint
DROP TABLE "sandbox_pod_allowed_host";--> statement-breakpoint
UPDATE "connection" SET "project_id" = "project"."id"
FROM "project" WHERE "project"."default_of_bot_id" = "connection"."bot_id";--> statement-breakpoint
-- A `shared` `pod`'s connections that waited for it are that project's too.
UPDATE "connection" SET "project_id" = "pod_id" WHERE "pod_id" IS NOT NULL;--> statement-breakpoint
UPDATE "automation" SET "project_id" = "project"."id"
FROM "project" WHERE "project"."default_of_bot_id" = "automation"."bot_id";--> statement-breakpoint
INSERT INTO "project_allowed_host" ("workspace_id", "project_id", "host", "added_by_id", "created_at")
SELECT "host"."workspace_id", "project"."id", "host"."host", "host"."added_by_id", "host"."created_at"
FROM "bot_allowed_host" AS "host"
JOIN "project" ON "project"."default_of_bot_id" = "host"."bot_id";
--> statement-breakpoint
-- ## Projects own resources: keys
-- What was keyed by bot is keyed by project now. A run goes with its
-- automation, which is only deleted, rather than marked deleted, with its
-- project; an automation is made by whichever bot works in its project.
DROP VIEW "placed_conversation";--> statement-breakpoint
ALTER TABLE "computer" DROP CONSTRAINT "computer_bot_workspace_fkey";--> statement-breakpoint
ALTER TABLE "automation" DROP CONSTRAINT "automation_bot_workspace_fkey";--> statement-breakpoint
ALTER TABLE "connection" DROP CONSTRAINT "connection_bot_workspace_fkey";--> statement-breakpoint
DROP TABLE "bot_allowed_host";--> statement-breakpoint
ALTER TABLE "automation" DROP CONSTRAINT "automation_created_by_bot_valid";--> statement-breakpoint
DROP INDEX "computer_bot_id_idx";--> statement-breakpoint
DROP INDEX "automation_bot_name_idx";--> statement-breakpoint
DROP INDEX "connection_github_bot_idx";--> statement-breakpoint
ALTER TABLE "automation" DROP COLUMN "bot_id";--> statement-breakpoint
ALTER TABLE "connection" DROP CONSTRAINT "connection_owner_check";--> statement-breakpoint
ALTER TABLE "connection" DROP COLUMN "bot_id";--> statement-breakpoint
ALTER TABLE "connection" DROP COLUMN "pod_id";--> statement-breakpoint
ALTER TABLE "computer" DROP CONSTRAINT "computer_owner_check";--> statement-breakpoint
ALTER TABLE "computer" DROP COLUMN "pod_id";--> statement-breakpoint
ALTER TABLE "computer" DROP COLUMN "bot_id";--> statement-breakpoint
ALTER TABLE "computer" ALTER COLUMN "project_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "automation" ALTER COLUMN "project_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "connection" ALTER COLUMN "project_id" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "computer_project_id_idx" ON "computer" ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "automation_project_name_idx" ON "automation" ("project_id","name") WHERE "deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "connection_github_project_idx" ON "connection" ("project_id") WHERE "kind" = 'github';--> statement-breakpoint
CREATE UNIQUE INDEX "connection_name_idx" ON "connection" ("project_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "connection_handle_idx" ON "connection" ("project_id","handle");--> statement-breakpoint
ALTER TABLE "computer" ADD CONSTRAINT "computer_project_workspace_fkey" FOREIGN KEY ("project_id","workspace_id") REFERENCES "project"("id","workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "automation" ADD CONSTRAINT "automation_created_by_bot_id_bot_id_fkey" FOREIGN KEY ("created_by_bot_id") REFERENCES "bot"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "automation" ADD CONSTRAINT "automation_project_workspace_fkey" FOREIGN KEY ("project_id","workspace_id") REFERENCES "project"("id","workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "run" DROP CONSTRAINT "run_automation_id_automation_id_fkey", ADD CONSTRAINT "run_automation_id_automation_id_fkey" FOREIGN KEY ("automation_id") REFERENCES "automation"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "connection" ADD CONSTRAINT "connection_project_workspace_fkey" FOREIGN KEY ("project_id","workspace_id") REFERENCES "project"("id","workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "run" DROP CONSTRAINT "run_automation_workspace_fkey", ADD CONSTRAINT "run_automation_workspace_fkey" FOREIGN KEY ("automation_id","workspace_id") REFERENCES "automation"("id","workspace_id") ON DELETE CASCADE;--> statement-breakpoint
CREATE VIEW "placed_conversation" AS (select
	c.id, c.workspace_id, c.kind, c.title, c.created_at, c.updated_at,
	coalesce(p.default_of_bot_id, co.collaborator_bot_id, sc.bot_id) as bot_id,
	p.id as project_id,
	case c.kind
		when 'collaboration' then co.root_conversation_id
		when 'run' then rf.conversation_id
		when 'system' then null
		else c.id
	end as root_conversation_id,
	coalesce(co.parent_conversation_id, sc.served_conversation_id) as parent_conversation_id,
	cc.started_by_id,
	sc.system_bot_key,
	cc.done_at,
	f.automation_id,
	cc.archived_at
from "conversation" c
left join "project_thread" cc on cc.conversation_id = c.id
left join "collaboration" co on co.conversation_id = c.id
left join "run" r on r.conversation_id = c.id
left join "automation_feed" rf on rf.automation_id = r.automation_id
left join "automation_feed" f on f.conversation_id = c.id
left join "automation" a on a.id = coalesce(r.automation_id, f.automation_id)
left join "project" p on p.id = coalesce(cc.project_id, a.project_id)
left join "system_conversation" sc on sc.conversation_id = c.id);
--> statement-breakpoint
-- ## Fresh start requirements
ALTER TABLE "automation_trigger" DROP CONSTRAINT "automation_trigger_secret_valid", ADD CONSTRAINT "automation_trigger_secret_valid" CHECK ("secret_encrypted" is null or "kind" = 'webhook');--> statement-breakpoint
-- A webhook trigger main kept only a digest of the secret for has lost its
-- secret with the digest, and a trigger with no secret answers anyone who has
-- its address. Its automation is paused, and its routines with it, and its
-- secret is one nobody knows: a placeholder no key opens, which the server
-- replaces with a random secret sealed under its own key when it starts (see
-- `WebhookAuthentication`). It refuses every caller until someone gives it a
-- new secret.
UPDATE "automation" SET "state" = 'paused', "updated_at" = now()
WHERE "state" = 'enabled' AND "id" IN (
	SELECT "automation_id" FROM "automation_trigger"
	WHERE "secret_digest" IS NOT NULL AND "secret_encrypted" IS NULL
);--> statement-breakpoint
UPDATE "automation_trigger" SET "next_scheduled_at" = NULL
WHERE "next_scheduled_at" IS NOT NULL AND "automation_id" IN (
	SELECT "automation_id" FROM "automation_trigger"
	WHERE "secret_digest" IS NOT NULL AND "secret_encrypted" IS NULL
);--> statement-breakpoint
UPDATE "automation_trigger" SET "secret_encrypted" = 'unsealed', "secret_digest" = NULL
WHERE "secret_digest" IS NOT NULL AND "secret_encrypted" IS NULL;--> statement-breakpoint

ALTER TABLE "automation_trigger" DROP CONSTRAINT "automation_trigger_digest_valid";--> statement-breakpoint
ALTER TABLE "automation_trigger" DROP COLUMN "secret_digest";--> statement-breakpoint
-- A computer made before computers recorded their image was made from an
-- image nobody knows now, so it counts as behind and is upgraded once idle.
UPDATE "computer" SET "image" = 'unknown' WHERE "image" IS NULL;--> statement-breakpoint
ALTER TABLE "computer" ALTER COLUMN "image" SET NOT NULL;--> statement-breakpoint
-- A thread nobody started, such as a `pod`'s main chat, was started by its
-- project's creator, or, when they are gone, by the workspace's owner.
UPDATE "project_thread" SET "started_by_id" = coalesce("project"."created_by_id", (
	SELECT "workspace_member"."user_id" FROM "workspace_member"
	WHERE "workspace_member"."workspace_id" = "project"."workspace_id" AND "workspace_member"."role" = 'owner'
	ORDER BY "workspace_member"."created_at" LIMIT 1
))
FROM "project" WHERE "project"."id" = "project_thread"."project_id" AND "project_thread"."started_by_id" IS NULL;--> statement-breakpoint
ALTER TABLE "project_thread" ALTER COLUMN "started_by_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "project" ALTER COLUMN "lead_bot_id" SET NOT NULL;--> statement-breakpoint
-- Checked at commit, which Drizzle can't declare: deleting a bot deletes its
-- default project, which it leads, in the same statement.
ALTER TABLE "project" DROP CONSTRAINT "project_lead_bot_id_bot_id_fkey", ADD CONSTRAINT "project_lead_bot_id_bot_id_fkey" FOREIGN KEY ("lead_bot_id") REFERENCES "bot"("id") DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
-- ## Chats by their glossary name
-- Conversations, and projects' threads, are chats: the glossary's one word for
-- anywhere messages are posted. Everything named for them is renamed, keeping
-- every row. A project's chat is now the kind `project_chat`.
DROP VIEW "placed_conversation";--> statement-breakpoint
ALTER TABLE "conversation" RENAME TO "chat";--> statement-breakpoint
ALTER TABLE "conversation_participant" RENAME TO "chat_participant";--> statement-breakpoint
ALTER TABLE "conversation_read" RENAME TO "chat_read";--> statement-breakpoint
ALTER TABLE "project_thread" RENAME TO "project_chat";--> statement-breakpoint
ALTER TABLE "system_conversation" RENAME TO "system_chat";--> statement-breakpoint
ALTER TABLE "project_chat" DROP CONSTRAINT "project_thread_conversation_fkey";--> statement-breakpoint
ALTER TABLE "model_request" RENAME COLUMN "conversation_id" TO "chat_id";--> statement-breakpoint
ALTER TABLE "automation_feed" RENAME COLUMN "conversation_id" TO "chat_id";--> statement-breakpoint
ALTER TABLE "run" RENAME COLUMN "conversation_id" TO "chat_id";--> statement-breakpoint
ALTER TABLE "compaction" RENAME COLUMN "conversation_id" TO "chat_id";--> statement-breakpoint
ALTER TABLE "chat_participant" RENAME COLUMN "conversation_id" TO "chat_id";--> statement-breakpoint
ALTER TABLE "chat_read" RENAME COLUMN "conversation_id" TO "chat_id";--> statement-breakpoint
ALTER TABLE "collaboration" RENAME COLUMN "conversation_id" TO "chat_id";--> statement-breakpoint
ALTER TABLE "collaboration" RENAME COLUMN "parent_conversation_id" TO "parent_chat_id";--> statement-breakpoint
ALTER TABLE "collaboration" RENAME COLUMN "root_conversation_id" TO "root_chat_id";--> statement-breakpoint
ALTER TABLE "message" RENAME COLUMN "conversation_id" TO "chat_id";--> statement-breakpoint
ALTER TABLE "project_chat" RENAME COLUMN "conversation_id" TO "chat_id";--> statement-breakpoint
ALTER TABLE "system_chat" RENAME COLUMN "conversation_id" TO "chat_id";--> statement-breakpoint
ALTER TABLE "system_chat" RENAME COLUMN "served_conversation_id" TO "served_chat_id";--> statement-breakpoint
ALTER TABLE "tool_call" RENAME COLUMN "conversation_id" TO "chat_id";--> statement-breakpoint
ALTER TABLE "turn" RENAME COLUMN "conversation_id" TO "chat_id";--> statement-breakpoint
ALTER TABLE "file" RENAME COLUMN "conversation_id" TO "chat_id";--> statement-breakpoint
ALTER TABLE "chat_participant" RENAME CONSTRAINT "conversation_participant_one_identity" TO "chat_participant_one_identity";--> statement-breakpoint
ALTER INDEX "model_request_conversation_idx" RENAME TO "model_request_chat_idx";--> statement-breakpoint
ALTER INDEX "run_conversation_idx" RENAME TO "run_chat_idx";--> statement-breakpoint
ALTER INDEX "conversation_id_kind_idx" RENAME TO "chat_id_kind_idx";--> statement-breakpoint
ALTER INDEX "conversation_id_kind_workspace_idx" RENAME TO "chat_id_kind_workspace_idx";--> statement-breakpoint
ALTER INDEX "conversation_workspace_created_at_idx" RENAME TO "chat_workspace_created_at_idx";--> statement-breakpoint
ALTER INDEX "conversation_workspace_updated_at_idx" RENAME TO "chat_workspace_updated_at_idx";--> statement-breakpoint
ALTER INDEX "conversation_participant_user_idx" RENAME TO "chat_participant_user_idx";--> statement-breakpoint
ALTER INDEX "conversation_participant_bot_idx" RENAME TO "chat_participant_bot_idx";--> statement-breakpoint
ALTER INDEX "conversation_read_user_conversation_idx" RENAME TO "chat_read_user_chat_idx";--> statement-breakpoint
ALTER INDEX "collaboration_conversation_idx" RENAME TO "collaboration_chat_idx";--> statement-breakpoint
ALTER INDEX "message_conversation_created_at_idx" RENAME TO "message_chat_created_at_idx";--> statement-breakpoint
ALTER INDEX "project_thread_project_idx" RENAME TO "project_chat_project_idx";--> statement-breakpoint
ALTER INDEX "system_conversation_served_key_idx" RENAME TO "system_chat_served_key_idx";--> statement-breakpoint
ALTER INDEX "turn_conversation_started_at_idx" RENAME TO "turn_chat_started_at_idx";--> statement-breakpoint
ALTER INDEX "file_conversation_updated_at_idx" RENAME TO "file_chat_updated_at_idx";--> statement-breakpoint
ALTER TABLE "automation_feed" RENAME CONSTRAINT "automation_feed_conversation_fkey" TO "automation_feed_chat_fkey";--> statement-breakpoint
ALTER TABLE "run" RENAME CONSTRAINT "run_conversation_fkey" TO "run_chat_fkey";--> statement-breakpoint
ALTER TABLE "collaboration" RENAME CONSTRAINT "collaboration_conversation_fkey" TO "collaboration_chat_fkey";--> statement-breakpoint
ALTER TABLE "project_chat" RENAME CONSTRAINT "project_thread_project_workspace_fkey" TO "project_chat_project_workspace_fkey";--> statement-breakpoint
ALTER TABLE "system_chat" RENAME CONSTRAINT "system_conversation_conversation_fkey" TO "system_chat_chat_fkey";--> statement-breakpoint
ALTER TABLE "system_chat" RENAME CONSTRAINT "system_conversation_bot_workspace_fkey" TO "system_chat_bot_workspace_fkey";--> statement-breakpoint
ALTER TABLE "automation_feed" RENAME CONSTRAINT "automation_feed_conversation_id_not_null" TO "automation_feed_chat_id_not_null";--> statement-breakpoint
ALTER TABLE "collaboration" RENAME CONSTRAINT "collaboration_child_conversation_id_not_null" TO "collaboration_chat_id_not_null";--> statement-breakpoint
ALTER TABLE "collaboration" RENAME CONSTRAINT "collaboration_parent_conversation_id_conversation_id_fkey" TO "collaboration_parent_chat_id_chat_id_fkey";--> statement-breakpoint
ALTER TABLE "collaboration" RENAME CONSTRAINT "collaboration_parent_conversation_id_not_null" TO "collaboration_parent_chat_id_not_null";--> statement-breakpoint
ALTER TABLE "collaboration" RENAME CONSTRAINT "collaboration_root_conversation_id_conversation_id_fkey" TO "collaboration_root_chat_id_chat_id_fkey";--> statement-breakpoint
ALTER TABLE "collaboration" RENAME CONSTRAINT "collaboration_root_conversation_id_not_null" TO "collaboration_root_chat_id_not_null";--> statement-breakpoint
ALTER TABLE "compaction" RENAME CONSTRAINT "compaction_conversation_id_conversation_id_fkey" TO "compaction_chat_id_chat_id_fkey";--> statement-breakpoint
ALTER TABLE "compaction" RENAME CONSTRAINT "compaction_conversation_id_not_null" TO "compaction_chat_id_not_null";--> statement-breakpoint
ALTER TABLE "chat" RENAME CONSTRAINT "conversation_created_at_not_null" TO "chat_created_at_not_null";--> statement-breakpoint
ALTER TABLE "chat" RENAME CONSTRAINT "conversation_id_not_null" TO "chat_id_not_null";--> statement-breakpoint
ALTER TABLE "chat" RENAME CONSTRAINT "conversation_pkey" TO "chat_pkey";--> statement-breakpoint
ALTER TABLE "chat" RENAME CONSTRAINT "conversation_title_not_null" TO "chat_title_not_null";--> statement-breakpoint
ALTER TABLE "chat" RENAME CONSTRAINT "conversation_type_not_null" TO "chat_kind_not_null";--> statement-breakpoint
ALTER TABLE "chat" RENAME CONSTRAINT "conversation_updated_at_not_null" TO "chat_updated_at_not_null";--> statement-breakpoint
ALTER TABLE "chat" RENAME CONSTRAINT "conversation_workspace_id_not_null" TO "chat_workspace_id_not_null";--> statement-breakpoint
ALTER TABLE "chat" RENAME CONSTRAINT "conversation_workspace_id_workspace_id_fkey" TO "chat_workspace_id_workspace_id_fkey";--> statement-breakpoint
ALTER TABLE "chat_participant" RENAME CONSTRAINT "conversation_participant_bot_id_bot_id_fkey" TO "chat_participant_bot_id_bot_id_fkey";--> statement-breakpoint
ALTER TABLE "chat_participant" RENAME CONSTRAINT "conversation_participant_conversation_id_conversation_id_fkey" TO "chat_participant_chat_id_chat_id_fkey";--> statement-breakpoint
ALTER TABLE "chat_participant" RENAME CONSTRAINT "conversation_participant_conversation_id_not_null" TO "chat_participant_chat_id_not_null";--> statement-breakpoint
ALTER TABLE "chat_participant" RENAME CONSTRAINT "conversation_participant_created_at_not_null" TO "chat_participant_created_at_not_null";--> statement-breakpoint
ALTER TABLE "chat_participant" RENAME CONSTRAINT "conversation_participant_id_not_null" TO "chat_participant_id_not_null";--> statement-breakpoint
ALTER TABLE "chat_participant" RENAME CONSTRAINT "conversation_participant_pkey" TO "chat_participant_pkey";--> statement-breakpoint
ALTER TABLE "chat_participant" RENAME CONSTRAINT "conversation_participant_user_id_user_id_fkey" TO "chat_participant_user_id_user_id_fkey";--> statement-breakpoint
ALTER TABLE "chat_read" RENAME CONSTRAINT "conversation_read_conversation_id_conversation_id_fkey" TO "chat_read_chat_id_chat_id_fkey";--> statement-breakpoint
ALTER TABLE "chat_read" RENAME CONSTRAINT "conversation_read_conversation_id_not_null" TO "chat_read_chat_id_not_null";--> statement-breakpoint
ALTER TABLE "chat_read" RENAME CONSTRAINT "conversation_read_created_at_not_null" TO "chat_read_created_at_not_null";--> statement-breakpoint
ALTER TABLE "chat_read" RENAME CONSTRAINT "conversation_read_id_not_null" TO "chat_read_id_not_null";--> statement-breakpoint
ALTER TABLE "chat_read" RENAME CONSTRAINT "conversation_read_pkey" TO "chat_read_pkey";--> statement-breakpoint
ALTER TABLE "chat_read" RENAME CONSTRAINT "conversation_read_read_through_not_null" TO "chat_read_read_through_not_null";--> statement-breakpoint
ALTER TABLE "chat_read" RENAME CONSTRAINT "conversation_read_updated_at_not_null" TO "chat_read_updated_at_not_null";--> statement-breakpoint
ALTER TABLE "chat_read" RENAME CONSTRAINT "conversation_read_user_id_not_null" TO "chat_read_user_id_not_null";--> statement-breakpoint
ALTER TABLE "chat_read" RENAME CONSTRAINT "conversation_read_user_id_user_id_fkey" TO "chat_read_user_id_user_id_fkey";--> statement-breakpoint
ALTER TABLE "file" RENAME CONSTRAINT "file_conversation_id_conversation_id_fkey" TO "file_chat_id_chat_id_fkey";--> statement-breakpoint
ALTER TABLE "file" RENAME CONSTRAINT "file_conversation_id_not_null" TO "file_chat_id_not_null";--> statement-breakpoint
ALTER TABLE "message" RENAME CONSTRAINT "message_conversation_id_conversation_id_fkey" TO "message_chat_id_chat_id_fkey";--> statement-breakpoint
ALTER TABLE "message" RENAME CONSTRAINT "message_conversation_id_not_null" TO "message_chat_id_not_null";--> statement-breakpoint
ALTER TABLE "project_chat" RENAME CONSTRAINT "project_thread_conversation_id_not_null" TO "project_chat_chat_id_not_null";--> statement-breakpoint
ALTER TABLE "project_chat" RENAME CONSTRAINT "project_thread_pkey" TO "project_chat_pkey";--> statement-breakpoint
ALTER TABLE "project_chat" RENAME CONSTRAINT "project_thread_project_id_not_null" TO "project_chat_project_id_not_null";--> statement-breakpoint
ALTER TABLE "project_chat" RENAME CONSTRAINT "project_thread_started_by_id_not_null" TO "project_chat_started_by_id_not_null";--> statement-breakpoint
ALTER TABLE "project_chat" RENAME CONSTRAINT "project_thread_started_by_id_user_id_fkey" TO "project_chat_started_by_id_user_id_fkey";--> statement-breakpoint
ALTER TABLE "project_chat" RENAME CONSTRAINT "project_thread_workspace_id_not_null" TO "project_chat_workspace_id_not_null";--> statement-breakpoint
ALTER TABLE "run" RENAME CONSTRAINT "run_conversation_id_not_null" TO "run_chat_id_not_null";--> statement-breakpoint
ALTER TABLE "system_chat" RENAME CONSTRAINT "system_conversation_bot_id_not_null" TO "system_chat_bot_id_not_null";--> statement-breakpoint
ALTER TABLE "system_chat" RENAME CONSTRAINT "system_conversation_conversation_id_not_null" TO "system_chat_chat_id_not_null";--> statement-breakpoint
ALTER TABLE "system_chat" RENAME CONSTRAINT "system_conversation_kind_not_null" TO "system_chat_kind_not_null";--> statement-breakpoint
ALTER TABLE "system_chat" RENAME CONSTRAINT "system_conversation_pkey" TO "system_chat_pkey";--> statement-breakpoint
ALTER TABLE "system_chat" RENAME CONSTRAINT "system_conversation_served_conversation_id_conversation_id_fkey" TO "system_chat_served_chat_id_chat_id_fkey";--> statement-breakpoint
ALTER TABLE "system_chat" RENAME CONSTRAINT "system_conversation_served_conversation_id_not_null" TO "system_chat_served_chat_id_not_null";--> statement-breakpoint
ALTER TABLE "system_chat" RENAME CONSTRAINT "system_conversation_system_bot_key_not_null" TO "system_chat_system_bot_key_not_null";--> statement-breakpoint
ALTER TABLE "system_chat" RENAME CONSTRAINT "system_conversation_workspace_id_not_null" TO "system_chat_workspace_id_not_null";--> statement-breakpoint
ALTER TABLE "tool_call" RENAME CONSTRAINT "tool_call_conversation_id_conversation_id_fkey" TO "tool_call_chat_id_chat_id_fkey";--> statement-breakpoint
ALTER TABLE "tool_call" RENAME CONSTRAINT "tool_call_conversation_id_not_null" TO "tool_call_chat_id_not_null";--> statement-breakpoint
ALTER TABLE "turn" RENAME CONSTRAINT "turn_conversation_id_conversation_id_fkey" TO "turn_chat_id_chat_id_fkey";--> statement-breakpoint
ALTER TABLE "turn" RENAME CONSTRAINT "turn_conversation_id_not_null" TO "turn_chat_id_not_null";--> statement-breakpoint
-- The kind `project_thread` is now `project_chat`: the kind row's own `kind`
-- follows its name, and the chats it names are moved with it, once the key
-- between them is gone.
ALTER TABLE "project_chat" DROP COLUMN "kind";--> statement-breakpoint
ALTER TABLE "chat" DROP CONSTRAINT "conversation_kind_valid";--> statement-breakpoint
UPDATE "chat" SET "kind" = 'project_chat' WHERE "kind" = 'project_thread';--> statement-breakpoint
ALTER TABLE "chat" ADD CONSTRAINT "chat_kind_valid" CHECK ("kind" in ('project_chat', 'collaboration', 'run', 'automation_feed', 'system'));--> statement-breakpoint
ALTER TABLE "project_chat" ADD COLUMN "kind" text GENERATED ALWAYS AS ('project_chat') STORED NOT NULL;--> statement-breakpoint
ALTER TABLE "project_chat" ADD CONSTRAINT "project_chat_chat_fkey" FOREIGN KEY ("chat_id","kind","workspace_id") REFERENCES "chat"("id","kind","workspace_id") ON DELETE CASCADE;--> statement-breakpoint
-- The triggers and their functions name the tables in their bodies, so each is
-- made again by its new name. A deleted chat's files are kept under `chats/<id>`.
DROP TRIGGER "conversation_blob_deletion" ON "chat";--> statement-breakpoint
DROP FUNCTION queue_deleted_conversation_blobs();--> statement-breakpoint
CREATE FUNCTION queue_deleted_chat_blobs() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	INSERT INTO "blob_deletion" ("prefix")
	SELECT 'chats/' || "id"::text FROM deleted_chats;
	RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER chat_blob_deletion
AFTER DELETE ON "chat"
REFERENCING OLD TABLE AS deleted_chats
FOR EACH STATEMENT EXECUTE FUNCTION queue_deleted_chat_blobs();
--> statement-breakpoint
DROP TRIGGER "conversation_has_kind_row" ON "chat";--> statement-breakpoint
DROP FUNCTION conversation_has_kind_row();--> statement-breakpoint
-- A chat must have the kind row its kind says, checked at commit, as the kind
-- row is written after the chat in the same transaction. One deleted again
-- before commit needs none.
CREATE FUNCTION chat_has_kind_row() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	has_kind_row boolean;
BEGIN
	IF NOT EXISTS (SELECT 1 FROM "chat" WHERE "id" = NEW."id") THEN
		RETURN NULL;
	END IF;
	has_kind_row := CASE NEW."kind"
		WHEN 'project_chat' THEN EXISTS (SELECT 1 FROM "project_chat" WHERE "chat_id" = NEW."id")
		WHEN 'collaboration' THEN EXISTS (SELECT 1 FROM "collaboration" WHERE "chat_id" = NEW."id")
		WHEN 'run' THEN EXISTS (SELECT 1 FROM "run" WHERE "chat_id" = NEW."id")
		WHEN 'automation_feed' THEN EXISTS (SELECT 1 FROM "automation_feed" WHERE "chat_id" = NEW."id")
		WHEN 'system' THEN EXISTS (SELECT 1 FROM "system_chat" WHERE "chat_id" = NEW."id")
		ELSE false
	END;
	IF NOT has_kind_row THEN
		RAISE EXCEPTION 'chat % is a % with no % row', NEW."id", NEW."kind", NEW."kind"
			USING ERRCODE = 'foreign_key_violation';
	END IF;
	RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER chat_has_kind_row
AFTER INSERT ON "chat"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION chat_has_kind_row();
--> statement-breakpoint
-- A kind row goes with its chat, by its foreign key; the chat goes with its
-- kind row, however that is deleted, by this.
DROP TRIGGER "automation_feed_conversation_deletion" ON "automation_feed";--> statement-breakpoint
DROP TRIGGER "collaboration_conversation_deletion" ON "collaboration";--> statement-breakpoint
DROP TRIGGER "project_thread_conversation_deletion" ON "project_chat";--> statement-breakpoint
DROP TRIGGER "run_conversation_deletion" ON "run";--> statement-breakpoint
DROP TRIGGER "system_conversation_conversation_deletion" ON "system_chat";--> statement-breakpoint
DROP FUNCTION delete_conversation_of_kind_row();--> statement-breakpoint
CREATE FUNCTION delete_chat_of_kind_row() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	DELETE FROM "chat" WHERE "id" = OLD."chat_id";
	RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER project_chat_chat_deletion
AFTER DELETE ON "project_chat"
FOR EACH ROW EXECUTE FUNCTION delete_chat_of_kind_row();
--> statement-breakpoint
CREATE TRIGGER collaboration_chat_deletion
AFTER DELETE ON "collaboration"
FOR EACH ROW EXECUTE FUNCTION delete_chat_of_kind_row();
--> statement-breakpoint
CREATE TRIGGER run_chat_deletion
AFTER DELETE ON "run"
FOR EACH ROW EXECUTE FUNCTION delete_chat_of_kind_row();
--> statement-breakpoint
CREATE TRIGGER automation_feed_chat_deletion
AFTER DELETE ON "automation_feed"
FOR EACH ROW EXECUTE FUNCTION delete_chat_of_kind_row();
--> statement-breakpoint
CREATE TRIGGER system_chat_chat_deletion
AFTER DELETE ON "system_chat"
FOR EACH ROW EXECUTE FUNCTION delete_chat_of_kind_row();
--> statement-breakpoint
CREATE VIEW "placed_chat" AS (select
	c.id, c.workspace_id, c.kind, c.title, c.created_at, c.updated_at,
	coalesce(p.default_of_bot_id, co.collaborator_bot_id, sc.bot_id) as bot_id,
	p.id as project_id,
	case c.kind
		when 'collaboration' then co.root_chat_id
		when 'run' then rf.chat_id
		when 'system' then null
		else c.id
	end as root_chat_id,
	coalesce(co.parent_chat_id, sc.served_chat_id) as parent_chat_id,
	cc.started_by_id,
	sc.system_bot_key,
	cc.done_at,
	f.automation_id,
	cc.archived_at
from "chat" c
left join "project_chat" cc on cc.chat_id = c.id
left join "collaboration" co on co.chat_id = c.id
left join "run" r on r.chat_id = c.id
left join "automation_feed" rf on rf.automation_id = r.automation_id
left join "automation_feed" f on f.chat_id = c.id
left join "automation" a on a.id = coalesce(r.automation_id, f.automation_id)
left join "project" p on p.id = coalesce(cc.project_id, a.project_id)
left join "system_chat" sc on sc.chat_id = c.id);
--> statement-breakpoint
-- ## Chats resolved
-- A project's chat marked done is now resolved, the glossary's word; archiving,
-- the other way a chat left its list, is folded into it.
DROP VIEW "placed_chat";--> statement-breakpoint
ALTER TABLE "project_chat" RENAME COLUMN "done_at" TO "resolved_at";--> statement-breakpoint
-- An archived chat was one taken off the list for good. A resolved chat leaves
-- the list too, and can be reopened, so archived chats become resolved ones.
UPDATE "project_chat" SET "resolved_at" = coalesce("resolved_at", "archived_at") WHERE "archived_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "project_chat" DROP COLUMN "archived_at";--> statement-breakpoint
CREATE VIEW "placed_chat" AS (select
	c.id, c.workspace_id, c.kind, c.title, c.created_at, c.updated_at,
	coalesce(p.default_of_bot_id, co.collaborator_bot_id, sc.bot_id) as bot_id,
	p.id as project_id,
	case c.kind
		when 'collaboration' then co.root_chat_id
		when 'run' then rf.chat_id
		when 'system' then null
		else c.id
	end as root_chat_id,
	coalesce(co.parent_chat_id, sc.served_chat_id) as parent_chat_id,
	cc.started_by_id,
	sc.system_bot_key,
	cc.resolved_at,
	f.automation_id
from "chat" c
left join "project_chat" cc on cc.chat_id = c.id
left join "collaboration" co on co.chat_id = c.id
left join "run" r on r.chat_id = c.id
left join "automation_feed" rf on rf.automation_id = r.automation_id
left join "automation_feed" f on f.chat_id = c.id
left join "automation" a on a.id = coalesce(r.automation_id, f.automation_id)
left join "project" p on p.id = coalesce(cc.project_id, a.project_id)
left join "system_chat" sc on sc.chat_id = c.id);
--> statement-breakpoint
-- ## Connectors and built-in providers
-- Connections are connectors, the glossary's word for a service a project is
-- connected to, and a provider's preset is the built-in provider it was made
-- from. Everything named for them is renamed, keeping every row.
ALTER TABLE "connection" RENAME TO "connector";--> statement-breakpoint
ALTER TABLE "model_request" RENAME COLUMN "preset" TO "built_in";--> statement-breakpoint
ALTER TABLE "tool_call" RENAME COLUMN "connection_id" TO "connector_id";--> statement-breakpoint
ALTER TABLE "tool_call" RENAME COLUMN "connection_revision" TO "connector_revision";--> statement-breakpoint
ALTER TABLE "computer_provider" RENAME COLUMN "preset" TO "built_in";--> statement-breakpoint
ALTER TABLE "model_provider" RENAME COLUMN "preset" TO "built_in";--> statement-breakpoint
ALTER TABLE "search_provider" RENAME COLUMN "preset" TO "built_in";--> statement-breakpoint
ALTER TABLE "computer_provider" RENAME CONSTRAINT "computer_provider_preset_check" TO "computer_provider_built_in_check";--> statement-breakpoint
ALTER TABLE "connector" RENAME CONSTRAINT "connection_kind_check" TO "connector_kind_check";--> statement-breakpoint
ALTER TABLE "connector" RENAME CONSTRAINT "connection_http_auth_check" TO "connector_http_auth_check";--> statement-breakpoint
ALTER TABLE "connector" RENAME CONSTRAINT "connection_settings_kind_check" TO "connector_settings_kind_check";--> statement-breakpoint
ALTER TABLE "connector" RENAME CONSTRAINT "connection_app_credential_kind_check" TO "connector_app_credential_kind_check";--> statement-breakpoint
ALTER INDEX "connection_name_idx" RENAME TO "connector_name_idx";--> statement-breakpoint
ALTER INDEX "connection_handle_idx" RENAME TO "connector_handle_idx";--> statement-breakpoint
ALTER INDEX "connection_github_project_idx" RENAME TO "connector_github_project_idx";--> statement-breakpoint
ALTER INDEX "connection_id_workspace_id_idx" RENAME TO "connector_id_workspace_id_idx";--> statement-breakpoint
ALTER INDEX "connection_oauth_state_idx" RENAME TO "connector_oauth_state_idx";--> statement-breakpoint
ALTER TABLE "connector" RENAME CONSTRAINT "connection_project_workspace_fkey" TO "connector_project_workspace_fkey";--> statement-breakpoint
-- What Postgres named for the table itself: its primary key, its own foreign
-- keys and its columns' not-null constraints.
ALTER TABLE "connector" RENAME CONSTRAINT "connection_pkey" TO "connector_pkey";--> statement-breakpoint
ALTER TABLE "connector" RENAME CONSTRAINT "connection_workspace_id_workspace_id_fkey" TO "connector_workspace_id_workspace_id_fkey";--> statement-breakpoint
ALTER TABLE "connector" RENAME CONSTRAINT "connection_created_by_id_user_id_fkey" TO "connector_created_by_id_user_id_fkey";--> statement-breakpoint
ALTER TABLE "connector" RENAME CONSTRAINT "connection_id_not_null" TO "connector_id_not_null";--> statement-breakpoint
ALTER TABLE "connector" RENAME CONSTRAINT "connection_workspace_id_not_null" TO "connector_workspace_id_not_null";--> statement-breakpoint
ALTER TABLE "connector" RENAME CONSTRAINT "connection_project_id_not_null" TO "connector_project_id_not_null";--> statement-breakpoint
ALTER TABLE "connector" RENAME CONSTRAINT "connection_name_not_null" TO "connector_name_not_null";--> statement-breakpoint
ALTER TABLE "connector" RENAME CONSTRAINT "connection_handle_not_null" TO "connector_handle_not_null";--> statement-breakpoint
ALTER TABLE "connector" RENAME CONSTRAINT "connection_kind_not_null" TO "connector_kind_not_null";--> statement-breakpoint
ALTER TABLE "connector" RENAME CONSTRAINT "connection_url_not_null" TO "connector_url_not_null";--> statement-breakpoint
ALTER TABLE "connector" RENAME CONSTRAINT "connection_auth_kind_not_null" TO "connector_auth_kind_not_null";--> statement-breakpoint
ALTER TABLE "connector" RENAME CONSTRAINT "connection_configuration_revision_not_null" TO "connector_configuration_revision_not_null";--> statement-breakpoint
ALTER TABLE "connector" RENAME CONSTRAINT "connection_tools_not_null" TO "connector_tools_not_null";--> statement-breakpoint
ALTER TABLE "connector" RENAME CONSTRAINT "connection_tool_access_not_null" TO "connector_tool_access_not_null";--> statement-breakpoint
ALTER TABLE "connector" RENAME CONSTRAINT "connection_created_at_not_null" TO "connector_created_at_not_null";--> statement-breakpoint
ALTER TABLE "connector" RENAME CONSTRAINT "connection_updated_at_not_null" TO "connector_updated_at_not_null";--> statement-breakpoint
ALTER TABLE "search_provider" RENAME CONSTRAINT "search_provider_preset_not_null" TO "search_provider_built_in_not_null";--> statement-breakpoint
ALTER TABLE "computer_provider" RENAME CONSTRAINT "computer_provider_preset_not_null" TO "computer_provider_built_in_not_null";--> statement-breakpoint
-- A computer provider's settings name its built-in provider under `builtIn`,
-- which `built_in` is generated from. The key is added before the expression
-- changes, so the column is never null, and the old key removed after.
UPDATE "computer_provider" SET "settings" = "settings" || jsonb_build_object('builtIn', "settings"->'preset');--> statement-breakpoint
ALTER TABLE "computer_provider" ALTER COLUMN "built_in" SET EXPRESSION AS (settings->>'builtIn');--> statement-breakpoint
UPDATE "computer_provider" SET "settings" = "settings" - 'preset';--> statement-breakpoint
UPDATE "computer_provider" SET "managed_resources" = ("managed_resources" - 'preset') || jsonb_build_object('builtIn', "managed_resources"->'preset') WHERE "managed_resources" ? 'preset';--> statement-breakpoint
-- A GitHub trigger, and the run it started, name their connector by `connectorId`.
UPDATE "automation_trigger" SET "settings" = ("settings" - 'connectionId') || jsonb_build_object('connectorId', "settings"->'connectionId') WHERE "settings" ? 'connectionId';--> statement-breakpoint
UPDATE "run" SET "trigger" = ("trigger" - 'connectionId') || jsonb_build_object('connectorId', "trigger"->'connectionId') WHERE "trigger" ? 'connectionId';
--> statement-breakpoint
-- ## People, avatars and computers by their glossary names
-- People, memberships, invitations, avatars and computers by their glossary
-- names: a user is a person, a workspace member's place is a membership, an
-- invite is an invitation, a bot's face is its eyes, a computer sleeps, and a
-- workspace is set up. Everything is renamed in place, keeping every row.
ALTER TABLE "workspace_invite" RENAME TO "invitation";--> statement-breakpoint
ALTER TABLE "workspace_member" RENAME TO "membership";--> statement-breakpoint
ALTER TABLE "user" RENAME TO "person";--> statement-breakpoint
ALTER TABLE "chat_participant" RENAME COLUMN "user_id" TO "person_id";--> statement-breakpoint
ALTER TABLE "chat_read" RENAME COLUMN "user_id" TO "person_id";--> statement-breakpoint
ALTER TABLE "message" RENAME COLUMN "author_user_id" TO "author_person_id";--> statement-breakpoint
ALTER TABLE "message_reaction" RENAME COLUMN "user_id" TO "person_id";--> statement-breakpoint
ALTER TABLE "computer" RENAME COLUMN "paused_at" TO "slept_at";--> statement-breakpoint
ALTER TABLE "notification_override" RENAME COLUMN "user_id" TO "person_id";--> statement-breakpoint
ALTER TABLE "notification_settings" RENAME COLUMN "user_id" TO "person_id";--> statement-breakpoint
ALTER TABLE "account" RENAME COLUMN "user_id" TO "person_id";--> statement-breakpoint
ALTER TABLE "bot" RENAME COLUMN "face" TO "eyes";--> statement-breakpoint
ALTER TABLE "membership" RENAME COLUMN "user_id" TO "person_id";--> statement-breakpoint
ALTER TABLE "pinned_bot" RENAME COLUMN "user_id" TO "person_id";--> statement-breakpoint
ALTER TABLE "project_member" RENAME COLUMN "user_id" TO "person_id";--> statement-breakpoint
ALTER TABLE "session" RENAME COLUMN "user_id" TO "person_id";--> statement-breakpoint
ALTER TABLE "workspace" RENAME COLUMN "setup_completed_at" TO "set_up_at";--> statement-breakpoint
ALTER TABLE "invitation" RENAME CONSTRAINT "workspace_invite_role_check" TO "invitation_role_check";--> statement-breakpoint
ALTER TABLE "invitation" RENAME CONSTRAINT "workspace_invite_status_check" TO "invitation_status_check";--> statement-breakpoint
ALTER TABLE "membership" RENAME CONSTRAINT "workspace_member_role_check" TO "membership_role_check";--> statement-breakpoint
ALTER INDEX "chat_participant_user_idx" RENAME TO "chat_participant_person_idx";--> statement-breakpoint
ALTER INDEX "chat_read_user_chat_idx" RENAME TO "chat_read_person_chat_idx";--> statement-breakpoint
ALTER INDEX "message_reaction_message_user_emoji_idx" RENAME TO "message_reaction_message_person_emoji_idx";--> statement-breakpoint
ALTER INDEX "account_user_id_idx" RENAME TO "account_person_id_idx";--> statement-breakpoint
ALTER INDEX "workspace_invite_workspace_id_idx" RENAME TO "invitation_workspace_id_idx";--> statement-breakpoint
ALTER INDEX "workspace_invite_email_idx" RENAME TO "invitation_email_idx";--> statement-breakpoint
ALTER INDEX "workspace_member_idx" RENAME TO "membership_idx";--> statement-breakpoint
ALTER INDEX "workspace_member_user_id_idx" RENAME TO "membership_person_id_idx";--> statement-breakpoint
ALTER INDEX "workspace_member_owner_idx" RENAME TO "membership_owner_idx";--> statement-breakpoint
ALTER INDEX "user_email_idx" RENAME TO "person_email_idx";--> statement-breakpoint
ALTER INDEX "user_referral_code_idx" RENAME TO "person_referral_code_idx";--> statement-breakpoint
ALTER INDEX "user_referred_by_idx" RENAME TO "person_referred_by_idx";--> statement-breakpoint
ALTER INDEX "project_member_user_id_idx" RENAME TO "project_member_person_id_idx";--> statement-breakpoint
ALTER INDEX "session_user_id_idx" RENAME TO "session_person_id_idx";--> statement-breakpoint
ALTER TABLE "invitation" ALTER COLUMN "role" SET DEFAULT 'editor';--> statement-breakpoint
ALTER TABLE "membership" ALTER COLUMN "role" SET DEFAULT 'editor';--> statement-breakpoint
-- What Postgres and Drizzle named for the renamed tables and columns: primary
-- keys, foreign keys and not-null constraints.
DO $$
DECLARE
	found record;
	renamed text;
BEGIN
	FOR found IN
		SELECT c.conrelid::regclass AS relation, c.conname
		FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
		WHERE n.nspname = 'public'
			AND c.conname ~ '(workspace_invite|workspace_member|user_id|^user_|^bot_face_)'
	LOOP
		renamed := replace(replace(found.conname, 'workspace_invite', 'invitation'), 'workspace_member', 'membership');
		renamed := regexp_replace(renamed, '^user_', 'person_');
		renamed := replace(renamed, 'user_id', 'person_id');
		renamed := regexp_replace(renamed, '^bot_face_', 'bot_eyes_');
		EXECUTE format('ALTER TABLE %s RENAME CONSTRAINT %I TO %I', found.relation, found.conname, renamed);
	END LOOP;
END;
$$;--> statement-breakpoint
-- The editor role was called member.
ALTER TABLE "invitation" DROP CONSTRAINT "invitation_role_check";--> statement-breakpoint
ALTER TABLE "membership" DROP CONSTRAINT "membership_role_check";--> statement-breakpoint
UPDATE "invitation" SET "role" = 'editor' WHERE "role" = 'member';--> statement-breakpoint
UPDATE "membership" SET "role" = 'editor' WHERE "role" = 'member';--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_role_check" CHECK ("role" in ('admin', 'editor', 'viewer'));--> statement-breakpoint
ALTER TABLE "membership" ADD CONSTRAINT "membership_role_check" CHECK ("role" in ('owner', 'admin', 'editor', 'viewer'));--> statement-breakpoint
-- The triggers that put administrators in every project people made name the
-- renamed table and column.
CREATE OR REPLACE FUNCTION add_administrators_to_new_project() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF NEW."default_of_bot_id" IS NOT NULL THEN
		RETURN NULL;
	END IF;
	PERFORM lock_project_membership(NEW."workspace_id");
	INSERT INTO "project_member" ("workspace_id", "project_id", "person_id")
	SELECT NEW."workspace_id", NEW."id", "person_id"
	FROM "membership"
	WHERE "workspace_id" = NEW."workspace_id" AND "role" IN ('owner', 'admin')
	ON CONFLICT ("project_id", "person_id") DO NOTHING;
	RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION add_new_administrator_to_projects() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	PERFORM lock_project_membership(NEW."workspace_id");
	INSERT INTO "project_member" ("workspace_id", "project_id", "person_id")
	SELECT NEW."workspace_id", "id", NEW."person_id"
	FROM "project"
	WHERE "workspace_id" = NEW."workspace_id" AND "default_of_bot_id" IS NULL
	ON CONFLICT ("project_id", "person_id") DO NOTHING;
	RETURN NULL;
END;
$$;--> statement-breakpoint
-- Request purposes are the glossary's: facilitation is gone, and a trial or
-- provider check is a model test.
ALTER TABLE "model_request" DROP CONSTRAINT "model_request_purpose_valid";--> statement-breakpoint
UPDATE "model_request" SET "purpose" = 'model-test' WHERE "purpose" IN ('trial', 'provider-check');--> statement-breakpoint
DELETE FROM "model_request" WHERE "purpose" = 'facilitation';--> statement-breakpoint
ALTER TABLE "model_request" ADD CONSTRAINT "model_request_purpose_valid" CHECK ("purpose" in ('bot-turn', 'compaction', 'model-test'));--> statement-breakpoint
-- Written files' blobs are kept under `files/<id>`.
CREATE OR REPLACE FUNCTION queue_deleted_file_blobs() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	INSERT INTO "blob_deletion" ("prefix")
	SELECT 'files/' || "id"::text FROM deleted_files WHERE "kind" IN ('document', 'html');
	RETURN NULL;
END;
$$;--> statement-breakpoint
UPDATE "blob" SET "key" = 'files/' || substring("key" from 11) WHERE "key" LIKE 'artifacts/%';--> statement-breakpoint
UPDATE "blob_deletion" SET "prefix" = 'files/' || substring("prefix" from 11) WHERE "prefix" LIKE 'artifacts/%';--> statement-breakpoint
-- Workflow payloads and lanes by their glossary names: a turn's and a
-- compaction's bot is `botId`, an automation's run is `automationId` and
-- `runId`, its workflow and lane are `automation`, and a turn an automation
-- asked for has the reason `automation`.
UPDATE "turn" SET "reason" = 'automation' WHERE "reason" = 'routine';--> statement-breakpoint
-- The turns and compactions running or waiting in lanes carry their requests
-- as their workflows encode them, so those are renamed the same way. Lanes
-- keep their keys, `turn:<chat>:<bot>` and `compaction:<chat>`, as every chat
-- and bot kept its thread's and agent's id.
UPDATE "lane" SET "payload" = ("payload" - 'threadId' - 'agentId')
	|| jsonb_build_object('chatId', "payload"->'threadId', 'botId', "payload"->'agentId')
	|| CASE WHEN "payload"->>'reason' = 'routine' THEN '{"reason": "automation"}'::jsonb ELSE '{}'::jsonb END
WHERE "workflow" IN ('turn', 'compaction') AND "payload" ? 'threadId';--> statement-breakpoint
UPDATE "lane_request" SET "payload" = ("payload" - 'threadId' - 'agentId')
	|| jsonb_build_object('chatId', "payload"->'threadId', 'botId', "payload"->'agentId')
	|| CASE WHEN "payload"->>'reason' = 'routine' THEN '{"reason": "automation"}'::jsonb ELSE '{}'::jsonb END
WHERE "workflow" IN ('turn', 'compaction') AND "payload" ? 'threadId';--> statement-breakpoint
-- An automation's runs went one at a time through the `routine` workflow,
-- which no longer exists. A run it was carrying out can't carry on in the
-- `automation` workflow, whose execution is another, and one waiting can't
-- be started from here, so both are recorded as failed, to be run again,
-- and their lanes go. Summaries are gone, and their lanes with them.
UPDATE "run" SET
	"state" = 'failed',
	"error" = 'Stopped when Sugabots was upgraded. Run it again.',
	"finished_at" = now(),
	"pending_terminal_state" = NULL,
	"pending_terminal_error" = NULL,
	"updated_at" = now()
WHERE "state" IN ('queued', 'running') AND "id"::text IN (
	SELECT "payload"->>'executionId' FROM "lane"
	WHERE "workflow" = 'routine' AND "state" <> 'idle'
	UNION
	SELECT "payload"->>'executionId' FROM "lane_request" WHERE "workflow" = 'routine'
);--> statement-breakpoint
DELETE FROM "lane_request" WHERE "workflow" IN ('routine', 'summary');--> statement-breakpoint
DELETE FROM "lane"
WHERE "workflow" IN ('routine', 'summary') OR "key" LIKE 'routine:%' OR "key" LIKE 'summary:%';--> statement-breakpoint
-- The workflow engine keeps each execution's request itself, as the JSON its
-- workflow's payload encodes to, in the tables it makes the first time it
-- starts (`cluster_messages`, its replies in `cluster_replies`), so an
-- installation that never ran it has none. An execution waiting to resume
-- decodes that request again, so a turn's and a compaction's are renamed as
-- their lanes are, and keep their executions, whose ids their unchanged
-- idempotency keys make. The `routine` and `summary` workflows are gone, so
-- their executions, and the clocks that would wake them, are forgotten:
-- nothing could carry them on, and their runs are recorded as failed above.
DO $$
BEGIN
	IF to_regclass('cluster_messages') IS NULL THEN
		RETURN;
	END IF;
	EXECUTE $sql$
		UPDATE "cluster_messages" SET "payload" = (
			("payload"::jsonb - 'threadId' - 'agentId')
			|| jsonb_build_object('chatId', "payload"::jsonb->'threadId', 'botId', "payload"::jsonb->'agentId')
			|| CASE WHEN "payload"::jsonb->>'reason' = 'routine' THEN '{"reason": "automation"}'::jsonb ELSE '{}'::jsonb END
		)::text
		WHERE "entity_type" IN ('Workflow/turn', 'Workflow/compaction') AND "tag" = 'run'
			AND "payload"::jsonb ? 'threadId'
	$sql$;
	EXECUTE $sql$
		CREATE TEMPORARY TABLE "workflow_gone" ON COMMIT DROP AS
		SELECT "id" FROM "cluster_messages"
		WHERE "entity_type" IN ('Workflow/routine', 'Workflow/summary')
			OR ("entity_type" = 'Workflow/-/DurableClock'
				AND "payload"::jsonb->>'workflowName' IN ('routine', 'summary'))
	$sql$;
	IF to_regclass('cluster_replies') IS NOT NULL THEN
		EXECUTE 'DELETE FROM "cluster_replies" WHERE "request_id" IN (SELECT "id" FROM "workflow_gone")';
	END IF;
	EXECUTE 'DELETE FROM "cluster_messages" WHERE "id" IN (SELECT "id" FROM "workflow_gone")';
	EXECUTE 'DROP TABLE "workflow_gone"';
END $$;
--> statement-breakpoint
-- ## Architecture and computer words
-- The architecture's and computers' glossary words: a tool call that may
-- change or delete something is a write/delete tool call, an event is
-- published on a stream, a computer's network mode is open or allowed hosts
-- only, a bot asking to reach a host makes a host request, a reply being
-- written is `writing`, and a model that thinks before it answers has the
-- thinking capability. Everything is renamed in place, keeping every row.
ALTER TABLE "tool_call" RENAME COLUMN "mutating" TO "write_or_delete";--> statement-breakpoint
ALTER TABLE "turn" RENAME COLUMN "mutation_started" TO "write_or_delete_started";--> statement-breakpoint
ALTER TABLE "event" RENAME COLUMN "channel" TO "stream";--> statement-breakpoint
ALTER INDEX "event_channel_seq_idx" RENAME TO "event_stream_seq_idx";--> statement-breakpoint
UPDATE "computer_provider" SET "settings" = jsonb_set("settings", '{networkMode}', '"allowed-hosts-only"') WHERE "settings"->>'networkMode' = 'allowlist';--> statement-breakpoint
UPDATE "tool_call" SET "tool" = 'request_host' WHERE "tool" = 'request_network_access';--> statement-breakpoint
UPDATE "message" SET "status" = 'writing' WHERE "status" = 'streaming';--> statement-breakpoint
UPDATE "provider_model" SET "capabilities" = (
	SELECT coalesce(jsonb_agg(CASE WHEN value = '"reasoning"' THEN '"thinking"'::jsonb ELSE value END), '[]'::jsonb)
	FROM jsonb_array_elements("capabilities")
) WHERE "capabilities" ? 'reasoning';--> statement-breakpoint
UPDATE "provider_model" SET "disabled_capabilities" = (
	SELECT coalesce(jsonb_agg(CASE WHEN value = '"reasoning"' THEN '"thinking"'::jsonb ELSE value END), '[]'::jsonb)
	FROM jsonb_array_elements("disabled_capabilities")
) WHERE "disabled_capabilities" ? 'reasoning';
--> statement-breakpoint
-- ## System chat kind
-- A system bot's chat is a system chat, the glossary's word, so its kind is
-- `system_chat`, as its table is named. The kind row's own `kind` follows it,
-- and the chats it names are moved with it once the key between them is gone.
DROP VIEW "placed_chat";--> statement-breakpoint
ALTER TABLE "system_chat" DROP CONSTRAINT "system_chat_chat_fkey";--> statement-breakpoint
ALTER TABLE "system_chat" DROP COLUMN "kind";--> statement-breakpoint
ALTER TABLE "chat" DROP CONSTRAINT "chat_kind_valid";--> statement-breakpoint
UPDATE "chat" SET "kind" = 'system_chat' WHERE "kind" = 'system';--> statement-breakpoint
ALTER TABLE "chat" ADD CONSTRAINT "chat_kind_valid" CHECK ("kind" in ('project_chat', 'collaboration', 'run', 'automation_feed', 'system_chat'));--> statement-breakpoint
ALTER TABLE "system_chat" ADD COLUMN "kind" text GENERATED ALWAYS AS ('system_chat') STORED NOT NULL;--> statement-breakpoint
ALTER TABLE "system_chat" ADD CONSTRAINT "system_chat_chat_fkey" FOREIGN KEY ("chat_id","kind","workspace_id") REFERENCES "chat"("id","kind","workspace_id") ON DELETE CASCADE;--> statement-breakpoint
-- The kind check names the kinds in its body, so it is made again.
CREATE OR REPLACE FUNCTION chat_has_kind_row() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	has_kind_row boolean;
BEGIN
	IF NOT EXISTS (SELECT 1 FROM "chat" WHERE "id" = NEW."id") THEN
		RETURN NULL;
	END IF;
	has_kind_row := CASE NEW."kind"
		WHEN 'project_chat' THEN EXISTS (SELECT 1 FROM "project_chat" WHERE "chat_id" = NEW."id")
		WHEN 'collaboration' THEN EXISTS (SELECT 1 FROM "collaboration" WHERE "chat_id" = NEW."id")
		WHEN 'run' THEN EXISTS (SELECT 1 FROM "run" WHERE "chat_id" = NEW."id")
		WHEN 'automation_feed' THEN EXISTS (SELECT 1 FROM "automation_feed" WHERE "chat_id" = NEW."id")
		WHEN 'system_chat' THEN EXISTS (SELECT 1 FROM "system_chat" WHERE "chat_id" = NEW."id")
		ELSE false
	END;
	IF NOT has_kind_row THEN
		RAISE EXCEPTION 'chat % is a % with no % row', NEW."id", NEW."kind", NEW."kind"
			USING ERRCODE = 'foreign_key_violation';
	END IF;
	RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE VIEW "placed_chat" AS (select
	c.id, c.workspace_id, c.kind, c.title, c.created_at, c.updated_at,
	coalesce(p.default_of_bot_id, co.collaborator_bot_id, sc.bot_id) as bot_id,
	p.id as project_id,
	case c.kind
		when 'collaboration' then co.root_chat_id
		when 'run' then rf.chat_id
		when 'system_chat' then null
		else c.id
	end as root_chat_id,
	coalesce(co.parent_chat_id, sc.served_chat_id) as parent_chat_id,
	cc.started_by_id,
	sc.system_bot_key,
	cc.resolved_at,
	f.automation_id
from "chat" c
left join "project_chat" cc on cc.chat_id = c.id
left join "collaboration" co on co.chat_id = c.id
left join "run" r on r.chat_id = c.id
left join "automation_feed" rf on rf.automation_id = r.automation_id
left join "automation_feed" f on f.chat_id = c.id
left join "automation" a on a.id = coalesce(r.automation_id, f.automation_id)
left join "project" p on p.id = coalesce(cc.project_id, a.project_id)
left join "system_chat" sc on sc.chat_id = c.id);
--> statement-breakpoint
-- ## Glossary words for columns, and failed turns' errors
-- Columns named by the glossary: compacted history is a condensed account, a
-- turn is interrupted, its workflow is its execution, and a bot has instructions.
ALTER TABLE "compaction" RENAME COLUMN "summary" TO "condensed";--> statement-breakpoint
ALTER TABLE "turn" RENAME COLUMN "owner" TO "execution_id";--> statement-breakpoint
ALTER TABLE "turn" RENAME COLUMN "cancel_requested" TO "interrupt_requested";--> statement-breakpoint
ALTER TABLE "bot" RENAME COLUMN "prompt" TO "instructions";--> statement-breakpoint
ALTER TABLE "message" DROP COLUMN "kind";--> statement-breakpoint
ALTER TABLE "workspace" DROP COLUMN "logo";--> statement-breakpoint
DROP INDEX "message_run_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "message_run_idx" ON "message" ("run_id") WHERE "run_id" is not null;--> statement-breakpoint
ALTER TABLE "model_request" ADD CONSTRAINT "model_request_bot_valid" CHECK (("purpose" = 'bot-turn') = ("bot_id" is not null));--> statement-breakpoint
ALTER TABLE "turn" ADD CONSTRAINT "turn_failure_has_error" CHECK ("status" <> 'failed' or "error" is not null);--> statement-breakpoint
ALTER TABLE "run" DROP CONSTRAINT "run_pending_terminal_valid", ADD CONSTRAINT "run_pending_terminal_valid" CHECK (("pending_terminal_state" is null and "pending_terminal_error" is null)
				or ("state" = 'running' and "pending_terminal_state" = 'cancelled' and "pending_terminal_error" is null)
				or ("state" = 'running' and "pending_terminal_state" = 'failed' and "pending_terminal_error" is not null));--> statement-breakpoint
-- A written Markdown file's kind is `markdown`, and a person's file is an
-- `attachment`. The versions' key carries the kind and has no ON UPDATE, so it
-- is dropped while the rows move, and their checks are made again.
ALTER TABLE "file_version" DROP CONSTRAINT "file_version_file_fkey";--> statement-breakpoint
ALTER TABLE "file_version" DROP CONSTRAINT "file_version_file_kind_valid";--> statement-breakpoint
ALTER TABLE "file" DROP CONSTRAINT "file_kind_valid";--> statement-breakpoint
ALTER TABLE "file" DROP CONSTRAINT "file_source_valid";--> statement-breakpoint
UPDATE "file" SET "kind" = 'markdown' WHERE "kind" = 'document';--> statement-breakpoint
UPDATE "file" SET "kind" = 'attachment' WHERE "kind" = 'upload';--> statement-breakpoint
UPDATE "file_version" SET "file_kind" = 'markdown' WHERE "file_kind" = 'document';--> statement-breakpoint
ALTER TABLE "file" ADD CONSTRAINT "file_kind_valid" CHECK ("kind" in ('markdown', 'html', 'attachment', 'bot_attachment', 'tool_result'));--> statement-breakpoint
ALTER TABLE "file" ADD CONSTRAINT "file_source_valid" CHECK (case "kind"
				when 'attachment' then "name" is not null and "content_type" is not null
					and "size" is not null and "tool_call_id" is null
					and ("message_id" is null) = ("position" is null)
					and "created_by_bot_id" is null and "current_version" is null
				when 'bot_attachment' then "name" is not null and "content_type" is not null
					and "size" is not null and "tool_call_id" is null
					and "uploader_id" is null and "message_id" is not null
					and "position" is not null
					and "created_by_bot_id" is null and "current_version" is null
				when 'tool_result' then "name" is null and "content_type" is not null
					and "size" is not null and "uploader_id" is null
					and "message_id" is null and "position" is null
					and "created_by_bot_id" is null and "current_version" is null
				else "name" is not null and "current_version" is not null
					and "content_type" is null and "size" is null
					and "tool_call_id" is null and "uploader_id" is null
					and "message_id" is null and "position" is null
			end);--> statement-breakpoint
ALTER TABLE "file_version" ADD CONSTRAINT "file_version_file_kind_valid" CHECK ("file_kind" in ('markdown', 'html'));--> statement-breakpoint
ALTER TABLE "file_version" ADD CONSTRAINT "file_version_file_fkey" FOREIGN KEY ("file_id","file_kind") REFERENCES "file"("id","kind") ON DELETE CASCADE;--> statement-breakpoint
-- The blob deletion names the written kinds in its body, so it is made again.
CREATE OR REPLACE FUNCTION queue_deleted_file_blobs() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	INSERT INTO "blob_deletion" ("prefix")
	SELECT 'files/' || "id"::text FROM deleted_files WHERE "kind" IN ('markdown', 'html');
	RETURN NULL;
END;
$$;
--> statement-breakpoint
-- ## Members, personal bots and read cursors
-- Members, personal bots and read cursors by their glossary names: a person
-- is a member, a bot only its creator sees is a personal bot, and how far a
-- member has read a chat is their read cursor. Everything is renamed in place,
-- keeping every row.
ALTER TABLE "chat_read" RENAME TO "read_cursor";--> statement-breakpoint
ALTER TABLE "person" RENAME TO "member";--> statement-breakpoint
ALTER TABLE "chat_participant" RENAME COLUMN "person_id" TO "member_id";--> statement-breakpoint
ALTER TABLE "message" RENAME COLUMN "author_person_id" TO "author_member_id";--> statement-breakpoint
ALTER TABLE "message_reaction" RENAME COLUMN "person_id" TO "member_id";--> statement-breakpoint
ALTER TABLE "read_cursor" RENAME COLUMN "person_id" TO "member_id";--> statement-breakpoint
ALTER TABLE "notification_override" RENAME COLUMN "person_id" TO "member_id";--> statement-breakpoint
ALTER TABLE "notification_settings" RENAME COLUMN "person_id" TO "member_id";--> statement-breakpoint
ALTER TABLE "account" RENAME COLUMN "person_id" TO "member_id";--> statement-breakpoint
ALTER TABLE "membership" RENAME COLUMN "person_id" TO "member_id";--> statement-breakpoint
ALTER TABLE "pinned_bot" RENAME COLUMN "person_id" TO "member_id";--> statement-breakpoint
ALTER TABLE "project_member" RENAME COLUMN "person_id" TO "member_id";--> statement-breakpoint
ALTER TABLE "session" RENAME COLUMN "person_id" TO "member_id";--> statement-breakpoint
ALTER INDEX "chat_participant_person_idx" RENAME TO "chat_participant_member_idx";--> statement-breakpoint
ALTER INDEX "message_reaction_message_person_emoji_idx" RENAME TO "message_reaction_message_member_emoji_idx";--> statement-breakpoint
ALTER INDEX "chat_read_person_chat_idx" RENAME TO "read_cursor_member_chat_idx";--> statement-breakpoint
ALTER INDEX "account_person_id_idx" RENAME TO "account_member_id_idx";--> statement-breakpoint
ALTER INDEX "person_email_idx" RENAME TO "member_email_idx";--> statement-breakpoint
ALTER INDEX "person_referral_code_idx" RENAME TO "member_referral_code_idx";--> statement-breakpoint
ALTER INDEX "person_referred_by_idx" RENAME TO "member_referred_by_idx";--> statement-breakpoint
ALTER INDEX "membership_person_id_idx" RENAME TO "membership_member_id_idx";--> statement-breakpoint
ALTER INDEX "project_member_person_id_idx" RENAME TO "project_member_member_id_idx";--> statement-breakpoint
ALTER INDEX "session_person_id_idx" RENAME TO "session_member_id_idx";--> statement-breakpoint
-- What Postgres and Drizzle named for the renamed tables and columns: primary
-- keys, foreign keys and not-null constraints.
DO $$
DECLARE
	found record;
BEGIN
	FOR found IN
		SELECT c.conrelid::regclass AS relation, c.conname
		FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
		WHERE n.nspname = 'public' AND c.conname ~ '(person(?!al)|chat_read)'
	LOOP
		EXECUTE format(
			'ALTER TABLE %s RENAME CONSTRAINT %I TO %I',
			found.relation,
			found.conname,
			regexp_replace(replace(found.conname, 'chat_read', 'read_cursor'), 'person(?!al)', 'member', 'g')
		);
	END LOOP;
END;
$$;--> statement-breakpoint
DROP INDEX "chat_participant_member_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "chat_participant_member_idx" ON "chat_participant" ("chat_id","member_id") WHERE "member_id" is not null;--> statement-breakpoint
DROP INDEX "message_reaction_message_member_emoji_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "message_reaction_message_member_emoji_idx" ON "message_reaction" ("message_id","member_id","emoji") WHERE "member_id" is not null;--> statement-breakpoint
ALTER TABLE "message" DROP CONSTRAINT "message_one_author", ADD CONSTRAINT "message_one_author" CHECK (num_nonnulls("author_member_id", "author_bot_id", "automation_trigger") = 1);--> statement-breakpoint
ALTER TABLE "chat_participant" DROP CONSTRAINT "chat_participant_one_identity", ADD CONSTRAINT "chat_participant_one_identity" CHECK (num_nonnulls("member_id", "bot_id") = 1);--> statement-breakpoint
ALTER TABLE "message_reaction" DROP CONSTRAINT "message_reaction_one_reactor", ADD CONSTRAINT "message_reaction_one_reactor" CHECK (num_nonnulls("member_id", "bot_id") = 1);--> statement-breakpoint
-- A bot only its creator sees is a personal bot; a private bot is now one its
-- creator invites others to, which Sugabots doesn't have yet.
ALTER TABLE "bot" DROP CONSTRAINT "bot_visibility_check";--> statement-breakpoint
UPDATE "bot" SET "visibility" = 'personal' WHERE "visibility" = 'private';--> statement-breakpoint
ALTER TABLE "bot" ADD CONSTRAINT "bot_visibility_check" CHECK ("visibility" in ('public', 'personal'));--> statement-breakpoint
-- A Personal Assistant is a personal bot, whose creator is the member it is for.
UPDATE "bot" SET "created_by_id" = "assistant_of"
WHERE "assistant_of" IS NOT NULL AND "created_by_id" IS DISTINCT FROM "assistant_of";--> statement-breakpoint
ALTER TABLE "bot" ADD CONSTRAINT "bot_personal_assistant_check" CHECK ("assistant_of" is null or ("visibility" = 'personal' and ("created_by_id" is null or "created_by_id" = "assistant_of")));--> statement-breakpoint
-- The triggers that put administrators in every project members made name the
-- renamed column.
CREATE OR REPLACE FUNCTION add_administrators_to_new_project() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF NEW."default_of_bot_id" IS NOT NULL THEN
		RETURN NULL;
	END IF;
	PERFORM lock_project_membership(NEW."workspace_id");
	INSERT INTO "project_member" ("workspace_id", "project_id", "member_id")
	SELECT NEW."workspace_id", NEW."id", "member_id"
	FROM "membership"
	WHERE "workspace_id" = NEW."workspace_id" AND "role" IN ('owner', 'admin')
	ON CONFLICT ("project_id", "member_id") DO NOTHING;
	RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION add_new_administrator_to_projects() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	PERFORM lock_project_membership(NEW."workspace_id");
	INSERT INTO "project_member" ("workspace_id", "project_id", "member_id")
	SELECT NEW."workspace_id", "id", NEW."member_id"
	FROM "project"
	WHERE "workspace_id" = NEW."workspace_id" AND "default_of_bot_id" IS NULL
	ON CONFLICT ("project_id", "member_id") DO NOTHING;
	RETURN NULL;
END;
$$;
--> statement-breakpoint
-- ## Collaborations become mentions
-- A bot asks another of its project's bots for help by mentioning it, and the
-- helper replies in the asking chat, so collaboration chats go. Each one's
-- messages move into the chat it was opened from, among that chat's own in
-- time order; one opened from another collaboration moves to the nearest chat
-- above it that isn't one. Its turns, tool calls, participants and files move
-- with them. The work still going on in those chats ends first, and the
-- collaboration cards in the asking replies go, as the messages they stood
-- for are in the chat now.
CREATE TABLE "blob_folder_move" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"from_prefix" text NOT NULL,
	"to_prefix" text NOT NULL,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- "People, avatars and computers by their glossary names" above renamed the
-- `artifacts/` keys to `files/` in the database only, so a
-- filesystem store still keeps their bytes under `artifacts/`. Moving a folder
-- that isn't there does nothing, so this is safe on every store.
INSERT INTO "blob_folder_move" ("from_prefix", "to_prefix") VALUES ('artifacts', 'files');--> statement-breakpoint
-- A chat's files were kept under `threads/<id>` until "Chats by their
-- glossary name" above named its folder `chats/<id>`,
-- which renamed no stored key, so every store moves its `threads/` folders
-- there too. Queued here, before the collaboration chats' moves below, which
-- move what this has moved: moves are made in the order queued, and a
-- connection's `uuidv7()` ids rise within one transaction.
INSERT INTO "blob_folder_move" ("from_prefix", "to_prefix") VALUES ('threads', 'chats');--> statement-breakpoint
-- A chat deleted before then queued its old folder for deletion, which is
-- where its bytes are no longer once they have moved.
UPDATE "blob_deletion" SET "prefix" = 'chats/' || substring("prefix" from length('threads/') + 1)
WHERE "prefix" LIKE 'threads/%';--> statement-breakpoint
-- A helper's failed turn its workflow will start again has not ended, which
-- its asking bot's hand-back waits for.
ALTER TABLE "turn" ADD COLUMN "retrying" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE TABLE "collaboration_move" AS
WITH RECURSIVE above AS (
	SELECT "chat_id", "parent_chat_id" AS "target_chat_id" FROM "collaboration"
	UNION ALL
	SELECT above."chat_id", up."parent_chat_id"
	FROM above JOIN "collaboration" up ON up."chat_id" = above."target_chat_id"
)
SELECT "chat_id", "target_chat_id" FROM above
WHERE "target_chat_id" NOT IN (SELECT "chat_id" FROM "collaboration");--> statement-breakpoint
-- Turns and compactions asked for there never start. A turn waiting for
-- approvals keeps its lane, so that once it is cancelled below the sweep
-- for lost cancels finds its workflow, still waiting, and tells it to stop.
DELETE FROM "lane" WHERE "subject" IN (SELECT "chat_id"::text FROM "collaboration_move")
	AND NOT EXISTS (
		SELECT 1 FROM "turn"
		WHERE "turn"."execution_id" = "lane"."execution_id"
			AND "turn"."chat_id" IN (SELECT "chat_id" FROM "collaboration_move")
			AND "turn"."status" = 'waiting'
	);--> statement-breakpoint
DELETE FROM "lane_request" WHERE "lane_key" IN (
	SELECT "key" FROM "lane" WHERE "subject" IN (SELECT "chat_id"::text FROM "collaboration_move")
);--> statement-breakpoint
-- The work still going on there ends, as cancelling a turn ends it: its
-- unfinished tool calls fail, a pending approval is denied, and its reply stops.
UPDATE "tool_call" SET
	"status" = 'failed',
	"approval_status" = CASE WHEN "approval_status" = 'pending' THEN 'denied' ELSE "approval_status" END,
	"error" = 'Turn cancelled',
	"finished_at" = now()
WHERE "chat_id" IN (SELECT "chat_id" FROM "collaboration_move")
	AND "status" IN ('running', 'awaiting_approval');--> statement-breakpoint
UPDATE "message" SET "status" = 'cancelled'
WHERE "chat_id" IN (SELECT "chat_id" FROM "collaboration_move") AND "status" = 'writing';--> statement-breakpoint
UPDATE "turn" SET
	"status" = 'cancelled',
	"interrupt_requested" = true,
	"checkpoint" = NULL,
	"finished_at" = now()
WHERE "chat_id" IN (SELECT "chat_id" FROM "collaboration_move")
	AND "status" IN ('running', 'waiting');--> statement-breakpoint
UPDATE "message" SET "chat_id" = moved."target_chat_id"
FROM "collaboration_move" moved WHERE "message"."chat_id" = moved."chat_id";--> statement-breakpoint
UPDATE "turn" SET "chat_id" = moved."target_chat_id"
FROM "collaboration_move" moved WHERE "turn"."chat_id" = moved."chat_id";--> statement-breakpoint
UPDATE "tool_call" SET "chat_id" = moved."target_chat_id"
FROM "collaboration_move" moved WHERE "tool_call"."chat_id" = moved."chat_id";--> statement-breakpoint
UPDATE "file" SET "chat_id" = moved."target_chat_id"
FROM "collaboration_move" moved WHERE "file"."chat_id" = moved."chat_id";--> statement-breakpoint
-- A file's bytes are kept under its chat's folder, so they follow it there,
-- moved by the blob store when the server starts: a migration can't reach a
-- filesystem store's disk.
INSERT INTO "blob_folder_move" ("from_prefix", "to_prefix")
SELECT 'chats/' || "chat_id", 'chats/' || "target_chat_id" FROM "collaboration_move";--> statement-breakpoint
-- The ledger keeps which chat a model request served.
UPDATE "model_request" SET "chat_id" = moved."target_chat_id"
FROM "collaboration_move" moved WHERE "model_request"."chat_id" = moved."chat_id";--> statement-breakpoint
INSERT INTO "chat_participant" ("chat_id", "member_id", "bot_id", "created_at")
SELECT moved."target_chat_id", participant."member_id", participant."bot_id", participant."created_at"
FROM "chat_participant" participant
JOIN "collaboration_move" moved ON moved."chat_id" = participant."chat_id"
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- What was recorded on the collaboration chats' own streams, and the cards'
-- updates, which no client shows any more.
DELETE FROM "event"
WHERE "type" = 'collaboration.updated'
	OR "stream" IN (SELECT 'chat:' || "chat_id" FROM "collaboration_move");--> statement-breakpoint
-- A finished asking reply that held nothing but collaboration cards goes,
-- unless something still points at it: a turn answering it, or one asked for
-- and not yet started, as a resumption is; a reply quoting it; a reaction, a
-- file or a tool call; or a compaction asked for up to it.
DELETE FROM "message"
WHERE "message"."parts" @> '[{"type": "collaboration"}]'
	AND "message"."status" = 'complete'
	AND NOT EXISTS (
		SELECT 1 FROM jsonb_array_elements("message"."parts") AS element(part)
		WHERE element.part->>'type' <> 'collaboration'
	)
	AND NOT EXISTS (SELECT 1 FROM "turn" WHERE "turn"."trigger_message_id" = "message"."id")
	AND NOT EXISTS (
		SELECT 1 FROM (
			SELECT "payload" FROM "lane" WHERE "payload" IS NOT NULL
			UNION ALL
			SELECT "payload" FROM "lane_request"
		) AS asked
		WHERE "message"."id"::text IN (asked."payload"->>'triggerMessageId', asked."payload"->>'sourceMessageId')
	)
	AND NOT EXISTS (SELECT 1 FROM "message" quoting WHERE quoting."reply_to_message_id" = "message"."id")
	AND NOT EXISTS (SELECT 1 FROM "message_reaction" WHERE "message_reaction"."message_id" = "message"."id")
	AND NOT EXISTS (SELECT 1 FROM "file" WHERE "file"."message_id" = "message"."id")
	AND NOT EXISTS (SELECT 1 FROM "tool_call" WHERE "tool_call"."message_id" = "message"."id");--> statement-breakpoint
-- The other asking replies without their collaboration cards, the text on
-- either side of a card joined again.
WITH kept AS (
	SELECT "message"."id" AS "message_id", element.part, element.position
	FROM "message", jsonb_array_elements("message"."parts") WITH ORDINALITY AS element(part, position)
	WHERE "message"."parts" @> '[{"type": "collaboration"}]'
		AND element.part->>'type' <> 'collaboration'
), starts AS (
	SELECT kept.*,
		CASE WHEN kept.part->>'type' = 'text' AND lag(kept.part->>'type') OVER in_order = 'text' THEN 0 ELSE 1 END AS starts_run
	FROM kept
	WINDOW in_order AS (PARTITION BY kept."message_id" ORDER BY kept.position)
), runs AS (
	SELECT starts.*,
		sum(starts.starts_run) OVER (PARTITION BY starts."message_id" ORDER BY starts.position) AS run
	FROM starts
), joined AS (
	SELECT runs."message_id", runs.run,
		CASE WHEN count(*) > 1
			THEN jsonb_build_object('type', 'text', 'text', string_agg(runs.part->>'text', '' ORDER BY runs.position))
			ELSE (array_agg(runs.part))[1]
		END AS part
	FROM runs
	GROUP BY runs."message_id", runs.run
)
UPDATE "message" SET "parts" = coalesce(
	(SELECT jsonb_agg(joined.part ORDER BY joined.run) FROM joined WHERE joined."message_id" = "message"."id"),
	'[]'::jsonb
)
WHERE "message"."parts" @> '[{"type": "collaboration"}]';--> statement-breakpoint
-- The asking bot's turn after its helpers have answered is a hand-back, where
-- it was resumed once its collaboration ended. Turns asked for and not yet
-- finished carry their reason too.
UPDATE "turn" SET "reason" = 'hand_back' WHERE "reason" = 'resume';--> statement-breakpoint
UPDATE "lane" SET "payload" = jsonb_set("payload", '{reason}', '"hand_back"') WHERE "workflow" = 'turn' AND "payload"->>'reason' = 'resume';--> statement-breakpoint
UPDATE "lane_request" SET "payload" = jsonb_set("payload", '{reason}', '"hand_back"') WHERE "workflow" = 'turn' AND "payload"->>'reason' = 'resume';--> statement-breakpoint
-- Empty now, the collaboration chats go, and with them their read cursors,
-- compactions and the system chats serving them. Deleting them queues their
-- folders for deletion, which would take the bytes queued to move above.
DELETE FROM "chat" WHERE "kind" = 'collaboration';--> statement-breakpoint
DELETE FROM "blob_deletion"
WHERE "prefix" IN (SELECT 'chats/' || "chat_id" FROM "collaboration_move");--> statement-breakpoint
DROP TABLE "collaboration_move";--> statement-breakpoint
DROP VIEW "placed_chat";--> statement-breakpoint
DROP TABLE "collaboration";--> statement-breakpoint
ALTER TABLE "chat" DROP CONSTRAINT "chat_kind_valid", ADD CONSTRAINT "chat_kind_valid" CHECK ("kind" in ('project_chat', 'run', 'automation_feed', 'system_chat'));--> statement-breakpoint
-- The kind check names the kinds in its body, so it is made again.
CREATE OR REPLACE FUNCTION chat_has_kind_row() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	has_kind_row boolean;
BEGIN
	IF NOT EXISTS (SELECT 1 FROM "chat" WHERE "id" = NEW."id") THEN
		RETURN NULL;
	END IF;
	has_kind_row := CASE NEW."kind"
		WHEN 'project_chat' THEN EXISTS (SELECT 1 FROM "project_chat" WHERE "chat_id" = NEW."id")
		WHEN 'run' THEN EXISTS (SELECT 1 FROM "run" WHERE "chat_id" = NEW."id")
		WHEN 'automation_feed' THEN EXISTS (SELECT 1 FROM "automation_feed" WHERE "chat_id" = NEW."id")
		WHEN 'system_chat' THEN EXISTS (SELECT 1 FROM "system_chat" WHERE "chat_id" = NEW."id")
		ELSE false
	END;
	IF NOT has_kind_row THEN
		RAISE EXCEPTION 'chat % is a % with no % row', NEW."id", NEW."kind", NEW."kind"
			USING ERRCODE = 'foreign_key_violation';
	END IF;
	RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE VIEW "placed_chat" AS (select
	c.id, c.workspace_id, c.kind, c.title, c.created_at, c.updated_at,
	coalesce(p.default_of_bot_id, sc.bot_id) as bot_id,
	p.id as project_id,
	case c.kind
		when 'run' then rf.chat_id
		when 'system_chat' then null
		else c.id
	end as root_chat_id,
	sc.served_chat_id as parent_chat_id,
	cc.started_by_id,
	sc.system_bot_key,
	cc.resolved_at,
	f.automation_id
from "chat" c
left join "project_chat" cc on cc.chat_id = c.id
left join "run" r on r.chat_id = c.id
left join "automation_feed" rf on rf.automation_id = r.automation_id
left join "automation_feed" f on f.chat_id = c.id
left join "automation" a on a.id = coalesce(r.automation_id, f.automation_id)
left join "project" p on p.id = coalesce(cc.project_id, a.project_id)
left join "system_chat" sc on sc.chat_id = c.id);
--> statement-breakpoint
-- ## Member sign-ins
-- Who each sign-in signs in as, so a member leaving a workspace can take
-- theirs with them: who made a connector's OAuth sign-in or a model provider's
-- subscription sign-in, and who installed a GitHub app on their own GitHub
-- account. Until now nothing recorded these, so the best evidence fills them in.
ALTER TABLE "connector" ADD COLUMN "signed_in_by_id" uuid;--> statement-breakpoint
ALTER TABLE "connector" ADD COLUMN "installed_by_id" uuid;--> statement-breakpoint
ALTER TABLE "model_provider" ADD COLUMN "signed_in_by_id" uuid;--> statement-breakpoint
ALTER TABLE "connector" ADD CONSTRAINT "connector_signed_in_by_id_member_id_fkey" FOREIGN KEY ("signed_in_by_id") REFERENCES "member"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "connector" ADD CONSTRAINT "connector_installed_by_id_member_id_fkey" FOREIGN KEY ("installed_by_id") REFERENCES "member"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "model_provider" ADD CONSTRAINT "model_provider_signed_in_by_id_member_id_fkey" FOREIGN KEY ("signed_in_by_id") REFERENCES "member"("id") ON DELETE SET NULL;--> statement-breakpoint
-- A connector's sign-in recorded no signer, and its tokens are sealed, so
-- whoever added it is taken to have signed it in, as adding a built-in
-- connector does in one step. A record with no tokens in it, of a sign-in
-- still under way or refused, is taken to be theirs too.
UPDATE "connector" SET "signed_in_by_id" = "created_by_id"
WHERE "auth_kind" = 'oauth' AND "oauth_encrypted" IS NOT NULL;--> statement-breakpoint
-- Signing a model provider in made the signer who connected it, which only a
-- key given since, irrelevant to a provider that signs in, changes.
UPDATE "model_provider" SET "signed_in_by_id" = "connected_by_id"
WHERE "oauth_tokens_encrypted" IS NOT NULL;--> statement-breakpoint
-- A project's app is private, so it is installed only on the account that
-- owns it, and one a GitHub user owns was made on their own account by the
-- member who added it.
UPDATE "connector" SET "installed_by_id" = "created_by_id"
WHERE "kind" = 'github'
	AND "settings" -> 'owner' ->> 'type' = 'User'
	AND "settings" ->> 'installationId' IS NOT NULL;
--> statement-breakpoint
-- ## Scheduled system work
CREATE TABLE "github_uninstall" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"workspace_id" uuid NOT NULL,
	"connector_id" uuid NOT NULL,
	"app_id" bigint NOT NULL,
	"installation_id" bigint,
	"app_credential_encrypted" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "automation" ADD COLUMN "pause_after_failures_pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "automation_pending_pause_idx" ON "automation" ("id") WHERE "pause_after_failures_pending";--> statement-breakpoint
CREATE INDEX "github_uninstall_due_idx" ON "github_uninstall" ("next_attempt_at","id");
--> statement-breakpoint
-- ## Message retries scoped
ALTER TABLE "message" ADD COLUMN "retry_key" uuid;--> statement-breakpoint
ALTER TABLE "project_chat" ADD COLUMN "start_retry_key" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "message_retry_idx" ON "message" ("chat_id","author_member_id","retry_key") WHERE "retry_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "project_chat_start_retry_idx" ON "project_chat" ("project_id","started_by_id","start_retry_key") WHERE "start_retry_key" is not null;
--> statement-breakpoint
-- ## Unbound connector sign-ins cleared
UPDATE "connector" SET "oauth_state" = NULL WHERE "oauth_state" IS NOT NULL;
--> statement-breakpoint
-- ## Connector on switch
ALTER TABLE "connector" ADD COLUMN "enabled" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
-- ## Turns take one model request a step
-- A turn takes one model request a step, and records which step made each of
-- its tool calls. Calls made before have none.
ALTER TABLE "tool_call" ADD COLUMN "step" integer;--> statement-breakpoint
-- A turn running or waiting now kept a checkpoint the bot loop can no longer
-- carry on from, so it ends as cancelled, as cancelling a turn ends it: its
-- unfinished tool calls fail, a pending approval is denied, and its reply
-- stops. Its workflow, once it resumes, finds the turn ended and frees its
-- lane; one waiting for approvals is told to stop by the sweep for lost
-- cancels, as the turn is marked as asked to stop.
UPDATE "tool_call" SET
	"status" = 'failed',
	"approval_status" = CASE WHEN "approval_status" = 'pending' THEN 'denied' ELSE "approval_status" END,
	"error" = 'Turn cancelled',
	"finished_at" = now()
WHERE "status" IN ('running', 'awaiting_approval')
	AND "turn_id" IN (SELECT "id" FROM "turn" WHERE "status" IN ('running', 'waiting'));--> statement-breakpoint
UPDATE "message" SET "status" = 'cancelled'
WHERE "status" = 'writing'
	AND "turn_id" IN (SELECT "id" FROM "turn" WHERE "status" IN ('running', 'waiting'));--> statement-breakpoint
UPDATE "turn" SET
	"status" = 'cancelled',
	"interrupt_requested" = true,
	"checkpoint" = NULL,
	"finished_at" = now()
WHERE "status" IN ('running', 'waiting');--> statement-breakpoint
-- A failed turn waiting to run again starts from nothing, so its old
-- checkpoint goes too.
UPDATE "turn" SET "checkpoint" = NULL WHERE "checkpoint" IS NOT NULL;
--> statement-breakpoint
-- ## Turns carry an execution number
-- Each turn counts its executions: its authenticator raises the number each
-- time the turn starts or resumes, and the bot loop's writes for an older
-- execution are refused. A turn has had none until the next time it starts.
ALTER TABLE "turn" ADD COLUMN "execution_number" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- ## Tool calls are recorded once a step
-- A tool call is recorded as sent before it is sent, under its turn, the
-- step that made it and the model's id for it, so only one execution of the
-- turn sends it. Calls made before steps were recorded have no step, and
-- keep no such key.
DROP INDEX "tool_call_sdk_call_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "tool_call_step_call_idx" ON "tool_call" ("turn_id","step","sdk_tool_call_id");
--> statement-breakpoint
-- ## OAuth exchange claim
ALTER TABLE "connector" ADD COLUMN "oauth_exchange_id" uuid;--> statement-breakpoint
ALTER TABLE "connector" ADD COLUMN "oauth_exchange_until" timestamp with time zone;
--> statement-breakpoint
-- ## Deletion intents
ALTER TABLE "project" ADD COLUMN "deleting" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace" ADD COLUMN "deleting" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- ## Notification deliveries
CREATE TABLE "notification_delivery" (
	"chat_id" uuid,
	"delivery_id" text,
	"member_id" uuid,
	"notification" jsonb NOT NULL,
	CONSTRAINT "notification_delivery_pkey" PRIMARY KEY("chat_id","delivery_id","member_id")
);
--> statement-breakpoint
ALTER TABLE "notification_delivery" ADD CONSTRAINT "notification_delivery_chat_id_chat_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "chat"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "notification_delivery" ADD CONSTRAINT "notification_delivery_member_id_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "member"("id") ON DELETE CASCADE;
--> statement-breakpoint
-- ## Tool calls without steps stay unique
CREATE UNIQUE INDEX "tool_call_unstepped_call_idx" ON "tool_call" ("turn_id","sdk_tool_call_id") WHERE "step" is null;
--> statement-breakpoint
-- ## Tool calls remember who sent them
-- Which execution of its turn last sent each tool call, so a newer execution
-- resuming the turn sends a call that changes nothing again only once. Calls
-- sent before have none.
ALTER TABLE "tool_call" ADD COLUMN "sent_in_execution" integer;
--> statement-breakpoint
-- ## Failed turns keep when they retry
-- When a failed turn that runs again may run, as its model's provider asked, kept
-- with the failure so a workflow resuming after it still waits. Existing turns
-- keep none: their workflows wait the usual delay.
ALTER TABLE "turn" ADD COLUMN "retry_at" timestamp with time zone;
--> statement-breakpoint
-- ## Computer intents
ALTER TABLE "computer" ADD COLUMN "intent_id" uuid;--> statement-breakpoint
ALTER TABLE "computer" ADD COLUMN "intent_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "computer" ADD CONSTRAINT "computer_intent_check" CHECK (("intent_id" is null) = ("intent_expires_at" is null));
--> statement-breakpoint
-- ## Pending pause time
ALTER TABLE "automation" ADD COLUMN "pause_after_failures_pending_at" timestamp with time zone;--> statement-breakpoint
UPDATE "automation" SET "pause_after_failures_pending_at" = "updated_at" WHERE "pause_after_failures_pending";--> statement-breakpoint
DROP INDEX "automation_pending_pause_idx";--> statement-breakpoint
ALTER TABLE "automation" DROP COLUMN "pause_after_failures_pending";--> statement-breakpoint
CREATE INDEX "automation_pending_pause_idx" ON "automation" ("id") WHERE "pause_after_failures_pending_at" is not null;
--> statement-breakpoint
-- ## Computer lease provider id
ALTER TABLE "computer_lease" ADD COLUMN "provider_computer_id" text;--> statement-breakpoint
UPDATE "computer_lease"
SET "provider_computer_id" = "computer"."provider_computer_id"
FROM "computer"
WHERE "computer_lease"."computer_id" = "computer"."id";--> statement-breakpoint
ALTER TABLE "computer_lease" ALTER COLUMN "provider_computer_id" SET NOT NULL;
--> statement-breakpoint
-- ## Memberships leaving
ALTER TABLE "membership" ADD COLUMN "leaving" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "membership" ADD CONSTRAINT "membership_owner_stays" CHECK (not "leaving" or "role" <> 'owner');--> statement-breakpoint
UPDATE "membership"
SET "leaving" = true
FROM "bot"
JOIN "project" ON "project"."workspace_id" = "bot"."workspace_id"
	AND "project"."default_of_bot_id" = "bot"."id"
WHERE "membership"."workspace_id" = "bot"."workspace_id"
	AND "membership"."member_id" = "bot"."assistant_of"
	AND "membership"."role" <> 'owner'
	AND "project"."deleting";--> statement-breakpoint
CREATE OR REPLACE FUNCTION add_administrators_to_new_project() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF NEW."default_of_bot_id" IS NOT NULL THEN
		RETURN NULL;
	END IF;
	PERFORM lock_project_membership(NEW."workspace_id");
	INSERT INTO "project_member" ("workspace_id", "project_id", "member_id")
	SELECT NEW."workspace_id", NEW."id", "member_id"
	FROM "membership"
	WHERE "workspace_id" = NEW."workspace_id" AND NOT "leaving" AND "role" IN ('owner', 'admin')
	ON CONFLICT ("project_id", "member_id") DO NOTHING;
	RETURN NULL;
END;
$$;
--> statement-breakpoint
-- ## Brief turn rule
ALTER TABLE "message" ADD COLUMN "brief_turn_rule" text;
--> statement-breakpoint
-- ## Written file receipts
ALTER TABLE "tool_call" ADD COLUMN "written_file_receipt" jsonb;
--> statement-breakpoint
-- ## Turn steers
ALTER TABLE "turn" ADD COLUMN "steers" jsonb DEFAULT '[]' NOT NULL;
--> statement-breakpoint
-- ## Turn askers and joins
ALTER TABLE "message" ADD COLUMN "joined_turns" jsonb DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE "turn" ADD COLUMN "asker_id" uuid;--> statement-breakpoint
ALTER TABLE "turn" ADD COLUMN "asked_by_automation" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "turn" ADD CONSTRAINT "turn_asker_id_member_id_fkey" FOREIGN KEY ("asker_id") REFERENCES "member"("id") ON DELETE RESTRICT;--> statement-breakpoint

-- Who a turn answering `trigger_message` in `chat` acts for, worked out once, when it is asked for and when it is made: the member who wrote the message; when a bot's turn wrote it, that turn's asker, or its run; when its automation's trigger posted it, its run, with no member. A bot's message no turn wrote, such as a brief, or a message not written yet, such as an interview's first reply, acts for the member who started the chat.
CREATE FUNCTION turn_asker(chat uuid, trigger_message uuid, OUT member_id uuid, OUT automation boolean)
LANGUAGE sql STABLE AS $$
	SELECT
		CASE
			WHEN answered.author_member_id IS NOT NULL THEN answered.author_member_id
			WHEN answered.automation_trigger IS NOT NULL THEN NULL
			WHEN writer.id IS NOT NULL THEN writer.asker_id
			ELSE started.started_by_id
		END,
		coalesce(
			answered.automation_trigger IS NOT NULL
				OR (answered.author_member_id IS NULL AND writer.asked_by_automation),
			false
		)
	FROM (SELECT chat AS chat_id) AS asked
	LEFT JOIN "message" AS answered ON answered.id = trigger_message AND answered.chat_id = asked.chat_id
	LEFT JOIN "turn" AS writer ON writer.id = answered.turn_id AND answered.author_bot_id IS NOT NULL
	LEFT JOIN "project_chat" AS started ON started.chat_id = asked.chat_id;
$$;--> statement-breakpoint

-- Stores the asker of every turn as it is made, however it is made.
CREATE FUNCTION set_turn_asker() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	SELECT member_id, automation INTO NEW."asker_id", NEW."asked_by_automation"
	FROM turn_asker(NEW."chat_id", NEW."trigger_message_id");
	RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER turn_asker
BEFORE INSERT ON "turn"
FOR EACH ROW EXECUTE FUNCTION set_turn_asker();--> statement-breakpoint

-- The turns made before askers were stored keep the asker their chain of turns gave them.
UPDATE "turn" AS t SET ("asker_id", "asked_by_automation") = (
	WITH RECURSIVE asking(turn_id, message_id, visited) AS (
		SELECT t.id, t.trigger_message_id, ARRAY[t.id]
		UNION ALL
		SELECT earlier.id, earlier.trigger_message_id, array_append(asking.visited, earlier.id)
		FROM asking
		INNER JOIN "message" AS asking_message ON asking_message.id = asking.message_id
		INNER JOIN "turn" AS earlier ON earlier.id = asking_message.turn_id
		WHERE asking_message.author_bot_id IS NOT NULL
			AND earlier.id <> ALL(asking.visited)
	)
	SELECT
		CASE
			WHEN end_message.author_member_id IS NOT NULL THEN end_message.author_member_id
			WHEN end_message.automation_trigger IS NULL
				AND (end_message.turn_id IS NULL OR end_message.turn_id = asking.turn_id)
				THEN end_chat.started_by_id
		END,
		coalesce(end_message.author_member_id IS NULL AND end_message.automation_trigger IS NOT NULL, false)
	FROM asking
	INNER JOIN "message" AS end_message ON end_message.id = asking.message_id
	LEFT JOIN "project_chat" AS end_chat ON end_chat.chat_id = end_message.chat_id
	ORDER BY cardinality(asking.visited) DESC
	LIMIT 1
)
WHERE EXISTS (SELECT 1 FROM "message" WHERE "message"."id" = t.trigger_message_id);
--> statement-breakpoint
-- ## Approval target and age
ALTER TABLE "tool_call" ADD COLUMN "approval_computer_project_id" uuid;--> statement-breakpoint
ALTER TABLE "tool_call" ADD COLUMN "approval_connector_access" text;--> statement-breakpoint
ALTER TABLE "tool_call" ADD COLUMN "approval_asked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tool_call" ADD COLUMN "approval_resolved_targets" jsonb;--> statement-breakpoint
CREATE INDEX "tool_call_pending_approval_age_idx" ON "tool_call" (coalesce("approval_asked_at", "started_at")) WHERE "approval_status" = 'pending';
--> statement-breakpoint
UPDATE "tool_call" AS call
SET "approval_computer_project_id" = placed."project_id"
FROM "placed_chat" AS placed
WHERE call."tool" = 'request_host'
	AND call."approval_id" IS NOT NULL
	AND placed."id" = call."chat_id";
--> statement-breakpoint
UPDATE "tool_call" SET "approval_asked_at" = "started_at"
WHERE "approval_id" IS NOT NULL;
--> statement-breakpoint
-- ## Backfill approval connector access
UPDATE "tool_call" AS call
SET "approval_connector_access" = 'ask'
FROM "connector" AS connector
WHERE connector."id" = call."connector_id"
	AND call."approval_status" IN ('pending', 'allowed')
	AND call."approval_connector_access" IS NULL
	AND COALESCE(
		connector."tool_access" ->> call."remote_tool_name",
		CASE WHEN (connector."kind" = 'http' AND call."remote_tool_name" = 'delete')
			OR (connector."kind" = 'github' AND call."remote_tool_name" = 'delete_comment')
			THEN 'off'
		END,
		(
			SELECT CASE
				WHEN described ->> 'destructive' = 'true' THEN 'off'
				WHEN described ->> 'readOnly' = 'true' THEN 'allow'
				ELSE 'ask'
			END
			FROM jsonb_array_elements(connector."tools") AS described
			WHERE connector."kind" = 'mcp' AND described ->> 'name' = call."remote_tool_name"
			LIMIT 1
		),
		CASE WHEN connector."kind" = 'mcp' AND call."remote_tool_name" = 'upload_file'
			AND connector."url" ~* '^https?://mcp[.]linear[.]app([/?#]|$)' THEN 'allow'
		END,
		CASE WHEN call."write_or_delete" THEN 'ask' ELSE 'allow' END
	) = 'ask';
--> statement-breakpoint
-- A legacy pending call's last update is when it parked, including if it parked again.
UPDATE "tool_call"
SET "approval_asked_at" = "updated_at"
WHERE "approval_status" = 'pending'
	AND "status" = 'awaiting_approval'
	AND "approval_asked_at" = "started_at"
	AND "updated_at" > "started_at";
--> statement-breakpoint
-- ## Turn end requests
ALTER TABLE "turn" ADD COLUMN "end_requested" text;--> statement-breakpoint
-- Why a turn was asked to end wasn't kept before; each one asked keeps that it was.
UPDATE "turn" SET "end_requested" = 'interrupted' WHERE "interrupt_requested";--> statement-breakpoint
ALTER TABLE "turn" DROP COLUMN "interrupt_requested";--> statement-breakpoint
ALTER TABLE "turn" ADD CONSTRAINT "turn_end_requested_valid" CHECK ("end_requested" in ('interrupted', 'run_ended', 'lost_reach', 'approval_expired'));
--> statement-breakpoint
-- ## Turn askers in code
-- The turn store now writes each turn's asker as it makes the turn, so no trigger does.
DROP TRIGGER "turn_asker" ON "turn";--> statement-breakpoint
DROP FUNCTION set_turn_asker();--> statement-breakpoint
DROP FUNCTION turn_asker(uuid, uuid);--> statement-breakpoint

-- Who the bot `answering_bot`'s turn answering `trigger_message` in `chat` acts for: the member who wrote the message; when a bot's turn wrote it, that turn's asker, or its run; when its automation's trigger posted it, its run. A personal bot's run, in its own chats, acts for its creator. A bot's message no turn wrote, such as a brief, acts for the member who started the chat, and so does an interview's turn, which answers its own first reply.
CREATE FUNCTION turn_asker(chat uuid, trigger_message uuid, answering_bot uuid, OUT member_id uuid, OUT automation boolean)
LANGUAGE sql STABLE AS $$
	SELECT
		coalesce(asked.member_id, CASE WHEN asked.automation AND run.id IS NOT NULL AND personal.visibility = 'personal' THEN personal.created_by_id END),
		asked.automation
	FROM (
		SELECT
			CASE
				WHEN answered.author_member_id IS NOT NULL THEN answered.author_member_id
				WHEN answered.automation_trigger IS NOT NULL THEN NULL
				WHEN writer.id IS NOT NULL THEN writer.asker_id
				ELSE started.started_by_id
			END AS member_id,
			coalesce(
				answered.automation_trigger IS NOT NULL
					OR (answered.author_member_id IS NULL AND writer.asked_by_automation),
				false
			) AS automation
		FROM (SELECT chat AS chat_id) AS asking
		LEFT JOIN "message" AS answered ON answered.id = trigger_message AND answered.chat_id = asking.chat_id
		LEFT JOIN "turn" AS writer ON writer.id = answered.turn_id AND answered.author_bot_id IS NOT NULL
		LEFT JOIN "project_chat" AS started ON started.chat_id = asking.chat_id
	) AS asked
	LEFT JOIN "run" AS run ON run.chat_id = chat
	LEFT JOIN "placed_chat" AS place ON place.id = chat
	LEFT JOIN "project" AS own ON own.id = place.project_id AND own.default_of_bot_id = answering_bot
	LEFT JOIN "bot" AS personal ON personal.id = own.default_of_bot_id;
$$;--> statement-breakpoint

-- A personal bot's runs' turns, in its own chats, act for its creator, which they now store.
UPDATE "turn" AS t SET "asker_id" = personal."created_by_id"
FROM "run" AS run, "placed_chat" AS place, "project" AS own, "bot" AS personal
WHERE t."asker_id" IS NULL
	AND t."asked_by_automation"
	AND run."chat_id" = t."chat_id"
	AND place."id" = t."chat_id"
	AND own."id" = place."project_id"
	AND own."default_of_bot_id" = t."bot_id"
	AND personal."id" = t."bot_id"
	AND personal."visibility" = 'personal'
	AND personal."created_by_id" IS NOT NULL;--> statement-breakpoint

-- A turn still in flight that the backfill found nobody to act for is asked to end, so it ends as it next runs, or, waiting, as the cancel sweep tells its workflow.
UPDATE "turn" AS t SET "end_requested" = 'lost_reach'
FROM "chat" AS c
WHERE c."id" = t."chat_id"
	AND c."kind" <> 'system_chat'
	AND t."asker_id" IS NULL
	AND NOT t."asked_by_automation"
	AND t."end_requested" IS NULL
	AND (t."status" IN ('running', 'waiting') OR (t."status" = 'failed' AND t."retrying"));
--> statement-breakpoint
-- ## Computer destructions
CREATE TABLE "computer_destruction" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"workspace_id" uuid NOT NULL,
	"computer_provider_id" uuid NOT NULL,
	"provider_computer_id" text,
	"creation_id" uuid,
	"due_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "computer_destruction_found_check" CHECK ("provider_computer_id" is not null or "creation_id" is not null)
);
--> statement-breakpoint
CREATE INDEX "computer_destruction_due_idx" ON "computer_destruction" ("due_at","id");--> statement-breakpoint
ALTER TABLE "computer_destruction" ADD CONSTRAINT "computer_destruction_provider_workspace_fkey" FOREIGN KEY ("computer_provider_id","workspace_id") REFERENCES "computer_provider"("id","workspace_id") ON DELETE CASCADE;--> statement-breakpoint
-- The computers of `personal` `pod`s with no bots, which "Bots own
-- resources" kept aside, are destroyed at their providers.
INSERT INTO "computer_destruction" ("workspace_id", "computer_provider_id", "provider_computer_id")
SELECT "workspace_id", "sandbox_provider_id", "provider_sandbox_id" FROM "sandbox_left_over";--> statement-breakpoint
DROP TABLE "sandbox_left_over";
--> statement-breakpoint
-- ## Blob deletions come due
ALTER TABLE "blob_deletion" ADD COLUMN "due_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE INDEX "blob_deletion_due_idx" ON "blob_deletion" ("due_at","id");
--> statement-breakpoint
-- ## Model provider refresh claim
ALTER TABLE "model_provider" ADD COLUMN "oauth_refresh_id" uuid;--> statement-breakpoint
ALTER TABLE "model_provider" ADD COLUMN "oauth_refresh_until" timestamp with time zone;--> statement-breakpoint
-- Which configuration a provider has, counted rather than read from when it
-- was last updated, which a test or a refresh also moves on.
ALTER TABLE "model_provider" ADD COLUMN "configuration_revision" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- ## Requests remember personal assistants
ALTER TABLE "model_request" ADD COLUMN "by_personal_assistant" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- What was recorded before is counted by the bots as they are now: a request
-- by a Personal Assistant still in the workspace was one.
UPDATE "model_request" SET "by_personal_assistant" = true
FROM "bot" WHERE "bot"."id" = "model_request"."bot_id" AND "bot"."assistant_of" IS NOT NULL;
--> statement-breakpoint
-- ## Deleted GitHub connectors uninstall
-- A GitHub connector is the only record of its app's installation, and of the
-- key that uninstalls it, so deleting one whose app was made, however it goes
-- (on its own, or with its project, bot or workspace), queues the uninstall,
-- which the scheduler makes at GitHub once it commits. Only the database sees
-- every route. One with no installation recorded may still have been
-- installed before GitHub sent its member back, so its uninstall names none,
-- and GitHub is asked for the app's installations.
CREATE FUNCTION queue_deleted_github_installations() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	INSERT INTO "github_uninstall" ("workspace_id", "connector_id", "app_id", "installation_id", "app_credential_encrypted")
	SELECT "workspace_id", "id", ("settings"->>'appId')::bigint, ("settings"->>'installationId')::bigint, "app_credential_encrypted"
	FROM deleted_connectors
	WHERE "kind" = 'github'
		AND "app_credential_encrypted" IS NOT NULL;
	RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER connector_github_uninstall
AFTER DELETE ON "connector"
REFERENCING OLD TABLE AS deleted_connectors
FOR EACH STATEMENT EXECUTE FUNCTION queue_deleted_github_installations();
--> statement-breakpoint
-- ## Notifications outlive their process
CREATE TABLE "pending_notification" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"chat_id" uuid NOT NULL,
	"delivery_id" text NOT NULL,
	"cause" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"due_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notification_delivery" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_delivery" ADD COLUMN "sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notification_delivery" ADD COLUMN "claimed_until" timestamp with time zone;--> statement-breakpoint
-- Every notification recorded before was sent as it was recorded.
UPDATE "notification_delivery" SET "sent_at" = "created_at";--> statement-breakpoint
CREATE INDEX "notification_delivery_unsent_idx" ON "notification_delivery" ("created_at") WHERE "sent_at" is null;--> statement-breakpoint
CREATE INDEX "pending_notification_due_idx" ON "pending_notification" ("due_at","id");--> statement-breakpoint
ALTER TABLE "pending_notification" ADD CONSTRAINT "pending_notification_chat_id_chat_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "chat"("id") ON DELETE CASCADE;--> statement-breakpoint
-- ## Turn lookups indexed
-- A turn's reply is found by its turn on every write the turn makes while it
-- runs, and the sweep for lost cancels reads only turns asked to end.
CREATE INDEX "message_turn_idx" ON "message" ("turn_id") WHERE "turn_id" is not null;--> statement-breakpoint
CREATE INDEX "turn_end_requested_idx" ON "turn" ("status","finished_at") WHERE "end_requested" is not null;--> statement-breakpoint
-- ## Ended sessions tell their streams
-- A member's streams and desktop viewers end with the session they were opened
-- with. Deleting a session, however it goes (signing out, revoking it,
-- resetting a password, or with its member), stores `session.ended` on the
-- member's stream in the same transaction, and notifies every process's event
-- relay, which Postgres sends once it commits.
--
-- Each stream is locked, as the event outbox locks it, so its events keep one
-- order. A transaction takes its streams' locks in one order, by name, and
-- lists them in its `sugabots.locked_streams` setting, as the outbox does too:
-- locking a stream that sorts before one it already holds fails at once,
-- rather than waiting on a transaction that may be waiting on this one.
CREATE FUNCTION publish_ended_sessions() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	stored record;
	locked text[] := coalesce(string_to_array(nullif(current_setting('sugabots.locked_streams', true), ''), ','), '{}');
	to_lock text[];
	next_stream text;
BEGIN
	SELECT coalesce(array_agg(ended.stream ORDER BY ended.stream COLLATE "C"), '{}') INTO to_lock
	FROM (SELECT DISTINCT 'member:' || "member_id"::text AS stream FROM ended_sessions) AS ended
	WHERE NOT ended.stream = ANY (locked);
	IF to_lock[1] COLLATE "C" < (SELECT max(held COLLATE "C") FROM unnest(locked) AS held) THEN
		RAISE EXCEPTION 'Locking event stream % after % would take a transaction''s stream locks out of order',
			to_lock[1], (SELECT max(held COLLATE "C") FROM unnest(locked) AS held);
	END IF;
	FOREACH next_stream IN ARRAY to_lock LOOP
		PERFORM pg_advisory_xact_lock(hashtextextended(next_stream, 0));
	END LOOP;
	IF cardinality(to_lock) > 0 THEN
		PERFORM set_config('sugabots.locked_streams', array_to_string(locked || to_lock, ','), true);
	END IF;
	FOR stored IN
		INSERT INTO "event" ("stream", "type", "payload")
		SELECT 'member:' || "member_id"::text, 'session.ended',
			jsonb_build_object('v', 1, 'type', 'session.ended', 'sessionId', "id"::text)
		FROM ended_sessions
		RETURNING "seq", "stream"
	LOOP
		PERFORM pg_notify('sugabots_events', json_build_object('from', 'database', 'stream', stored."stream", 'seq', stored."seq")::text);
	END LOOP;
	RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER session_ended
AFTER DELETE ON "session"
REFERENCING OLD TABLE AS ended_sessions
FOR EACH STATEMENT EXECUTE FUNCTION publish_ended_sessions();
--> statement-breakpoint
-- ## Private bots
-- A bot may be private: reached only by its members, as a private project
-- is. The owner and admins are members of every private bot, as of every
-- project members made, so `bot_member` is the whole list of who reaches one.
CREATE TABLE "bot_member" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"workspace_id" uuid NOT NULL,
	"bot_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "bot_member_idx" ON "bot_member" ("bot_id","member_id");--> statement-breakpoint
CREATE INDEX "bot_member_member_id_idx" ON "bot_member" ("member_id");--> statement-breakpoint
ALTER TABLE "bot_member" ADD CONSTRAINT "bot_member_bot_workspace_fkey" FOREIGN KEY ("bot_id","workspace_id") REFERENCES "bot"("id","workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "bot_member" ADD CONSTRAINT "bot_member_membership_fkey" FOREIGN KEY ("workspace_id","member_id") REFERENCES "membership"("workspace_id","member_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "bot" DROP CONSTRAINT "bot_visibility_check", ADD CONSTRAINT "bot_visibility_check" CHECK ("visibility" in ('public', 'private', 'personal'));--> statement-breakpoint
-- Serialises every write that decides whether an administrator is in a private bot, as `lock_project_membership` does for projects.
CREATE FUNCTION lock_bot_membership(workspace uuid) RETURNS void
LANGUAGE sql AS $$
	SELECT pg_advisory_xact_lock(hashtext('bot_membership:' || workspace::text));
$$;--> statement-breakpoint
CREATE FUNCTION add_administrators_to_private_bot() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	PERFORM lock_bot_membership(NEW."workspace_id");
	INSERT INTO "bot_member" ("workspace_id", "bot_id", "member_id")
	SELECT NEW."workspace_id", NEW."id", "member_id"
	FROM "membership"
	WHERE "workspace_id" = NEW."workspace_id" AND "role" IN ('owner', 'admin') AND NOT "leaving"
	ON CONFLICT ("bot_id", "member_id") DO NOTHING;
	RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER bot_administrators
AFTER INSERT OR UPDATE OF "visibility" ON "bot"
FOR EACH ROW WHEN (NEW."visibility" = 'private')
EXECUTE FUNCTION add_administrators_to_private_bot();--> statement-breakpoint
-- Only adds: somebody demoted keeps the private bots they are in.
CREATE FUNCTION add_new_administrator_to_private_bots() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	PERFORM lock_bot_membership(NEW."workspace_id");
	INSERT INTO "bot_member" ("workspace_id", "bot_id", "member_id")
	SELECT NEW."workspace_id", "id", NEW."member_id"
	FROM "bot"
	WHERE "workspace_id" = NEW."workspace_id" AND "visibility" = 'private'
	ON CONFLICT ("bot_id", "member_id") DO NOTHING;
	RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER administrator_private_bots
AFTER INSERT OR UPDATE OF "role" ON "membership"
FOR EACH ROW WHEN (NEW."role" IN ('owner', 'admin') AND NOT NEW."leaving")
EXECUTE FUNCTION add_new_administrator_to_private_bots();--> statement-breakpoint
-- A `shared` `pod`'s bots become private, its people their members, and
-- nobody else: a creator who had left the `pod` stays out (the trigger above
-- adds the owner and admins, who were in every `shared` `pod`). Each stays in
-- the private project its `pod` became, so its own chats, files, connectors
-- and automations, in its default project, are reached by those who reached
-- them before, and nobody else.
UPDATE "bot" SET "visibility" = 'private' WHERE "in_shared_pod";--> statement-breakpoint
INSERT INTO "bot_member" ("workspace_id", "bot_id", "member_id")
SELECT b."workspace_id", b."id", pm."member_id"
FROM "bot" b
INNER JOIN "project_bot" pb ON pb."bot_id" = b."id"
INNER JOIN "project" p ON p."id" = pb."project_id" AND p."default_of_bot_id" IS NULL
INNER JOIN "project_member" pm ON pm."project_id" = p."id"
WHERE b."in_shared_pod"
ON CONFLICT ("bot_id", "member_id") DO NOTHING;--> statement-breakpoint
-- A bot's own connectors stay off in each project but its default one until
-- one of that project's managers turns them on there, for the address each
-- has then, numbered by its address revision, which every change of address
-- raises.
ALTER TABLE "connector" ADD COLUMN "address_revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE TABLE "project_bot_connector" (
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"bot_id" uuid NOT NULL,
	"connector_id" uuid NOT NULL,
	"address_revision" integer NOT NULL,
	"turned_on_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_bot_connector_pkey" PRIMARY KEY("project_id","connector_id")
);
--> statement-breakpoint
CREATE INDEX "project_bot_connector_connector_id_idx" ON "project_bot_connector" ("connector_id");--> statement-breakpoint
ALTER TABLE "project_bot_connector" ADD CONSTRAINT "project_bot_connector_turned_on_by_id_member_id_fkey" FOREIGN KEY ("turned_on_by_id") REFERENCES "member"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "project_bot_connector" ADD CONSTRAINT "project_bot_connector_project_bot_fkey" FOREIGN KEY ("project_id","bot_id") REFERENCES "project_bot"("project_id","bot_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "project_bot_connector" ADD CONSTRAINT "project_bot_connector_connector_workspace_fkey" FOREIGN KEY ("connector_id","workspace_id") REFERENCES "connector"("id","workspace_id") ON DELETE CASCADE;--> statement-breakpoint
-- A `shared` `pod`'s bots used their own connectors in the `pod`, so each
-- stays on in the private project the `pod` became.
INSERT INTO "project_bot_connector" ("workspace_id", "project_id", "bot_id", "connector_id", "address_revision")
SELECT b."workspace_id", pb."project_id", b."id", c."id", c."address_revision"
FROM "bot" b
INNER JOIN "project_bot" pb ON pb."bot_id" = b."id"
INNER JOIN "project" p ON p."id" = pb."project_id" AND p."default_of_bot_id" IS NULL
INNER JOIN "project" own ON own."default_of_bot_id" = b."id"
INNER JOIN "connector" c ON c."project_id" = own."id"
WHERE b."in_shared_pod";--> statement-breakpoint
ALTER TABLE "bot" DROP COLUMN "in_shared_pod";
