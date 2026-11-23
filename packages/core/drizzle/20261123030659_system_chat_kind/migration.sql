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