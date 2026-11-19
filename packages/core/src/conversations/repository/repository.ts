export * as ConversationRepository from "./repository.ts";

import {
	type AutomationTriggerAuthor,
	type ConversationKind,
	MAX_REACTION_EMOJI_PER_MESSAGE,
	type Message,
	type MessageReaction,
	type SystemBotKey,
	type WrittenFilePart,
} from "@sugabots/contracts";
import { userText } from "@sugabots/errors";
import { and, eq, isNull, lt, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Context, Data, DateTime, Effect, Layer } from "effect";
import { query, serviceOperations, transaction, writtenRow } from "../../database/database.ts";
import type * as schema from "../../database/schema.ts";
import {
	automationFeed,
	automationRun,
	bot,
	collaboration,
	conversation,
	conversationParticipant,
	conversationRead,
	directMessage,
	directMessageMember,
	message,
	messageReaction,
	placedConversation,
	projectThread,
	systemConversation,
} from "../../database/schema.ts";
import { ConversationFiles } from "../../files/conversation-files.ts";
import type { UserFacing } from "../../user-message.ts";
import { ConversationEvents } from "../conversation-events.ts";
import { ConversationEvent } from "../events.ts";
import { loadFileParts, toFilePart } from "./file-parts.ts";
import {
	authorRow,
	type PersonIdentity,
	personAuthor,
	personColumns,
	quotedMessageColumns,
	reactionColumns,
	toMessage,
	toPerson,
	toReactions,
	toReplyTo,
	withReplyTo,
} from "./participants.ts";
import type { BotConversationId } from "./rooms.ts";

/**
 * The only writer of `conversation` and of each kind's own table, except a
 * collaboration's and a run's, which their repositories write in the same
 * transaction as the conversation; of `conversation_participant` and
 * `conversation_read`; and of the messages posted into conversations. A
 * turn's reply is the exception: it is `TurnRepository`'s while the turn
 * writes it.
 *
 * Commands take the ids and facts they write, and return rows. Whether
 * somebody may ask for any of this is decided by the caller.
 */
export interface Interface {
	/**
	 * The direct message between `memberIds` in the workspace, in no project,
	 * created on first use with them as its members: one for each set of
	 * people, whichever of them opens it, however their ids are written.
	 */
	readonly openDirectMessage: (placement: {
		workspaceId: string;
		memberIds: readonly string[];
		startedById: string;
	}) => Effect.Effect<schema.PlacedConversationRow>;
	/**
	 * Starts a thread in the project, called `title`, with `startedById` in it,
	 * and in a bot's default project the bot too, and announces it.
	 */
	readonly startThread: (placement: NewThread) => Effect.Effect<schema.PlacedConversationRow>;
	/**
	 * Starts a thread in the bot's default project `projectId` for the person
	 * `startedById`, with them and the bot in it. Its first message is `brief`,
	 * written by the bot `briefingBotId`, which may be the thread's own bot;
	 * announced so the thread's bot takes its turn on the brief. Dies on a
	 * project people made, which has no bot of its own to brief.
	 */
	readonly startBriefedThread: (
		input: NewThread & { briefingBotId: string; brief: string },
	) => Effect.Effect<schema.PlacedConversationRow>;
	/**
	 * Marks the project's thread `thread` done, or reopens it, and announces it
	 * when that changed it. Only a project's thread is ever done, so any other
	 * conversation is left as it is.
	 */
	readonly setDone: (
		thread: Pick<schema.PlacedConversationRow, "id" | "workspaceId">,
		done: boolean,
	) => Effect.Effect<void>;
	/**
	 * Renames the project's thread `chat`, or archives it when `change` says so, and
	 * announces it. An archived thread is left as it is: the caller refuses
	 * changing one.
	 */
	readonly changeChat: (
		chat: Pick<schema.PlacedConversationRow, "id" | "workspaceId">,
		change: { title: string } | { archived: true },
	) => Effect.Effect<void>;
	/**
	 * The automation's feed, where each of its runs posts, created on first use
	 * with its project's lead bot in it, if the project has one.
	 */
	readonly openAutomationFeed: (
		owned: Pick<schema.AutomationRow, "id" | "workspaceId" | "name">,
		leadBotId: string | null,
	) => Effect.Effect<schema.PlacedConversationRow>;
	/**
	 * Posts a person's message with the files they attach, making them a
	 * participant, and announces it. Posting a message again with the same
	 * `id` returns the one already posted, unchanged and unannounced; an `id`
	 * already used by a different message, or the same text with other files,
	 * fails, and so does quoting a message that is not in the conversation.
	 * Fails with `UploadsNotFound`, posting nothing, when an attachment is not
	 * one of the author's unsent uploads in the conversation.
	 */
	readonly post: (input: {
		/** The id the person's client chose, which makes sending it again safe to detect. */
		id: string;
		conversationId: string;
		author: PersonIdentity;
		/** May be empty when the message carries files. */
		content: string;
		/** Ids of the author's uploads to attach. */
		attachments: readonly string[];
		/** The id of the message in the conversation that this one quotes and answers. */
		replyTo?: string;
	}) => Effect.Effect<
		Posted | AlreadyPosted,
		MessageIdConflict | ReplyTargetNotFound | ConversationFiles.UploadsNotFound
	>;
	/** Brings bots into the conversation, announcing the ones who were not there yet. */
	readonly addBots: (conversationId: string, botIds: readonly string[]) => Effect.Effect<void>;
	/**
	 * Opens a collaboration's conversation in `parent`'s workspace, with both
	 * bots in it and the brief as its first message, written by the asking
	 * bot. The caller writes its `collaboration` row in the same transaction.
	 */
	readonly openCollaboration: (input: {
		parent: Pick<schema.PlacedConversationRow, "workspaceId">;
		askingBotId: string;
		collaboratorId: string;
		title: string;
		brief: string;
	}) => Effect.Effect<{ conversationId: string; briefMessageId: string }>;
	/**
	 * Opens an automation run's conversation, with the bot in it. The caller
	 * writes its `run` row in the same transaction.
	 */
	readonly openRun: (input: {
		workspaceId: string;
		botId: string;
		title: string;
	}) => Effect.Effect<schema.ConversationRow>;
	/** Posts what started an automation run into its conversation, as the run's first message. */
	readonly postAutomationTrigger: (input: {
		conversationId: string;
		trigger: AutomationTriggerAuthor;
		content: string;
	}) => Effect.Effect<schema.MessageRow>;
	/**
	 * Posts an automation run's result into the automation's feed, from the
	 * run's bot and linked to the run, which it opens, and announces it. A run
	 * has one result: posting a second fails.
	 */
	readonly postRunResult: (input: {
		run: RunPosting;
		result: RunResult;
	}) => Effect.Effect<schema.MessageRow>;
	/**
	 * The conversation the system bot `systemBotKey` works in on `served`,
	 * with `systemBotId`: one per system bot per conversation, created on
	 * first use.
	 */
	readonly openSystemConversation: (input: {
		served: Pick<schema.PlacedConversationRow, "id" | "workspaceId">;
		systemBotId: string;
		systemBotKey: SystemBotKey;
		title: string;
	}) => Effect.Effect<string>;
	/**
	 * Calls the bot's conversation `title`. Never a project's, which goes by
	 * the name people gave it. True when the conversation was still there to
	 * take it.
	 */
	readonly retitle: (conversationId: BotConversationId, title: string) => Effect.Effect<boolean>;
	/** Retitles the conversation the system bot `systemBotKey` works in on `servedConversationId`. */
	readonly retitleSystemConversation: (input: {
		servedConversationId: BotConversationId;
		systemBotKey: SystemBotKey;
		title: string;
	}) => Effect.Effect<void>;
	/**
	 * Records that `userId` has read the conversation `conversationId` up to
	 * its newest finished message, and tells its watchers when that moved
	 * them on. Never moves past a reply still streaming, which is not yet
	 * read, so it is news once it is done, however much was written after it
	 * began. Never moves anyone back.
	 */
	readonly markRead: (userId: string, conversationId: string) => Effect.Effect<void>;
	/**
	 * Records that `userId` has read an automation run or collaboration as an
	 * item, by its own conversation `itemConversationId`: that conversation up
	 * to when the item began, or up to when a run ended once it has. The
	 * conversation it is listed in, and what was written in the item since,
	 * stay as they were. Tells the item's watchers when that moved them on.
	 * Never moves anyone back, and does nothing for any other conversation.
	 */
	readonly markItemRead: (userId: string, itemConversationId: string) => Effect.Effect<void>;
	/**
	 * Adds the person's reaction to a finished message, and announces what the
	 * message has now. A reaction already there changes nothing and is not
	 * announced. A new emoji past `MAX_REACTION_EMOJI_PER_MESSAGE` fails.
	 */
	readonly addReaction: (
		reaction: Reaction,
	) => Effect.Effect<MessageReaction[], MessageNotFinished | TooManyReactionEmoji>;
	/** Takes the person's reaction back, announcing it as `addReaction` does, if it was there. */
	readonly removeReaction: (reaction: Reaction) => Effect.Effect<MessageReaction[]>;
}

/** What of an automation run its posted result names. */
type RunPosting = Pick<
	schema.RunRow,
	"id" | "conversationId" | "botId" | "automationId" | "automationName"
>;

/**
 * What an automation run's result says: its bot's last reply, and the files
 * the run wrote, which the calls that wrote them show only in the run's
 * conversation.
 */
interface RunResult {
	readonly content: string;
	readonly files: readonly WrittenFilePart[];
}

/** The run `run` as the result posted from it links to it. */
function resultOf(run: RunPosting): NonNullable<Message["automationResultOf"]> {
	return {
		runId: run.id,
		conversationId: run.conversationId,
		automationId: run.automationId,
		automationName: run.automationName,
	};
}

/**
 * What a direct message between people is called where a title is needed:
 * lists name it for the others in it, who differ for each of them.
 */
const DIRECT_MESSAGE_TITLE = "Direct message";

/** What names the direct message between these people, whichever of them opens it. */
function directKeyOf(memberIds: readonly string[]): string {
	// Lower-cased as Postgres writes a uuid, so the same people are named the same way.
	const ids = new Set(memberIds.map((id) => id.toLowerCase()));
	return [...ids].sort().join(DIRECT_KEY_SEPARATOR);
}

const DIRECT_KEY_SEPARATOR = ":";

/** The people a direct message's key names, by id. */
export function membersOfDirectKey(directKey: string): string[] {
	return directKey.split(DIRECT_KEY_SEPARATOR);
}

/** One person's emoji on a message in a conversation. */
export interface Reaction {
	readonly conversationId: string;
	readonly messageId: string;
	readonly userId: string;
	readonly emoji: string;
}

/** A new thread in the project `projectId`. */
export interface NewThread {
	workspaceId: string;
	projectId: string;
	startedById: string;
	title: string;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/ConversationRepository",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("ConversationRepository");
	const { emit } = yield* ConversationEvents.Service;
	const files = yield* ConversationFiles.Service;

	/** Writes the shared row of a new conversation; its kind's row is written beside it. */
	const insertConversation = (row: {
		workspaceId: string;
		kind: ConversationKind;
		title: string;
	}) =>
		query((db) => db.insert(conversation).values(row).returning()).pipe(
			Effect.flatMap(writtenRow("conversation")),
		);

	/**
	 * Takes back a conversation whose kind row lost a race to one already
	 * there, such as a second feed for one automation, so it is never left
	 * without one.
	 */
	const discardConversation = (id: string) =>
		query((db) => db.delete(conversation).where(eq(conversation.id, id)));

	const placedById = (id: string) =>
		query((db) =>
			db.select().from(placedConversation).where(eq(placedConversation.id, id)).limit(1),
		).pipe(Effect.flatMap(writtenRow("conversation")));

	/** What the message has now, announced when `changed`. */
	const reactionsAfter = (reaction: Reaction, changed: boolean) =>
		Effect.gen(function* () {
			const rows = yield* query((db) =>
				db.query.messageReaction.findMany({
					where: { messageId: reaction.messageId },
					...reactionColumns,
				}),
			);
			const reactions = toReactions(rows);
			if (changed) {
				yield* emit([
					ConversationEvent.ReactionsChanged({
						conversationId: reaction.conversationId,
						messageId: reaction.messageId,
						reactions,
					}),
				]);
			}
			return reactions;
		});

	/**
	 * Posts the run's `result` into `conversationId` from the run's bot, and
	 * announces it as the run's result, which opens the run.
	 */
	const postFromRunBot = (input: { conversationId: string; run: RunPosting; result: RunResult }) =>
		Effect.gen(function* () {
			const [author] = yield* query((db) =>
				db
					.select({
						id: bot.id,
						name: bot.name,
						handle: bot.handle,
						color: bot.color,
						face: bot.face,
						shape: bot.shape,
					})
					.from(bot)
					.where(eq(bot.id, input.run.botId))
					.limit(1),
			);
			if (!author) return yield* Effect.die(new Error("An automation run's bot is gone"));
			const { content } = input.result;
			const created = yield* query((db) =>
				db
					.insert(message)
					.values({
						conversationId: input.conversationId,
						authorBotId: input.run.botId,
						runId: input.run.id,
						kind: "text",
						status: "complete",
						parts: [
							...(content === "" ? [] : [{ type: "text" as const, text: content }]),
							...input.result.files,
						],
						content,
					})
					.returning(),
			).pipe(Effect.flatMap(writtenRow("message")));
			const now = yield* DateTime.nowAsDate;
			const placed = yield* query((db) =>
				db
					.update(conversation)
					.set({ updatedAt: now })
					.where(eq(conversation.id, input.conversationId))
					.returning({ workspaceId: conversation.workspaceId }),
			).pipe(Effect.flatMap(writtenRow("conversation")));
			yield* emit([
				ConversationEvent.MessagePosted({
					conversationId: input.conversationId,
					workspaceId: placed.workspaceId,
					message: {
						...toMessage(created, authorRow(null, author)),
						automationResultOf: resultOf(input.run),
					},
				}),
			]);
			return created;
		});

	/**
	 * Moves how far `userId` has read `conversationId` on to `at`, a timestamp
	 * as text, and tells the conversation's watchers. Never moves anyone back.
	 */
	const readThrough = Effect.fn("ConversationRepository.readThrough")(function* (
		userId: string,
		conversationId: string,
		at: string,
	) {
		const through = sql`${at}::timestamptz`;
		const [moved] = yield* query((db) =>
			db
				.insert(conversationRead)
				.values({ userId, conversationId, readThrough: through })
				.onConflictDoUpdate({
					target: [conversationRead.userId, conversationRead.conversationId],
					set: { readThrough: through },
					setWhere: lt(conversationRead.readThrough, through),
				})
				.returning({
					readThrough: conversationRead.readThrough,
					readAt: conversationRead.updatedAt,
				}),
		);
		if (!moved) return;
		const reader = yield* query((db) =>
			db.query.user.findFirst({ where: { id: userId }, ...personColumns }),
		);
		if (!reader) return;
		yield* emit([
			ConversationEvent.ConversationRead({
				conversationId: conversationId,
				person: toPerson(reader),
				readThrough: moved.readThrough,
				readAt: moved.readAt,
			}),
		]);
	});

	/**
	 * Starts a project's thread, with the person who started it in it, and in a
	 * bot's default project the bot, whose thread it is.
	 */
	const insertThread = (input: NewThread) =>
		Effect.gen(function* () {
			const created = yield* insertConversation({
				workspaceId: input.workspaceId,
				kind: "project_thread",
				title: input.title,
			});
			yield* query((db) =>
				db.insert(projectThread).values({
					conversationId: created.id,
					workspaceId: input.workspaceId,
					projectId: input.projectId,
					startedById: input.startedById,
				}),
			);
			const placed = yield* placedById(created.id);
			const { botId } = placed;
			yield* query((db) =>
				db
					.insert(conversationParticipant)
					.values([
						{ conversationId: created.id, userId: input.startedById },
						...(botId ? [{ conversationId: created.id, botId }] : []),
					]),
			);
			return placed;
		});

	/** The feed of the automation `automationId`, if it has been opened. */
	const feedOf = (automationId: string) =>
		query((db) =>
			db
				.select({ conversationId: automationFeed.conversationId })
				.from(automationFeed)
				.where(eq(automationFeed.automationId, automationId))
				.limit(1),
		).pipe(Effect.map(([found]) => found?.conversationId));

	/** The conversation `systemBotKey` works in on `servedConversationId`, if it has been opened. */
	const systemConversationOf = (servedConversationId: string, systemBotKey: SystemBotKey) =>
		query((db) =>
			db
				.select({ conversationId: systemConversation.conversationId })
				.from(systemConversation)
				.where(
					and(
						eq(systemConversation.servedConversationId, servedConversationId),
						eq(systemConversation.systemBotKey, systemBotKey),
					),
				)
				.limit(1),
		).pipe(Effect.map(([found]) => found?.conversationId));

	/** The direct message named by `directKey` in the workspace, if it has been opened. */
	const directMessageOf = (workspaceId: string, directKey: string) =>
		query((db) =>
			db
				.select({ conversationId: directMessage.conversationId })
				.from(directMessage)
				.where(
					and(eq(directMessage.workspaceId, workspaceId), eq(directMessage.directKey, directKey)),
				)
				.limit(1),
		).pipe(Effect.map(([found]) => found?.conversationId));

	return Service.of({
		openDirectMessage: (placement) =>
			operation(
				"openDirectMessage",
				transaction(
					Effect.gen(function* () {
						const directKey = directKeyOf(placement.memberIds);
						const existing = yield* directMessageOf(placement.workspaceId, directKey);
						if (existing) return yield* placedById(existing);
						// Each person once, as the key names them.
						const memberIds = membersOfDirectKey(directKey);
						const created = yield* insertConversation({
							workspaceId: placement.workspaceId,
							kind: "direct_message",
							title: DIRECT_MESSAGE_TITLE,
						});
						const [opened] = yield* query((db) =>
							db
								.insert(directMessage)
								.values({
									conversationId: created.id,
									workspaceId: placement.workspaceId,
									directKey,
									startedById: placement.startedById,
								})
								.onConflictDoNothing({
									target: [directMessage.workspaceId, directMessage.directKey],
								})
								.returning({ conversationId: directMessage.conversationId }),
						);
						if (opened) {
							yield* query((db) =>
								db
									.insert(directMessageMember)
									.values(memberIds.map((userId) => ({ conversationId: created.id, userId }))),
							);
							return yield* placedById(created.id);
						}
						yield* discardConversation(created.id);
						const raced = yield* directMessageOf(placement.workspaceId, directKey);
						if (!raced) return yield* Effect.die(new Error("The direct message was not opened"));
						return yield* placedById(raced);
					}),
				),
			),

		startThread: (input) =>
			operation(
				"startThread",
				transaction(
					Effect.gen(function* () {
						const created = yield* insertThread(input);
						yield* emit([
							ConversationEvent.ThreadStarted({
								workspaceId: created.workspaceId,
								conversationId: created.id,
							}),
						]);
						return created;
					}),
				),
			),

		startBriefedThread: (input) =>
			operation(
				"startBriefedThread",
				transaction(
					Effect.gen(function* () {
						// One bot per thread: the briefing bot writes the first message without joining.
						const created = yield* insertThread(input);
						const hostBotId = created.botId;
						if (!hostBotId) {
							return yield* Effect.die(
								new Error(`Project ${input.projectId} is not a bot's default project`),
							);
						}
						const brief = yield* query((db) =>
							db
								.insert(message)
								.values({
									conversationId: created.id,
									authorBotId: input.briefingBotId,
									kind: "text",
									status: "complete",
									parts: [{ type: "text", text: input.brief }],
									content: input.brief,
								})
								.returning(),
						).pipe(Effect.flatMap(writtenRow("message")));
						yield* emit([
							ConversationEvent.BriefedThreadStarted({
								workspaceId: created.workspaceId,
								conversationId: created.id,
								hostBotId,
								briefMessageId: brief.id,
							}),
						]);
						return created;
					}),
				),
			),

		setDone: (marked, done) =>
			operation(
				"setDone",
				transaction(
					Effect.gen(function* () {
						const changed = yield* query((db) =>
							db
								.update(projectThread)
								.set({ doneAt: done ? sql`now()` : null })
								.where(
									and(
										eq(projectThread.conversationId, marked.id),
										done ? isNull(projectThread.doneAt) : sql`${projectThread.doneAt} is not null`,
									),
								)
								.returning({ id: projectThread.conversationId }),
						);
						if (changed.length === 0) return;
						yield* emit([
							ConversationEvent.ConversationDoneChanged({
								workspaceId: marked.workspaceId,
								conversationId: marked.id,
							}),
						]);
					}),
				),
			),

		changeChat: (chat, change) =>
			operation(
				"changeChat",
				transaction(
					Effect.gen(function* () {
						const listed = and(
							eq(projectThread.conversationId, chat.id),
							isNull(projectThread.archivedAt),
						);
						const changed =
							"title" in change
								? yield* query((db) =>
										db
											.update(conversation)
											.set({ title: change.title })
											.where(
												and(
													eq(conversation.id, chat.id),
													sql`exists (${db.select({ one: sql`1` }).from(projectThread).where(listed)})`,
												),
											)
											.returning({ id: conversation.id }),
									)
								: yield* query((db) =>
										db
											.update(projectThread)
											.set({ archivedAt: sql`now()` })
											.where(listed)
											.returning({ id: projectThread.conversationId }),
									);
						if (changed.length === 0) return;
						yield* emit([
							ConversationEvent.ProjectThreadChanged({
								workspaceId: chat.workspaceId,
								conversationId: chat.id,
							}),
						]);
					}),
				),
			),

		post: (input) =>
			operation(
				"post",
				transaction(
					Effect.gen(function* () {
						// Two sends of one message wait here for each other, so the second
						// finds the first rather than failing on its primary key.
						yield* lockMessageId(input.id);
						const [existing] = yield* query((db) =>
							db.select().from(message).where(eq(message.id, input.id)).limit(1),
						);
						const author = personAuthor(input.author);
						if (existing) {
							const attached =
								(yield* query((db) => loadFileParts(db, [existing.id]))).get(existing.id) ?? [];
							if (
								existing.conversationId !== input.conversationId ||
								existing.authorUserId !== input.author.id ||
								existing.content !== input.content ||
								(existing.replyToMessageId ?? undefined) !== input.replyTo ||
								!sameIds(
									attached.map(({ id }) => id),
									input.attachments,
								)
							) {
								return yield* new MessageIdConflict();
							}
							const replyTo = yield* quotedIn(existing.conversationId, existing.replyToMessageId);
							return {
								_tag: "AlreadyPosted",
								message: withReplyTo(toMessage(existing, author, { files: attached }), replyTo),
							} as const;
						}
						const replyTo = yield* quotedIn(input.conversationId, input.replyTo);
						if (input.replyTo && !replyTo) return yield* new ReplyTargetNotFound();
						const created = yield* query((db) =>
							db
								.insert(message)
								.values({
									id: input.id,
									conversationId: input.conversationId,
									authorUserId: input.author.id,
									kind: "text",
									status: "complete",
									parts: input.content === "" ? [] : [{ type: "text", text: input.content }],
									content: input.content,
									replyToMessageId: input.replyTo,
								})
								.returning(),
						).pipe(Effect.flatMap(writtenRow("message")));
						const now = yield* DateTime.nowAsDate;
						const placed = yield* query((db) =>
							db
								.update(conversation)
								.set({ updatedAt: now })
								.where(eq(conversation.id, input.conversationId))
								.returning({ workspaceId: conversation.workspaceId }),
						).pipe(Effect.flatMap(writtenRow("conversation")));
						yield* query((db) =>
							db
								.insert(conversationParticipant)
								.values({ conversationId: input.conversationId, userId: input.author.id })
								.onConflictDoNothing(),
						);
						const attached =
							input.attachments.length === 0
								? []
								: (yield* files.attach({
										conversationId: input.conversationId,
										messageId: created.id,
										uploaderId: input.author.id,
										fileIds: input.attachments,
									})).map(toFilePart);
						const posted = withReplyTo(toMessage(created, author, { files: attached }), replyTo);
						yield* emit([
							ConversationEvent.MessagePosted({
								conversationId: input.conversationId,
								workspaceId: placed.workspaceId,
								message: posted,
							}),
						]);
						return { _tag: "Posted", message: posted } as const;
					}),
				),
			),

		addBots: (conversationId, botIds) =>
			operation(
				"addBots",
				transaction(
					Effect.gen(function* () {
						if (botIds.length === 0) return;
						const inserted = yield* query((db) =>
							db
								.insert(conversationParticipant)
								.values(botIds.map((botId) => ({ conversationId, botId })))
								.onConflictDoNothing()
								.returning({ botId: conversationParticipant.botId }),
						);
						const joined = new Set(inserted.map((row) => row.botId));
						if (joined.size === 0) return;
						yield* emit([
							ConversationEvent.BotsJoined({
								conversationId: conversationId,
								botIds: botIds.filter((botId) => joined.has(botId)),
							}),
						]);
					}),
				),
			),

		openCollaboration: (input) =>
			operation(
				"openCollaboration",
				transaction(
					Effect.gen(function* () {
						const opened = yield* insertConversation({
							workspaceId: input.parent.workspaceId,
							kind: "collaboration",
							title: input.title,
						});
						yield* query((db) =>
							db.insert(conversationParticipant).values([
								{ conversationId: opened.id, botId: input.askingBotId },
								{ conversationId: opened.id, botId: input.collaboratorId },
							]),
						);
						const brief = yield* query((db) =>
							db
								.insert(message)
								.values({
									conversationId: opened.id,
									authorBotId: input.askingBotId,
									kind: "text",
									status: "complete",
									parts: [{ type: "text", text: input.brief }],
									content: input.brief,
								})
								.returning(),
						).pipe(Effect.flatMap(writtenRow("message")));
						return { conversationId: opened.id, briefMessageId: brief.id };
					}),
				),
			),

		openRun: (input) =>
			operation(
				"openRun",
				transaction(
					Effect.gen(function* () {
						const created = yield* insertConversation({
							workspaceId: input.workspaceId,
							kind: "run",
							title: input.title,
						});
						yield* query((db) =>
							db
								.insert(conversationParticipant)
								.values({ conversationId: created.id, botId: input.botId }),
						);
						return created;
					}),
				),
			),

		postAutomationTrigger: (input) =>
			operation(
				"postAutomationTrigger",
				query((db) =>
					db
						.insert(message)
						.values({
							conversationId: input.conversationId,
							automationTrigger: input.trigger,
							kind: "text",
							status: "complete",
							parts: [{ type: "text", text: input.content }],
							content: input.content,
						})
						.returning(),
				).pipe(Effect.flatMap(writtenRow("message"))),
			),

		openAutomationFeed: (owned, leadBotId) =>
			operation(
				"openAutomationFeed",
				transaction(
					Effect.gen(function* () {
						const existing = yield* feedOf(owned.id);
						if (existing) return yield* placedById(existing);
						const created = yield* insertConversation({
							workspaceId: owned.workspaceId,
							kind: "automation_feed",
							title: owned.name,
						});
						const [opened] = yield* query((db) =>
							db
								.insert(automationFeed)
								.values({
									conversationId: created.id,
									workspaceId: owned.workspaceId,
									automationId: owned.id,
								})
								.onConflictDoNothing({ target: automationFeed.automationId })
								.returning({ conversationId: automationFeed.conversationId }),
						);
						if (opened) {
							if (leadBotId !== null) {
								yield* query((db) =>
									db
										.insert(conversationParticipant)
										.values({ conversationId: created.id, botId: leadBotId }),
								);
							}
							return yield* placedById(created.id);
						}
						yield* discardConversation(created.id);
						const raced = yield* feedOf(owned.id);
						if (!raced) return yield* Effect.die(new Error("The automation's feed was not opened"));
						return yield* placedById(raced);
					}),
				),
			),

		postRunResult: ({ run, result }) =>
			operation(
				"postRunResult",
				transaction(
					Effect.gen(function* () {
						const feed = yield* feedOf(run.automationId);
						if (!feed) {
							return yield* Effect.die(new Error("An automation run's automation has no feed"));
						}
						return yield* postFromRunBot({ conversationId: feed, run, result });
					}),
				),
			),

		openSystemConversation: (input) =>
			operation(
				"openSystemConversation",
				transaction(
					Effect.gen(function* () {
						const existing = yield* systemConversationOf(input.served.id, input.systemBotKey);
						if (existing) return existing;
						const created = yield* insertConversation({
							workspaceId: input.served.workspaceId,
							kind: "system",
							title: input.title,
						});
						const [opened] = yield* query((db) =>
							db
								.insert(systemConversation)
								.values({
									conversationId: created.id,
									workspaceId: input.served.workspaceId,
									botId: input.systemBotId,
									systemBotKey: input.systemBotKey,
									servedConversationId: input.served.id,
								})
								.onConflictDoNothing({
									target: [
										systemConversation.servedConversationId,
										systemConversation.systemBotKey,
									],
								})
								.returning({ conversationId: systemConversation.conversationId }),
						);
						if (opened) return opened.conversationId;
						yield* discardConversation(created.id);
						const raced = yield* systemConversationOf(input.served.id, input.systemBotKey);
						if (!raced) {
							return yield* Effect.die(
								new Error("Opening a system bot's conversation returned none"),
							);
						}
						return raced;
					}),
				),
			),

		retitle: (conversationId, title) =>
			operation(
				"retitle",
				Effect.flatMap(DateTime.nowAsDate, (now) =>
					query((db) =>
						db
							.update(conversation)
							.set({ title, updatedAt: now })
							.where(eq(conversation.id, conversationId))
							.returning({ id: conversation.id }),
					),
				).pipe(Effect.map((retitled) => retitled.length > 0)),
			),

		retitleSystemConversation: (input) =>
			operation(
				"retitleSystemConversation",
				Effect.gen(function* () {
					const working = yield* systemConversationOf(
						input.servedConversationId,
						input.systemBotKey,
					);
					if (!working) return;
					const now = yield* DateTime.nowAsDate;
					yield* query((db) =>
						db
							.update(conversation)
							.set({ title: input.title, updatedAt: now })
							.where(eq(conversation.id, working)),
					);
				}),
			),

		markRead: (userId, conversationId) =>
			operation(
				"markRead",
				transaction(
					Effect.gen(function* () {
						// The newest item's own time rather than this server's clock, so
						// one stamped later is never counted as read. As text, which
						// keeps the microseconds a `Date` would drop.
						const [newest] = yield* query((db) => {
							const streaming = alias(message, "streaming_message");
							const oldestStreaming = db
								// Through `sql`, because `min` of a timestamp column is cast to text for reading.
								.select({ at: sql`min(${streaming.createdAt})` })
								.from(streaming)
								.where(
									and(
										eq(streaming.conversationId, conversationId),
										eq(streaming.status, "streaming"),
									),
								);
							// An automation's feed lists its runs among its messages, so reading it reads
							// them too: through when the newest ended, or began while it still runs.
							const newestRun = db
								.select({
									at: sql`max(coalesce(${automationRun.finishedAt}, ${automationRun.acceptedAt}))`,
								})
								.from(automationRun)
								.innerJoin(
									automationFeed,
									eq(automationFeed.automationId, automationRun.automationId),
								)
								.where(eq(automationFeed.conversationId, conversationId));
							// A collaboration starts while its asking reply is written, so after the
							// time that reply is stamped with; reading the conversation reads it too,
							// once that reply is done.
							const newestCollaboration = db
								.select({ at: sql`max(${collaboration.createdAt})` })
								.from(collaboration)
								.where(
									and(
										eq(collaboration.rootConversationId, conversationId),
										sql`${collaboration.createdAt} < coalesce((${oldestStreaming}), 'infinity')`,
									),
								);
							return db
								.select({
									at: sql<
										string | null
									>`greatest(max(${message.createdAt}), (${newestRun}), (${newestCollaboration}))::text`,
								})
								.from(message)
								.where(
									and(
										eq(message.conversationId, conversationId),
										ne(message.status, "streaming"),
										sql`${message.createdAt} < coalesce((${oldestStreaming}), 'infinity')`,
									),
								);
						});
						if (!newest?.at) return;
						yield* readThrough(userId, conversationId, newest.at);
					}),
				),
			),

		markItemRead: (userId, itemConversationId) =>
			operation(
				"markItemRead",
				transaction(
					Effect.gen(function* () {
						// As text, which keeps the microseconds a `Date` would drop.
						const [item] = yield* query((db) => {
							// Through when a run ended, so one opened while it ran is news again once it ends.
							const runEnd = db
								.select({
									at: sql`coalesce(${automationRun.finishedAt}, ${automationRun.acceptedAt})`,
								})
								.from(automationRun)
								.where(eq(automationRun.conversationId, itemConversationId));
							const collaborationStart = db
								.select({ at: sql`${collaboration.createdAt}` })
								.from(collaboration)
								.where(eq(collaboration.conversationId, itemConversationId));
							return db
								.select({
									at: sql<string | null>`coalesce((${runEnd}), (${collaborationStart}))::text`,
								})
								.from(conversation)
								.where(eq(conversation.id, itemConversationId))
								.limit(1);
						});
						if (!item?.at) return;
						yield* readThrough(userId, itemConversationId, item.at);
					}),
				),
			),

		addReaction: (reaction) =>
			operation(
				"addReaction",
				transaction(
					Effect.gen(function* () {
						// Locked, so two people adding new emoji at once cannot both pass the limit.
						const [target] = yield* query((db) =>
							db
								.select({ status: message.status })
								.from(message)
								.where(
									and(
										eq(message.id, reaction.messageId),
										eq(message.conversationId, reaction.conversationId),
									),
								)
								.for("update"),
						);
						if (target?.status !== "complete") return yield* new MessageNotFinished();
						const used = yield* query((db) =>
							db
								.selectDistinct({ emoji: messageReaction.emoji })
								.from(messageReaction)
								.where(eq(messageReaction.messageId, reaction.messageId)),
						);
						const isNewEmoji = !used.some((row) => row.emoji === reaction.emoji);
						if (isNewEmoji && used.length >= MAX_REACTION_EMOJI_PER_MESSAGE) {
							return yield* new TooManyReactionEmoji();
						}
						const added = yield* query((db) =>
							db
								.insert(messageReaction)
								.values({
									messageId: reaction.messageId,
									userId: reaction.userId,
									emoji: reaction.emoji,
								})
								.onConflictDoNothing()
								.returning({ id: messageReaction.id }),
						);
						return yield* reactionsAfter(reaction, added.length > 0);
					}),
				),
			),

		removeReaction: (reaction) =>
			operation(
				"removeReaction",
				transaction(
					Effect.gen(function* () {
						const removed = yield* query((db) =>
							db
								.delete(messageReaction)
								.where(
									and(
										eq(messageReaction.messageId, reaction.messageId),
										eq(messageReaction.userId, reaction.userId),
										eq(messageReaction.emoji, reaction.emoji),
									),
								)
								.returning({ id: messageReaction.id }),
						);
						return yield* reactionsAfter(reaction, removed.length > 0);
					}),
				),
			),
	});
});

/** Posting a message ends its files' wait to be sent, so this provides `ConversationFiles`. */
export const layer = Layer.effect(Service, make).pipe(Layer.provide(ConversationFiles.layer));

/** A message posted now, and announced. */
export interface Posted {
	readonly _tag: "Posted";
	readonly message: Message;
}

/** A message posted before with the same id, content and files, returned as it was. */
export interface AlreadyPosted {
	readonly _tag: "AlreadyPosted";
	readonly message: Message;
}

/**
 * Holds the message id `messageId` until the transaction ends, so two sends
 * of one message, which may start what it is posted in, run one at a time.
 */
export const lockMessageId = (messageId: string) =>
	query((db) =>
		db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`message:${messageId}`}, 0))`),
	);

/** The message `messageId` in `conversationId`, as a reply quotes it, or nothing when it is not there. */
const quotedIn = (conversationId: string, messageId: string | null | undefined) =>
	messageId
		? query((db) =>
				db.query.message.findFirst({
					where: { id: messageId, conversationId },
					...quotedMessageColumns,
				}),
			).pipe(Effect.map((quoted) => (quoted ? toReplyTo(quoted) : undefined)))
		: Effect.succeed(undefined);

export class MessageNotFinished
	extends Data.TaggedError("MessageNotFinished")
	implements UserFacing
{
	override get message() {
		return "A reaction was added to a message that is not finished";
	}
	get userMessage() {
		return userText`You can react once the message is finished`;
	}
}

export class TooManyReactionEmoji
	extends Data.TaggedError("TooManyReactionEmoji")
	implements UserFacing
{
	override get message() {
		return "A message already has as many different reaction emoji as it can";
	}
	get userMessage() {
		return userText`This message has as many different reactions as it can take. React with one already on it`;
	}
}

export class ReplyTargetNotFound
	extends Data.TaggedError("ReplyTargetNotFound")
	implements UserFacing
{
	override get message() {
		return "A reply quoted a message that is not in its conversation";
	}
	get userMessage() {
		return userText`The message you replied to isn't in this conversation`;
	}
}

/** Whether two lists hold the same ids, in any order. */
function sameIds(left: readonly string[], right: readonly string[]): boolean {
	const wanted = new Set(right);
	return left.length === wanted.size && left.every((id) => wanted.has(id));
}

export class MessageIdConflict extends Data.TaggedError("MessageIdConflict") implements UserFacing {
	override get message() {
		return "A message id was reused for a different message";
	}
	get userMessage() {
		return userText`That message ID is already used by a different message`;
	}
}
