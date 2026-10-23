import { randomUUID } from "node:crypto";
import type { ArtifactKind, ConnectionTool, JsonValue } from "@sugabots/contracts";
import { CONNECTION_TOOL_SEPARATOR } from "@sugabots/contracts";
import { Artifacts } from "@sugabots/core/artifacts/artifacts";
import { ARTIFACT_WRITE_TOOL } from "@sugabots/core/conversations/tools/artifacts/tool";
import { query } from "@sugabots/core/database/database";
import {
	artifact,
	artifactVersion,
	chat,
	collaboration,
	connection,
	message,
	messageReaction,
	podMember,
	routine,
	routineExecution,
	type StoredMessagePart,
	thread,
	threadParticipant,
	threadRead,
	toolCall,
	turn,
} from "@sugabots/core/database/schema";
import type { ToolAccess } from "@sugabots/core/providers/sql";
import { and, eq, isNull, max } from "drizzle-orm";
import { Effect } from "effect";

/**
 * The showcase's conversations, written straight into the tables the app reads
 * them from, so the screenshots need no model, no second login and no waiting.
 * Nothing is announced: the app shows them when it next loads.
 *
 * Each chat is written once: one that already has messages is left alone, and
 * so is a routine that already has runs.
 */

/** Who the conversations name, by the keys `seed.ts` gives them. */
export interface Cast<Person extends string> {
	workspaceId: string;
	people: Record<Person, string>;
	podIds: Record<string, string>;
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
				connection: string;
				tool: string;
				input: JsonValue;
				/** What the call returned, once it has run. */
				output?: JsonValue;
				/** Who allowed it, and when; without it, the call is still waiting for someone to. */
				allowed?: { by: Person; at: Clock };
			};
	  }
	| { artifact: { kind: ArtifactKind; title: string; content: string } };

interface ScriptedMessage<Person extends string> {
	/** How a later message quotes this one. */
	key?: string;
	at: Clock;
	from: Speaker<Person>;
	parts: readonly ScriptedPart<Person>[];
	replyTo?: string;
	reactions?: readonly { emoji: string; by: readonly Person[] }[];
}

/** One chat: a pod's bot, and what was said to and by it. */
export interface Scene<Person extends string> {
	pod: string;
	bot: string;
	messages: readonly ScriptedMessage<Person>[];
}

/** One past run of a routine that posts its result to its bot's chat. */
export interface RoutineRun {
	pod: string;
	bot: string;
	routine: string;
	scheduledAt: Clock;
	finishedAt: Clock;
	result: string;
}

/** A connection a pod's bots use, with the tools its server lists and what they may do with each. */
export interface SeedConnection {
	pod: string;
	name: string;
	handle: string;
	url: string;
	tools: readonly ConnectionTool[];
	toolAccess: ToolAccess;
}

/**
 * The day the conversations happen: the latest weekday whose morning is over,
 * so none of them is in the future and the weekday routines ran on it.
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
	podIds: Record<string, string>;
	createdById: string;
	connections: readonly SeedConnection[];
}) =>
	Effect.forEach(
		input.connections,
		(seed) =>
			query((db) =>
				db
					.insert(connection)
					.values({
						workspaceId: input.workspaceId,
						podId: podIdOf(input.podIds, seed.pod),
						name: seed.name,
						handle: seed.handle,
						url: seed.url,
						authKind: "oauth",
						tools: [...seed.tools],
						toolAccess: seed.toolAccess,
						createdById: input.createdById,
					})
					.onConflictDoNothing(),
			),
		{ discard: true },
	);

export const ensureConversations = <Person extends string>(
	cast: Cast<Person>,
	scenes: readonly Scene<Person>[],
	runs: readonly RoutineRun[],
) =>
	Effect.gen(function* () {
		const day = conversationDay(new Date());
		let written = 0;
		for (const run of runs) {
			if (yield* writeRoutineRun(cast, day, run)) written += 1;
		}
		for (const scene of scenes) {
			if (yield* writeScene(cast, day, scene)) written += 1;
		}
		yield* markEverythingRead(cast);
		return written;
	});

/** The pod's chat with `bot`, made if it is not there yet, with its main thread. */
const chatWith = (cast: Cast<string>, pod: string, bot: string) =>
	Effect.gen(function* () {
		const podId = podIdOf(cast.podIds, pod);
		const agentId = idOf(cast.botIds, bot);
		const [existing] = yield* query((db) =>
			db
				.select()
				.from(chat)
				.where(and(eq(chat.podId, podId), eq(chat.hostAgentId, agentId))),
		);
		if (existing) return existing;
		const [main] = yield* query((db) =>
			db
				.insert(thread)
				.values({
					workspaceId: cast.workspaceId,
					podId,
					hostAgentId: agentId,
					type: "chat",
					title: "Chat",
				})
				.returning(),
		);
		if (!main) return yield* Effect.die(new Error(`Could not open ${bot}'s chat`));
		const [created] = yield* query((db) =>
			db
				.insert(chat)
				.values({
					workspaceId: cast.workspaceId,
					podId,
					hostAgentId: agentId,
					mainThreadId: main.id,
				})
				.returning(),
		);
		if (!created) return yield* Effect.die(new Error(`Could not open ${bot}'s chat`));
		yield* query((db) =>
			db.update(thread).set({ chatId: created.id }).where(eq(thread.id, main.id)),
		);
		yield* query((db) => db.insert(threadParticipant).values({ threadId: main.id, agentId }));
		return created;
	});

/** Writes the scene into its chat, unless the chat already has messages. */
const writeScene = <Person extends string>(cast: Cast<Person>, day: Date, scene: Scene<Person>) =>
	Effect.gen(function* () {
		const opened = yield* chatWith(cast, scene.pod, scene.bot);
		const [said] = yield* query((db) =>
			db
				.select({ id: message.id })
				.from(message)
				.where(and(eq(message.threadId, opened.mainThreadId), isNull(message.routineExecutionId)))
				.limit(1),
		);
		if (said) return false;

		const threadId = opened.mainThreadId;
		const keyed = new Map<string, string>();
		let lastPersonMessage: string | undefined;
		for (const scripted of scene.messages) {
			const at = timeOn(day, scripted.at);
			const replyToMessageId = scripted.replyTo ? keyed.get(scripted.replyTo) : undefined;
			const messageId =
				"person" in scripted.from
					? yield* writePersonMessage({
							threadId,
							userId: cast.people[scripted.from.person],
							text: textOf(scripted.parts),
							at,
							replyToMessageId,
						})
					: yield* writeBotReply(cast, day, {
							threadId,
							chatId: opened.id,
							podId: opened.podId,
							bot: scripted.from.bot,
							triggerMessageId: lastPersonMessage,
							parts: scripted.parts,
							at,
							replyToMessageId,
						});
			if ("person" in scripted.from) lastPersonMessage = messageId;
			if (scripted.key) keyed.set(scripted.key, messageId);
			for (const reaction of scripted.reactions ?? []) {
				yield* query((db) =>
					db.insert(messageReaction).values(
						reaction.by.map((person) => ({
							messageId,
							userId: cast.people[person],
							emoji: reaction.emoji,
							createdAt: new Date(at.getTime() + REACTION_DELAY_MILLISECONDS),
						})),
					),
				);
			}
		}
		yield* touch(threadId, opened.id);
		return true;
	});

const REACTION_DELAY_MILLISECONDS = 60_000;
/** How long a scripted bot takes to reply, from its turn starting to its message being done. */
const REPLY_MILLISECONDS = 20_000;

const writePersonMessage = (input: {
	threadId: string;
	userId: string;
	text: string;
	at: Date;
	replyToMessageId: string | undefined;
}) =>
	Effect.gen(function* () {
		yield* query((db) =>
			db
				.insert(threadParticipant)
				.values({ threadId: input.threadId, userId: input.userId, createdAt: input.at })
				.onConflictDoNothing(),
		);
		const id = randomUUID();
		yield* query((db) =>
			db.insert(message).values({
				id,
				threadId: input.threadId,
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
		threadId: string;
		chatId: string;
		podId: string;
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
		const agentId = idOf(cast.botIds, input.bot);
		const { stored, content, placed } = placeParts(input.parts);
		// A call still waiting for approval leaves its turn waiting and its reply unfinished.
		const waiting = placed.some(({ part }) => "toolCall" in part && !part.toolCall.allowed);
		const turnId = yield* writeTurn(cast, {
			threadId: input.threadId,
			bot: input.bot,
			triggerMessageId: input.triggerMessageId,
			at: input.at,
			waiting,
		});
		const messageId = randomUUID();
		yield* query((db) =>
			db.insert(message).values({
				id: messageId,
				threadId: input.threadId,
				authorAgentId: agentId,
				kind: "text",
				status: waiting ? "streaming" : "complete",
				parts: stored,
				content,
				turnId,
				replyToMessageId: input.replyToMessageId ?? null,
				createdAt: input.at,
			}),
		);
		for (const { id, atOffset, part } of placed) {
			if ("collaboration" in part) {
				yield* writeCollaboration(cast, day, {
					id,
					parentThreadId: input.threadId,
					parentMessageId: messageId,
					chatId: input.chatId,
					podId: input.podId,
					askingBot: input.bot,
					turnId,
					atOffset,
					asked: input.at,
					...part.collaboration,
				});
			} else if ("artifact" in part) {
				yield* writeArtifact(cast, {
					id,
					threadId: input.threadId,
					messageId,
					turnId,
					podId: input.podId,
					bot: input.bot,
					atOffset,
					writtenAt: input.at,
					...part.artifact,
				});
			} else {
				yield* writeToolCall(cast, day, {
					id,
					threadId: input.threadId,
					messageId,
					turnId,
					podId: input.podId,
					atOffset,
					startedAt: input.at,
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
	input: { threadId: string; bot: string; triggerMessageId: string; at: Date; waiting?: boolean },
) =>
	Effect.gen(function* () {
		const id = randomUUID();
		const startedAt = new Date(input.at.getTime() - REPLY_MILLISECONDS);
		yield* query((db) =>
			db.insert(turn).values({
				id,
				threadId: input.threadId,
				agentId: idOf(cast.botIds, input.bot),
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

/** The bots' own thread under the reply: the brief, the collaborator's answer, and the row tying them to the reply. */
const writeCollaboration = (
	cast: Cast<string>,
	day: Date,
	input: {
		id: string;
		parentThreadId: string;
		parentMessageId: string;
		chatId: string;
		podId: string;
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
		const [child] = yield* query((db) =>
			db
				.insert(thread)
				.values({
					workspaceId: cast.workspaceId,
					podId: input.podId,
					hostAgentId: collaboratorId,
					chatId: input.chatId,
					type: "collaboration",
					title: input.title,
					parentThreadId: input.parentThreadId,
					createdAt: input.asked,
					updatedAt: answeredAt,
				})
				.returning(),
		);
		if (!child) return yield* Effect.die(new Error("Could not open the collaboration"));
		yield* query((db) =>
			db.insert(threadParticipant).values([
				{ threadId: child.id, agentId: askingId },
				{ threadId: child.id, agentId: collaboratorId },
			]),
		);
		const briefId = randomUUID();
		yield* query((db) =>
			db.insert(message).values({
				id: briefId,
				threadId: child.id,
				authorAgentId: askingId,
				kind: "text",
				status: "complete",
				parts: [{ type: "text", text: input.brief }],
				content: input.brief,
				createdAt: input.asked,
			}),
		);
		const answerTurn = yield* writeTurn(cast, {
			threadId: child.id,
			bot: input.with,
			triggerMessageId: briefId,
			at: answeredAt,
		});
		yield* query((db) =>
			db.insert(message).values({
				threadId: child.id,
				authorAgentId: collaboratorId,
				kind: "text",
				status: "complete",
				parts: [{ type: "text", text: input.answer }],
				content: input.answer,
				turnId: answerTurn,
				createdAt: answeredAt,
			}),
		);
		yield* query((db) =>
			db.insert(collaboration).values({
				id: input.id,
				parentThreadId: input.parentThreadId,
				parentMessageId: input.parentMessageId,
				turnId: input.turnId,
				childThreadId: child.id,
				collaboratorAgentId: collaboratorId,
				brief: input.brief,
				status: "answered",
				answer: input.answer,
				atOffset: input.atOffset,
				createdAt: input.asked,
				updatedAt: answeredAt,
			}),
		);
	});

/** A connection tool call that waited for a person, who allowed it, and then ran. */
const writeToolCall = (
	cast: Cast<string>,
	day: Date,
	input: {
		id: string;
		threadId: string;
		messageId: string;
		turnId: string;
		podId: string;
		atOffset: number;
		startedAt: Date;
		connection: string;
		tool: string;
		input: JsonValue;
		/** What the call returned, once it has run. */
		output?: JsonValue;
		allowed?: { by: string; at: Clock };
	},
) =>
	Effect.gen(function* () {
		const [used] = yield* query((db) =>
			db
				.select({ id: connection.id, revision: connection.configurationRevision })
				.from(connection)
				.where(and(eq(connection.podId, input.podId), eq(connection.handle, input.connection))),
		);
		if (!used) return yield* Effect.die(new Error(`No ${input.connection} connection`));
		const allowedAt = input.allowed ? timeOn(day, input.allowed.at) : undefined;
		const decided =
			input.allowed && allowedAt
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
				threadId: input.threadId,
				messageId: input.messageId,
				turnId: input.turnId,
				tool: `${input.connection}${CONNECTION_TOOL_SEPARATOR}${input.tool}`,
				sdkToolCallId: randomUUID(),
				approvalId: randomUUID(),
				connectionId: used.id,
				connectionRevision: used.revision,
				remoteToolName: input.tool,
				executionInput: input.input,
				input: input.input,
				mutating: true,
				atOffset: input.atOffset,
				startedAt: input.startedAt,
				createdAt: input.startedAt,
				...decided,
			}),
		);
	});

/** How long a scripted bot takes to write an artifact. */
const ARTIFACT_WRITE_MILLISECONDS = 8_000;

/**
 * An artifact the bot wrote, made the way its artifact tool makes one, and the
 * `artifact_write` call that shows it under the reply.
 */
const writeArtifact = (
	cast: Cast<string>,
	input: {
		id: string;
		threadId: string;
		messageId: string;
		turnId: string;
		podId: string;
		bot: string;
		atOffset: number;
		writtenAt: Date;
		kind: ArtifactKind;
		title: string;
		content: string;
	},
) =>
	Effect.gen(function* () {
		const authoring = yield* Artifacts.Authoring;
		const { kind, title, content } = input;
		const written = yield* authoring
			.create(
				{
					workspaceId: cast.workspaceId,
					podId: input.podId,
					agentId: idOf(cast.botIds, input.bot),
					threadId: input.threadId,
				},
				{ kind, title, content },
			)
			.pipe(Effect.orDie);
		yield* query((db) =>
			db
				.update(artifact)
				.set({ createdAt: input.writtenAt, updatedAt: input.writtenAt })
				.where(eq(artifact.id, written.id)),
		);
		yield* query((db) =>
			db
				.update(artifactVersion)
				.set({ createdAt: input.writtenAt })
				.where(eq(artifactVersion.artifactId, written.id)),
		);
		yield* query((db) =>
			db.insert(toolCall).values({
				id: input.id,
				threadId: input.threadId,
				messageId: input.messageId,
				turnId: input.turnId,
				tool: ARTIFACT_WRITE_TOOL,
				sdkToolCallId: randomUUID(),
				input: { kind, title, content },
				output: {
					status: "written",
					artifactId: written.id,
					kind,
					title,
					version: written.version,
				},
				status: "completed",
				mutating: true,
				atOffset: input.atOffset,
				startedAt: new Date(input.writtenAt.getTime() - ARTIFACT_WRITE_MILLISECONDS),
				finishedAt: input.writtenAt,
				createdAt: input.writtenAt,
				updatedAt: input.writtenAt,
			}),
		);
	});

/**
 * A finished run, as the routine runner leaves one: its thread, what started
 * it, the bot's reply there, and that reply posted to the bot's chat.
 * Skipped when the routine already has a run.
 */
const writeRoutineRun = (cast: Cast<string>, day: Date, run: RoutineRun) =>
	Effect.gen(function* () {
		const agentId = idOf(cast.botIds, run.bot);
		const [defined] = yield* query((db) =>
			db
				.select()
				.from(routine)
				.where(
					and(
						eq(routine.agentId, agentId),
						eq(routine.name, run.routine),
						isNull(routine.deletedAt),
					),
				),
		);
		if (!defined) return yield* Effect.die(new Error(`${run.bot} has no routine ${run.routine}`));
		const scheduledAt = timeOn(day, run.scheduledAt);
		const [ranAlready] = yield* query((db) =>
			db
				.select({ id: routineExecution.id })
				.from(routineExecution)
				.where(
					and(
						eq(routineExecution.routineId, defined.id),
						eq(routineExecution.triggerIdentity, scheduledAt.toISOString()),
					),
				),
		);
		if (ranAlready) return false;

		const opened = yield* chatWith(cast, run.pod, run.bot);
		const finishedAt = timeOn(day, run.finishedAt);
		const [runThread] = yield* query((db) =>
			db
				.insert(thread)
				.values({
					workspaceId: cast.workspaceId,
					podId: opened.podId,
					hostAgentId: agentId,
					chatId: opened.id,
					type: "routine",
					title: `${run.routine} - ${scheduledAt.toISOString()}`,
					createdAt: scheduledAt,
					updatedAt: finishedAt,
				})
				.returning(),
		);
		if (!runThread) return yield* Effect.die(new Error("Could not open the run's thread"));
		yield* query((db) => db.insert(threadParticipant).values({ threadId: runThread.id, agentId }));
		const executionId = randomUUID();
		yield* query((db) =>
			db.insert(routineExecution).values({
				id: executionId,
				routineId: defined.id,
				workspaceId: cast.workspaceId,
				agentId,
				threadId: runThread.id,
				triggerKind: "cron",
				triggerIdentity: scheduledAt.toISOString(),
				trigger: {
					kind: "cron",
					scheduledAt: scheduledAt.toISOString(),
					acceptedAt: scheduledAt.toISOString(),
				},
				routineName: defined.name,
				instructions: defined.instructions,
				results: defined.results,
				state: "completed",
				acceptedAt: scheduledAt,
				startedAt: scheduledAt,
				finishedAt,
				createdAt: scheduledAt,
				updatedAt: finishedAt,
			}),
		);
		const triggerId = randomUUID();
		yield* query((db) =>
			db.insert(message).values({
				id: triggerId,
				threadId: runThread.id,
				routineTrigger: {
					kind: "routine_trigger",
					executionId,
					routineName: defined.name,
					triggerKind: "cron",
				},
				kind: "text",
				status: "complete",
				parts: [{ type: "text", text: defined.instructions }],
				content: defined.instructions,
				createdAt: scheduledAt,
			}),
		);
		const turnId = yield* writeTurn(cast, {
			threadId: runThread.id,
			bot: run.bot,
			triggerMessageId: triggerId,
			at: finishedAt,
		});
		for (const [threadId, routineExecutionId] of [
			[runThread.id, null],
			[opened.mainThreadId, executionId],
		] as const) {
			yield* query((db) =>
				db.insert(message).values({
					threadId,
					authorAgentId: agentId,
					kind: "text",
					status: "complete",
					parts: [{ type: "text", text: run.result }],
					content: run.result,
					turnId,
					routineExecutionId,
					createdAt: finishedAt,
				}),
			);
		}
		yield* touch(opened.mainThreadId, opened.id);
		return true;
	});

/** Stamps the thread and its chat with the thread's latest message, so they sort where it happened. */
const touch = (threadId: string, chatId: string) =>
	Effect.gen(function* () {
		const [latest] = yield* query((db) =>
			db
				.select({ at: max(message.createdAt) })
				.from(message)
				.where(eq(message.threadId, threadId)),
		);
		if (!latest?.at) return;
		const at = latest.at;
		yield* query((db) => db.update(thread).set({ updatedAt: at }).where(eq(thread.id, threadId)));
		yield* query((db) => db.update(chat).set({ updatedAt: at }).where(eq(chat.id, chatId)));
	});

/** Everyone has read every thread in their pods, so nothing seeded shows as unread. */
const markEverythingRead = (cast: Cast<string>) =>
	Effect.gen(function* () {
		const now = new Date();
		const rows = yield* query((db) =>
			db
				.select({ threadId: thread.id, userId: podMember.userId })
				.from(thread)
				.innerJoin(podMember, eq(podMember.podId, thread.podId))
				.where(eq(thread.workspaceId, cast.workspaceId)),
		);
		if (rows.length === 0) return;
		yield* query((db) =>
			db
				.insert(threadRead)
				.values(rows.map((row) => ({ ...row, readThrough: now })))
				.onConflictDoUpdate({
					target: [threadRead.userId, threadRead.threadId],
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

function podIdOf(podIds: Record<string, string>, pod: string): string {
	const id = podIds[pod];
	if (!id) throw new Error(`No pod is keyed ${pod}`);
	return id;
}
