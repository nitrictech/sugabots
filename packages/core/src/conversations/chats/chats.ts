export * as Chats from "./chats.ts";

import type {
	AutomationFeed,
	ConversationKind,
	Message,
	ProjectThread,
	StartedThread,
} from "@sugabots/contracts";
import { userText } from "@sugabots/errors";
import { and, eq, getColumns, isNotNull, isNull, notExists } from "drizzle-orm";
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
import { conversationsWithUnread } from "./chat-view.ts";
import { toAutomationFeed, toProjectThread } from "./conversation.ts";
import { threadTitleFrom } from "./thread-title.ts";

/**
 * Talking in conversations: the current actor starts threads, in projects and
 * with bots, talks in them, and whoever has the floor after a message is asked
 * to speak.
 */
export interface Interface {
	/**
	 * Starts the thread in which the bot `botId` interviews the actor, who made
	 * it, to write its own instructions: once, while it still has the
	 * interview's prompt, a model and no threads. Null when it is not due one.
	 */
	readonly startInterview: (
		botId: string,
	) => Effect.Effect<ProjectThread | null, AuthorizationDenied, CurrentActor.Service>;
	/**
	 * Starts a thread for the actor in the project `projectId`, for everyone in
	 * it, titled from its first message, which whoever has the floor answers:
	 * the lead bot, unless it mentions others. Anyone who reaches the project
	 * may, so a bot's threads are started in its default project. Refused when
	 * a bot given the floor has no model. Starting it again with the same
	 * message returns the thread it started. Files are added once it has
	 * started, since an upload belongs to a conversation.
	 */
	readonly startProjectThread: (input: {
		projectId: string;
		messageId: string;
		content: string;
	}) => Effect.Effect<
		StartedThread,
		AuthorizationDenied | FloorControl.BotHasNoModel | ConversationRepository.MessageIdConflict,
		CurrentActor.Service
	>;
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
		| FloorControl.BotHasNoModel,
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
	}) => Effect.Effect<
		ProjectThread,
		HostUnavailable | FloorControl.BotHasNoModel,
		CurrentActor.Service
	>;
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
	 * Records that the actor has read every conversation they reach in
	 * `workspace`, named by its id or its slug, that holds something they have
	 * not read, each as `markRead` reads it.
	 */
	readonly markAllRead: (
		workspace: string,
	) => Effect.Effect<void, AuthorizationDenied, CurrentActor.Service>;
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
	 * to reach, and gives the floor. Posting the same message again returns it
	 * unchanged.
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
			// Something new in a done thread is not left where nobody looks.
			yield* conversations.setDone(conversation, false);
			// Given once the message is known to be new, so sending it again
			// still returns it; a refusal rolls the post back.
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
	 */
	const startWithMessage = Effect.fnUntraced(function* (
		place: { workspaceId: string; projectId: string },
		userId: string,
		input: { messageId: string; content: string },
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

	return Service.of({
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
						const host = yield* reachedHost(input, yield* visibility.reachesBot);
						if (!host) return yield* new HostUnavailable();
						if (host.model === null) return yield* new FloorControl.BotHasNoModel();
						const { userId } = yield* CurrentActor.Service;
						return toProjectThread(
							yield* conversations.startBriefedThread({
								workspaceId: input.workspaceId,
								projectId: host.defaultProjectId,
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

		markAllRead: (workspace) =>
			operation(
				"markAllRead",
				Effect.gen(function* () {
					const { workspaceId, actor } = yield* authorization.workspace(
						workspace,
						"workspace.read",
					);
					const unread = yield* conversationsWithUnread({
						workspaceId,
						userId: actor.userId,
						reachesConversation: yield* visibility.reachesConversation,
					});
					// Each in its own transaction, as `markRead` is, so no lock is held
					// across the workspace's conversations.
					yield* Effect.forEach(
						unread,
						(conversationId) => conversations.markRead(actor.userId, conversationId),
						{ discard: true },
					);
				}),
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

/**
 * Suspended: the floor control's module reaches this one through the turns,
 * their steps and the bot threads, so `FloorControl.layer` is read once the
 * layer is built, not while the modules load.
 */
export const layer = Layer.suspend(() =>
	layerNoDeps.pipe(
		Layer.provide([
			Authorization.layer,
			Visibility.layer,
			ConversationRepository.layer,
			FloorControl.layer,
		]),
	),
);

/** The conversations that are an item of their own in Inbox: an automation run's and a collaboration's. */
const ITEM_CONVERSATION_KINDS: ReadonlySet<ConversationKind> = new Set(["run", "collaboration"]);

/** The bot asked to host the thread is out of the actor's reach, or not one people make. */
export class HostUnavailable extends Data.TaggedError("HostUnavailable") implements UserFacing {
	get userMessage() {
		return userText`That bot isn't available for this thread`;
	}
}

export class ChatArchived extends Data.TaggedError("ChatArchived") implements UserFacing {
	get userMessage() {
		return userText`This thread is archived, so it can't be changed`;
	}
}

/**
 * The bot `input.botId`, with its model and default project, when
 * `reachesBot` reaches it, it is in the workspace, and people make it.
 */
const reachedHost = (
	input: { workspaceId: string; botId: string },
	reachesBot: Visibility.ReachesBot,
) =>
	Effect.map(
		query((db) =>
			db
				.select({ model: bot.model, defaultProjectId: project.id })
				.from(bot)
				.innerJoin(project, eq(project.defaultOfBotId, bot.id))
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
		([host]) => host,
	);

/** The actor as their messages are signed. */
const senderOf = ({ userId }: CurrentActor.Interface) =>
	Effect.flatMap(
		query((db) => db.query.user.findFirst({ where: { id: userId }, ...personColumns })),
		(sender) =>
			sender ? Effect.succeed(sender) : Effect.die(new Error("The current actor has no account")),
	);
