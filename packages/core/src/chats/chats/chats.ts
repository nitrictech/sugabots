export * as Chats from "./chats.ts";

import type {
	AutomationFeed,
	ChatKind,
	Message,
	ProjectChat,
	StartedChat,
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
	type PlacedChatRow,
	placedChat,
	project,
} from "../../database/schema.ts";
import type { ChatFileStore } from "../../files/chat-file-store.ts";
import { Ids, isUuid } from "../../ids/ids.ts";
import type { UserFacing } from "../../user-message.ts";
import { INTERVIEW_PROMPT } from "../../workspaces/bots/interview-prompt.ts";
import { defaultProjectOf } from "../../workspaces/projects/project-reads.ts";
import { FloorControl } from "../floor/floor-control.ts";
import { madeByPeople, personColumns } from "../store/participants.ts";
import { ChatStore, lockMessageId } from "../store/store.ts";
import { Turns } from "../turns/turns.ts";
import { toAutomationFeed, toProjectChat } from "./chat.ts";
import { chatTitleFrom } from "./chat-title.ts";

/**
 * Talking in chats: the current actor starts chats, in projects and
 * with bots, talks in them, and whoever has the floor after a message is asked
 * to speak.
 */
export interface Interface {
	/**
	 * Starts the chat in which the bot `botId` interviews the actor, who made
	 * it, to write its own instructions: once, while it still has the
	 * interview's prompt, a model and no chats. Null when it is not due one.
	 */
	readonly startInterview: (
		botId: string,
	) => Effect.Effect<ProjectChat | null, AuthorizationDenied, CurrentActor.Service>;
	/**
	 * Starts a chat for the actor in the project `projectId`, for everyone in
	 * it, titled from its first message, which whoever has the floor answers:
	 * the lead bot, unless it mentions others. Anyone who reaches the project
	 * may, so a bot's chats are started in its default project. Refused when
	 * a bot given the floor has no model. Starting it again with the same
	 * message returns the chat it started. Files are added once it has
	 * started, since an upload belongs to a chat.
	 */
	readonly startProjectChat: (input: {
		projectId: string;
		messageId: string;
		content: string;
	}) => Effect.Effect<
		StartedChat,
		AuthorizationDenied | FloorControl.BotHasNoModel | ChatStore.MessageIdConflict,
		CurrentActor.Service
	>;
	/**
	 * Renames the project's chat `chatId` to `name`, for whoever may manage
	 * the project's chats.
	 */
	readonly renameChat: (input: {
		chatId: string;
		name: string;
	}) => Effect.Effect<void, AuthorizationDenied | ResourceHidden, CurrentActor.Service>;
	/**
	 * The automation's feed, where its runs post, opened on first use.
	 * Hidden unless the actor reaches the automation's project.
	 */
	readonly openAutomationFeed: (input: {
		workspace: string;
		automationId: string;
	}) => Effect.Effect<AutomationFeed, AuthorizationDenied | ResourceHidden, CurrentActor.Service>;
	/**
	 * Posts the actor's message into the chat, with the files
	 * they uploaded to it, and gives the floor. Posting the same message again
	 * returns it unchanged.
	 */
	readonly post: (input: {
		chatId: string;
		messageId: string;
		/** May be empty when the message carries files. */
		content: string;
		/** Ids of the actor's uploads to the chat, not yet sent. None unless set. */
		attachments?: readonly string[];
		/** The id of the message in the chat that this one quotes and answers. */
		replyTo?: string;
	}) => Effect.Effect<
		Message,
		| ResourceHidden
		| ChatStore.MessageIdConflict
		| ChatStore.ReplyTargetNotFound
		| ChatFileStore.UploadsNotFound
		| FloorControl.BotHasNoModel,
		CurrentActor.Service
	>;
	/**
	 * Starts a chat for the actor with the bot `botId`, in its default
	 * project, which takes its turn on `brief`, the first message, written by
	 * the bot `briefingBotId` that started it for them. Refused unless the
	 * actor reaches that bot and it has a model.
	 */
	readonly startBriefedChat: (input: {
		workspaceId: string;
		botId: string;
		briefingBotId: string;
		title: string;
		brief: string;
	}) => Effect.Effect<
		ProjectChat,
		HostUnavailable | FloorControl.BotHasNoModel,
		CurrentActor.Service
	>;
	/**
	 * Marks the chat `chatId` resolved, or reopens it. An automation's
	 * feed is never resolved, so it is hidden from this.
	 */
	readonly setResolved: (input: {
		chatId: string;
		resolved: boolean;
	}) => Effect.Effect<void, ResourceHidden, CurrentActor.Service>;
	/** Records that the actor has read the chat up to its newest finished message. */
	readonly markRead: (chatId: string) => Effect.Effect<void, ResourceHidden, CurrentActor.Service>;
	/**
	 * Records that the actor has read one automation run or collaboration,
	 * opened as a page of its own, by its own chat `nestedChatId`, leaving the
	 * chat it is listed in, and what was written in the nested chat since it
	 * began, unread. Other chats are hidden from this.
	 */
	readonly markNestedChatRead: (
		nestedChatId: string,
	) => Effect.Effect<void, ResourceHidden, CurrentActor.Service>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/Chats") {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("Chats");
	const authorization = yield* Authorization.Service;
	const visibility = yield* Visibility.Service;
	const chats = yield* ChatStore.Service;
	const floor = yield* FloorControl.Service;
	const turns = yield* Turns.Service;
	const ids = yield* Ids.Service;

	/** The bot `botId`, when `personId` made it and it is still due its interview: it has no chats. */
	const dueInterview = (botId: string, personId: string) =>
		Effect.map(
			query((db) =>
				db
					.select({ id: bot.id, name: bot.name, workspaceId: bot.workspaceId })
					.from(bot)
					.where(
						and(
							eq(bot.id, botId),
							eq(bot.createdById, personId),
							eq(bot.prompt, INTERVIEW_PROMPT),
							isNotNull(bot.model),
							notExists(
								db
									.select({ id: placedChat.id })
									.from(placedChat)
									.where(and(eq(placedChat.kind, "project_chat"), eq(placedChat.botId, botId))),
							),
						),
					)
					.limit(1),
			),
			([row]) => row,
		);

	/**
	 * Posts the actor's message in `chat`, which they have been found
	 * to reach, and gives the floor. Posting the same message again returns it
	 * unchanged.
	 */
	const postIn = (
		chat: PlacedChatRow,
		input: {
			messageId: string;
			content: string;
			attachments?: readonly string[];
			replyTo?: string;
		},
	) =>
		Effect.gen(function* () {
			const author = yield* authorOf(yield* CurrentActor.Service);
			const posted = yield* chats.post({
				id: input.messageId,
				chatId: chat.id,
				author,
				content: input.content,
				replyTo: input.replyTo,
				attachments: input.attachments ?? [],
			});
			if (posted._tag === "AlreadyPosted") return posted.message;
			// Something new in a resolved chat is not left where nobody looks.
			yield* chats.setResolved(chat, false);
			// Given once the message is known to be new, so sending it again
			// still returns it; a refusal rolls the post back.
			yield* floor.giveFloor({
				id: posted.message.id,
				chatId: chat.id,
				content: posted.message.content,
			});
			return posted.message;
		});

	/**
	 * Starts a chat for `personId` in the project `place.projectId`, titled
	 * from its first message, and posts it, giving the floor. Sent again with the same message, it
	 * returns the chat that message started instead, unless that is elsewhere.
	 */
	const startWithMessage = Effect.fnUntraced(function* (
		place: { workspaceId: string; projectId: string },
		personId: string,
		input: { messageId: string; content: string },
	) {
		// A retry waits for the first send, and then finds the chat it started.
		yield* lockMessageId(input.messageId);
		const [sent] = isUuid(input.messageId)
			? yield* query((db) =>
					db
						.select({ chat: getColumns(placedChat) })
						.from(message)
						.innerJoin(placedChat, eq(placedChat.id, message.chatId))
						.where(and(eq(message.id, input.messageId), eq(message.authorPersonId, personId)))
						.limit(1),
				)
			: [];
		if (sent) {
			if (sent.chat.kind !== "project_chat" || sent.chat.projectId !== place.projectId) {
				return yield* new ChatStore.MessageIdConflict();
			}
			const posted = yield* postIn(sent.chat, input).pipe(
				// It neither quotes a message nor carries files, so neither can be missing.
				Effect.catchTags({ ReplyTargetNotFound: Effect.die, UploadsNotFound: Effect.die }),
			);
			return { chat: toProjectChat(sent.chat), message: posted };
		}
		const started = yield* chats.startChat({
			workspaceId: place.workspaceId,
			projectId: place.projectId,
			startedById: personId,
			title: chatTitleFrom(input.content),
		});
		const posted = yield* postIn(started, input).pipe(
			// It neither quotes a message nor carries files, so neither can be missing.
			Effect.catchTags({ ReplyTargetNotFound: Effect.die, UploadsNotFound: Effect.die }),
		);
		return { chat: toProjectChat(started), message: posted };
	});

	return Service.of({
		startInterview: (botId) =>
			operation(
				"startInterview",
				transaction(
					Effect.gen(function* () {
						const { actor } = yield* authorization.bot(botId, "bot.update");
						const due = yield* dueInterview(botId, actor.personId);
						if (!due) return null;
						const interview = yield* chats.startChat({
							workspaceId: due.workspaceId,
							projectId: yield* defaultProjectOf(due.id),
							startedById: actor.personId,
							title: `Setting up ${due.name}`,
						});
						yield* turns.ask({
							chatId: interview.id,
							botId: due.id,
							triggerMessageId: yield* ids.next,
							reason: "interview",
						});
						return toProjectChat(interview);
					}),
				),
			),

		startProjectChat: (input) =>
			operation(
				"startProjectChat",
				transaction(
					Effect.gen(function* () {
						const { project: started, actor } = yield* authorization.project(
							input.projectId,
							"project.read",
						);
						return yield* startWithMessage(
							{ workspaceId: started.workspaceId, projectId: started.id },
							actor.personId,
							input,
						);
					}),
				),
			),

		renameChat: (input) =>
			operation(
				"renameChat",
				Effect.gen(function* () {
					const chat = yield* visibility.chat(input.chatId);
					if (chat.kind !== "project_chat" || chat.projectId === null) {
						return yield* new ResourceHidden({ resource: "chat" });
					}
					yield* authorization.project(chat.projectId, "project.chats.manage");
					yield* chats.renameChat(chat, input.name);
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
							yield* chats.openAutomationFeed(owned.automation, owned.leadBotId),
						);
					}),
				),
			),

		post: (input) =>
			operation(
				"post",
				transaction(
					Effect.flatMap(visibility.chat(input.chatId), (visible) => postIn(visible, input)),
				),
			),

		startBriefedChat: (input) =>
			operation(
				"startBriefedChat",
				transaction(
					Effect.gen(function* () {
						const host = yield* reachedHost(input, yield* visibility.reachesBot);
						if (!host) return yield* new HostUnavailable();
						if (host.model === null) return yield* new FloorControl.BotHasNoModel();
						const { personId } = yield* CurrentActor.Service;
						return toProjectChat(
							yield* chats.startBriefedChat({
								workspaceId: input.workspaceId,
								projectId: host.defaultProjectId,
								briefingBotId: input.briefingBotId,
								startedById: personId,
								title: input.title,
								brief: input.brief,
							}),
						);
					}),
				),
			),

		setResolved: (input) =>
			operation(
				"setResolved",
				transaction(
					Effect.gen(function* () {
						const visible = yield* visibility.chat(input.chatId);
						// Only a project's chat is ever resolved, not an automation's feed.
						if (visible.kind !== "project_chat") {
							return yield* new ResourceHidden({ resource: "chat" });
						}
						yield* chats.setResolved(visible, input.resolved);
					}),
				),
			),

		markRead: (chatId) =>
			operation(
				"markRead",
				transaction(
					Effect.gen(function* () {
						const visible = yield* visibility.chat(chatId);
						const { personId } = yield* CurrentActor.Service;
						yield* chats.markRead(personId, visible.id);
					}),
				),
			),

		markNestedChatRead: (nestedChatId) =>
			operation(
				"markNestedChatRead",
				transaction(
					Effect.gen(function* () {
						const { chat } = yield* visibility.chatStanding(nestedChatId);
						if (!NESTED_CHAT_KINDS.has(chat.kind)) {
							return yield* new ResourceHidden({ resource: "chat" });
						}
						const { personId } = yield* CurrentActor.Service;
						yield* chats.markNestedChatRead(personId, chat.id);
					}),
				),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

/**
 * Suspended: the floor control's module reaches this one through the turns,
 * their steps and the bot chats, so `FloorControl.layer` is read once the
 * layer is built, not while the modules load.
 */
export const layer = Layer.suspend(() =>
	layerNoDeps.pipe(
		Layer.provide([Authorization.layer, Visibility.layer, ChatStore.layer, FloorControl.layer]),
	),
);

/** The nested chats, which open over the root chat they hang under: an automation run's and a collaboration's. */
const NESTED_CHAT_KINDS: ReadonlySet<ChatKind> = new Set(["run", "collaboration"]);

/** The bot asked to host the chat is out of the actor's reach, or not one people make. */
export class HostUnavailable extends Data.TaggedError("HostUnavailable") implements UserFacing {
	get userMessage() {
		return userText`That bot isn't available for this chat`;
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

/** The actor as the author of their messages. */
const authorOf = ({ personId }: CurrentActor.Interface) =>
	Effect.flatMap(
		query((db) => db.query.person.findFirst({ where: { id: personId }, ...personColumns })),
		(author) =>
			author ? Effect.succeed(author) : Effect.die(new Error("The current actor has no account")),
	);
