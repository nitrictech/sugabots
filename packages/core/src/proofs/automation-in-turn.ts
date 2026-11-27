import { ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { and, eq, isNotNull } from "drizzle-orm";
import { Effect } from "effect";
import { turnFacts } from "../authentication/turn-facts.ts";
import { query } from "../database/database.ts";
import { automation, bot, placedChat, project, workspace } from "../database/schema.ts";
import { isUuid } from "../ids/ids.ts";
import type { Principal } from "../principal.ts";
import { proveCanManageProject } from "./project-permissions.ts";
import { named } from "./proof.ts";
import { proveReachesProject } from "./reaches-project.ts";

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
		return { ...place, botHandle: place.defaultOf === null ? null : place.botHandle };
	});

export const automationWasRemoved = (principal: Principal, automationId: string) =>
	Effect.gen(function* () {
		if (!isUuid(automationId)) return false;
		const place = yield* automationProject(principal, "change");
		return yield* named(principal, place.id, (principal, project) =>
			Effect.gen(function* () {
				const reach = yield* proveReachesProject(principal, project);
				yield* proveCanManageProject(reach);
				const [removed] = yield* query((db) =>
					db
						.select({ id: automation.id })
						.from(automation)
						.where(
							and(
								eq(automation.id, automationId),
								eq(automation.projectId, project.value),
								eq(automation.workspaceId, reach.workspace),
								isNotNull(automation.deletedAt),
							),
						)
						.limit(1),
				);
				return removed !== undefined;
			}),
		);
	}).pipe(Effect.orElseSucceed(() => false));
