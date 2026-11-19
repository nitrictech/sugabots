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
ALTER TABLE "connection" DROP COLUMN "bot_id";--> statement-breakpoint
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
	coalesce(cc.started_by_id, dm.started_by_id) as started_by_id,
	sc.system_bot_key,
	cc.done_at,
	f.automation_id,
	cc.archived_at,
	dm.direct_key
from "conversation" c
left join "project_thread" cc on cc.conversation_id = c.id
left join "direct_message" dm on dm.conversation_id = c.id
left join "collaboration" co on co.conversation_id = c.id
left join "run" r on r.conversation_id = c.id
left join "automation_feed" rf on rf.automation_id = r.automation_id
left join "automation_feed" f on f.conversation_id = c.id
left join "automation" a on a.id = coalesce(r.automation_id, f.automation_id)
left join "project" p on p.id = coalesce(cc.project_id, a.project_id)
left join "system_conversation" sc on sc.conversation_id = c.id);