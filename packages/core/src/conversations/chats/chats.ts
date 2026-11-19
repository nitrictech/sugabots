export * as Chats from "./chats.ts";

import type {
	AutomationFeed,
	ConversationKind,
	DirectMessage,
	Message,
	ProjectThread,
	StartedThread,
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
	message,
	type PlacedConversationRow,
	placedConversation,
	project,
	workspaceMember,
} from "../../database/schema.ts";
import type { ConversationFiles } from "../../files/conversation-files.ts";
import { Ids, isUuid } from "../../ids/ids.ts";
import type { UserFacing } from "../../user-message.ts";
import { INTERVIEW_PROMPT } from "../../workspaces/bots/interview-prompt.ts";
import { defaultProjectOf } from "../../workspaces/projects/project-reads.ts";
import { FloorControl } from "../floor/floor-control.ts";
import { madeByPeople, personColumns } from "../repository/participants.ts";
import { ConversationRepository, lockMessageId } from "../repository/repository.ts";
import { Turns } from "../turns/turns.ts";
import { toAutomationFeed, toDirectMessage, toProjectThread } from "./conversation.ts";
import { threadTitleFrom } from "./thread-title.ts";

/**
 * Talking in conversations: the current actor starts threads, in projects and
 * with bots, talks in them and in direct messages, and whoever has the floor
 * after a message is asked to speak.
 */
export interface Interface {
	/**
	 * Starts a thread for the actor with the bot `botId`, in its default
	 * project, titled from its first message, which the bot answers. Hidden
	 * unless the actor reaches the bot; refused when it has no model. Starting
	 * it again with the same message returns the thread it started. Files are
	 * added once it has started, since an upload belongs to a conversation.
	 */
	readonly startThread: (input: {
		botId: string;
		messageId: string;
		content: string;
	}) => Effect.Effect<
		StartedThread,
		AuthorizationDenied | HostHasNoModel | ConversationRepository.MessageIdConflict,
		CurrentActor.Service
	>;
	/**
	 * Starts the thread in which the bot `botId` interviews the actor, who made
	 * it, to write its own instructions: once, while it still has the
	 * interview's prompt, a model and no threads. Null when it is not due one.
	 */
	readonly startInterview: (
		botId: string,
	) => Effect.Effect<ProjectThread | null, AuthorizationDenied, CurrentActor.Service>;
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
	 * Starts a thread for the actor in the project `projectId`, for everyone in
	 * it, titled from its first message, which whoever has the floor answers:
	 * the lead bot, unless it mentions others. Anyone in the project may.
	 * Starting it again with the same message returns the thread it started.
	 */
	readonly startProjectThread: (input: {
		projectId: string;
		messageId: string;
		content: string;
	}) => Effect.Effect<
		StartedThread,
		AuthorizationDenied | HostHasNoModel | ConversationRepository.MessageIdConflict,
		CurrentActor.Service
	>;
	/**
	 * Starts a thread in the project `projectId`, called `name`, for everyone in
	 * it. Anyone in the project may.
	 */
	readonly startNamedThread: (input: {
		projectId: string;
		name: string;
	}) => Effect.Effect<ProjectThread, AuthorizationDenied | ResourceHidden, CurrentActor.Service>;
	/**
	 * Renames the project's thread `conversationId`, or archives it, for
	 * whoever may manage the project's threads. An archived thread is changed no more.
	 */
	readonly changeThread: (input: {
		conversationId: string;
		change: { name: string } | { archived: true };
	}) => Effect.Effect<
		void,
		AuthorizationDenied | ResourceHidden | ChatArchived,
		CurrentActor.Service
	>;
	/**
	 * The automation's feed, where its runs post, opened on first use.
	 * Hidden unless the actor reaches the automation's project.
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
	 * Starts a thread for the actor with the bot `botId`, in its default
	 * project, which takes its turn on `brief`, the first message, written by
	 * the bot `briefingBotId` that started it for them. Refused unless the
	 * actor reaches that bot and it has a model.
	 */
	readonly startBriefedThread: (input: {
		workspaceId: string;
		botId: string;
		briefingBotId: string;
		title: string;
		brief: string;
	}) => Effect.Effect<ProjectThread, HostUnavailable | HostHasNoModel, CurrentActor.Service>;
	/**
	 * Marks the thread `conversationId` done, or reopens it. An automation's
	 * feed is never done, so it is hidden from this.
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

	/** The bot `botId`, when `userId` made it and it is still due its interview: it has no threads. */
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
								db
									.select({ id: placedConversation.id })
									.from(placedConversation)
									.where(
										and(
											eq(placedConversation.kind, "project_thread"),
											eq(placedConversation.botId, botId),
										),
									),
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
			// Something new in a done thread is not left where nobody looks.
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
	 * Starts a thread for `userId` in the project `place.projectId`, titled
	 * from its first message, and posts it, giving the floor. Sent again with the same message, it
	 * returns the thread that message started instead, unless that is elsewhere.
	 * `refusal`, when given, is failed with before anything is made.
	 */
	const startWithMessage = Effect.fnUntraced(function* (
		place: { workspaceId: string; projectId: string },
		userId: string,
		input: { messageId: string; content: string },
		refusal?: HostHasNoModel,
	) {
		// A retry waits for the first send, and then finds the thread it started.
		yield* lockMessageId(input.messageId);
		const [sent] = isUuid(input.messageId)
			? yield* query((db) =>
					db
						.select({ conversation: getColumns(placedConversation) })
						.from(message)
						.innerJoin(placedConversation, eq(placedConversation.id, message.conversationId))
						.where(and(eq(message.id, input.messageId), eq(message.authorUserId, userId)))
						.limit(1),
				)
			: [];
		if (sent) {
			if (
				sent.conversation.kind !== "project_thread" ||
				sent.conversation.projectId !== place.projectId
			) {
				return yield* new ConversationRepository.MessageIdConflict();
			}
			const posted = yield* postIn(sent.conversation, input).pipe(
				// It neither quotes a message nor carries files, so neither can be missing.
				Effect.catchTags({ ReplyTargetNotFound: Effect.die, UploadsNotFound: Effect.die }),
			);
			return { conversation: toProjectThread(sent.conversation), message: posted };
		}
		if (refusal) return yield* refusal;
		const started = yield* conversations.startThread({
			workspaceId: place.workspaceId,
			projectId: place.projectId,
			startedById: userId,
			title: threadTitleFrom(input.content),
		});
		const posted = yield* postIn(started, input).pipe(
			// It neither quotes a message nor carries files, so neither can be missing.
			Effect.catchTags({ ReplyTargetNotFound: Effect.die, UploadsNotFound: Effect.die }),
		);
		return { conversation: toProjectThread(started), message: posted };
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
		startThread: (input) =>
			operation(
				"startThread",
				transaction(
					Effect.gen(function* () {
						const { bot: host, actor } = yield* authorization.bot(input.botId, "bot.read");
						const projectId = yield* defaultProjectOf(host.id);
						return yield* startWithMessage(
							{ workspaceId: host.workspaceId, projectId },
							actor.userId,
							input,
							// Refused before the thread is made, rather than after its message.
							host.model === null ? new HostHasNoModel() : undefined,
						);
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
						const interview = yield* conversations.startThread({
							workspaceId: due.workspaceId,
							projectId: yield* defaultProjectOf(due.id),
							startedById: actor.userId,
							title: `Setting up ${due.name}`,
						});
						yield* turns.ask({
							conversationId: interview.id,
							botId: due.id,
							triggerMessageId: yield* ids.next,
							reason: "interview",
						});
						return toProjectThread(interview);
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

		startProjectThread: (input) =>
			operation(
				"startProjectThread",
				transaction(
					Effect.gen(function* () {
						const { project: started, actor } = yield* authorization.project(
							input.projectId,
							"project.read",
						);
						return yield* startWithMessage(
							{ workspaceId: started.workspaceId, projectId: started.id },
							actor.userId,
							input,
						);
					}),
				),
			),

		startNamedThread: (input) =>
			operation(
				"startNamedThread",
				Effect.gen(function* () {
					const { project, actor } = yield* authorization.project(input.projectId, "project.read");
					return toProjectThread(
						yield* conversations.startThread({
							workspaceId: project.workspaceId,
							projectId: project.id,
							startedById: actor.userId,
							title: input.name,
						}),
					);
				}),
			),

		changeThread: (input) =>
			operation(
				"changeThread",
				Effect.gen(function* () {
					const chat = yield* visibility.conversation(input.conversationId);
					if (chat.kind !== "project_thread" || chat.projectId === null) {
						return yield* new ResourceHidden({ resource: "conversation" });
					}
					yield* authorization.project(chat.projectId, "project.threads.manage");
					if (chat.archivedAt) return yield* new ChatArchived();
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
						const reachesProject = yield* visibility.reachesProject;
						const [owned] = isUuid(input.automationId)
							? yield* query((db) =>
									db
										.select({ automation, leadBotId: project.leadBotId })
										.from(automation)
										.innerJoin(project, eq(project.id, automation.projectId))
										.where(
											and(
												eq(automation.id, input.automationId),
												eq(automation.workspaceId, workspaceId),
												isNull(automation.deletedAt),
												reachesProject(automation.projectId),
											),
										)
										.limit(1),
								)
							: [];
						if (!owned) return yield* new ResourceHidden({ resource: "automation" });
						return toAutomationFeed(
							yield* conversations.openAutomationFeed(owned.automation, owned.leadBotId),
						);
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
						if (!(yield* hostReached(input, yield* visibility.reachesBot))) {
							return yield* new HostUnavailable();
						}
						if ((yield* hostModelOf(input.botId)) === null) {
							return yield* new HostHasNoModel();
						}
						const { userId } = yield* CurrentActor.Service;
						return toProjectThread(
							yield* conversations.startBriefedThread({
								workspaceId: input.workspaceId,
								projectId: yield* defaultProjectOf(input.botId),
								briefingBotId: input.briefingBotId,
								startedById: userId,
								title: input.title,
								brief: input.brief,
							}),
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
						// Only a thread is ever done, not an automation's feed.
						if (visible.kind !== "project_thread") {
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

/** The bot asked to host the thread is out of the actor's reach, or not one people make. */
export class HostUnavailable extends Data.TaggedError("HostUnavailable") implements UserFacing {
	get userMessage() {
		return userText`That bot isn't available for this thread`;
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
