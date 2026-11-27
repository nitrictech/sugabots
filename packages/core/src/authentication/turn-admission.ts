import { and, eq, sql } from "drizzle-orm";
import { Effect } from "effect";
import { query } from "../database/database.ts";
import { turn } from "../database/schema.ts";
import {
	authenticated,
	type Principal,
	type StoredTurnAdmission,
	type TurnAdmission,
} from "../principal.ts";

/** Loads grants written by this execution before its next operation starts. */
export const refreshTurnAdmission = (principal: Principal) =>
	Effect.gen(function* () {
		if (
			principal._tag !== "BotForAsker" ||
			principal.bounds.kind !== "member" ||
			!principal.admission
		)
			return principal;
		const [stored] = yield* query((db) =>
			db
				.select({
					grants: sql<
						StoredTurnAdmission["projectGrants"] | null
					>`${turn.admission} -> 'projectGrants'`,
				})
				.from(turn)
				.where(
					and(eq(turn.id, principal.turn), eq(turn.executionNumber, principal.executionNumber)),
				),
		);
		if (!stored?.grants) return principal;
		return authenticated.botForAsker({
			...principal,
			admission: freezeAdmission({ ...principal.admission, projectGrants: stored.grants }),
		});
	});

export function freezeAdmission(
	admission: Omit<StoredTurnAdmission, "briefRecipientBotIds"> | null,
): TurnAdmission | null {
	if (!admission) return null;
	const { projectGrants, ...captured } = admission;
	const projects = projectGrants ? { ...captured.projects, ...projectGrants } : captured.projects;
	for (const place of Object.values(projects)) {
		const bot = place.project.defaultOf;
		if (bot) {
			if ("memberIds" in bot) Object.freeze(bot.memberIds);
			Object.freeze(bot);
		}
		Object.freeze(place.project);
		Object.freeze(place);
	}
	Object.freeze(projects);
	Object.freeze(captured.chatProjectBotIds);
	return Object.freeze({ ...captured, projects });
}
