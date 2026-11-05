export * as Chats from "./chats.ts";

import type {
	BotChannel,
	ConversationThread,
	Message,
	PodChat,
	RoutineFeed,
} from "@sugabots/contracts";
import { userText } from "@sugabots/errors";
import { and, eq, isNotNull, isNull, not, notExists, sql } from "drizzle-orm";
import { Context, Data, Effect, Layer } from "effect";
import { type AuthorizationDenied, ResourceHidden } from "../../authorization/access.ts";
import { Authorization } from "../../authorization/authorization.ts";
import { CurrentActor } from "../../authorization/current-actor.ts";
import { Visibility } from "../../authorization/visibility.ts";
import { query, serviceOperations, transaction } from "../../database/database.ts";
import { agent, message, pod, routine, type ThreadRow } from "../../database/schema.ts";
import { Ids, isUuid } from "../../ids/ids.ts";
import type { UserFacing } from "../../user-message.ts";
import { INTERVIEW_PROMPT } from "../../workspaces/agents/interview-prompt.ts";
import { FloorControl } from "../floor/floor-control.ts";
import type { ThreadFiles } from "../thread-files/thread-files.ts";
import { crewOf, personColumns } from "../threads/participants.ts";
import { ThreadRepository } from "../threads/repository.ts";
import { Turns } from "../turns/turns.ts";
import { toBotChannel, toConversationThread, toPodChat, toRoutineFeed } from "./conversation.ts";
import { threadTitleFrom } from "./thread-title.ts";

/**
 * Talking to a crew agent: the current actor opens a conversation with an
 * agent in a pod and posts into it, and whoever has the floor after a message is asked to
 * speak.
 */
export interface Interface {
	/**
	 * The channel of the pod's crew agent, opened on first use, in a workspace
	 * named by its id or its slug. Refused unless the actor reaches the pod and
	 * the agent is its crew. Starts the creator's interview when the channel
	 * is empty, the bot has a model, and no turn is already queued.
	 */
	readonly openBotChannel: (input: {
		workspace: string;
		podId: string;
		hostAgentId: string;
	}) => Effect.Effect<BotChannel, AuthorizationDenied | HostNotCrew, CurrentActor.Service>;
	/**
	 * The shared pod's first chat, opened on first use, in a workspace named by
	 * its id or its slug. Hidden unless the actor reaches the pod; a Personal
	 * pod is one person's, so it has no chat.
	 */
	readonly openPodChat: (input: {
		workspace: string;
		podId: string;
	}) => Effect.Effect<PodChat, AuthorizationDenied | ResourceHidden, CurrentActor.Service>;
	/**
	 * Starts another chat in the shared pod `podId`, called `name`, for everyone
	 * in it. Anyone who reaches the pod may.
	 */
	readonly startChat: (input: {
		podId: string;
		name: string;
	}) => Effect.Effect<PodChat, AuthorizationDenied | ResourceHidden, CurrentActor.Service>;
	/**
	 * Renames the pod's chat `conversationId`, or archives it, for whoever may
	 * change the pod. An archived chat is changed no more, and the pod's first
	 * chat is never archived.
	 */
	readonly changeChat: (input: {
		conversationId: string;
		change: { name: string } | { archived: true };
	}) => Effect.Effect<
		void,
		AuthorizationDenied | ResourceHidden | ChatArchived | FirstChatNotArchivable,
		CurrentActor.Service
	>;
	/**
	 * The routine's own thread, where its runs post, opened on first use.
	 * Hidden unless the actor reaches the pod of the bot that runs it.
	 */
	readonly openRoutineFeed: (input: {
		workspace: string;
		routineId: string;
	}) => Effect.Effect<RoutineFeed, AuthorizationDenied | ResourceHidden, CurrentActor.Service>;
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
		/** The id of the message in the conversation that this one quotes and answers. */
		replyTo?: string;
	}) => Effect.Effect<
		Message,
		| ResourceHidden
		| ThreadRepository.MessageIdConflict
		| ThreadRepository.ReplyTargetNotFound
		| ThreadFiles.UploadsNotFound
		| HostHasNoModel,
		CurrentActor.Service
	>;
	/**
	 * Posts the actor's message in `conversationId`, a pod's chat or a bot's
	 * channel, and starts a thread from it: with the bot `hostAgentId`, which is
	 * given the floor and answers in the thread, or between people when it is
	 * absent. From a bot's channel the thread is always with that bot, which is
	 * how a Personal pod, having no chat, starts one. The thread is titled from
	 * the message and hangs off it. Starting it again with the same message
	 * returns the thread it started.
	 */
	readonly startThread: (input: {
		conversationId: string;
		messageId: string;
		content: string;
		/** Ids of the actor's uploads to the conversation, not yet sent. None unless set. */
		attachments?: readonly string[];
		/** The id of the message in the conversation that this one quotes and answers. */
		replyTo?: string;
		/** Ignored in a bot's channel, where the thread is with its bot. */
		hostAgentId?: string;
	}) => Effect.Effect<
		StartedThread,
		| ResourceHidden
		| HostNotCrew
		| HostHasNoModel
		| ThreadRepository.MessageIdConflict
		| ThreadRepository.ReplyTargetNotFound
		| ThreadFiles.UploadsNotFound,
		CurrentActor.Service
	>;
	/**
	 * Starts a thread from the message `messageId`, titled from it and linked
	 * from where it was said: between people in a pod's chat, or with the bot
	 * in its channel. A message has one such thread: asking again returns it.
	 */
	readonly threadFrom: (
		messageId: string,
	) => Effect.Effect<ConversationThread, ResourceHidden, CurrentActor.Service>;
	/**
	 * Starts a thread for the actor in the pod `podId` with its crew bot
	 * `hostAgentId`, which takes its turn on `brief`, the first message, written
	 * by the bot `briefingAgentId` that started it for them. Refused unless the
	 * actor reaches the pod and the host is its crew with a model.
	 */
	readonly startBriefedThread: (input: {
		workspaceId: string;
		podId: string;
		hostAgentId: string;
		briefingAgentId: string;
		title: string;
		brief: string;
	}) => Effect.Effect<ConversationThread, HostNotCrew | HostHasNoModel, CurrentActor.Service>;
	/**
	 * Marks the thread `conversationId` done, or reopens it. A pod's chat and a
	 * routine's thread are never done, so they are hidden from this.
	 */
	readonly setDone: (input: {
		conversationId: string;
		done: boolean;
	}) => Effect.Effect<void, ResourceHidden, CurrentActor.Service>;
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
	const turns = yield* Turns.Service;
	const ids = yield* Ids.Service;

	const startInterview = (channel: ThreadRow, userId: string) =>
		Effect.gen(function* () {
			const hostAgentId = channel.hostAgentId;
			if (!hostAgentId) return;
			const [eligible] = yield* query((db) =>
				db
					.select({ id: agent.id })
					.from(agent)
					.where(
						and(
							eq(agent.id, hostAgentId),
							eq(agent.createdById, userId),
							eq(agent.prompt, INTERVIEW_PROMPT),
							isNotNull(agent.model),
							notExists(
								db.select({ id: message.id }).from(message).where(eq(message.threadId, channel.id)),
							),
							not(Turns.busyIn(sql`${channel.id}`)),
						),
					),
			);
			if (!eligible) return;
			yield* turns.ask({
				threadId: channel.id,
				agentId: hostAgentId,
				triggerMessageId: yield* ids.next,
				reason: "interview",
			});
		});

	return Service.of({
		openBotChannel: (input) =>
			operation(
				"openBotChannel",
				transaction(
					Effect.gen(function* () {
						const { workspaceId, actor } = yield* authorization.workspace(
							input.workspace,
							"workspace.read",
						);
						const placement = { workspaceId, podId: input.podId, hostAgentId: input.hostAgentId };
						if (!(yield* placementAllowed(placement, yield* visibility.reachesPod))) {
							return yield* new HostNotCrew();
						}
						const channel = yield* threads.openBotChannel({
							...placement,
							initiatorUserId: actor.userId,
						});
						yield* startInterview(channel, actor.userId);
						return toBotChannel(channel);
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
						return toPodChat(
							yield* threads.openPodChat({
								workspaceId,
								podId: reached.id,
								initiatorUserId: actor.userId,
							}),
						);
					}),
				),
			),

		startChat: (input) =>
			operation(
				"startChat",
				Effect.gen(function* () {
					const { pod: shared, actor } = yield* authorization.pod(input.podId, "pod.read");
					// A Personal pod is one person's, so it has no chat.
					if (shared.kind !== "shared") return yield* new ResourceHidden({ resource: "pod" });
					return toPodChat(
						yield* threads.startChat({
							workspaceId: shared.workspaceId,
							podId: shared.id,
							initiatorUserId: actor.userId,
							title: input.name,
						}),
					);
				}),
			),

		changeChat: (input) =>
			operation(
				"changeChat",
				Effect.gen(function* () {
					const chat = yield* visibility.conversation(input.conversationId);
					if (chat.type !== "pod_chat")
						return yield* new ResourceHidden({ resource: "conversation" });
					yield* authorization.pod(chat.podId, "pod.update");
					if (chat.archivedAt) return yield* new ChatArchived();
					if ("archived" in input.change && chat.main) return yield* new FirstChatNotArchivable();
					yield* threads.changeChat(
						chat,
						"name" in input.change ? { title: input.change.name } : { archived: true },
					);
				}),
			),

		openRoutineFeed: (input) =>
			operation(
				"openRoutineFeed",
				transaction(
					Effect.gen(function* () {
						const { workspaceId } = yield* authorization.workspace(
							input.workspace,
							"workspace.read",
						);
						const reachesPod = yield* visibility.reachesPod;
						const [owned] = isUuid(input.routineId)
							? yield* query((db) =>
									db
										.select({ routine, podId: agent.podId })
										.from(routine)
										.innerJoin(agent, eq(agent.id, routine.agentId))
										.where(
											and(
												eq(routine.id, input.routineId),
												eq(routine.workspaceId, workspaceId),
												isNull(routine.deletedAt),
												reachesPod(agent.podId),
											),
										)
										.limit(1),
								)
							: [];
						if (!owned?.podId) return yield* new ResourceHidden({ resource: "routine" });
						return toRoutineFeed(
							yield* threads.openRoutineFeed({ ...owned.routine, podId: owned.podId }),
						);
					}),
				),
			),

		post: (input) =>
			operation(
				"post",
				transaction(
					Effect.gen(function* () {
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
						// Something new in a done conversation is not left where nobody looks.
						yield* threads.setDone(visible, false);
						// Checked once the message is known to be new, so sending it again
						// still returns it; refusing here rolls the post back.
						if (visible.hostAgentId && (yield* hostModelOf(visible.hostAgentId)) === null) {
							return yield* new HostHasNoModel();
						}
						yield* floor.giveFloor({
							id: posted.message.id,
							threadId: visible.id,
							content: posted.message.content,
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
						const parent = yield* visibility.conversation(input.conversationId);
						if (parent.type !== "pod_chat" && parent.type !== "bot_channel") {
							return yield* new ResourceHidden({ resource: "conversation" });
						}
						const hostAgentId =
							parent.type === "bot_channel" ? parent.hostAgentId : input.hostAgentId;
						if (hostAgentId) {
							const placement = { ...parent, hostAgentId };
							if (!(yield* placementAllowed(placement, yield* visibility.reachesPod))) {
								return yield* new HostNotCrew();
							}
							if ((yield* hostModelOf(hostAgentId)) === null) {
								return yield* new HostHasNoModel();
							}
						}
						const actor = yield* CurrentActor.Service;
						// The message stays where it was sent, and the thread hangs off it there.
						const posted = yield* threads.post({
							id: input.messageId,
							threadId: parent.id,
							author: yield* senderOf(actor),
							content: input.content,
							attachments: input.attachments ?? [],
							replyTo: input.replyTo,
						});
						const started = yield* threads.openThread({
							parent,
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
							});
						}
						return { conversation: toConversationThread(started.thread), message: posted.message };
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
						const parent = yield* visibility.conversation(origin.threadId);
						if (parent.type !== "pod_chat" && parent.type !== "bot_channel") {
							return yield* new ResourceHidden({ resource: "message" });
						}
						const { userId } = yield* CurrentActor.Service;
						const started = yield* threads.openThread({
							parent,
							originMessageId: messageId,
							hostAgentId: parent.type === "bot_channel" ? parent.hostAgentId : null,
							title: threadTitleFrom(origin.content),
							initiatorUserId: userId,
						});
						return toConversationThread(started.thread);
					}),
				),
			),

		startBriefedThread: (input) =>
			operation(
				"startBriefedThread",
				transaction(
					Effect.gen(function* () {
						if (!(yield* placementAllowed(input, yield* visibility.reachesPod))) {
							return yield* new HostNotCrew();
						}
						if ((yield* hostModelOf(input.hostAgentId)) === null) {
							return yield* new HostHasNoModel();
						}
						const { userId } = yield* CurrentActor.Service;
						return toConversationThread(
							yield* threads.startBriefedThread({ ...input, initiatorUserId: userId }),
						);
					}),
				),
			),

		setDone: (input) =>
			operation(
				"setDone",
				transaction(
					Effect.gen(function* () {
						const visible = yield* visibility.conversation(input.conversationId);
						// Only a thread is ever done: not a pod's chat, nor a routine's thread.
						if (visible.type !== "conversation") {
							return yield* new ResourceHidden({ resource: "conversation" });
						}
						yield* threads.setDone(visible, input.done);
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

/** The bot asked to host the conversation is not crew in its pod, or the pod is out of reach. */
export class HostNotCrew extends Data.TaggedError("HostNotCrew") implements UserFacing {
	get userMessage() {
		return userText`The agent and pod are not available for this conversation`;
	}
}

/**
 * The conversation's agent has no model, so nothing could answer. The message is not
 * kept, rather than kept with a turn that will never run.
 */
export class HostHasNoModel extends Data.TaggedError("HostHasNoModel") implements UserFacing {
	get userMessage() {
		return userText`This agent has no model chosen, so it cannot answer yet`;
	}
}

export class ChatArchived extends Data.TaggedError("ChatArchived") implements UserFacing {
	get userMessage() {
		return userText`This chat is archived, so it can't be changed`;
	}
}

export class FirstChatNotArchivable
	extends Data.TaggedError("FirstChatNotArchivable")
	implements UserFacing
{
	get userMessage() {
		return userText`A pod's first chat can't be archived`;
	}
}

/** A thread started from a pod's chat, and the message it was started with. */
export interface StartedThread {
	conversation: ConversationThread;
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
