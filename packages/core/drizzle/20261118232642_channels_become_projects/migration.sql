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
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_kind_valid" CHECK ("kind" in ('bot_thread', 'project_thread', 'direct_message', 'collaboration', 'run', 'automation_feed', 'system'));--> statement-breakpoint
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
	coalesce(t.started_by_id, cc.started_by_id, dm.started_by_id) as started_by_id,
	sc.system_bot_key,
	t.done_at,
	f.automation_id,
	coalesce(cc.main, false) as main,
	cc.archived_at,
	dm.direct_key
from "conversation" c
left join "bot_thread" t on t.conversation_id = c.id
left join "project_thread" cc on cc.conversation_id = c.id
left join "direct_message" dm on dm.conversation_id = c.id
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
		WHEN 'direct_message' THEN EXISTS (SELECT 1 FROM "direct_message" WHERE "conversation_id" = NEW."id")
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
