export * as Chats from "./chats.ts";

import type { Conversation, Message } from "@sugabots/contracts";
import { userText } from "@sugabots/errors";
import { and, eq } from "drizzle-orm";
import { Context, Data, Effect, Layer } from "effect";
import { type AuthorizationDenied, ResourceHidden } from "../../authorization/access.ts";
import { Authorization } from "../../authorization/authorization.ts";
import { CurrentActor } from "../../authorization/current-actor.ts";
import { Visibility } from "../../authorization/visibility.ts";
import { query, serviceOperations, transaction } from "../../database/database.ts";
import { agent, message, pod } from "../../database/schema.ts";
import { isUuid } from "../../ids/ids.ts";
import type { UserFacing } from "../../user-message.ts";
import { FloorControl } from "../floor/floor-control.ts";
import type { ThreadFiles } from "../thread-files/thread-files.ts";
import { crewOf, personColumns } from "../threads/participants.ts";
import { ThreadRepository } from "../threads/repository.ts";
import { toConversation } from "./conversation.ts";
import { threadTitleFrom } from "./thread-title.ts";

/**
 * Talking to a crew agent: the current actor opens a conversation with an
 * agent in a pod and posts into it, and whoever has the floor after a message is asked to
 * speak.
 */
export interface Interface {
	/**
	 * The newest conversation with the pod's crew agent, opened on first use, in a workspace
	 * named by its id or its slug. Refused unless the actor reaches the pod and
	 * the agent is its crew.
	 */
	readonly open: (input: {
		workspace: string;
		podId: string;
		hostAgentId: string;
	}) => Effect.Effect<
		Conversation,
		AuthorizationDenied | ChatPlacementRejected,
		CurrentActor.Service
	>;
	/**
	 * The shared pod's chat, opened on first use, in a workspace named by its
	 * id or its slug. Hidden unless the actor reaches the pod; a Personal pod
	 * is one person's, so it has no chat.
	 */
	readonly openPodChat: (input: {
		workspace: string;
		podId: string;
	}) => Effect.Effect<Conversation, AuthorizationDenied | ResourceHidden, CurrentActor.Service>;
	/**
	 * Posts the actor's message into the conversation, with the files
	 * they uploaded to it, and gives the floor. Posting the same message again
	 * returns it unchanged.
	 */
	readonly post: (input: {
		conversationId: string;
		messageId: string;
		/** May be empty when the message carries files. */
		content: string;
		/** Ids of the actor's uploads to the conversation, not yet sent. None unless set. */
		attachments?: readonly string[];
		/** Written for the other people, so no bot replies. Off unless set. */
		peopleOnly?: boolean;
		/** The id of the message in the conversation that this one quotes and answers. */
		replyTo?: string;
	}) => Effect.Effect<
		Message,
		| ResourceHidden
		| ThreadRepository.MessageIdConflict
		| ThreadRepository.ReplyTargetNotFound
		| ThreadFiles.UploadsNotFound
		| ChatAgentHasNoModel,
		CurrentActor.Service
	>;
	/**
	 * Posts the actor's message in the pod's chat `podChatId` and starts a
	 * thread from it: with the bot `hostAgentId`, which is given the floor and
	 * answers in the thread, or between people when it is absent. The thread
	 * is titled from the message and hangs off it in the chat. Starting it again
	 * with the same message returns the thread it started.
	 */
	readonly startThread: (input: {
		podChatId: string;
		messageId: string;
		content: string;
		/** Ids of the actor's uploads to the pod's chat, not yet sent. None unless set. */
		attachments?: readonly string[];
		/** The id of the message in the pod's chat that this one quotes and answers. */
		replyTo?: string;
		hostAgentId?: string;
	}) => Effect.Effect<
		StartedThread,
		| ResourceHidden
		| ChatPlacementRejected
		| ChatAgentHasNoModel
		| ThreadRepository.MessageIdConflict
		| ThreadRepository.ReplyTargetNotFound
		| ThreadFiles.UploadsNotFound,
		CurrentActor.Service
	>;
	/**
	 * Starts a thread between people from the message `messageId` in a pod's
	 * chat, titled from it and linked from the chat. A message has one such
	 * thread: asking again returns it.
	 */
	readonly threadFrom: (
		messageId: string,
	) => Effect.Effect<Conversation, ResourceHidden, CurrentActor.Service>;
	/** Records that the actor has read the conversation up to its newest finished message. */
	readonly markRead: (
		conversationId: string,
	) => Effect.Effect<void, ResourceHidden, CurrentActor.Service>;
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
						return toConversation(
							yield* threads.openConversation({ ...placement, initiatorUserId: actor.userId }),
						);
					}),
				),
			),

		openPodChat: (input) =>
			operation(
				"openPodChat",
				transaction(
					Effect.gen(function* () {
						const { workspaceId, actor } = yield* authorization.workspace(
							input.workspace,
							"workspace.read",
						);
						const reachesPod = yield* visibility.reachesPod;
						const [reached] = isUuid(input.podId)
							? yield* query((db) =>
									db
										.select({ id: pod.id })
										.from(pod)
										.where(
											and(
												eq(pod.id, input.podId),
												eq(pod.workspaceId, workspaceId),
												eq(pod.kind, "shared"),
												reachesPod(pod.id),
											),
										)
										.limit(1),
								)
							: [];
						if (!reached) return yield* new ResourceHidden({ resource: "pod" });
						return toConversation(
							yield* threads.openPodChat({
								workspaceId,
								podId: reached.id,
								initiatorUserId: actor.userId,
							}),
						);
					}),
				),
			),

		post: (input) =>
			operation(
				"post",
				transaction(
					Effect.gen(function* () {
						const peopleOnly = input.peopleOnly ?? false;
						const visible = yield* visibility.conversation(input.conversationId);
						const sender = yield* senderOf(yield* CurrentActor.Service);
						const posted = yield* threads.post({
							id: input.messageId,
							threadId: visible.id,
							author: sender,
							content: input.content,
							replyTo: input.replyTo,
							attachments: input.attachments ?? [],
						});
						if (posted._tag === "AlreadyPosted") return posted.message;
						// Checked once the message is known to be new, so sending it again
						// still returns it; refusing here rolls the post back.
						if (visible.hostAgentId && (yield* hostModelOf(visible.hostAgentId)) === null) {
							return yield* new ChatAgentHasNoModel();
						}
						yield* floor.giveFloor({
							id: posted.message.id,
							threadId: visible.id,
							content: posted.message.content,
							peopleOnly,
						});
						return posted.message;
					}),
				),
			),

		startThread: (input) =>
			operation(
				"startThread",
				transaction(
					Effect.gen(function* () {
						const podChat = yield* visibility.conversation(input.podChatId);
						if (podChat.type !== "pod_chat") {
							return yield* new ResourceHidden({ resource: "conversation" });
						}
						const { hostAgentId } = input;
						if (hostAgentId) {
							const placement = { ...podChat, hostAgentId };
							if (!(yield* placementAllowed(placement, yield* visibility.reachesPod))) {
								return yield* new ChatPlacementRejected();
							}
							if ((yield* hostModelOf(hostAgentId)) === null) {
								return yield* new ChatAgentHasNoModel();
							}
						}
						const actor = yield* CurrentActor.Service;
						// The message stays in the chat, where the thread hangs off it.
						const posted = yield* threads.post({
							id: input.messageId,
							threadId: podChat.id,
							author: yield* senderOf(actor),
							content: input.content,
							attachments: input.attachments ?? [],
							replyTo: input.replyTo,
						});
						const started = yield* threads.openThread({
							podChat,
							originMessageId: posted.message.id,
							hostAgentId: hostAgentId ?? null,
							title: threadTitleFrom(input.content),
							initiatorUserId: actor.userId,
						});
						if (started.opened) {
							yield* floor.giveFloor({
								id: posted.message.id,
								threadId: started.thread.id,
								content: posted.message.content,
								peopleOnly: false,
							});
						}
						return { conversation: toConversation(started.thread), message: posted.message };
					}),
				),
			),

		threadFrom: (messageId) =>
			operation(
				"threadFrom",
				transaction(
					Effect.gen(function* () {
						const [origin] = isUuid(messageId)
							? yield* query((db) =>
									db
										.select({ threadId: message.threadId, content: message.content })
										.from(message)
										.where(eq(message.id, messageId))
										.limit(1),
								)
							: [];
						if (!origin) return yield* new ResourceHidden({ resource: "message" });
						const podChat = yield* visibility.conversation(origin.threadId);
						if (podChat.type !== "pod_chat") {
							return yield* new ResourceHidden({ resource: "message" });
						}
						const { userId } = yield* CurrentActor.Service;
						const started = yield* threads.openThread({
							podChat,
							originMessageId: messageId,
							hostAgentId: null,
							title: threadTitleFrom(origin.content),
							initiatorUserId: userId,
						});
						return toConversation(started.thread);
					}),
				),
			),

		markRead: (conversationId) =>
			operation(
				"markRead",
				transaction(
					Effect.gen(function* () {
						const visible = yield* visibility.conversation(conversationId);
						const { userId } = yield* CurrentActor.Service;
						yield* threads.markRead(userId, visible.id);
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
		return userText`The agent and pod are not available for this conversation`;
	}
}

/**
 * The conversation's agent has no model, so nothing could answer. The message is not
 * kept, rather than kept with a turn that will never run.
 */
export class ChatAgentHasNoModel
	extends Data.TaggedError("ChatAgentHasNoModel")
	implements UserFacing
{
	get userMessage() {
		return userText`This agent has no model chosen, so it cannot answer yet`;
	}
}

/** A thread started from a pod's chat, and the message it was started with. */
export interface StartedThread {
	conversation: Conversation;
	message: Message;
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
		query((db) => db.query.user.findFirst({ where: { id: userId }, ...personColumns })),
		(sender) =>
			sender ? Effect.succeed(sender) : Effect.die(new Error("The current actor has no account")),
	);

const hostModelOf = (agentId: string) =>
	Effect.map(
		query((db) =>
			db.select({ model: agent.model }).from(agent).where(eq(agent.id, agentId)).limit(1),
		),
		([row]) => row?.model ?? null,
	);
