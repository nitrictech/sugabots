import { and, eq } from "drizzle-orm";
import { Effect } from "effect";
import { query } from "../database/database.ts";
import { turn } from "../database/schema.ts";
import { authenticated, type Principal, type TurnAdmission } from "../principal.ts";

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
				.select({ admission: turn.admission })
				.from(turn)
				.where(
					and(eq(turn.id, principal.turn), eq(turn.executionNumber, principal.executionNumber)),
				),
		);
		return stored?.admission
			? authenticated.botForAsker({ ...principal, admission: freezeAdmission(stored.admission) })
			: principal;
	});

export function freezeAdmission(admission: TurnAdmission | null): TurnAdmission | null {
	if (!admission) return null;
	for (const place of Object.values(admission.projects)) {
		const bot = place.project.defaultOf;
		if (bot) {
			if ("memberIds" in bot) Object.freeze(bot.memberIds);
			Object.freeze(bot);
		}
		Object.freeze(place.project);
		Object.freeze(place);
	}
	Object.freeze(admission.projects);
	Object.freeze(admission.chatProjectBotIds);
	return Object.freeze(admission);
}
