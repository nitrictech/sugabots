export * as Visibility from "./visibility.ts";

import type { SQL, SQLWrapper } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { reachesPod } from "./access.ts";
import { CurrentActor } from "./current-actor.ts";

/**
 * What the current actor can see. A pod is seen by whoever reaches it, and
 * everything inside a pod is seen by whoever sees the pod, so lists and
 * single reads are scoped by one rule and cannot disagree.
 */
export interface Interface {
	/**
	 * SQL for "the actor reaches this pod", given the column naming the pod
	 * (`thread.podId`, `agent.podId`, `pod.id`), for queries that scope a list.
	 */
	readonly reachesPod: Effect.Effect<
		(podId: SQLWrapper) => SQL<boolean>,
		never,
		CurrentActor.Service
	>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/Visibility") {}

export const make = Effect.succeed(
	Service.of({
		reachesPod: Effect.map(
			CurrentActor.Service,
			({ userId }) =>
				(podId) =>
					reachesPod(podId, userId),
		),
	}),
);

export const layer = Layer.effect(Service, make);
