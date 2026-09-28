export * as TurnCancellation from "./cancellation.ts";

import { eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { afterCommit, query, serviceOperations, transaction } from "../../database/database.ts";
import { turn } from "../../database/schema.ts";
import { isUuid } from "../../ids/ids.ts";
import { ResourceHidden } from "../../workspaces/access.ts";
import type { CurrentActor } from "../../workspaces/current-actor.ts";
import { Visibility } from "../../workspaces/visibility.ts";
import { TurnRepository } from "./repository.ts";
import { TurnSignals } from "./signals.ts";

/** A person asking an agent's turn to stop. */
export interface Interface {
	/**
	 * Asks a turn in a thread the current actor can see to stop. `false` when
	 * it is no longer running.
	 */
	readonly request: (
		turnId: string,
	) => Effect.Effect<boolean, ResourceHidden, CurrentActor.Service>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/TurnCancellation",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("TurnCancellation");
	const visibility = yield* Visibility.Service;
	const turns = yield* TurnRepository.Service;
	const signals = yield* TurnSignals.Service;
	return Service.of({
		request: (turnId) =>
			operation(
				"request",
				transaction(
					Effect.gen(function* () {
						const hidden = new ResourceHidden({ resource: "turn" });
						if (!isUuid(turnId)) return yield* hidden;
						const [candidate] = yield* query((db) =>
							db.select({ threadId: turn.threadId }).from(turn).where(eq(turn.id, turnId)).limit(1),
						);
						if (!candidate) return yield* hidden;
						yield* visibility
							.thread(candidate.threadId)
							.pipe(Effect.catchTag("ResourceHidden", () => Effect.fail(hidden)));
						const requested = yield* turns.requestCancel(turnId);
						if (requested._tag === "Refused") return false;
						// Telling the workflow is the cancellation; it records it. The flag
						// set with it stops the next segment instead if the workflow has
						// just stopped waiting, since the signal would then go unheard.
						if (requested._tag === "SignalOwner") {
							yield* afterCommit(signals.cancel(requested.owner));
						}
						return true;
					}),
				),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(Layer.provide([TurnRepository.layer, Visibility.layer]));
