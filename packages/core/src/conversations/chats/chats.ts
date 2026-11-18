export * as Chats from "./chats.ts";

import type {
	ConversationThread,
	Direct,
	Message,
	PodChat,
	RoutineFeed,
	ThreadType,
} from "@sugabots/contracts";
import { MAX_DIRECT_MESSAGE_PEOPLE } from "@sugabots/contracts";
import { userText } from "@sugabots/errors";
import { and, eq, inArray, isNotNull, isNull, notExists } from "drizzle-orm";
import { Context, Data, Effect, Layer } from "effect";
import { type AuthorizationDenied, ResourceHidden } from "../../authorization/access.ts";
import { Authorization } from "../../authorization/authorization.ts";
import { CurrentActor } from "../../authorization/current-actor.ts";
import { Visibility } from "../../authorization/visibility.ts";
import { query, serviceOperations, transaction } from "../../database/database.ts";
import {
	agent,
	message,
	pod,
	routine,
	type ThreadRow,
	thread,
	workspaceMember,
} from "../../database/schema.ts";
import { Ids, isUuid } from "../../ids/ids.ts";
import type { UserFacing } from "../../user-message.ts";
import { INTERVIEW_PROMPT } from "../../workspaces/agents/interview-prompt.ts";
import { FloorControl } from "../floor/floor-control.ts";
import type { ThreadFiles } from "../thread-files/thread-files.ts";
import { crewAgent, personColumns } from "../threads/participants.ts";
import { lockMessageId, ThreadRepository } from "../threads/repository.ts";
import { Turns } from "../turns/turns.ts";
import { toConversationThread, toDirect, toPodChat, toRoutineFeed } from "./conversation.ts";
import { threadTitleFrom } from "./thread-title.ts";

/**
 * Talking in conversations: the current actor starts tasks with bots, talks in
 * channels and direct messages, and whoever has the floor after a message is
 * asked to speak.
 */
export interface Interface {
	/**
	 * Starts a task for the actor with the bot `agentId`, titled from its first
	 * message, which the bot answers. Hidden unless the actor reaches the bot;
	 * refused when it has no model. Starting it again with the same message
	 * returns the task it started. Files are added once it has started, since
	 * an upload belongs to a conversation.
	 */
	readonly startTask: (input: {
		agentId: string;
		messageId: string;
		content: string;
	}) => Effect.Effect<
		StartedThread,
		AuthorizationDenied | HostHasNoModel | ThreadRepository.MessageIdConflict,
		CurrentActor.Service
	>;
	/**
	 * Starts the task in which the bot `agentId` interviews the actor, who made
	 * it, to write its own instructions: once, while it still has the
	 * interview's prompt, a model and no tasks. Null when it is not due one.
	 */
	readonly startInterview: (
		agentId: string,
	) => Effect.Effect<ConversationThread | null, AuthorizationDenied, CurrentActor.Service>;
	/**
	 * Posts the actor's message to `userIds`, other members of the workspace
	 * named by its id or its slug, in the direct message between them and the
	 * actor, which is opened first if there is none: one for each set of
	 * people, so adding somebody makes another and they never see what was
	 * said before. Hidden when any is not a member; refused when nobody but the
	 * actor is named, or more than `MAX_DIRECT_MESSAGE_PEOPLE` would be in it.
	 * Sending the same message again returns it unchanged.
	 */
	readonly sendDirectMessage: (input: {
		workspace: string;
		/** The others it is to; the actor is in it, and named here or not changes nothing. */
		userIds: readonly string[];
		messageId: string;
		content: string;
	}) => Effect.Effect<
		{ conversation: Direct; message: Message },
		AuthorizationDenied | DirectToSelf | TooManyInDirect | ThreadRepository.MessageIdConflict,
		CurrentActor.Service
	>;
	/**
	 * The channel's main chat, opened on first use, in a workspace named by its
	 * id or its slug. Hidden unless the actor reaches the channel.
	 */
	readonly openPodChat: (input: {
		workspace: string;
		podId: string;
	}) => Effect.Effect<PodChat, AuthorizationDenied | ResourceHidden, CurrentActor.Service>;
	/**
	 * Starts a thread in the channel `podId`, called `name`, for everyone in
	 * it. Anyone in the channel may.
	 */
	readonly startChat: (input: {
		podId: string;
		name: string;
	}) => Effect.Effect<PodChat, AuthorizationDenied | ResourceHidden, CurrentActor.Service>;
	/**
	 * Renames the channel's thread `conversationId`, or archives it, for
	 * whoever may change the channel. An archived thread is changed no more,
	 * and the channel's main chat is never archived.
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
	 * The automation's own thread, where its runs post, opened on first use.
	 * Hidden unless the actor reaches the bot that runs it.
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
	 * Starts a task for the actor with the bot `hostAgentId`, which takes its
	 * turn on `brief`, the first message, written by the bot `briefingAgentId`
	 * that started it for them. Refused unless the actor reaches the host and
	 * it has a model.
	 */
	readonly startBriefedThread: (input: {
		workspaceId: string;
		hostAgentId: string;
		briefingAgentId: string;
		title: string;
		brief: string;
	}) => Effect.Effect<ConversationThread, HostNotCrew | HostHasNoModel, CurrentActor.Service>;
	/**
	 * Marks the task `conversationId` done, or reopens it. A channel and an
	 * automation's thread are never done, so they are hidden from this.
	 */
	readonly setDone: (input: {
		conversationId: string;
		done: boolean;
	}) => Effect.Effect<void, ResourceHidden, CurrentActor.Service>;
	/** Records that the actor has read the conversation up to its newest finished message. */
	readonly markRead: (
		conversationId: string,
	) => Effect.Effect<void, ResourceHidden, CurrentActor.Service>;
	/**
	 * Records that the actor has read one automation run or collaboration as an
	 * Inbox item, by its thread `threadId`, leaving the rest of its
	 * conversation, and what was written in the item since it began, unread.
	 * Other threads are hidden from this.
	 */
	readonly markItemRead: (
		threadId: string,
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

	/** The bot `agentId`, when `userId` made it and it is still due its interview. */
	const dueInterview = (agentId: string, userId: string) =>
		Effect.map(
			query((db) =>
				db
					.select({ id: agent.id, name: agent.name, workspaceId: agent.workspaceId })
					.from(agent)
					.where(
						and(
							eq(agent.id, agentId),
							eq(agent.createdById, userId),
							eq(agent.prompt, INTERVIEW_PROMPT),
							isNotNull(agent.model),
							notExists(
								db
									.select({ id: thread.id })
									.from(thread)
									.where(and(eq(thread.hostAgentId, agentId), eq(thread.type, "conversation"))),
							),
						),
					)
					.limit(1),
			),
			([row]) => row,
		);

	/**
	 * Posts the actor's message in `conversation`, which they have been found
	 * to reach, and gives the floor, unless it is a direct message, which has
	 * no bots. Posting the same message again returns it unchanged.
	 */
	const postIn = (
		conversation: ThreadRow,
		input: {
			messageId: string;
			content: string;
			attachments?: readonly string[];
			replyTo?: string;
		},
	) =>
		Effect.gen(function* () {
			const sender = yield* senderOf(yield* CurrentActor.Service);
			const posted = yield* threads.post({
				id: input.messageId,
				threadId: conversation.id,
				author: sender,
				content: input.content,
				replyTo: input.replyTo,
				attachments: input.attachments ?? [],
			});
			if (posted._tag === "AlreadyPosted") return posted.message;
			// A direct message is between people only: it is never done, and no bot is there to answer.
			if (conversation.type === "direct") return posted.message;
			// Something new in a done conversation is not left where nobody looks.
			yield* threads.setDone(conversation, false);
			// Checked once the message is known to be new, so sending it again
			// still returns it; refusing here rolls the post back.
			if (conversation.hostAgentId && (yield* hostModelOf(conversation.hostAgentId)) === null) {
				return yield* new HostHasNoModel();
			}
			yield* floor.giveFloor({
				id: posted.message.id,
				threadId: conversation.id,
				content: posted.message.content,
			});
			return posted.message;
		});

	/**
	 * The others a direct message from `actorId` to `userIds` is with, by the
	 * ids the workspace's members are stored under, so the same people are
	 * named the same way however the request wrote them.
	 */
	const directMessageOthers = Effect.fnUntraced(function* (
		workspaceId: string,
		actorId: string,
		userIds: readonly string[],
	) {
		if (!userIds.every(isUuid)) return yield* new ResourceHidden({ resource: "member" });
		const named = new Set(userIds.map((id) => id.toLowerCase()));
		const othersNamed = [...named].filter((id) => id !== actorId.toLowerCase()).length;
		if (othersNamed === 0) return yield* new DirectToSelf();
		if (othersNamed + 1 > MAX_DIRECT_MESSAGE_PEOPLE) return yield* new TooManyInDirect();
		const members = yield* query((db) =>
			db
				.select({ userId: workspaceMember.userId })
				.from(workspaceMember)
				.where(
					and(
						eq(workspaceMember.workspaceId, workspaceId),
						inArray(workspaceMember.userId, [...named]),
					),
				),
		);
		if (members.length !== named.size) return yield* new ResourceHidden({ resource: "member" });
		return members.map((member) => member.userId).filter((id) => id !== actorId);
	});

	return Service.of({
		startTask: (input) =>
			operation(
				"startTask",
				transaction(
					Effect.gen(function* () {
						const { agent: host, actor } = yield* authorization.agent(input.agentId, "agent.read");
						// A retry waits for the first send, and then finds the task it started.
						yield* lockMessageId(input.messageId);
						const [sent] = isUuid(input.messageId)
							? yield* query((db) =>
									db
										.select({ thread })
										.from(message)
										.innerJoin(thread, eq(thread.id, message.threadId))
										.where(
											and(eq(message.id, input.messageId), eq(message.authorUserId, actor.userId)),
										)
										.limit(1),
								)
							: [];
						if (sent) {
							if (sent.thread.type !== "conversation" || sent.thread.hostAgentId !== host.id) {
								return yield* new ThreadRepository.MessageIdConflict();
							}
							const posted = yield* postIn(sent.thread, input).pipe(
								// It neither quotes a message nor carries files, so neither can be missing.
								Effect.catchTags({ ReplyTargetNotFound: Effect.die, UploadsNotFound: Effect.die }),
							);
							return { conversation: toConversationThread(sent.thread), message: posted };
						}
						if (host.model === null) return yield* new HostHasNoModel();
						const task = yield* threads.startTask({
							workspaceId: host.workspaceId,
							hostAgentId: host.id,
							initiatorUserId: actor.userId,
							title: threadTitleFrom(input.content),
						});
						const posted = yield* postIn(task, input).pipe(
							// It neither quotes a message nor carries files, so neither can be missing.
							Effect.catchTags({ ReplyTargetNotFound: Effect.die, UploadsNotFound: Effect.die }),
						);
						return { conversation: toConversationThread(task), message: posted };
					}),
				),
			),

		startInterview: (agentId) =>
			operation(
				"startInterview",
				transaction(
					Effect.gen(function* () {
						const { actor } = yield* authorization.agent(agentId, "agent.update");
						const due = yield* dueInterview(agentId, actor.userId);
						if (!due) return null;
						const task = yield* threads.startTask({
							workspaceId: due.workspaceId,
							hostAgentId: due.id,
							initiatorUserId: actor.userId,
							title: `Setting up ${due.name}`,
						});
						yield* turns.ask({
							threadId: task.id,
							agentId: due.id,
							triggerMessageId: yield* ids.next,
							reason: "interview",
						});
						return toConversationThread(task);
					}),
				),
			),

		sendDirectMessage: (input) =>
			operation(
				"sendDirectMessage",
				transaction(
					Effect.gen(function* () {
						const { workspaceId, actor } = yield* authorization.workspace(
							input.workspace,
							"workspace.read",
						);
						const otherIds = yield* directMessageOthers(workspaceId, actor.userId, input.userIds);
						const conversation = yield* threads.openDirect({
							workspaceId,
							memberIds: [actor.userId, ...otherIds],
							initiatorUserId: actor.userId,
						});
						// It neither quotes a message nor carries files, so neither can be
						// missing, and it has no bot, so none can be without a model.
						const message = yield* postIn(conversation, {
							messageId: input.messageId,
							content: input.content,
						}).pipe(
							Effect.catchTags({
								ReplyTargetNotFound: Effect.die,
								UploadsNotFound: Effect.die,
								HostHasNoModel: Effect.die,
							}),
						);
						return { conversation: toDirect(conversation), message };
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
					const { pod: channel, actor } = yield* authorization.pod(input.podId, "pod.read");
					return toPodChat(
						yield* threads.startChat({
							workspaceId: channel.workspaceId,
							podId: channel.id,
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
					if (chat.type !== "pod_chat" || chat.podId === null) {
						return yield* new ResourceHidden({ resource: "conversation" });
					}
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
						const reachesAgent = yield* visibility.reachesAgent;
						const [owned] = isUuid(input.routineId)
							? yield* query((db) =>
									db
										.select({ routine })
										.from(routine)
										.where(
											and(
												eq(routine.id, input.routineId),
												eq(routine.workspaceId, workspaceId),
												isNull(routine.deletedAt),
												reachesAgent(routine.agentId),
											),
										)
										.limit(1),
								)
							: [];
						if (!owned) return yield* new ResourceHidden({ resource: "routine" });
						return toRoutineFeed(yield* threads.openRoutineFeed(owned.routine));
					}),
				),
			),

		post: (input) =>
			operation(
				"post",
				transaction(
					Effect.flatMap(visibility.conversation(input.conversationId), (visible) =>
						postIn(visible, input),
					),
				),
			),

		startBriefedThread: (input) =>
			operation(
				"startBriefedThread",
				transaction(
					Effect.gen(function* () {
						if (!(yield* hostReached(input, yield* visibility.reachesAgent))) {
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
						// Only a task is ever done: not a channel, nor an automation's thread.
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

		markItemRead: (threadId) =>
			operation(
				"markItemRead",
				transaction(
					Effect.gen(function* () {
						const { thread } = yield* visibility.thread(threadId);
						if (!ITEM_THREAD_TYPES.has(thread.type)) {
							return yield* new ResourceHidden({ resource: "thread" });
						}
						const { userId } = yield* CurrentActor.Service;
						yield* threads.markItemRead(userId, thread.id);
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

/** The threads that are an item of their own in Inbox: an automation run's and a collaboration's. */
const ITEM_THREAD_TYPES: ReadonlySet<ThreadType> = new Set(["routine", "collaboration"]);

/** Somebody tried to open a direct message with themselves. */
export class DirectToSelf extends Data.TaggedError("DirectToSelf") implements UserFacing {
	get userMessage() {
		return userText`You can't send a direct message to yourself`;
	}
}

/** More people were named for a direct message than one may have. */
export class TooManyInDirect extends Data.TaggedError("TooManyInDirect") implements UserFacing {
	get userMessage() {
		return userText`A direct message can have at most ${MAX_DIRECT_MESSAGE_PEOPLE} people`;
	}
}

/** The bot asked to host the task is out of the actor's reach, or not one people make. */
export class HostNotCrew extends Data.TaggedError("HostNotCrew") implements UserFacing {
	get userMessage() {
		return userText`That bot isn't available for this task`;
	}
}

/**
 * The conversation's agent has no model, so nothing could answer. The message is not
 * kept, rather than kept with a turn that will never run.
 */
export class HostHasNoModel extends Data.TaggedError("HostHasNoModel") implements UserFacing {
	get userMessage() {
		return userText`This bot has no model chosen, so it can't answer yet`;
	}
}

export class ChatArchived extends Data.TaggedError("ChatArchived") implements UserFacing {
	get userMessage() {
		return userText`This thread is archived, so it can't be changed`;
	}
}

export class FirstChatNotArchivable
	extends Data.TaggedError("FirstChatNotArchivable")
	implements UserFacing
{
	get userMessage() {
		return userText`A channel's main chat can't be archived`;
	}
}

/** A task started with a bot, and the message it was started with. */
export interface StartedThread {
	conversation: ConversationThread;
	message: Message;
}

/** Whether `reachesAgent` reaches the bot, which is in the workspace and one people make. */
const hostReached = (
	input: { workspaceId: string; hostAgentId: string },
	reachesAgent: Visibility.ReachesAgent,
) =>
	Effect.map(
		query((db) =>
			db
				.select({ id: agent.id })
				.from(agent)
				.where(
					and(
						eq(agent.id, input.hostAgentId),
						eq(agent.workspaceId, input.workspaceId),
						crewAgent,
						reachesAgent(agent.id),
					),
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
