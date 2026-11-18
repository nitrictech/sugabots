export * as Chats from "./chats.ts";

import type {
	AutomationFeed,
	ChannelConversation,
	ConversationKind,
	DirectMessage,
	Message,
	Task,
} from "@sugabots/contracts";
import { MAX_DIRECT_MESSAGE_PEOPLE } from "@sugabots/contracts";
import { userText } from "@sugabots/errors";
import { and, eq, getColumns, inArray, isNotNull, isNull, notExists } from "drizzle-orm";
import { Context, Data, Effect, Layer } from "effect";
import { type AuthorizationDenied, ResourceHidden } from "../../authorization/access.ts";
import { Authorization } from "../../authorization/authorization.ts";
import { CurrentActor } from "../../authorization/current-actor.ts";
import { Visibility } from "../../authorization/visibility.ts";
import { query, serviceOperations, transaction } from "../../database/database.ts";
import {
	automation,
	bot,
	channel,
	message,
	type PlacedConversationRow,
	placedConversation,
	task,
	workspaceMember,
} from "../../database/schema.ts";
import type { ConversationFiles } from "../../files/conversation-files.ts";
import { Ids, isUuid } from "../../ids/ids.ts";
import type { UserFacing } from "../../user-message.ts";
import { INTERVIEW_PROMPT } from "../../workspaces/bots/interview-prompt.ts";
import { FloorControl } from "../floor/floor-control.ts";
import { madeByPeople, personColumns } from "../repository/participants.ts";
import { ConversationRepository, lockMessageId } from "../repository/repository.ts";
import { Turns } from "../turns/turns.ts";
import {
	toAutomationFeed,
	toChannelConversation,
	toDirectMessage,
	toTask,
} from "./conversation.ts";
import { taskTitleFrom } from "./task-title.ts";

/**
 * Talking in conversations: the current actor starts tasks with bots, talks in
 * channels and direct messages, and whoever has the floor after a message is
 * asked to speak.
 */
export interface Interface {
	/**
	 * Starts a task for the actor with the bot `botId`, titled from its first
	 * message, which the bot answers. Hidden unless the actor reaches the bot;
	 * refused when it has no model. Starting it again with the same message
	 * returns the task it started. Files are added once it has started, since
	 * an upload belongs to a conversation.
	 */
	readonly startTask: (input: {
		botId: string;
		messageId: string;
		content: string;
	}) => Effect.Effect<
		StartedTask,
		AuthorizationDenied | HostHasNoModel | ConversationRepository.MessageIdConflict,
		CurrentActor.Service
	>;
	/**
	 * Starts the task in which the bot `botId` interviews the actor, who made
	 * it, to write its own instructions: once, while it still has the
	 * interview's prompt, a model and no tasks. Null when it is not due one.
	 */
	readonly startInterview: (
		botId: string,
	) => Effect.Effect<Task | null, AuthorizationDenied, CurrentActor.Service>;
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
		{ conversation: DirectMessage; message: Message },
		AuthorizationDenied | DirectToSelf | TooManyInDirect | ConversationRepository.MessageIdConflict,
		CurrentActor.Service
	>;
	/**
	 * The channel's main chat, opened on first use, in a workspace named by its
	 * id or its slug. Hidden unless the actor reaches the channel.
	 */
	readonly openMainChat: (input: {
		workspace: string;
		channelId: string;
	}) => Effect.Effect<
		ChannelConversation,
		AuthorizationDenied | ResourceHidden,
		CurrentActor.Service
	>;
	/**
	 * Starts a thread in the channel `channelId`, called `name`, for everyone in
	 * it. Anyone in the channel may.
	 */
	readonly startChat: (input: {
		channelId: string;
		name: string;
	}) => Effect.Effect<
		ChannelConversation,
		AuthorizationDenied | ResourceHidden,
		CurrentActor.Service
	>;
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
	 * The automation's feed, where its runs post, opened on first use.
	 * Hidden unless the actor reaches the bot that runs it.
	 */
	readonly openAutomationFeed: (input: {
		workspace: string;
		automationId: string;
	}) => Effect.Effect<AutomationFeed, AuthorizationDenied | ResourceHidden, CurrentActor.Service>;
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
		| ConversationRepository.MessageIdConflict
		| ConversationRepository.ReplyTargetNotFound
		| ConversationFiles.UploadsNotFound
		| HostHasNoModel,
		CurrentActor.Service
	>;
	/**
	 * Starts a task for the actor with the bot `botId`, which takes its
	 * turn on `brief`, the first message, written by the bot `briefingBotId`
	 * that started it for them. Refused unless the actor reaches that bot and
	 * it has a model.
	 */
	readonly startBriefedTask: (input: {
		workspaceId: string;
		botId: string;
		briefingBotId: string;
		title: string;
		brief: string;
	}) => Effect.Effect<Task, HostUnavailable | HostHasNoModel, CurrentActor.Service>;
	/**
	 * Marks the task `conversationId` done, or reopens it. A channel's
	 * conversation and an automation's feed are never done, so they are hidden
	 * from this.
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
	 * Inbox item, by its own conversation `itemConversationId`, leaving the
	 * conversation it is listed in, and what was written in the item since it
	 * began, unread. Other conversations are hidden from this.
	 */
	readonly markItemRead: (
		itemConversationId: string,
	) => Effect.Effect<void, ResourceHidden, CurrentActor.Service>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/Chats") {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("Chats");
	const authorization = yield* Authorization.Service;
	const visibility = yield* Visibility.Service;
	const conversations = yield* ConversationRepository.Service;
	const floor = yield* FloorControl.Service;
	const turns = yield* Turns.Service;
	const ids = yield* Ids.Service;

	/** The bot `botId`, when `userId` made it and it is still due its interview. */
	const dueInterview = (botId: string, userId: string) =>
		Effect.map(
			query((db) =>
				db
					.select({ id: bot.id, name: bot.name, workspaceId: bot.workspaceId })
					.from(bot)
					.where(
						and(
							eq(bot.id, botId),
							eq(bot.createdById, userId),
							eq(bot.prompt, INTERVIEW_PROMPT),
							isNotNull(bot.model),
							notExists(
								db.select({ id: task.conversationId }).from(task).where(eq(task.botId, botId)),
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
		conversation: PlacedConversationRow,
		input: {
			messageId: string;
			content: string;
			attachments?: readonly string[];
			replyTo?: string;
		},
	) =>
		Effect.gen(function* () {
			const sender = yield* senderOf(yield* CurrentActor.Service);
			const posted = yield* conversations.post({
				id: input.messageId,
				conversationId: conversation.id,
				author: sender,
				content: input.content,
				replyTo: input.replyTo,
				attachments: input.attachments ?? [],
			});
			if (posted._tag === "AlreadyPosted") return posted.message;
			// A direct message is between people only: it is never done, and no bot is there to answer.
			if (conversation.kind === "direct_message") return posted.message;
			// Something new in a done task is not left where nobody looks.
			yield* conversations.setDone(conversation, false);
			// Checked once the message is known to be new, so sending it again
			// still returns it; refusing here rolls the post back.
			if (conversation.botId && (yield* hostModelOf(conversation.botId)) === null) {
				return yield* new HostHasNoModel();
			}
			yield* floor.giveFloor({
				id: posted.message.id,
				conversationId: conversation.id,
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
						const { bot: host, actor } = yield* authorization.bot(input.botId, "bot.read");
						// A retry waits for the first send, and then finds the task it started.
						yield* lockMessageId(input.messageId);
						const [sent] = isUuid(input.messageId)
							? yield* query((db) =>
									db
										.select({ conversation: getColumns(placedConversation) })
										.from(message)
										.innerJoin(
											placedConversation,
											eq(placedConversation.id, message.conversationId),
										)
										.where(
											and(eq(message.id, input.messageId), eq(message.authorUserId, actor.userId)),
										)
										.limit(1),
								)
							: [];
						if (sent) {
							if (sent.conversation.kind !== "task" || sent.conversation.botId !== host.id) {
								return yield* new ConversationRepository.MessageIdConflict();
							}
							const posted = yield* postIn(sent.conversation, input).pipe(
								// It neither quotes a message nor carries files, so neither can be missing.
								Effect.catchTags({ ReplyTargetNotFound: Effect.die, UploadsNotFound: Effect.die }),
							);
							return { conversation: toTask(sent.conversation), message: posted };
						}
						if (host.model === null) return yield* new HostHasNoModel();
						const started = yield* conversations.startTask({
							workspaceId: host.workspaceId,
							botId: host.id,
							startedById: actor.userId,
							title: taskTitleFrom(input.content),
						});
						const posted = yield* postIn(started, input).pipe(
							// It neither quotes a message nor carries files, so neither can be missing.
							Effect.catchTags({ ReplyTargetNotFound: Effect.die, UploadsNotFound: Effect.die }),
						);
						return { conversation: toTask(started), message: posted };
					}),
				),
			),

		startInterview: (botId) =>
			operation(
				"startInterview",
				transaction(
					Effect.gen(function* () {
						const { actor } = yield* authorization.bot(botId, "bot.update");
						const due = yield* dueInterview(botId, actor.userId);
						if (!due) return null;
						const interview = yield* conversations.startTask({
							workspaceId: due.workspaceId,
							botId: due.id,
							startedById: actor.userId,
							title: `Setting up ${due.name}`,
						});
						yield* turns.ask({
							conversationId: interview.id,
							botId: due.id,
							triggerMessageId: yield* ids.next,
							reason: "interview",
						});
						return toTask(interview);
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
						const conversation = yield* conversations.openDirectMessage({
							workspaceId,
							memberIds: [actor.userId, ...otherIds],
							startedById: actor.userId,
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
						return { conversation: toDirectMessage(conversation), message };
					}),
				),
			),

		openMainChat: (input) =>
			operation(
				"openMainChat",
				transaction(
					Effect.gen(function* () {
						const { workspaceId, actor } = yield* authorization.workspace(
							input.workspace,
							"workspace.read",
						);
						const reachesChannel = yield* visibility.reachesChannel;
						const [reached] = isUuid(input.channelId)
							? yield* query((db) =>
									db
										.select({ id: channel.id })
										.from(channel)
										.where(
											and(
												eq(channel.id, input.channelId),
												eq(channel.workspaceId, workspaceId),
												reachesChannel(channel.id),
											),
										)
										.limit(1),
								)
							: [];
						if (!reached) return yield* new ResourceHidden({ resource: "channel" });
						return toChannelConversation(
							yield* conversations.openMainChat({
								workspaceId,
								channelId: reached.id,
								startedById: actor.userId,
							}),
						);
					}),
				),
			),

		startChat: (input) =>
			operation(
				"startChat",
				Effect.gen(function* () {
					const { channel, actor } = yield* authorization.channel(input.channelId, "channel.read");
					return toChannelConversation(
						yield* conversations.startChat({
							workspaceId: channel.workspaceId,
							channelId: channel.id,
							startedById: actor.userId,
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
					if (chat.kind !== "channel_conversation" || chat.channelId === null) {
						return yield* new ResourceHidden({ resource: "conversation" });
					}
					yield* authorization.channel(chat.channelId, "channel.update");
					if (chat.archivedAt) return yield* new ChatArchived();
					if ("archived" in input.change && chat.main) return yield* new FirstChatNotArchivable();
					yield* conversations.changeChat(
						chat,
						"name" in input.change ? { title: input.change.name } : { archived: true },
					);
				}),
			),

		openAutomationFeed: (input) =>
			operation(
				"openAutomationFeed",
				transaction(
					Effect.gen(function* () {
						const { workspaceId } = yield* authorization.workspace(
							input.workspace,
							"workspace.read",
						);
						const reachesBot = yield* visibility.reachesBot;
						const [owned] = isUuid(input.automationId)
							? yield* query((db) =>
									db
										.select({ automation })
										.from(automation)
										.where(
											and(
												eq(automation.id, input.automationId),
												eq(automation.workspaceId, workspaceId),
												isNull(automation.deletedAt),
												reachesBot(automation.botId),
											),
										)
										.limit(1),
								)
							: [];
						if (!owned) return yield* new ResourceHidden({ resource: "automation" });
						return toAutomationFeed(yield* conversations.openAutomationFeed(owned.automation));
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

		startBriefedTask: (input) =>
			operation(
				"startBriefedTask",
				transaction(
					Effect.gen(function* () {
						if (!(yield* hostReached(input, yield* visibility.reachesBot))) {
							return yield* new HostUnavailable();
						}
						if ((yield* hostModelOf(input.botId)) === null) {
							return yield* new HostHasNoModel();
						}
						const { userId } = yield* CurrentActor.Service;
						return toTask(yield* conversations.startBriefedTask({ ...input, startedById: userId }));
					}),
				),
			),

		setDone: (input) =>
			operation(
				"setDone",
				transaction(
					Effect.gen(function* () {
						const visible = yield* visibility.conversation(input.conversationId);
						// Only a task is ever done: not a channel's conversation, nor an automation's feed.
						if (visible.kind !== "task") {
							return yield* new ResourceHidden({ resource: "conversation" });
						}
						yield* conversations.setDone(visible, input.done);
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
						yield* conversations.markRead(userId, visible.id);
					}),
				),
			),

		markItemRead: (itemConversationId) =>
			operation(
				"markItemRead",
				transaction(
					Effect.gen(function* () {
						const { conversation } = yield* visibility.conversationStanding(itemConversationId);
						if (!ITEM_CONVERSATION_KINDS.has(conversation.kind)) {
							return yield* new ResourceHidden({ resource: "conversation" });
						}
						const { userId } = yield* CurrentActor.Service;
						yield* conversations.markItemRead(userId, conversation.id);
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
		ConversationRepository.layer,
		FloorControl.layer,
	]),
);

/** The conversations that are an item of their own in Inbox: an automation run's and a collaboration's. */
const ITEM_CONVERSATION_KINDS: ReadonlySet<ConversationKind> = new Set(["run", "collaboration"]);

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
export class HostUnavailable extends Data.TaggedError("HostUnavailable") implements UserFacing {
	get userMessage() {
		return userText`That bot isn't available for this task`;
	}
}

/**
 * The conversation's bot has no model, so nothing could answer. The message is not
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
export interface StartedTask {
	conversation: Task;
	message: Message;
}

/** Whether `reachesBot` reaches the bot, which is in the workspace and one people make. */
const hostReached = (
	input: { workspaceId: string; botId: string },
	reachesBot: Visibility.ReachesBot,
) =>
	Effect.map(
		query((db) =>
			db
				.select({ id: bot.id })
				.from(bot)
				.where(
					and(
						eq(bot.id, input.botId),
						eq(bot.workspaceId, input.workspaceId),
						madeByPeople,
						reachesBot(bot.id),
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

const hostModelOf = (botId: string) =>
	Effect.map(
		query((db) => db.select({ model: bot.model }).from(bot).where(eq(bot.id, botId)).limit(1)),
		([row]) => row?.model ?? null,
	);
