import { Turns } from "@sugabots/core/chats/turns/turns";
import { processLayer } from "@sugabots/core/tiers";
import { Lanes } from "@sugabots/core/workflows/lanes";
import { Effect, Layer } from "effect";
import { Turn } from "./turn.workflow.ts";

/**
 * Core's `TurnRequests`, which asks for a turn by starting the bot loop's
 * workflow in the turn's lane, as core's rules for the lane say.
 */
export const make = Effect.gen(function* () {
	const lanes = yield* Lanes.Service;
	return Turns.TurnRequests.Service.of({
		ask: (request) =>
			lanes.admit({ ...Turns.TurnRequests.admission(request), workflow: Turn, payload: request }),
	});
});

export const layer = processLayer(Layer.effect(Turns.TurnRequests.Service, make));
