export * as Chats from "./chats.ts";

import type { Chat, Message } from "@sugabots/contracts";
import { and, eq } from "drizzle-orm";
import { Context, Data, Effect, Layer } from "effect";
import type { AuthorizationDenied, ResourceHidden } from "../../authorization/access.ts";
import { Authorization } from "../../authorization/authorization.ts";
import { CurrentActor } from "../../authorization/current-actor.ts";
import { Visibility } from "../../authorization/visibility.ts";
import { query, serviceOperations, transaction } from "../../database/database.ts";
import type * as schema from "../../database/schema.ts";
import { agent, pod, user } from "../../database/schema.ts";
import { type UserFacing, UserMessage } from "../../user-message.ts";
import { FloorControl } from "../floor/floor-control.ts";
import { crewOf, personAuthor, toMessage } from "../threads/participants.ts";
import { ThreadRepository } from "../threads/repository.ts";

/**
 * Talking to a crew agent: the current actor opens a chat with an agent in a
 * pod and posts into it, and whoever has the floor after a message is asked to
 * speak.
 */
export interface Interface {
	/**
	 * The chat with the pod's crew agent, opened on first use, in a workspace
	 * named by its id or its slug. Refused unless the actor reaches the pod and
	 * the agent is its crew.
	 */
	readonly open: (input: {
		workspace: string;
		podId: string;
		hostAgentId: string;
	}) => Effect.Effect<Chat, AuthorizationDenied | ChatPlacementRejected, CurrentActor.Service>;
	/**
	 * Posts the actor's message into the chat's main thread and gives the
	 * floor. Posting the same message again returns it unchanged.
	 */
	readonly post: (input: {
		chatId: string;
		messageId: string;
		content: string;
	}) => Effect.Effect<
		Message,
		ResourceHidden | ThreadRepository.MessageIdConflict | ChatAgentHasNoModel,
		CurrentActor.Service
	>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/Chats") {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("Chats");
	const authorization = yield* Authorization.Service;
	const visibility = yield* Visibility.Service;
	const threads = yield* ThreadRepository.Service;
	const floor = yield* FloorControl.Service;

	return Service.of({
		open: (input) =>
			operation(
				"open",
				transaction(
					Effect.gen(function* () {
						const { workspaceId, actor } = yield* authorization.workspace(
							input.workspace,
							"workspace.read",
						);
						const placement = { workspaceId, podId: input.podId, hostAgentId: input.hostAgentId };
						if (!(yield* placementAllowed(placement, yield* visibility.reachesPod))) {
							return yield* new ChatPlacementRejected();
						}
						return toChat(yield* threads.openChat({ ...placement, initiatorUserId: actor.userId }));
					}),
				),
			),

		post: (input) =>
			operation(
				"post",
				transaction(
					Effect.gen(function* () {
						const visible = yield* visibility.chat(input.chatId);
						const sender = yield* senderOf(yield* CurrentActor.Service);
						const author = personAuthor({
							userId: sender.id,
							userName: sender.name,
							userImage: sender.image,
						});
						const posted = yield* threads.post({
							id: input.messageId,
							threadId: visible.mainThreadId,
							author: sender,
							content: input.content,
						});
						if (posted._tag === "AlreadyPosted") return toMessage(posted.message, author);
						// Checked once the message is known to be new, so sending it again
						// still returns it; refusing here rolls the post back.
						if ((yield* hostModelOf(visible.hostAgentId)) === null) {
							return yield* new ChatAgentHasNoModel();
						}
						yield* floor.giveFloor({
							id: posted.message.id,
							threadId: visible.mainThreadId,
							content: posted.message.content,
							author: { kind: "person" },
						});
						return toMessage(posted.message, author);
					}),
				),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(
	Layer.provide([
		Authorization.layer,
		Visibility.layer,
		ThreadRepository.layer,
		FloorControl.layer,
	]),
);

export class ChatPlacementRejected
	extends Data.TaggedError("ChatPlacementRejected")
	implements UserFacing
{
	get userMessage() {
		return UserMessage.of`The agent and pod are not available for this chat`;
	}
}

/**
 * The chat's agent has no model, so nothing could answer. The message is not
 * kept, rather than kept with a turn that will never run.
 */
export class ChatAgentHasNoModel
	extends Data.TaggedError("ChatAgentHasNoModel")
	implements UserFacing
{
	get userMessage() {
		return UserMessage.of`This agent has no model chosen, so it cannot answer yet`;
	}
}

/** Whether `reachesPod` reaches the pod and the agent is crew in it. */
const placementAllowed = (
	input: { workspaceId: string; podId: string; hostAgentId: string },
	reachesPod: Visibility.ReachesPod,
) =>
	Effect.map(
		query((db) =>
			db
				.select({ id: pod.id })
				.from(pod)
				.innerJoin(
					agent,
					and(
						eq(agent.id, input.hostAgentId),
						crewOf(pod.id),
						eq(agent.workspaceId, pod.workspaceId),
					),
				)
				.where(
					and(eq(pod.id, input.podId), eq(pod.workspaceId, input.workspaceId), reachesPod(pod.id)),
				)
				.limit(1),
		),
		([allowed]) => allowed !== undefined,
	);

/** The actor as their messages are signed. */
const senderOf = ({ userId }: CurrentActor.Interface) =>
	Effect.flatMap(
		query((db) =>
			db
				.select({ id: user.id, name: user.name, image: user.image })
				.from(user)
				.where(eq(user.id, userId))
				.limit(1),
		),
		([sender]) =>
			sender ? Effect.succeed(sender) : Effect.die(new Error("The current actor has no account")),
	);

const hostModelOf = (agentId: string) =>
	Effect.map(
		query((db) =>
			db.select({ model: agent.model }).from(agent).where(eq(agent.id, agentId)).limit(1),
		),
		([row]) => row?.model ?? null,
	);

function toChat(row: schema.ChatRow): Chat {
	return {
		id: row.id,
		workspaceId: row.workspaceId,
		podId: row.podId,
		hostAgentId: row.hostAgentId,
		mainThreadId: row.mainThreadId,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}
