export * as TurnAuthentication from "./turn.ts";

import { type DomainError, userText } from "@sugabots/errors";
import { Context, Effect, ErrorReporter, Layer, Schema } from "effect";
import { query, serviceOperations } from "../database/database.ts";
import {
	type AutomationRun,
	authenticated,
	type BotForAsker,
	type TurnBounds,
} from "../principal.ts";
import { processLayer, Tier } from "../tiers.ts";
import { askerOf, type TurnFacts, turnFacts } from "./turn-facts.ts";

/**
 * The authenticator for a turn, which the bot loop calls each time a turn
 * starts or resumes: from the turn's stored ids, who the bot is and who it
 * acts for. It checks no permission; each operation the turn calls proves
 * access for the principal this builds.
 *
 * Only the bot loop and the scheduler may import this, as it takes nothing
 * but a stored id.
 */
export interface Interface {
	/**
	 * The principal of the turn `turnId`: its bot acting for its asker, with
	 * the turn's bounds, or a bot in an automation's run.
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
							chat: facts.chat,
							turn: facts.turn,
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
							bounds: { kind: "chat", project },
						});
					}
					return yield* new TurnUnavailable({ turn: turnId, reason: "noAsker" });
				}),
			),
	});
});

export const layerNoDeps = processLayer(Layer.effect(Service, make));

export const layer = layerNoDeps;

/**
 * A turn's bounds: member bounds for a Personal Assistant's own turns, and
 * those of its routine and manual runs; chat bounds for every other turn. A
 * brief's first turn gets chat bounds, as nothing stored says whether the
 * turn that wrote the brief had member bounds; and so does every turn in a run
 * a webhook or GitHub event started, whose input comes from outside.
 */
function boundsOf(facts: TurnFacts, asker: string, project: string): TurnBounds {
	const assistantsOwn = facts.assistantOf === asker && facts.inOwnChats;
	const startedFromOutside =
		facts.run?.startedBy === "webhook" || facts.run?.startedBy === "github";
	return assistantsOwn && facts.reason !== "brief" && !startedFromOutside
		? { kind: "member" }
		: { kind: "chat", project };
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
