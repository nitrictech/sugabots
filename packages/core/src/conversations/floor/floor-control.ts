export * as FloorControl from "./floor-control.ts";

import { Context, Effect, Layer } from "effect";
import { query, serviceOperations, transaction } from "../../database/database.ts";
import { ThreadRepository } from "../threads/repository.ts";
import { TurnRequests } from "../turns/requests.ts";
import { decideFloor, type FloorDecision, type FloorMessage, loadFloorScope } from "./floor.ts";

/** Who speaks after a message, in a thread of any type. */
export interface Interface {
	/**
	 * Decides who speaks after the committed message `committed` (see
	 * `decideFloor`) and asks for them: brings each addressed agent into the
	 * thread and queues its turn, or queues the Facilitator. Runs in the
	 * caller's transaction, so it commits with the message.
	 */
	readonly giveFloor: (committed: FloorMessage) => Effect.Effect<FloorDecision>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/FloorControl") {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("FloorControl");
	const threads = yield* ThreadRepository.Service;
	const requests = yield* TurnRequests.Service;

	return Service.of({
		giveFloor: (committed) =>
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
							yield* requests.queueFacilitation({
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
							yield* requests.queueTurn({
								threadId: committed.threadId,
								agentId,
								triggerMessageId: committed.id,
								reason,
							});
						}
						return decision;
					}),
				),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(Layer.provide(ThreadRepository.layer));
