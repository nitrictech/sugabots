export * as StreamAccess from "./access.ts";

import {
	conversationStream,
	type EventStream,
	personStream,
	workspaceStream,
} from "@sugabots/contracts";
import { Authorization } from "@sugabots/core/authorization/authorization";
import { CurrentActor } from "@sugabots/core/authorization/current-actor";
import { Visibility } from "@sugabots/core/authorization/visibility";
import { query, serviceOperations } from "@sugabots/core/database/database";
import type { Audience } from "@sugabots/core/database/events/audience";
import { placedConversation } from "@sugabots/core/database/schema";
import { and, eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";

/**
 * Who may listen to what.
 *
 * A stream route authorises exactly like the REST route for the same
 * resource — the same `Authorization` and the same `Visibility`, so a
 * demotion that closes a REST route closes the stream with it.
 *
 * Each function answers, for the current actor, with the stream to subscribe
 * to, or `undefined` when they may not have it. A conversation's events go on that
 * conversation's own stream, and a workspace stream carries what its lists need
 * (`ConversationFeed` in core decides both).
 */
export interface Interface {
	/** `workspaceRef` is the workspace's id or slug; the stream is always named by id. */
	workspace(
		workspaceRef: string,
	): Effect.Effect<EventStream | undefined, never, CurrentActor.Service>;
	conversation(
		conversationId: string,
	): Effect.Effect<EventStream | undefined, never, CurrentActor.Service>;
	/** The current actor's own stream, which nobody else may have. */
	me(): Effect.Effect<EventStream | undefined, never, CurrentActor.Service>;
	/**
	 * Whether the current actor is in `audience`, by `Visibility`'s rules, and
	 * so may hear what a workspace stream says of the conversation it is for: they
	 * reach the conversation.
	 */
	hears(audience: Audience.Group): Effect.Effect<boolean, never, CurrentActor.Service>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/server/StreamAccess",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("StreamAccess");
	const authorization = yield* Authorization.Service;
	const visibility = yield* Visibility.Service;
	return Service.of({
		workspace: (workspaceRef) =>
			authorization.workspace(workspaceRef, "workspace.read").pipe(
				Effect.match({
					onSuccess: ({ workspaceId }) => workspaceStream(workspaceId),
					onFailure: () => undefined,
				}),
			),

		conversation: (conversationId) =>
			visibility.conversationStanding(conversationId).pipe(
				Effect.match({
					onSuccess: ({ conversation }) => conversationStream(conversation.id),
					onFailure: () => undefined,
				}),
			),

		me: () => Effect.map(CurrentActor.Service, ({ userId }) => personStream(userId)),

		hears: (audience) =>
			operation(
				"hears",
				Effect.gen(function* () {
					const { conversationId } = audience;
					const reachesConversation = yield* visibility.reachesConversation;
					const [reached] = yield* query((db) =>
						db
							.select({ id: placedConversation.id })
							.from(placedConversation)
							.where(
								and(
									eq(placedConversation.id, conversationId),
									reachesConversation(placedConversation),
								),
							)
							.limit(1),
					);
					return reached !== undefined;
				}),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(Layer.provide([Authorization.layer, Visibility.layer]));
