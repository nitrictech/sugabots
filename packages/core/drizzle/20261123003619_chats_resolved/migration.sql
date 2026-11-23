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