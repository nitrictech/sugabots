-- People talk only in projects' threads, or with bots: direct messages
-- between people go, with everything in them. Deleting each conversation
-- takes its kind row, members, messages, reads, files and the system bots'
-- conversations serving it by their foreign keys, and queues its blobs.
DELETE FROM "conversation" WHERE "kind" = 'direct_message';--> statement-breakpoint
DROP VIEW "placed_conversation";--> statement-breakpoint
ALTER TABLE "direct_message_member" DROP CONSTRAINT "direct_message_member_direct_message_fkey";--> statement-breakpoint
DROP TABLE "direct_message_member";--> statement-breakpoint
DROP TABLE "direct_message";--> statement-breakpoint
ALTER TABLE "conversation" DROP CONSTRAINT "conversation_kind_valid", ADD CONSTRAINT "conversation_kind_valid" CHECK ("kind" in ('project_thread', 'collaboration', 'run', 'automation_feed', 'system'));--> statement-breakpoint
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
$$;
