export * as TurnAuthentication from "./turn.ts";

import { type DomainError, userText } from "@sugabots/errors";
import { eq, sql } from "drizzle-orm";
import { Context, Effect, ErrorReporter, Layer, Schema } from "effect";
import { query, serviceOperations } from "../database/database.ts";
import { turn } from "../database/schema.ts";
import {
	type AutomationRun,
	authenticated,
	type BotForAsker,
	type TurnBounds,
} from "../principal.ts";
import { processLayer, Tier } from "../tiers.ts";
import { askerOf, hasMemberBounds, type TurnFacts, turnFacts } from "./turn-facts.ts";

/**
 * The authenticator for a turn, which the bot loop calls each time a turn
 * starts or resumes: from the turn's stored ids, who the bot is and who it
 * acts for. It checks no permission; each operation the turn calls proves
 * access for the principal this builds.
 *
 * Each principal it builds is a new execution of the turn: it raises the
 * turn's execution number, which the principal carries, so the writes of an
 * execution that was resumed elsewhere since are refused.
 *
 * Only the bot loop and the scheduler may import this, as it takes nothing
 * but a stored id.
 */
export interface Interface {
	/**
	 * The principal of the turn `turnId`: its bot acting for its asker, with
	 * the turn's bounds, or a bot in an automation's run, as the turn's newest
	 * execution.
	 */
	readonly authenticate: (
		turnId: string,
	) => Effect.Effect<BotForAsker | AutomationRun, TurnUnavailable>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/TurnAuthentication",
) {
	declare readonly [Tier]: "process";
}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("TurnAuthentication");

	return Service.of({
		authenticate: (turnId) =>
			operation(
				"authenticate",
				Effect.gen(function* () {
					const facts = yield* query((db) => turnFacts(db, turnId));
					if (!facts) return yield* new TurnUnavailable({ turn: turnId, reason: "missing" });
					const { project } = facts;
					if (project === null) {
						return yield* new TurnUnavailable({ turn: turnId, reason: "inNoProject" });
					}
					const asker = askerOf(facts);
					if (asker !== undefined) {
						return authenticated.botForAsker({
							workspace: facts.workspace,
							bot: facts.bot,
							asker,
							askedByAutomation: facts.askedBy.kind === "automation",
							chat: facts.chat,
							turn: facts.turn,
							executionNumber: yield* newExecution(facts.turn),
							bounds: boundsOf(facts, asker, project),
						});
					}
					if (facts.askedBy.kind === "automation" && facts.run) {
						return authenticated.automationRun({
							workspace: facts.workspace,
							bot: facts.bot,
							automation: facts.run.automation,
							run: facts.run.run,
							chat: facts.chat,
							turn: facts.turn,
							executionNumber: yield* newExecution(facts.turn),
							bounds: { kind: "chat", project },
						});
					}
					return yield* new TurnUnavailable({ turn: turnId, reason: "noAsker" });
				}),
			),
	});
});

export const layerNoDeps = processLayer(Layer.effect(Service, make));

/**
 * Raises the turn `turnId`'s execution number and returns it: the number of
 * the execution being authenticated, which every older one no longer is.
 */
const newExecution = (turnId: string) =>
	Effect.flatMap(
		query((db) =>
			db
				.update(turn)
				.set({ executionNumber: sql`${turn.executionNumber} + 1` })
				.where(eq(turn.id, turnId))
				.returning({ executionNumber: turn.executionNumber }),
		),
		([raised]) =>
			raised ? Effect.succeed(raised.executionNumber) : Effect.die(new Error("A turn is gone")),
	);

export const layer = layerNoDeps;

/**
 * A turn's bounds: member bounds for a personal bot's own turns, and those of
 * its routine and manual runs. A brief can grant member bounds only
 * if the turn writing it had them.
 */
function boundsOf(facts: TurnFacts, asker: string, project: string): TurnBounds {
	return hasMemberBounds(facts, asker) ? { kind: "member" } : { kind: "chat", project };
}

/**
 * The turn is gone, is in a chat in no project, or answers neither a member
 * nor its automation's run, so it has nobody to act for and can only end.
 */
export class TurnUnavailable
	extends Schema.TaggedError<TurnUnavailable>()("TurnUnavailable", {
		turn: Schema.String,
		reason: Schema.Literals(["missing", "inNoProject", "noAsker"]),
	})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return `Turn ${this.turn} has no principal: ${this.reason}`;
	}
	get userMessage() {
		return userText`This bot can't carry on here: the chat or the message it answers is gone`;
	}
}
