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