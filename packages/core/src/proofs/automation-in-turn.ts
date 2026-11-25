import { ApprovalRefused, ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { AUTOMATIONS_TOOL_KEY } from "@sugabots/contracts/operations/automations";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { turnFacts } from "../authentication/turn-facts.ts";
import { query } from "../database/database.ts";
import { bot, placedChat, project, workspace } from "../database/schema.ts";
import type { Principal } from "../principal.ts";

export const automationProject = (principal: Principal, access: "read" | "change") =>
	Effect.gen(function* () {
		const hidden = new ResourceHidden({ resource: "project" });
		if (principal._tag !== "BotForAsker" && principal._tag !== "AutomationRun")
			return yield* hidden;
		if (access === "change") {
			if (principal._tag !== "BotForAsker") return yield* hidden;
			const facts = yield* query((db) => turnFacts(db, principal.turn));
			if (
				!facts ||
				facts.reason === "automation" ||
				facts.askedBy.kind !== "member" ||
				facts.askedBy.member !== principal.asker
			) {
				return yield* hidden;
			}
		}
		const [place] = yield* query((db) =>
			db
				.select({
					id: project.id,
					kind: placedChat.kind,
					defaultOf: project.defaultOfBotId,
					botHandle: bot.handle,
					projectSlug: project.slug,
					workspaceSlug: workspace.slug,
					timeZone: workspace.timeZone,
					disabledTools: bot.disabledTools,
				})
				.from(placedChat)
				.innerJoin(project, eq(project.id, placedChat.projectId))
				.innerJoin(workspace, eq(workspace.id, project.workspaceId))
				.innerJoin(bot, eq(bot.id, principal.bot))
				.where(eq(placedChat.id, principal.chat))
				.limit(1),
		);
		if (
			!place ||
			(place.defaultOf &&
				(place.defaultOf !== principal.bot ||
					(access === "change" && place.kind !== "project_chat")))
		) {
			return yield* hidden;
		}
		if (place.disabledTools.includes(AUTOMATIONS_TOOL_KEY))
			return yield* new ApprovalRefused({ reason: "automationsOff" });
		return { ...place, botHandle: place.defaultOf === null ? null : place.botHandle };
	});
