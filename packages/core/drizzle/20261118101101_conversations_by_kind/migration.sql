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
CREATE TABLE "direct_message" (
	"conversation_id" uuid PRIMARY KEY,
	"kind" text GENERATED ALWAYS AS ('direct_message') STORED NOT NULL,
	"workspace_id" uuid NOT NULL,
	"direct_key" text NOT NULL,
	"started_by_id" uuid
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
ALTER TABLE "thread_summary" RENAME TO "summary";--> statement-breakpoint
ALTER TABLE "direct_member" RENAME TO "direct_message_member";--> statement-breakpoint
-- Named for the tables it was made between, which earlier migrations renamed.
ALTER TABLE "run" DROP CONSTRAINT IF EXISTS "routine_execution_thread_id_thread_id_fkey", DROP CONSTRAINT IF EXISTS "run_thread_id_thread_id_fkey";--> statement-breakpoint
ALTER TABLE "collaboration" DROP CONSTRAINT "collaboration_child_thread_id_thread_id_fkey";--> statement-breakpoint
ALTER TABLE "direct_message_member" DROP CONSTRAINT "direct_member_thread_id_thread_id_fkey";--> statement-breakpoint
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
ALTER TABLE "summary" RENAME COLUMN "thread_id" TO "conversation_id";--> statement-breakpoint
ALTER TABLE "direct_message_member" RENAME COLUMN "thread_id" TO "conversation_id";--> statement-breakpoint
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
ALTER TABLE "conversation" DROP CONSTRAINT "thread_direct_valid";--> statement-breakpoint
ALTER TABLE "conversation_participant" RENAME CONSTRAINT "thread_participant_one_identity" TO "conversation_participant_one_identity";--> statement-breakpoint
ALTER INDEX "model_request_thread_idx" RENAME TO "model_request_conversation_idx";--> statement-breakpoint
ALTER INDEX "run_thread_idx" RENAME TO "run_conversation_idx";--> statement-breakpoint
ALTER INDEX "collaboration_child_thread_idx" RENAME TO "collaboration_conversation_idx";--> statement-breakpoint
ALTER INDEX "thread_workspace_created_at_idx" RENAME TO "conversation_workspace_created_at_idx";--> statement-breakpoint
ALTER INDEX "thread_workspace_updated_at_idx" RENAME TO "conversation_workspace_updated_at_idx";--> statement-breakpoint
ALTER INDEX "thread_participant_user_idx" RENAME TO "conversation_participant_user_idx";--> statement-breakpoint
ALTER INDEX "thread_participant_bot_idx" RENAME TO "conversation_participant_bot_idx";--> statement-breakpoint
ALTER INDEX "thread_read_user_thread_idx" RENAME TO "conversation_read_user_conversation_idx";--> statement-breakpoint
ALTER INDEX "direct_member_thread_user_idx" RENAME TO "direct_message_member_conversation_user_idx";--> statement-breakpoint
ALTER INDEX "direct_member_user_idx" RENAME TO "direct_message_member_user_idx";--> statement-breakpoint
ALTER INDEX "message_thread_created_at_idx" RENAME TO "message_conversation_created_at_idx";--> statement-breakpoint
ALTER INDEX "turn_thread_started_at_idx" RENAME TO "turn_conversation_started_at_idx";--> statement-breakpoint
ALTER INDEX "file_thread_updated_at_idx" RENAME TO "file_conversation_updated_at_idx";--> statement-breakpoint
UPDATE "conversation" SET "kind" = CASE "kind"
	WHEN 'conversation' THEN 'task'
	WHEN 'pod_chat' THEN 'channel_conversation'
	WHEN 'direct' THEN 'direct_message'
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
INSERT INTO "direct_message" ("conversation_id", "workspace_id", "direct_key", "started_by_id")
SELECT "id", "workspace_id", "direct_key", "initiator_user_id"
FROM "conversation" WHERE "kind" = 'direct_message';
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
DROP INDEX "thread_direct_key_idx";--> statement-breakpoint
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
ALTER TABLE "conversation" DROP COLUMN "direct_key";--> statement-breakpoint
DROP INDEX "model_request_conversation_idx";--> statement-breakpoint
CREATE INDEX "model_request_conversation_idx" ON "model_request" ("conversation_id") WHERE "conversation_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "automation_feed_automation_idx" ON "automation_feed" ("automation_id");--> statement-breakpoint
CREATE INDEX "channel_conversation_channel_idx" ON "channel_conversation" ("channel_id");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_conversation_main_idx" ON "channel_conversation" ("channel_id") WHERE "main";--> statement-breakpoint
CREATE INDEX "collaboration_root_idx" ON "collaboration" ("root_conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_id_kind_idx" ON "conversation" ("id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_id_kind_workspace_idx" ON "conversation" ("id","kind","workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "direct_message_key_idx" ON "direct_message" ("workspace_id","direct_key");--> statement-breakpoint
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
ALTER TABLE "direct_message" ADD CONSTRAINT "direct_message_started_by_id_user_id_fkey" FOREIGN KEY ("started_by_id") REFERENCES "user"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "direct_message" ADD CONSTRAINT "direct_message_conversation_fkey" FOREIGN KEY ("conversation_id","kind","workspace_id") REFERENCES "conversation"("id","kind","workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "direct_message_member" ADD CONSTRAINT "direct_message_member_direct_message_fkey" FOREIGN KEY ("conversation_id") REFERENCES "direct_message"("conversation_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "system_conversation" ADD CONSTRAINT "system_conversation_served_conversation_id_conversation_id_fkey" FOREIGN KEY ("served_conversation_id") REFERENCES "conversation"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "system_conversation" ADD CONSTRAINT "system_conversation_conversation_fkey" FOREIGN KEY ("conversation_id","kind","workspace_id") REFERENCES "conversation"("id","kind","workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "system_conversation" ADD CONSTRAINT "system_conversation_bot_workspace_fkey" FOREIGN KEY ("bot_id","workspace_id") REFERENCES "bot"("id","workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_started_by_id_user_id_fkey" FOREIGN KEY ("started_by_id") REFERENCES "user"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_conversation_fkey" FOREIGN KEY ("conversation_id","kind","workspace_id") REFERENCES "conversation"("id","kind","workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_bot_workspace_fkey" FOREIGN KEY ("bot_id","workspace_id") REFERENCES "bot"("id","workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_kind_valid" CHECK ("kind" in ('task', 'channel_conversation', 'direct_message', 'collaboration', 'run', 'automation_feed', 'system'));--> statement-breakpoint
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
			AND (conname LIKE '%thread%' OR conname LIKE 'direct_member%')
	LOOP
		EXECUTE format(
			'ALTER TABLE %s RENAME CONSTRAINT %I TO %I',
			found.on_table,
			found.name,
			replace(replace(replace(replace(replace(replace(replace(found.name,
				'thread_participant', 'conversation_participant'),
				'thread_read', 'conversation_read'),
				'thread_summary', 'summary'),
				'thread_compaction', 'compaction'),
				'direct_member', 'direct_message_member'),
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
CREATE TRIGGER direct_message_conversation_deletion
AFTER DELETE ON "direct_message"
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
	WHEN 'direct_message' THEN EXISTS (SELECT 1 FROM "direct_message" WHERE "conversation_id" = c."id")
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
	coalesce(t.started_by_id, cc.started_by_id, dm.started_by_id) as started_by_id,
	sc.system_bot_key,
	t.done_at,
	f.automation_id,
	coalesce(cc.main, false) as main,
	cc.archived_at,
	dm.direct_key
from "conversation" c
left join "task" t on t.conversation_id = c.id
left join "channel_conversation" cc on cc.conversation_id = c.id
left join "direct_message" dm on dm.conversation_id = c.id
left join "collaboration" co on co.conversation_id = c.id
left join "run" r on r.conversation_id = c.id
left join "automation_feed" rf on rf.automation_id = r.automation_id
left join "automation_feed" f on f.conversation_id = c.id
left join "automation" fa on fa.id = f.automation_id
left join "system_conversation" sc on sc.conversation_id = c.id);
