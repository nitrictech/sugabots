import { type SQLWrapper, sql } from "drizzle-orm";
import { automation, automationFeed, automationRun } from "../database/schema.ts";
import { outerColumn } from "../database/sql.ts";
import type { WebhookCall } from "../principal.ts";

export function webhookReachesChat(call: WebhookCall, chatId: SQLWrapper) {
	const { source, workspace } = call;
	if (source.kind !== "trigger") return sql<boolean>`false`;
	return sql<boolean>`exists (
		select 1 from ${automation} as webhook_automation
		where webhook_automation.id = ${source.automation}::uuid
			and webhook_automation.workspace_id = ${workspace}::uuid
			and webhook_automation.project_id = ${source.project}::uuid
			and webhook_automation.deleted_at is null
			and (
				exists (select 1 from ${automationFeed} as webhook_feed
					where webhook_feed.automation_id = webhook_automation.id
						and webhook_feed.chat_id = ${outerColumn(chatId)})
				or exists (select 1 from ${automationRun} as webhook_run
					where webhook_run.automation_id = webhook_automation.id
						and webhook_run.chat_id = ${outerColumn(chatId)})
			)
	)`;
}
