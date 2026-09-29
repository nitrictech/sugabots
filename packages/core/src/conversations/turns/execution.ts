export * as TurnExecution from "./execution.ts";

import type { Message, PodRouting, ThreadParticipant, ThreadType } from "@sugabots/contracts";
import { sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import {
	type Database,
	type Executor,
	query,
	serviceOperations,
	type Transaction,
	transaction,
} from "../../database/database.ts";
import { type TurnReason, threadCompaction } from "../../database/schema.ts";
import { UserMessage } from "../../user-message.ts";
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
		ending: { status: "failed" | "cancelled"; userMessage: UserMessage },
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
						// The agent has to be crew placed in the thread's pod, not the
						// thread's host. A shared thread gives the floor to whoever the
						// facilitator or a mention picks, and that is rarely the host.
						// Pod membership is still a real check: it is what stops a turn
						// request naming an agent from another pod or another workspace.
						const speaker = loaded.pod.agents.find(({ id }) => id === request.agentId);
						if (!speaker) {
							return yield* refuseRun(run, "The agent is not a crew agent in the thread's pod", {
								status: "failed",
								userMessage: NOT_IN_POD,
							});
						}
						// An agent whose model has been cleared does not fall back to
						// another one: it stops, and says so, until somebody chooses.
						// Read out here so what opens the turn is handed a model rather
						// than an agent that might not carry one.
						const model = speaker.model;
						if (model === null) {
							return yield* refuseRun(run, "The agent has no model chosen", {
								status: "failed",
								userMessage: UserMessage.of`${UserMessage.unchecked(speaker.name)} has no model chosen, so it cannot reply. Choose one in its settings.`,
							});
						}
						if (loaded.type === "chat" && request.reason === "facilitator") {
							return yield* refuseRun(run, "The Facilitator does not route Chats", CANCELLED);
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
									parentThreadId: loaded.parentThreadId,
								},
								agent: {
									id: speaker.id,
									name: speaker.name,
									handle: speaker.handle,
									model,
									prompt: speaker.prompt,
									disabledTools: speaker.disabledTools,
									podId: loaded.podId,
								},
								reason: request.reason,
								routing: loaded.pod.routing,
								podName: loaded.pod.name,
								workspaceName: loaded.workspace.name,
								crew: loaded.pod.agents
									.filter(({ id }) => id !== speaker.id)
									.map(({ id, name, handle, description }) => ({ id, name, handle, description })),
								participants: loaded.participants.map(({ user, agent }) =>
									toParticipant(authorRow(user, agent)),
								),
								windowTokens,
								compaction: loaded.compaction ?? undefined,
								messages: newestWithinLimit(
									loaded.messages.reverse().map((stored) => messageFromRelations(stored)),
									(message) => estimatedTokens(messageTextWithPlacedParts(message)),
									historyLimitTokens(windowTokens),
								),
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
		podId: prepared.context.agent.podId,
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
		type?: ThreadType;
		/** Set when another agent opened this thread by delegating to this one. */
		parentThreadId: string | null;
	};
	agent: {
		id: string;
		name: string;
		handle: string;
		model: string;
		prompt: string;
		/** Built-in tools an admin switched off for this agent, by key. */
		disabledTools: string[];
		podId: string;
	};
	/** Why this agent has the turn, when the trigger recorded it. */
	reason: TurnReason | undefined;
	/** Whether non-chat threads use the Facilitator to choose the next speaker. */
	routing: PodRouting;
	podName: string;
	workspaceName: string;
	/** The other crew agents in the pod, who this agent may collaborate with. */
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
}

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
const NOT_IN_POD = UserMessage.of`The agent asked to reply is not in this pod, so it cannot reply.`;

function notRunnable(reason: string, ended?: Ended): NotRunnable {
	return { _tag: "NotRunnable", reason, ended };
}

/**
 * Everything the model is told about the thread, in one statement: the
 * thread with its workspace, its pod and the crew placed there, the people and
 * agents in it, its compaction, and its newest completed messages since the
 * compaction kept them, with the parts placed in them.
 */
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
			title: true,
			type: true,
		},
		with: {
			workspace: { columns: { name: true } },
			pod: {
				columns: { name: true, routing: true },
				with: {
					// Every agent placed in a pod is crew: system agents are placed in none.
					agents: {
						columns: {
							id: true,
							name: true,
							handle: true,
							color: true,
							face: true,
							description: true,
							model: true,
							prompt: true,
							disabledTools: true,
						},
						orderBy: { name: "asc" },
					},
				},
			},
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
