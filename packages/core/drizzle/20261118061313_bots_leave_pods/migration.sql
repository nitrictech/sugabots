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
ALTER TABLE "thread" DROP CONSTRAINT "thread_direct_valid";--> statement-breakpoint
DROP INDEX "agent_name_idx";--> statement-breakpoint
DROP INDEX "agent_handle_idx";--> statement-breakpoint
DROP INDEX "agent_provisioned_key_idx";--> statement-breakpoint
ALTER TABLE "agent" ADD COLUMN "visibility" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent" ADD COLUMN "assistant_of" uuid;--> statement-breakpoint
ALTER TABLE "pod" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "pod" ADD COLUMN "visibility" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
CREATE INDEX "pinned_agent_agent_id_idx" ON "pinned_agent" ("agent_id");--> statement-breakpoint
CREATE INDEX "pod_agent_agent_id_idx" ON "pod_agent" ("agent_id");--> statement-breakpoint
ALTER TABLE "pinned_agent" ADD CONSTRAINT "pinned_agent_workspace_member_fkey" FOREIGN KEY ("workspace_id","user_id") REFERENCES "workspace_member"("workspace_id","user_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "pinned_agent" ADD CONSTRAINT "pinned_agent_agent_workspace_fkey" FOREIGN KEY ("agent_id","workspace_id") REFERENCES "agent"("id","workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "pod_agent" ADD CONSTRAINT "pod_agent_pod_workspace_fkey" FOREIGN KEY ("pod_id","workspace_id") REFERENCES "pod"("id","workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "pod_agent" ADD CONSTRAINT "pod_agent_agent_workspace_fkey" FOREIGN KEY ("agent_id","workspace_id") REFERENCES "agent"("id","workspace_id") ON DELETE CASCADE;--> statement-breakpoint
-- A Personal pod's bots become its owner's private bots, and its Personal
-- Assistant becomes theirs by `assistant_of`.
UPDATE "agent" SET "visibility" = 'private'
FROM "pod" WHERE "pod"."id" = "agent"."pod_id" AND "pod"."kind" = 'personal';--> statement-breakpoint
UPDATE "agent" SET "assistant_of" = "pod"."owner_id"
FROM "pod"
WHERE "pod"."id" = "agent"."pod_id" AND "pod"."kind" = 'personal'
	AND "agent"."provisioned_key" = 'personal-assistant';--> statement-breakpoint
-- Sugabots manages a Personal Assistant, which has no automations: nobody can
-- change or run one now, nor would its runs reach its person in a task. Any an
-- assistant had are paused, with no next time, rather than running unmanaged.
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
-- A shared pod becomes a channel with its bots in it.
INSERT INTO "pod_agent" ("workspace_id", "pod_id", "agent_id")
SELECT "agent"."workspace_id", "agent"."pod_id", "agent"."id"
FROM "agent" JOIN "pod" ON "pod"."id" = "agent"."pod_id"
WHERE "pod"."kind" = 'shared';--> statement-breakpoint
-- Everyone keeps the bots they saw in their sidebar: a pod's members pin its
-- bots, and a Personal pod's owner their own.
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
-- A thread between people started from a pod's chat becomes one of the
-- channel's threads; everything else a bot hosts leaves the pod.
UPDATE "thread" SET "type" = 'pod_chat'
WHERE "type" = 'conversation' AND "host_agent_id" IS NULL AND "pod_id" IS NOT NULL;--> statement-breakpoint
UPDATE "thread" SET "type" = 'conversation', "pod_id" = NULL WHERE "type" = 'bot_channel';--> statement-breakpoint
UPDATE "thread" SET "pod_id" = NULL WHERE "type" NOT IN ('pod_chat', 'direct');--> statement-breakpoint
-- A file is reached through the conversation it was made in. A file whose
-- conversation is gone, which its pod's Files still listed, moves to a
-- conversation of that pod's: a shared pod's to its channel's main chat,
-- opened for it if the pod never opened one.
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
-- A Personal pod's goes to a task of the bot that made it, or else of the
-- pod's oldest bot other than its Personal Assistant, which only when it is
-- the pod's only bot: the bot's latest task, or a new one with the pod's owner
-- when it has none. A Personal pod with no bots left has no conversation to
-- give its files, and no channel survives it, so they're deleted with it.
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
-- A Personal pod admitted its owner alone; channels have no such rule.
DROP TRIGGER "personal_pod_owner_membership" ON "pod_member";--> statement-breakpoint
DROP FUNCTION enforce_personal_pod_owner_membership();--> statement-breakpoint
DROP TRIGGER "shared_pod_administrators" ON "pod";--> statement-breakpoint
CREATE TRIGGER shared_pod_administrators
AFTER INSERT ON "pod"
FOR EACH ROW EXECUTE FUNCTION add_administrators_to_new_shared_pod();