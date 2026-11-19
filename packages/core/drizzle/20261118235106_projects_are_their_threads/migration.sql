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
	coalesce(t.started_by_id, cc.started_by_id, dm.started_by_id) as started_by_id,
	sc.system_bot_key,
	t.done_at,
	f.automation_id,
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
left join "system_conversation" sc on sc.conversation_id = c.id);