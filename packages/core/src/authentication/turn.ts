export * as TurnAuthentication from "./turn.ts";

import { type DomainError, userText } from "@sugabots/errors";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { Context, Effect, ErrorReporter, Layer, Schema } from "effect";
import { query, serviceOperations } from "../database/database.ts";
import { ACTIVE_TURN_STATUSES, turn } from "../database/schema.ts";
import { type AutomationRun, authenticated, type BotForAsker } from "../principal.ts";
import { captureTurnAdmission } from "../proofs/facts.ts";
import { processLayer, Tier } from "../tiers.ts";
import { freezeAdmission } from "./turn-admission.ts";
import { askerOf, turnBounds, turnFacts } from "./turn-facts.ts";

/**
 * The authenticator for a turn, which the bot loop calls each time a turn
 * starts or resumes: from the turn's stored ids, who the bot is and who it
 * acts for. The first execution checks that the bot and its asker reach
 * the chat and records its permissions for later executions.
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
					const mayResume =
						(ACTIVE_TURN_STATUSES as readonly string[]).includes(facts.status) || facts.retrying;
					const captured =
						mayResume && !facts.hasAdmission
							? yield* query((db) => captureTurnAdmission(db, facts))
							: null;
					const execution =
						mayResume && (facts.hasAdmission || captured)
							? yield* newExecution(facts.turn, captured)
							: { executionNumber: 0, admission: null };
					const asker = askerOf(facts);
					if (asker !== undefined) {
						return authenticated.botForAsker({
							workspace: facts.workspace,
							bot: facts.bot,
							asker,
							askedByAutomation: facts.askedBy.kind === "automation",
							chat: facts.chat,
							turn: facts.turn,
							...execution,
							bounds: turnBounds(facts, asker, project),
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
							...execution,
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
const newExecution = (
	turnId: string,
	captured: Effect.Success<ReturnType<typeof captureTurnAdmission>>,
) =>
	Effect.flatMap(
		query((db) =>
			db
				.update(turn)
				.set({
					executionNumber: sql`${turn.executionNumber} + 1`,
					...(captured && {
						admission: sql`coalesce(${turn.admission}, ${JSON.stringify(captured.admission)}::jsonb)`,
						briefRecipientBotIds: sql`case when ${turn.admission} is null
							then ${sql.param(captured.briefRecipientBotIds.length > 0 ? captured.briefRecipientBotIds : null)}::uuid[]
							else ${turn.briefRecipientBotIds} end`,
					}),
				})
				.where(
					and(
						eq(turn.id, turnId),
						or(inArray(turn.status, [...ACTIVE_TURN_STATUSES]), eq(turn.retrying, true)),
					),
				)
				.returning({
					executionNumber: turn.executionNumber,
					admission: turn.admission,
				}),
		),
		([raised]) =>
			raised
				? Effect.succeed({ ...raised, admission: freezeAdmission(raised.admission) })
				: Effect.succeed({ executionNumber: 0, admission: null }),
	);

export const layer = layerNoDeps;

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
