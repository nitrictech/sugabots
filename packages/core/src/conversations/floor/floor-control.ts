export * as FloorControl from "./floor-control.ts";

import { Context, Effect, Layer } from "effect";
import { query, serviceOperations, transaction } from "../../database/database.ts";
import type { DomainEvents } from "../../database/events/domain-events.ts";
import { Lanes } from "../../workflows/lanes.ts";
import type { ConversationEvent } from "../events.ts";
import { ThreadRepository } from "../threads/repository.ts";
import { Turns } from "../turns/turns.ts";
import { admitFacilitation } from "./facilitate.workflow.ts";
import { decideFloor, type FloorDecision, type FloorMessage, loadFloorScope } from "./floor.ts";

/** Who speaks after a message, in a thread of any type. */
export interface Interface {
	/**
	 * Decides who speaks after the committed message `committed` (see
	 * `decideFloor`) and asks for them: brings each addressed agent into the
	 * thread and asks for its turn, or asks the Facilitator. Runs in the
	 * caller's transaction, so it commits with the message.
	 */
	readonly giveFloor: (committed: FloorMessage) => Effect.Effect<FloorDecision>;
	/**
	 * Gives the floor after each completed reply, in the transaction that
	 * completed it. A reply that answered a brief goes back to the agent that
	 * asked, which carries on in the parent thread, so nobody speaks next there.
	 * Also asks for the collaborator's turn when a collaboration opens, and for
	 * the asking agent's when an answer arrives after it stopped waiting.
	 */
	readonly handler: DomainEvents.Handler<ConversationEvent>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/FloorControl") {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("FloorControl");
	const threads = yield* ThreadRepository.Service;
	const lanes = yield* Lanes.Service;
	const turns = yield* Turns.Service;

	const giveFloor: Interface["giveFloor"] = (committed) =>
		operation(
			"giveFloor",
			transaction(
				Effect.gen(function* () {
					const scope = yield* query((db) => loadFloorScope(db, committed));
					const decision = decideFloor({
						...scope,
						content: committed.content,
						author: committed.author,
					});
					if (decision.kind === "facilitate") {
						yield* admitFacilitation(lanes, {
							threadId: committed.threadId,
							triggerMessageId: committed.id,
						});
					}
					if (decision.kind !== "turns") return decision;
					yield* threads.addAgents(
						committed.threadId,
						decision.agents.map(({ agentId }) => agentId),
					);
					for (const { agentId, reason } of decision.agents) {
						yield* turns.ask({
							threadId: committed.threadId,
							agentId,
							triggerMessageId: committed.id,
							reason,
						});
					}
					return decision;
				}),
			),
		);

	return Service.of({
		giveFloor,
		handler: (events) =>
			Effect.forEach(
				events,
				(event): Effect.Effect<unknown> => {
					switch (event._tag) {
						case "TurnCompleted":
							return event.answeredCollaboration
								? Effect.void
								: giveFloor({
										id: event.messageId,
										threadId: event.threadId,
										content: event.content,
										author: { kind: "agent", agentId: event.agentId, spokeBecause: event.reason },
									});
						case "CollaborationOpened":
							return turns.ask({
								threadId: event.collaboration.threadId,
								agentId: event.collaboratorAgentId,
								triggerMessageId: event.briefMessageId,
								reason: "collaboration",
							});
						case "CollaborationAnswered":
							// While it was still waiting, the asking tool reads the answer itself.
							return event.askerMovedOn
								? turns.ask({
										threadId: event.parentThreadId,
										agentId: event.askingAgentId,
										triggerMessageId: event.parentMessageId,
										reason: "resume",
									})
								: Effect.void;
						default:
							return Effect.void;
					}
				},
				{ discard: true },
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(Layer.provide(ThreadRepository.layer));
