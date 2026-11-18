export * as TurnExecution from "./execution.ts";

import type {
	AgentColor,
	AgentVisibility,
	Message,
	ThreadParticipant,
	ThreadType,
} from "@sugabots/contracts";
import { UserText, userText } from "@sugabots/errors";
import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import {
	type Database,
	type Executor,
	query,
	serviceOperations,
	type Transaction,
	transaction,
} from "../../database/database.ts";
import {
	agent,
	routineExecution,
	type TurnReason,
	threadCompaction,
} from "../../database/schema.ts";
import { modelAcceptsImages } from "../../providers/model-providers/model-provider-reads.ts";
import { ASSISTANT_PROMPT } from "../../workspaces/agents/assistant-prompt.ts";
import { ConversationEvents } from "../conversation-events.ts";
import { ConversationEvent } from "../events.ts";
import { messageTextWithPlacedParts } from "../threads/message-text.ts";
import {
	agentColumns,
	authorRow,
	messageFromRelations,
	messageRelations,
	personColumns,
	toParticipant,
} from "../threads/participants.ts";
import {
	estimatedTokens,
	historyLimitTokens,
	loadContextWindow,
	newestWithinLimit,
} from "./context-window.ts";
import { type Ended, TURN_CANCELLED } from "./lifecycle.ts";
import {
	type NotRunnable,
	type ReplyTurn,
	type TurnCheckpoint,
	TurnRepository,
} from "./repository.ts";
import { Turn, type TurnRequest } from "./turn.workflow.ts";

/**
 * Running an agent's turn: one agent answering one message in a thread.
 *
 * A turn is asked for when a person posts and run by the turn workflow (see
 * `turn.workflow.ts`), one segment at a time. Each segment starts here, with
 * the turn opened through `TurnRepository` and what the model is told loaded.
 * It runs for the workflow, not for a person, so it asks for no actor and is
 * never handed to a route; a person asking a turn to stop is
 * `TurnCancellation`.
 */
export interface Interface {
	/**
	 * Opens the turn for this run and loads what the model needs, or says why
	 * it may not run: its thread or agent is gone, its agent has no model, its
	 * routine run takes no more work, or newer work made it pointless. A turn
	 * this ends stays ended, so the refusal is a result rather than a failure
	 * that would roll the ending back. A refusal that ends no turn announces
	 * `TurnAbandoned`: as failed, telling people why, when they asked for a
	 * reply that cannot come, and otherwise as cancelled. Every refusal's
	 * reason is logged.
	 */
	readonly prepare: (run: TurnRun) => Effect.Effect<PreparedTurn | NotRunnable>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/TurnExecution",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("TurnExecution");
	const { emit } = yield* ConversationEvents.Service;
	const turns = yield* TurnRepository.Service;

	/**
	 * Ends the turn the run holds, if any, because the run may not go on, as
	 * `ending` says. With no turn to end, people are told of a failure as a
	 * notice in the thread, so nobody waits on a reply that cannot come.
	 */
	const refuseRun = (
		run: TurnRun,
		reason: string,
		ending: { status: "failed" | "cancelled"; userMessage: UserText },
	) =>
		Effect.gen(function* () {
			const ended = yield* turns.abandon(run.executionId, ending);
			if (!ended) {
				yield* emit([
					ConversationEvent.TurnAbandoned({
						threadId: run.request.threadId,
						agentId: run.request.agentId,
						outcome:
							ending.status === "failed"
								? { state: "failed", error: ending.userMessage }
								: { state: "cancelled" },
					}),
				]);
			}
			return notRunnable(reason, ended);
		});

	return Service.of({
		prepare: (run) =>
			operation(
				"prepare",
				transaction(
					Effect.gen(function* (): Effect.fn.Return<
						PreparedTurn | NotRunnable,
						never,
						Database | Transaction
					> {
						const request = run.request;
						const loaded = yield* query((db) => loadTurnContext(db, request.threadId));
						if (!loaded) return yield* refuseRun(run, "The thread is gone", CANCELLED);
						// In a channel the bot has to be one of the channel's, whoever a
						// mention picks; in a bot's own thread, it has to be that bot. A
						// direct message between people has no bot at all. This is what
						// stops a turn request naming a bot from elsewhere.
						const speaker = loaded.pod
							? loaded.pod.agents.find(({ id }) => id === request.agentId)
							: loaded.hostAgent?.id === request.agentId
								? loaded.hostAgent
								: undefined;
						if (!speaker) {
							return yield* refuseRun(run, "The bot does not answer in this thread", {
								status: "failed",
								userMessage: NOT_HERE,
							});
						}
						const crew = yield* query((db) => collaboratorsOf(db, loaded.workspaceId, speaker.id));
						// An agent whose model has been cleared does not fall back to
						// another one: it stops, and says so, until somebody chooses.
						// Read out here so what opens the turn is handed a model rather
						// than an agent that might not carry one.
						const model = speaker.model;
						if (model === null) {
							return yield* refuseRun(run, "The agent has no model chosen", {
								status: "failed",
								userMessage: userText`${UserText.unchecked(speaker.name)} has no model chosen, so it cannot reply. Choose one in its settings.`,
							});
						}
						const opened = yield* turns.openReplyTurn({
							threadId: loaded.id,
							agentId: speaker.id,
							triggerMessageId: request.triggerMessageId,
							model,
							reason: request.reason,
							owner: run.executionId,
							author: authorRow(null, speaker),
						});
						if (opened._tag === "NotRunnable") {
							if (!opened.ended) {
								yield* emit([
									ConversationEvent.TurnAbandoned({
										threadId: request.threadId,
										agentId: request.agentId,
										outcome: { state: "cancelled" },
									}),
								]);
							}
							return opened;
						}
						const windowTokens = yield* query((db) =>
							loadContextWindow(db, loaded.workspaceId, model),
						);
						const acceptsImages = yield* modelAcceptsImages(loaded.workspaceId, model);
						const inThread = loaded.messages
							.reverse()
							.map((stored) => messageFromRelations(stored));
						const messages = inThread;
						const trigger = messages.find(({ id }) => id === request.triggerMessageId);
						// Loaded before the history is trimmed, so what they add counts towards its limit.
						const routineInstructions = yield* query((db) => loadRoutineInstructions(db, messages));
						const history = newestWithinLimit(
							messages,
							(message) =>
								estimatedTokens(
									messageTextWithPlacedParts(message) +
										(message.routineResultOf
											? (routineInstructions.get(message.routineResultOf.executionId) ?? "")
											: ""),
								),
							historyLimitTokens(windowTokens),
						);
						return {
							_tag: "Prepared",
							run,
							turnId: opened.turnId,
							responseMessage: opened.reply,
							context: {
								thread: {
									id: loaded.id,
									workspaceId: loaded.workspaceId,
									title: loaded.title,
									type: loaded.type,
									hostAgentId: loaded.hostAgentId,
									parentThreadId: loaded.parentThreadId,
								},
								agent: {
									id: speaker.id,
									name: speaker.name,
									handle: speaker.handle,
									model,
									acceptsImages,
									prompt: speaker.assistantOf === null ? speaker.prompt : ASSISTANT_PROMPT,
									assistantOf: speaker.assistantOf,
									visibility: speaker.visibility,
									disabledTools: speaker.disabledTools,
									usesSandbox: speaker.usesSandbox,
									naturalBrowsing: speaker.naturalBrowsing,
									color: speaker.color,
								},
								reason: request.reason,
								channel: loaded.pod ? { name: loaded.pod.name, slug: loaded.pod.slug } : null,
								workspaceName: loaded.workspace.name,
								workspaceSlug: loaded.workspace.slug,
								workspaceTimeZone: loaded.workspace.timeZone,
								askedBy: trigger?.author.kind === "person" ? trigger.author.id : null,
								startedFor: request.reason === "brief" ? loaded.initiatorUserId : null,
								crew,
								participants: loaded.participants.map(({ user, agent }) =>
									toParticipant(authorRow(user, agent)),
								),
								windowTokens,
								compaction: loaded.compaction ?? undefined,
								messages: history,
								routineInstructions,
							},
							...(opened.checkpoint ? { checkpoint: opened.checkpoint } : {}),
						};
					}).pipe(
						Effect.tap((preparation) =>
							preparation._tag === "NotRunnable"
								? Effect.logInfo(
										`Turn of agent ${run.request.agentId} in thread ${run.request.threadId} may not run: ${preparation.reason}`,
									)
								: Effect.void,
						),
					),
				),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(Layer.provide(TurnRepository.layer));

/** One run of a turn, by the workflow execution `executionId`, which owns the turn. */
export interface TurnRun {
	readonly executionId: string;
	readonly request: TurnRequest;
}

/** The turn workflow's run of the turn `request` asks for. */
export const turnRunFor = (request: TurnRequest) =>
	Effect.map(Turn.executionId(request), (executionId): TurnRun => ({ executionId, request }));

/** A run with its turn opened and its context loaded, ready to stream. */
export interface PreparedTurn {
	readonly _tag: "Prepared";
	readonly run: TurnRun;
	readonly turnId: string;
	/** The agent's reply, `streaming` and empty until the segment streams into it. */
	readonly responseMessage: Message;
	readonly context: TurnContext;
	/** Where a suspended turn left off; set only when this run continues it. */
	readonly checkpoint?: TurnCheckpoint;
}

/** Where the prepared turn and its reply are, for recording how it goes. */
export function replyTurnOf(prepared: PreparedTurn): ReplyTurn {
	return {
		turnId: prepared.turnId,
		threadId: prepared.context.thread.id,
		workspaceId: prepared.context.thread.workspaceId,
		agentId: prepared.context.agent.id,
		reason: prepared.run.request.reason,
		messageId: prepared.responseMessage.id,
	};
}

/** What the model is told about where it is and what has been said. */
export interface TurnContext {
	thread: {
		id: string;
		workspaceId: string;
		title: string;
		type: ThreadType;
		/** The bot whose thread it is; none in a channel's conversation or between people. */
		hostAgentId: string | null;
		/** Set when another agent opened this thread by delegating to this one. */
		parentThreadId: string | null;
	};
	agent: {
		id: string;
		name: string;
		handle: string;
		model: string;
		/** Whether its model takes images, which tools can then show it. */
		acceptsImages: boolean;
		/** What it is told to be: its own instructions, or for a Personal Assistant, Sugabots'. */
		prompt: string;
		/** On a Personal Assistant: the one person it works for. */
		assistantOf: string | null;
		/** Whether everyone in the workspace reaches it, or only its creator. */
		visibility: AgentVisibility;
		/** Built-in tools an admin switched off for this agent, by key. */
		disabledTools: string[];
		/** Whether somebody let this bot use a computer. */
		usesSandbox: boolean;
		/** Whether it browses so people watching its desktop can follow. */
		naturalBrowsing: boolean;
		/** Its colour, which its desktop in the sandbox is drawn in. */
		color: AgentColor;
	};
	/** Why this agent has the turn, when the trigger recorded it. */
	reason: TurnReason | undefined;
	/** The channel the conversation is in, by name and address; none in a bot's own thread. */
	channel: { name: string; slug: string } | null;
	workspaceName: string;
	workspaceSlug: string;
	/** The workspace's timezone, which the schedules the agent sets up run in. */
	workspaceTimeZone: string;
	/**
	 * The person whose message this turn answers, who the agent acts for when
	 * it changes something on their behalf. None when it answers an agent, a
	 * bot's brief, or a routine's trigger.
	 */
	askedBy: string | null;
	/**
	 * On a bot's brief, the person the bot started the thread for. The agent
	 * may mark this thread done for them, and nothing more: the brief is a
	 * bot's words, not theirs, so it never vouches for anything else they could
	 * do, such as starting another thread or changing instructions.
	 */
	startedFor: string | null;
	/** The workspace's other bots, which this one may ask for help. */
	crew: Array<{ id: string; name: string; handle: string; description: string | null }>;
	participants: ThreadParticipant[];
	/** The context window the agent's model is treated as having, which every limit is a share of. */
	windowTokens: number;
	/** What the Compaction agent left in place of older history, once the thread has been compacted. */
	compaction: TurnCompaction | undefined;
	/**
	 * The newest completed messages, oldest first: those since the compaction
	 * kept them word for word, as many as fit the agent's history limit.
	 */
	messages: Message[];
	/**
	 * What each routine run whose result is among `messages` was told to do,
	 * by the run's id, so the agent can say why a result was posted. Each is
	 * cut to `MAX_ROUTINE_INSTRUCTION_CHARACTERS`, ending in an ellipsis when cut.
	 */
	routineInstructions: ReadonlyMap<string, string>;
}

/**
 * How much of a routine run's instructions a result in the history carries:
 * enough to say why it was posted, while a thread of a routine's results
 * repeats them for every run.
 */
const MAX_ROUTINE_INSTRUCTION_CHARACTERS = 1_000;

/** The instructions of the routine runs whose results are among `messages`, by run id. */
const loadRoutineInstructions = Effect.fn("TurnExecution.loadRoutineInstructions")(function* (
	db: Executor,
	messages: readonly Message[],
) {
	const runIds = messages.flatMap((message) =>
		message.routineResultOf ? [message.routineResultOf.executionId] : [],
	);
	if (runIds.length === 0) return new Map<string, string>();
	const runs = yield* db
		.select({
			id: routineExecution.id,
			// One more than is kept, to tell a cut from an exact fit.
			instructions: sql<string>`left(${routineExecution.instructions}, ${MAX_ROUTINE_INSTRUCTION_CHARACTERS + 1})`,
		})
		.from(routineExecution)
		.where(inArray(routineExecution.id, runIds));
	return new Map(
		runs.map((run) => [
			run.id,
			run.instructions.length > MAX_ROUTINE_INSTRUCTION_CHARACTERS
				? `${run.instructions.slice(0, MAX_ROUTINE_INSTRUCTION_CHARACTERS)}…`
				: run.instructions,
		]),
	);
});

export interface TurnCompaction {
	/** The Compaction agent's summary of the messages from `historyStartsAt` to `keptFrom`. */
	summary: string;
	/** History before this is neither summarised nor read, only searched. */
	historyStartsAt: Date;
	/** Where the messages the agent reads word for word start. */
	keptFrom: Date;
}

/**
 * The most messages loaded for a turn, before they are cut to the agent's
 * history limit. It bounds the query, not what the agent reads.
 */
const MAX_HISTORY_MESSAGES = 1_000;

/** How a run is refused whose reply nobody needs any more. */
const CANCELLED = { status: "cancelled", userMessage: TURN_CANCELLED } as const;

/** What people are told when an agent asked to reply in a thread is not in its pod. */
const NOT_HERE = userText`The bot asked to reply doesn't answer here, so it cannot reply.`;

/**
 * The bots `agentId` may ask for help: every other bot of the workspace that
 * people talk to, but not a Personal Assistant, which is its person's alone.
 */
const collaboratorsOf = (db: Executor, workspaceId: string, agentId: string) =>
	db
		.select({
			id: agent.id,
			name: agent.name,
			handle: agent.handle,
			description: agent.description,
		})
		.from(agent)
		.where(
			and(
				eq(agent.workspaceId, workspaceId),
				ne(agent.id, agentId),
				isNull(agent.systemAgentKey),
				isNull(agent.assistantOf),
			),
		)
		.orderBy(asc(agent.name));

function notRunnable(reason: string, ended?: Ended): NotRunnable {
	return { _tag: "NotRunnable", reason, ended };
}

/**
 * Everything the model is told about the thread, in one statement: the
 * thread with its workspace, its channel and the bots in it or the bot it is
 * with, the people and bots in it, its compaction, and its newest completed
 * messages since the compaction kept them, with the parts placed in them.
 */
/** What a bot that speaks in a thread is read with. */
const SPEAKER_COLUMNS = {
	id: true,
	name: true,
	handle: true,
	color: true,
	face: true,
	shape: true,
	description: true,
	model: true,
	prompt: true,
	disabledTools: true,
	usesSandbox: true,
	naturalBrowsing: true,
	assistantOf: true,
	visibility: true,
} as const;

const loadTurnContext = Effect.fn("TurnExecution.loadTurnContext")(function* (
	db: Executor,
	threadId: string,
) {
	return yield* db.query.thread.findFirst({
		where: { id: threadId },
		columns: {
			id: true,
			workspaceId: true,
			podId: true,
			parentThreadId: true,
			hostAgentId: true,
			title: true,
			type: true,
			initiatorUserId: true,
		},
		with: {
			workspace: { columns: { name: true, slug: true, timeZone: true } },
			pod: {
				columns: { id: true, name: true, slug: true },
				with: { agents: { columns: SPEAKER_COLUMNS, orderBy: { name: "asc" } } },
			},
			hostAgent: { columns: SPEAKER_COLUMNS },
			participants: {
				columns: {},
				orderBy: { createdAt: "asc", id: "asc" },
				with: { user: personColumns, agent: agentColumns },
			},
			compaction: { columns: { summary: true, historyStartsAt: true, keptFrom: true } },
			// The reply being written is `streaming`, so this leaves it out.
			messages: {
				where: {
					status: "complete",
					RAW: (row) =>
						sql`${row.createdAt} >= coalesce((select ${threadCompaction.keptFrom} from ${threadCompaction} where ${threadCompaction.threadId} = ${row.threadId}), '-infinity')`,
				},
				orderBy: { createdAt: "desc", id: "desc" },
				limit: MAX_HISTORY_MESSAGES,
				with: messageRelations,
			},
		},
	});
});
