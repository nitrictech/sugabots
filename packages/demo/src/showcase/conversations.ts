import { randomUUID } from "node:crypto";
import type { ConnectionTool, JsonValue, WrittenFileKind } from "@sugabots/contracts";
import { CONNECTION_TOOL_SEPARATOR, FIRST_CHAT_NAME } from "@sugabots/contracts";
import { reachesConversationFor } from "@sugabots/core/authorization/access";
import { taskTitleFrom } from "@sugabots/core/conversations/chats/task-title";
import { seedConversation } from "@sugabots/core/conversations/seed.test-support";
import { FILE_WRITE_TOOL } from "@sugabots/core/conversations/tools/files/tool";
import { query } from "@sugabots/core/database/database";
import {
	automation,
	automationFeed,
	automationRun,
	bot,
	channelBot,
	channelConversation,
	connection,
	conversation,
	conversationParticipant,
	conversationRead,
	file,
	fileVersion,
	message,
	messageReaction,
	type PlacedConversationRow,
	placedConversation,
	type StoredMessagePart,
	task,
	toolCall,
	turn,
	workspaceMember,
} from "@sugabots/core/database/schema";
import { Files } from "@sugabots/core/files/files";
import type { ToolAccess } from "@sugabots/core/providers/sql";
import type { UserText } from "@sugabots/errors";
import { and, eq, getColumns, isNull, max, sql } from "drizzle-orm";
import { Effect } from "effect";

/**
 * The showcase's conversations, written straight into the tables the app reads
 * them from, so the screenshots need no model, no second login and no waiting.
 * Nothing is announced: the app shows them when it next loads.
 *
 * Each main chat and task gets only the scripted messages it does not have
 * yet, matched by their text, so a scene added later reaches a showcase seeded
 * before it. An automation that already has a run at a scheduled time keeps it.
 */

/** Who the conversations name, by the keys `seed.ts` gives them. */
interface Cast<Person extends string> {
	workspaceId: string;
	people: Record<Person, string>;
	/** By the seed's key for each channel. */
	channelIds: Record<string, string>;
	/** By name. */
	botIds: ReadonlyMap<string, string>;
	/** By bot name: the model each is on, which their turns record. */
	botModels: ReadonlyMap<string, string>;
}

/**
 * A time of day on the day the conversations happen, or on the weekday or
 * Monday before it.
 */
interface Clock {
	time: `${number}:${number}`;
	day?: "previous weekday" | "previous monday";
}

type Speaker<Person extends string> = { person: Person } | { bot: string };

type ScriptedPart<Person extends string> =
	| { text: string }
	| {
			collaboration: {
				with: string;
				title: string;
				brief: string;
				answer: string;
				answeredAt: Clock;
			};
	  }
	| {
			toolCall: {
				/** The bot's connection it went through; without one, a tool built into every bot. */
				connection?: string;
				tool: string;
				input: JsonValue;
				/** What the call returned, once it has run. */
				output?: JsonValue;
				/** A call that only reads, so it ran without anyone being asked. */
				readOnly?: boolean;
				/** Who allowed it, and when; without it (and not `readOnly`), the call is still waiting for someone to. */
				allowed?: { by: Person; at: Clock };
			};
	  }
	| { file: { kind: WrittenFileKind; title: string; content: string } };

interface ScriptedMessage<Person extends string> {
	/** How a later message quotes this one. */
	key?: string;
	at: Clock;
	from: Speaker<Person>;
	parts: readonly ScriptedPart<Person>[];
	replyTo?: string;
	reactions?: readonly { emoji: string; by: readonly Person[] }[];
}

/**
 * A task: somebody's conversation with one bot. The first message is theirs,
 * and names the task as the app would.
 */
export interface TaskScene<Person extends string> {
	bot: string;
	messages: readonly [
		ScriptedMessage<Person> & { from: { person: Person } },
		...ScriptedMessage<Person>[],
	];
}

/**
 * What was said in a channel's main chat: its people, and the channel's bots
 * answering when they are mentioned.
 */
export interface ChatScene<Person extends string> {
	channel: string;
	messages: readonly ScriptedMessage<Person>[];
}

/** One past run of a bot's automation, which posts its result in the automation's feed. */
export interface AutomationRun {
	bot: string;
	automation: string;
	scheduledAt: Clock;
	finishedAt: Clock;
	/** What the run posted; with `failed`, what it got as far as saying. */
	result: string;
	/** Why the run failed, as its people are told; without it, the run finished. */
	failed?: UserText;
}

/** A connection every bot in a channel has, with the tools its server lists and what they may do with each. */
export interface SeedConnection {
	channel: string;
	name: string;
	handle: string;
	url: string;
	tools: readonly ConnectionTool[];
	toolAccess: ToolAccess;
}

/**
 * The day the conversations happen: the latest weekday whose morning is over,
 * so none of them is in the future and the weekday automations ran on it.
 */
function conversationDay(now: Date): Date {
	const day = new Date(now);
	day.setHours(0, 0, 0, 0);
	if (now.getHours() < LATEST_SCRIPTED_HOUR) day.setDate(day.getDate() - 1);
	while (isWeekend(day)) day.setDate(day.getDate() - 1);
	return day;
}

/** Every scripted time is before noon. */
const LATEST_SCRIPTED_HOUR = 12;

function timeOn(day: Date, clock: Clock): Date {
	const [hours = 0, minutes = 0] = clock.time.split(":").map(Number);
	const at = new Date(day);
	if (clock.day) {
		const wanted = (date: Date) =>
			clock.day === "previous monday" ? date.getDay() === MONDAY : !isWeekend(date);
		do at.setDate(at.getDate() - 1);
		while (!wanted(at));
	}
	at.setHours(hours, minutes, 0, 0);
	return at;
}

const MONDAY = 1;

function isWeekend(date: Date): boolean {
	return date.getDay() === 0 || date.getDay() === 6;
}

export const ensureConnections = (input: {
	workspaceId: string;
	channelIds: Record<string, string>;
	createdById: string;
	connections: readonly SeedConnection[];
}) =>
	Effect.forEach(
		input.connections,
		// Each bot in the seed's channel has its own connection to it.
		(seed) =>
			query((db) =>
				db
					.insert(connection)
					.select(
						db
							.select({
								workspaceId: bot.workspaceId,
								botId: bot.id,
								name: sql<string>`${seed.name}`.as("name"),
								handle: sql<string>`${seed.handle}`.as("handle"),
								url: sql<string>`${seed.url}`.as("url"),
								authKind: sql<"oauth">`'oauth'`.as("auth_kind"),
								tools: sql<ConnectionTool[]>`${JSON.stringify(seed.tools)}::jsonb`.as("tools"),
								toolAccess: sql<ToolAccess>`${JSON.stringify(seed.toolAccess)}::jsonb`.as(
									"tool_access",
								),
								createdById: sql<string>`${input.createdById}::uuid`.as("created_by_id"),
							})
							.from(bot)
							.innerJoin(channelBot, eq(channelBot.botId, bot.id))
							.where(
								and(
									eq(bot.workspaceId, input.workspaceId),
									eq(channelBot.channelId, channelIdOf(input.channelIds, seed.channel)),
								),
							),
					)
					.onConflictDoNothing(),
			),
		{ discard: true },
	);

export const ensureConversations = <Person extends string>(
	cast: Cast<Person>,
	written: {
		chats: readonly ChatScene<Person>[];
		tasks: readonly TaskScene<Person>[];
		runs: readonly AutomationRun[];
	},
) =>
	Effect.gen(function* () {
		const day = conversationDay(new Date());
		let count = 0;
		for (const run of written.runs) {
			if (yield* writeAutomationRun(cast, day, run)) count += 1;
		}
		for (const chat of written.chats) {
			if (yield* writeChatScene(cast, day, chat)) count += 1;
		}
		for (const scene of written.tasks) {
			if (yield* writeTask(cast, day, scene)) count += 1;
		}
		yield* markEverythingRead(cast);
		return count;
	});

/**
 * The task `scene` tells, made if it is not there yet: one with its bot and
 * the title its first message gives it.
 */
const taskOf = <Person extends string>(cast: Cast<Person>, day: Date, scene: TaskScene<Person>) =>
	Effect.gen(function* () {
		const botId = idOf(cast.botIds, scene.bot);
		const [first] = scene.messages;
		const title = taskTitleFrom(textOf(first.parts));
		const [existing] = yield* query((db) =>
			db
				.select({ conversation: getColumns(placedConversation) })
				.from(task)
				.innerJoin(placedConversation, eq(placedConversation.id, task.conversationId))
				.where(and(eq(task.botId, botId), eq(placedConversation.title, title))),
		);
		if (existing) return existing.conversation;
		const startedById = cast.people[first.from.person];
		const at = timeOn(day, first.at);
		const { id } = yield* query((db) =>
			seedConversation(db, {
				workspaceId: cast.workspaceId,
				kind: "task",
				botId,
				startedById,
				title,
				createdAt: at,
			}),
		);
		yield* query((db) =>
			db.insert(conversationParticipant).values([
				{ conversationId: id, userId: startedById, createdAt: at },
				{ conversationId: id, botId, createdAt: at },
			]),
		);
		return yield* placedById(id);
	});

/** The channel's main chat, made if it is not there yet. */
const mainChatOf = (cast: Cast<string>, channelId: string) =>
	Effect.gen(function* () {
		const mainChatId = () =>
			query((db) =>
				db
					.select({ id: channelConversation.conversationId })
					.from(channelConversation)
					.where(
						and(eq(channelConversation.main, true), eq(channelConversation.channelId, channelId)),
					),
			).pipe(Effect.map(([found]) => found?.id));
		const existing = yield* mainChatId();
		if (existing) return yield* placedById(existing);
		const { id } = yield* query((db) =>
			seedConversation(db, {
				workspaceId: cast.workspaceId,
				kind: "channel_conversation",
				channelId,
				main: true,
				title: FIRST_CHAT_NAME,
			}),
		);
		return yield* placedById(id);
	});

/** An automation's feed, where each of its runs posts its result, made if it is not there yet. */
const automationFeedOf = (
	cast: Cast<string>,
	automationRow: { id: string; botId: string; name: string },
) =>
	Effect.gen(function* () {
		const [existing] = yield* query((db) =>
			db
				.select({ id: automationFeed.conversationId })
				.from(automationFeed)
				.where(eq(automationFeed.automationId, automationRow.id)),
		);
		if (existing) return yield* placedById(existing.id);
		const { id } = yield* query((db) =>
			seedConversation(db, {
				workspaceId: cast.workspaceId,
				kind: "automation_feed",
				automationId: automationRow.id,
				title: automationRow.name,
			}),
		);
		yield* query((db) =>
			db.insert(conversationParticipant).values({ conversationId: id, botId: automationRow.botId }),
		);
		return yield* placedById(id);
	});

/** Writes into the task the scene's messages it does not have yet. */
const writeTask = <Person extends string>(
	cast: Cast<Person>,
	day: Date,
	scene: TaskScene<Person>,
) =>
	Effect.gen(function* () {
		const task = yield* taskOf(cast, day, scene);
		const wrote = yield* writeMessages(cast, day, {
			inConversation: task,
			messages: scene.messages,
		});
		if (wrote) yield* touch(task.id);
		return wrote;
	});

/** Writes into its channel's main chat the scene's messages it does not have yet. */
const writeChatScene = <Person extends string>(
	cast: Cast<Person>,
	day: Date,
	scene: ChatScene<Person>,
) =>
	Effect.gen(function* () {
		const mainChat = yield* mainChatOf(cast, channelIdOf(cast.channelIds, scene.channel));
		const wrote = yield* writeMessages(cast, day, {
			inConversation: mainChat,
			messages: scene.messages,
		});
		if (wrote) yield* touch(mainChat.id);
		return wrote;
	});

/**
 * Writes the scripted messages into the conversation, each bot reply answering the
 * person's message before it, leaving out those it already has: a person's or a
 * bot's with the same words. Says whether it wrote any.
 */
const writeMessages = <Person extends string>(
	cast: Cast<Person>,
	day: Date,
	input: {
		inConversation: PlacedConversationRow;
		messages: readonly ScriptedMessage<Person>[];
	},
) =>
	Effect.gen(function* () {
		const conversationId = input.inConversation.id;
		const said = yield* query((db) =>
			db
				.select({
					id: message.id,
					content: message.content,
					authorUserId: message.authorUserId,
				})
				.from(message)
				.where(eq(message.conversationId, conversationId)),
		);
		const saidAlready = new Map(
			said.map((row) => [`${row.authorUserId ? "person" : "bot"}:${row.content}`, row.id]),
		);
		const keyed = new Map<string, string>();
		let lastPersonMessage: string | undefined;
		let wrote = false;
		for (const scripted of input.messages) {
			const byPerson = "person" in scripted.from;
			const already = saidAlready.get(`${byPerson ? "person" : "bot"}:${textOf(scripted.parts)}`);
			if (already) {
				if (scripted.key) keyed.set(scripted.key, already);
				if (byPerson) lastPersonMessage = already;
				continue;
			}
			wrote = true;
			const at = timeOn(day, scripted.at);
			const replyToMessageId = scripted.replyTo ? keyed.get(scripted.replyTo) : undefined;
			const messageId =
				"person" in scripted.from
					? yield* writePersonMessage({
							conversationId,
							userId: cast.people[scripted.from.person],
							text: textOf(scripted.parts),
							at,
							replyToMessageId,
						})
					: yield* writeBotReply(cast, day, {
							conversationId,
							rootConversationId: input.inConversation.rootConversationId ?? conversationId,
							bot: scripted.from.bot,
							triggerMessageId: lastPersonMessage,
							parts: scripted.parts,
							at,
							replyToMessageId,
						});
			if ("person" in scripted.from) lastPersonMessage = messageId;
			if (scripted.key) keyed.set(scripted.key, messageId);
			yield* writeReactions(cast, messageId, at, scripted.reactions);
		}
		return wrote;
	});

const writeReactions = <Person extends string>(
	cast: Cast<Person>,
	messageId: string,
	at: Date,
	reactions: ScriptedMessage<Person>["reactions"],
) =>
	Effect.forEach(
		reactions ?? [],
		(reaction) =>
			query((db) =>
				db.insert(messageReaction).values(
					reaction.by.map((person) => ({
						messageId,
						userId: cast.people[person],
						emoji: reaction.emoji,
						createdAt: new Date(at.getTime() + REACTION_DELAY_MILLISECONDS),
					})),
				),
			),
		{ discard: true },
	);

const REACTION_DELAY_MILLISECONDS = 60_000;
/** How long a scripted bot takes to reply, from its turn starting to its message being done. */
const REPLY_MILLISECONDS = 20_000;
/** How much longer a scripted reply takes for each tool call it makes, and how far apart they start. */
const CALL_MILLISECONDS = 6_000;

const writePersonMessage = (input: {
	conversationId: string;
	userId: string;
	text: string;
	at: Date;
	replyToMessageId: string | undefined;
}) =>
	Effect.gen(function* () {
		yield* query((db) =>
			db
				.insert(conversationParticipant)
				.values({ conversationId: input.conversationId, userId: input.userId, createdAt: input.at })
				.onConflictDoNothing(),
		);
		const id = randomUUID();
		yield* query((db) =>
			db.insert(message).values({
				id,
				conversationId: input.conversationId,
				authorUserId: input.userId,
				kind: "text",
				status: "complete",
				parts: [{ type: "text", text: input.text }],
				content: input.text,
				replyToMessageId: input.replyToMessageId ?? null,
				createdAt: input.at,
			}),
		);
		return id;
	});

/**
 * A bot's reply as its turn left it: the turn, the message, and the
 * collaborations and tool calls placed in it.
 */
const writeBotReply = <Person extends string>(
	cast: Cast<Person>,
	day: Date,
	input: {
		conversationId: string;
		rootConversationId: string;
		bot: string;
		triggerMessageId: string | undefined;
		parts: readonly ScriptedPart<Person>[];
		at: Date;
		replyToMessageId?: string | undefined;
	},
) =>
	Effect.gen(function* () {
		if (!input.triggerMessageId) {
			return yield* Effect.die(new Error(`${input.bot} replies before anyone has written`));
		}
		const botId = idOf(cast.botIds, input.bot);
		const { stored, content, placed } = placeParts(input.parts);
		// A call still waiting for approval leaves its turn waiting and its reply unfinished.
		const waiting = placed.some(
			({ part }) => "toolCall" in part && !part.toolCall.allowed && !part.toolCall.readOnly,
		);
		const calls = placed.filter(({ part }) => "toolCall" in part).length;
		const workMilliseconds = REPLY_MILLISECONDS + calls * CALL_MILLISECONDS;
		// The reply is written from its turn's start, as a real one is, so it shows how long the bot worked.
		const startedAt = new Date(input.at.getTime() - workMilliseconds);
		const turnId = yield* writeTurn(cast, {
			conversationId: input.conversationId,
			bot: input.bot,
			triggerMessageId: input.triggerMessageId,
			at: input.at,
			waiting,
			workMilliseconds,
		});
		const messageId = randomUUID();
		yield* query((db) =>
			db.insert(message).values({
				id: messageId,
				conversationId: input.conversationId,
				authorBotId: botId,
				kind: "text",
				status: waiting ? "streaming" : "complete",
				parts: stored,
				content,
				turnId,
				replyToMessageId: input.replyToMessageId ?? null,
				createdAt: startedAt,
			}),
		);
		let callsStarted = 0;
		for (const { id, atOffset, part } of placed) {
			if ("collaboration" in part) {
				yield* writeCollaboration(cast, day, {
					id,
					parentConversationId: input.conversationId,
					parentMessageId: messageId,
					rootConversationId: input.rootConversationId,
					askingBot: input.bot,
					turnId,
					atOffset,
					asked: input.at,
					...part.collaboration,
				});
			} else if ("file" in part) {
				yield* writeFile(cast, {
					id,
					conversationId: input.conversationId,
					messageId,
					turnId,
					bot: input.bot,
					atOffset,
					writtenAt: input.at,
					...part.file,
				});
			} else {
				yield* writeToolCall(cast, day, {
					id,
					conversationId: input.conversationId,
					messageId,
					turnId,
					botId,
					atOffset,
					startedAt: new Date(startedAt.getTime() + ++callsStarted * CALL_MILLISECONDS),
					...part.toolCall,
				});
			}
		}
		return messageId;
	});

/**
 * A turn of `bot`'s, started by `triggerMessageId`: finished at `at`, or
 * waiting since then for a call to be approved. A waiting turn names an
 * owner, as a real one does, though no workflow runs it: `stage.ts`
 * plays what happens once the call is allowed.
 */
const writeTurn = (
	cast: Cast<string>,
	input: {
		conversationId: string;
		bot: string;
		triggerMessageId: string;
		at: Date;
		waiting?: boolean;
		/** How long before `at` the turn started. */
		workMilliseconds?: number;
	},
) =>
	Effect.gen(function* () {
		const id = randomUUID();
		const startedAt = new Date(input.at.getTime() - (input.workMilliseconds ?? REPLY_MILLISECONDS));
		yield* query((db) =>
			db.insert(turn).values({
				id,
				conversationId: input.conversationId,
				botId: idOf(cast.botIds, input.bot),
				triggerMessageId: input.triggerMessageId,
				status: input.waiting ? "waiting" : "done",
				owner: input.waiting ? STAGED_TURN_OWNER : null,
				model: cast.botModels.get(input.bot) ?? "",
				reason: "default",
				startedAt,
				finishedAt: input.waiting ? null : input.at,
				createdAt: startedAt,
			}),
		);
		return id;
	});

/** The owner a staged waiting turn names, in place of a workflow execution's. */
export const STAGED_TURN_OWNER = "showcase-stage";

/** The bots' own conversation under the reply: the brief, the collaborator's answer, and the row tying them to the reply. */
const writeCollaboration = (
	cast: Cast<string>,
	day: Date,
	input: {
		id: string;
		parentConversationId: string;
		parentMessageId: string;
		rootConversationId: string;
		askingBot: string;
		turnId: string;
		atOffset: number;
		asked: Date;
		with: string;
		title: string;
		brief: string;
		answer: string;
		answeredAt: Clock;
	},
) =>
	Effect.gen(function* () {
		const askingId = idOf(cast.botIds, input.askingBot);
		const collaboratorId = idOf(cast.botIds, input.with);
		const answeredAt = timeOn(day, input.answeredAt);
		const child = yield* query((db) =>
			seedConversation(db, {
				workspaceId: cast.workspaceId,
				kind: "collaboration",
				title: input.title,
				createdAt: input.asked,
				updatedAt: answeredAt,
				collaboration: {
					id: input.id,
					parentConversationId: input.parentConversationId,
					rootConversationId: input.rootConversationId,
					parentMessageId: input.parentMessageId,
					turnId: input.turnId,
					collaboratorBotId: collaboratorId,
					brief: input.brief,
					status: "answered",
					answer: input.answer,
					atOffset: input.atOffset,
					createdAt: input.asked,
					updatedAt: answeredAt,
				},
			}),
		);
		yield* query((db) =>
			db.insert(conversationParticipant).values([
				{ conversationId: child.id, botId: askingId },
				{ conversationId: child.id, botId: collaboratorId },
			]),
		);
		const briefId = randomUUID();
		yield* query((db) =>
			db.insert(message).values({
				id: briefId,
				conversationId: child.id,
				authorBotId: askingId,
				kind: "text",
				status: "complete",
				parts: [{ type: "text", text: input.brief }],
				content: input.brief,
				createdAt: input.asked,
			}),
		);
		const answerTurn = yield* writeTurn(cast, {
			conversationId: child.id,
			bot: input.with,
			triggerMessageId: briefId,
			at: answeredAt,
		});
		yield* query((db) =>
			db.insert(message).values({
				conversationId: child.id,
				authorBotId: collaboratorId,
				kind: "text",
				status: "complete",
				parts: [{ type: "text", text: input.answer }],
				content: input.answer,
				turnId: answerTurn,
				createdAt: answeredAt,
			}),
		);
	});

/** How long a scripted call that only reads takes to run. */
const READ_CALL_MILLISECONDS = 1_400;

/**
 * A tool call in a bot's reply: one that only read and ran straight away, or a
 * connection's call that waited for a person, who allowed it, and then ran.
 * Without a connection it is a tool built into every bot.
 */
const writeToolCall = (
	cast: Cast<string>,
	day: Date,
	input: {
		id: string;
		conversationId: string;
		messageId: string;
		turnId: string;
		botId: string;
		atOffset: number;
		startedAt: Date;
		connection?: string;
		tool: string;
		input: JsonValue;
		/** What the call returned, once it has run. */
		output?: JsonValue;
		readOnly?: boolean;
		allowed?: { by: string; at: Clock };
	},
) =>
	Effect.gen(function* () {
		const handle = input.connection;
		const [used] =
			handle === undefined
				? [undefined]
				: yield* query((db) =>
						db
							.select({ id: connection.id, revision: connection.configurationRevision })
							.from(connection)
							.where(and(eq(connection.botId, input.botId), eq(connection.handle, handle))),
					);
		if (handle !== undefined && !used)
			return yield* Effect.die(new Error(`No ${handle} connection`));
		const allowedAt = input.allowed ? timeOn(day, input.allowed.at) : undefined;
		const ranAt = new Date(input.startedAt.getTime() + READ_CALL_MILLISECONDS);
		const decided = input.readOnly
			? {
					output: input.output ?? null,
					status: "completed" as const,
					finishedAt: ranAt,
					updatedAt: ranAt,
				}
			: input.allowed && allowedAt
				? {
						approvalStatus: "allowed" as const,
						decidedById: (cast.people as Record<string, string>)[input.allowed.by] ?? null,
						decidedAt: allowedAt,
						output: input.output ?? null,
						status: "completed" as const,
						finishedAt: allowedAt,
						updatedAt: allowedAt,
					}
				: {
						approvalStatus: "pending" as const,
						status: "awaiting_approval" as const,
						updatedAt: input.startedAt,
					};
		yield* query((db) =>
			db.insert(toolCall).values({
				id: input.id,
				conversationId: input.conversationId,
				messageId: input.messageId,
				turnId: input.turnId,
				tool:
					handle === undefined ? input.tool : `${handle}${CONNECTION_TOOL_SEPARATOR}${input.tool}`,
				sdkToolCallId: randomUUID(),
				approvalId: input.readOnly ? null : randomUUID(),
				connectionId: used?.id ?? null,
				connectionRevision: used?.revision ?? null,
				remoteToolName: handle === undefined ? null : input.tool,
				executionInput: input.input,
				input: input.input,
				mutating: !input.readOnly,
				atOffset: input.atOffset,
				startedAt: input.startedAt,
				createdAt: input.startedAt,
				...decided,
			}),
		);
	});

/** How long a scripted bot takes to write a file. */
const FILE_WRITE_MILLISECONDS = 8_000;

/**
 * A file the bot wrote, made the way its file tool makes one, and the
 * `file_write` call that shows it under the reply.
 */
const writeFile = (
	cast: Cast<string>,
	input: {
		id: string;
		conversationId: string;
		messageId: string;
		turnId: string;
		bot: string;
		atOffset: number;
		writtenAt: Date;
		kind: WrittenFileKind;
		title: string;
		content: string;
	},
) =>
	Effect.gen(function* () {
		const authoring = yield* Files.Authoring;
		const { kind, title, content } = input;
		const written = yield* authoring
			.create(
				{
					workspaceId: cast.workspaceId,
					botId: idOf(cast.botIds, input.bot),
					conversationId: input.conversationId,
				},
				{ kind, title, content },
			)
			.pipe(Effect.orDie);
		yield* query((db) =>
			db
				.update(file)
				.set({ createdAt: input.writtenAt, updatedAt: input.writtenAt })
				.where(eq(file.id, written.id)),
		);
		yield* query((db) =>
			db
				.update(fileVersion)
				.set({ createdAt: input.writtenAt })
				.where(eq(fileVersion.fileId, written.id)),
		);
		yield* query((db) =>
			db.insert(toolCall).values({
				id: input.id,
				conversationId: input.conversationId,
				messageId: input.messageId,
				turnId: input.turnId,
				tool: FILE_WRITE_TOOL,
				sdkToolCallId: randomUUID(),
				input: { kind, title, content },
				output: {
					status: "written",
					fileId: written.id,
					kind,
					title,
					version: written.version,
				},
				status: "completed",
				mutating: true,
				atOffset: input.atOffset,
				startedAt: new Date(input.writtenAt.getTime() - FILE_WRITE_MILLISECONDS),
				finishedAt: input.writtenAt,
				createdAt: input.writtenAt,
				updatedAt: input.writtenAt,
			}),
		);
	});

/**
 * A finished or failed run, as the automation runner leaves one: its
 * conversation in the automation's own, what started it, the bot's reply
 * there, and that reply posted as the run's result in the automation's feed.
 * Skipped when the automation already has a run at that time.
 */
const writeAutomationRun = (cast: Cast<string>, day: Date, run: AutomationRun) =>
	Effect.gen(function* () {
		const botId = idOf(cast.botIds, run.bot);
		const [defined] = yield* query((db) =>
			db
				.select()
				.from(automation)
				.where(
					and(
						eq(automation.botId, botId),
						eq(automation.name, run.automation),
						isNull(automation.deletedAt),
					),
				),
		);
		if (!defined)
			return yield* Effect.die(new Error(`${run.bot} has no automation ${run.automation}`));
		const scheduledAt = timeOn(day, run.scheduledAt);
		const [ranAlready] = yield* query((db) =>
			db
				.select({ id: automationRun.id })
				.from(automationRun)
				.where(
					and(
						eq(automationRun.automationId, defined.id),
						eq(automationRun.triggerIdentity, scheduledAt.toISOString()),
					),
				),
		);
		if (ranAlready) return false;

		const feed = yield* automationFeedOf(cast, defined);
		const finishedAt = timeOn(day, run.finishedAt);
		const runId = randomUUID();
		const runConversation = yield* query((db) =>
			seedConversation(db, {
				workspaceId: cast.workspaceId,
				kind: "run",
				title: `${run.automation} - ${scheduledAt.toISOString()}`,
				createdAt: scheduledAt,
				updatedAt: finishedAt,
				run: {
					id: runId,
					automationId: defined.id,
					botId,
					triggerKind: "schedule",
					triggerIdentity: scheduledAt.toISOString(),
					trigger: {
						kind: "schedule",
						scheduledAt: scheduledAt.toISOString(),
						acceptedAt: scheduledAt.toISOString(),
					},
					automationName: defined.name,
					instructions: defined.instructions,
					state: run.failed ? "failed" : "completed",
					error: run.failed ?? null,
					acceptedAt: scheduledAt,
					startedAt: scheduledAt,
					finishedAt,
					createdAt: scheduledAt,
					updatedAt: finishedAt,
				},
			}),
		);
		yield* query((db) =>
			db.insert(conversationParticipant).values({ conversationId: runConversation.id, botId }),
		);
		const triggerId = randomUUID();
		yield* query((db) =>
			db.insert(message).values({
				id: triggerId,
				conversationId: runConversation.id,
				automationTrigger: {
					kind: "automation_trigger",
					runId,
					automationName: defined.name,
					triggerKind: "schedule",
				},
				kind: "text",
				status: "complete",
				parts: [{ type: "text", text: defined.instructions }],
				content: defined.instructions,
				createdAt: scheduledAt,
			}),
		);
		const turnId = yield* writeTurn(cast, {
			conversationId: runConversation.id,
			bot: run.bot,
			triggerMessageId: triggerId,
			at: finishedAt,
		});
		// A failed run's reply says why from its turn, as a real failed turn's does.
		const failed = run.failed;
		if (failed) {
			yield* query((db) =>
				db.update(turn).set({ status: "failed", error: failed }).where(eq(turn.id, turnId)),
			);
		}
		const posts = [
			{ conversationId: runConversation.id, runId: null, turnId },
			{ conversationId: feed.id, runId, turnId: null },
		];
		for (const post of posts) {
			yield* query((db) =>
				db.insert(message).values({
					...post,
					authorBotId: botId,
					kind: "text",
					status: run.failed ? "failed" : "complete",
					parts: [{ type: "text", text: run.result }],
					content: run.result,
					createdAt: finishedAt,
				}),
			);
		}
		yield* touch(feed.id);
		return true;
	});

/** Stamps the conversation with its latest message, so it sorts where that happened. */
const touch = (conversationId: string) =>
	Effect.gen(function* () {
		const [latest] = yield* query((db) =>
			db
				.select({ at: max(message.createdAt) })
				.from(message)
				.where(eq(message.conversationId, conversationId)),
		);
		if (!latest?.at) return;
		const at = latest.at;
		yield* query((db) =>
			db.update(conversation).set({ updatedAt: at }).where(eq(conversation.id, conversationId)),
		);
	});

/** Everyone has read every conversation they reach, so nothing seeded shows as unread. */
const markEverythingRead = (cast: Cast<string>) =>
	Effect.gen(function* () {
		const now = new Date();
		const rows = yield* query((db) =>
			db
				.select({ conversationId: placedConversation.id, userId: workspaceMember.userId })
				.from(placedConversation)
				.innerJoin(workspaceMember, eq(workspaceMember.workspaceId, placedConversation.workspaceId))
				.where(
					and(
						eq(placedConversation.workspaceId, cast.workspaceId),
						reachesConversationFor(placedConversation, workspaceMember.userId),
					),
				),
		);
		if (rows.length === 0) return;
		yield* query((db) =>
			db
				.insert(conversationRead)
				.values(rows.map((row) => ({ ...row, readThrough: now })))
				.onConflictDoUpdate({
					target: [conversationRead.userId, conversationRead.conversationId],
					set: { readThrough: now },
				}),
		);
	});

type PlacedPart<Person extends string> = Exclude<ScriptedPart<Person>, { text: string }>;

/**
 * A reply's parts as they are stored: its text, and an id for each
 * collaboration and tool call with how much text came before it. Its content
 * is the text parts run together, as the app requires.
 */
function placeParts<Person extends string>(parts: readonly ScriptedPart<Person>[]) {
	const stored: StoredMessagePart[] = [];
	const placed: { id: string; atOffset: number; part: PlacedPart<Person> }[] = [];
	let content = "";
	for (const part of parts) {
		if ("text" in part) {
			stored.push({ type: "text", text: part.text });
			content += part.text;
			continue;
		}
		const id = randomUUID();
		stored.push(
			"collaboration" in part
				? { type: "collaboration", collaborationId: id }
				: { type: "tool_call", toolCallId: id },
		);
		placed.push({ id, atOffset: content.length, part });
	}
	return { stored, content, placed };
}

function textOf(parts: readonly ScriptedPart<string>[]): string {
	return parts.flatMap((part) => ("text" in part ? [part.text] : [])).join("");
}

function idOf(ids: ReadonlyMap<string, string>, name: string): string {
	const id = ids.get(name);
	if (!id) throw new Error(`No bot is named ${name}`);
	return id;
}

function channelIdOf(channelIds: Record<string, string>, channel: string): string {
	const id = channelIds[channel];
	if (!id) throw new Error(`No channel is keyed ${channel}`);
	return id;
}

/** The conversation `id`, as the scenes read it back. */
const placedById = (id: string) =>
	Effect.flatMap(
		query((db) =>
			db.select().from(placedConversation).where(eq(placedConversation.id, id)).limit(1),
		),
		([found]) =>
			found ? Effect.succeed(found) : Effect.die(new Error(`Conversation ${id} is not there`)),
	);
