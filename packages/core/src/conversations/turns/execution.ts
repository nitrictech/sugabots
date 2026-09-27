import type {
	AgentColor,
	Message,
	PodRouting,
	ThreadParticipant,
	ThreadType,
} from "@sugabots/contracts";
import { and, desc, eq, isNull, ne } from "drizzle-orm";
import { Effect } from "effect";
import {
	type Database,
	type Executor,
	type QueryFailure,
	query,
	transaction,
} from "../../database/database.ts";
import type { DomainEvents } from "../../database/events/domain-events.ts";
import {
	type AgentRow,
	agent,
	message,
	pod,
	type TurnReason,
	thread,
	turn,
	user,
	workspace,
} from "../../database/schema.ts";
import type { UserMessage } from "../../user-message.ts";
import type { ConversationEvent } from "../events.ts";
import { threadRejectsTurns } from "../routines/execution.ts";
import { loadParticipants, participantColumns, toMessage } from "../threads/participants.ts";
import { loadPlacedParts } from "../threads/placed-parts.ts";
import { visibleThread } from "../threads/visibility.ts";
import { type FloorDecision, giveFloor } from "./floor.ts";
import { ROUTINE_EXECUTION_ENDED, TURN_CANCELLED } from "./lifecycle.ts";
import type { QueueFacilitation, QueueTurn } from "./queue.ts";
import type {
	NotRunnable,
	ReplyDraft,
	ReplyTurn,
	TurnCheckpoint,
	TurnRepository,
} from "./repository.ts";
import type { TurnSignals } from "./signals.ts";
import { Turn, type TurnRequest } from "./turn.workflow.ts";

/**
 * Running an agent's turn: one agent answering one message in a thread.
 *
 * A turn is asked for when a person posts and run by the turn workflow (see
 * `turn.workflow.ts`), one segment at a time. Each segment starts here, with
 * the turn opened through `TurnRepository` and what the model is told loaded;
 * a completed reply comes back here to decide who speaks next. A person asking
 * a turn to stop is heard here too.
 */
export interface TurnExecution {
	/**
	 * Opens the turn for this run and loads what the model needs, or says why
	 * it may not run: its thread or agent is gone, or newer work made it
	 * pointless. A turn this ends stays ended, so the refusal is a result
	 * rather than a failure that would roll the ending back.
	 */
	prepare(run: TurnRun): Effect.Effect<PreparedTurn | NotRunnable, never, Database>;
	/** Decides who speaks after this completed reply, and queues them (ADR 004). */
	giveFloor(
		prepared: PreparedTurn,
		reply: ReplyDraft,
	): Effect.Effect<FloorDecision, never, Database>;
	/** Asks a turn to stop for `userId`. `false` when there is no running turn they may see. */
	requestCancel(turnId: string, userId: string): Effect.Effect<boolean, never, Database>;
}

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
	/** messages contains up to one hundred completed messages, oldest first. */
	messages: Message[];
}

/** How much of the conversation the agent is shown. */
const MAX_HISTORY_MESSAGES = 100;

export function turnExecution(dependencies: {
	turns: TurnRepository;
	emit: DomainEvents.Emit<ConversationEvent>;
	queueTurn: QueueTurn;
	queueFacilitation: QueueFacilitation;
	signals: TurnSignals;
}): TurnExecution {
	const { turns, emit, queueTurn, queueFacilitation, signals } = dependencies;

	/** Ends the turn the run holds, if any, because the run may not go on. */
	const refuseRun = (run: TurnRun, reason: string, userMessage: UserMessage) =>
		Effect.map(
			turns.abandon(run.executionId, { status: "cancelled", userMessage }),
			(ended): NotRunnable => ({ _tag: "NotRunnable", reason, ended }),
		);

	return {
		prepare: (run) =>
			transaction(
				Effect.gen(function* (): Effect.fn.Return<PreparedTurn | NotRunnable, never, Database> {
					const request = run.request;
					if (yield* threadRejectsTurns(request.threadId)) {
						return yield* refuseRun(
							run,
							"The Routine execution has ended",
							ROUTINE_EXECUTION_ENDED,
						);
					}
					const scope = yield* query((db) => loadTurnScope(db, request));
					if (!scope) {
						return notRunnable("The thread is gone, or this agent is not a crew agent in its pod");
					}
					// An agent whose model has been cleared does not fall back to
					// another one: it stops, and says so, until somebody chooses.
					// Read out here so what opens the turn is handed a model rather
					// than a scope that might not carry one.
					const model = scope.agentModel;
					if (model === null) return notRunnable(`${scope.agentName} has no model chosen`);
					if (scope.threadType === "chat" && request.reason === "facilitator") {
						return yield* refuseRun(run, "The Facilitator does not route Chats", TURN_CANCELLED);
					}
					const opened = yield* turns.openReplyTurn({
						threadId: scope.threadId,
						agentId: scope.agentId,
						triggerMessageId: request.triggerMessageId,
						model,
						reason: request.reason,
						owner: run.executionId,
						author: {
							userId: null,
							userName: null,
							userImage: null,
							agentId: scope.agentId,
							agentName: scope.agentName,
							agentHandle: scope.agentHandle,
							agentColor: scope.agentColor,
							agentFace: scope.agentFace,
						},
					});
					if (opened._tag === "NotRunnable") return opened;
					// One query at a time: inside a transaction the executor is a single
					// connection, and queries sent concurrently down one are not run
					// concurrently anyway. The driver queues them, and warns that it is
					// about to stop accepting them at all.
					const participants = yield* query((db) => loadParticipants(db, scope.threadId));
					const crew = yield* query((db) => loadCrew(db, scope));
					const messages = yield* query((db) => loadHistory(db, scope.threadId, opened.reply.id));
					return {
						_tag: "Prepared",
						run,
						turnId: opened.turnId,
						responseMessage: opened.reply,
						context: {
							thread: {
								id: scope.threadId,
								workspaceId: scope.workspaceId,
								title: scope.threadTitle,
								type: scope.threadType,
								parentThreadId: scope.parentThreadId,
							},
							agent: {
								id: scope.agentId,
								name: scope.agentName,
								handle: scope.agentHandle,
								model,
								prompt: scope.agentPrompt,
								disabledTools: scope.agentDisabledTools,
								podId: scope.podId,
							},
							reason: request.reason,
							routing: scope.routing,
							podName: scope.podName,
							workspaceName: scope.workspaceName,
							crew,
							participants,
							messages,
						},
						...(opened.checkpoint ? { checkpoint: opened.checkpoint } : {}),
					};
				}),
			),

		giveFloor: (prepared, reply) =>
			giveFloor(
				{ emit, queueTurn, queueFacilitation },
				{
					id: prepared.responseMessage.id,
					threadId: prepared.context.thread.id,
					content: reply.content,
					author: {
						kind: "agent",
						agentId: prepared.context.agent.id,
						spokeBecause: prepared.run.request.reason,
					},
				},
			),

		requestCancel: (turnId, userId) =>
			transaction(
				Effect.gen(function* () {
					const [candidate] = yield* query((db) =>
						db.select({ threadId: turn.threadId }).from(turn).where(eq(turn.id, turnId)).limit(1),
					);
					if (!candidate) return false;
					if (!(yield* query((db) => visibleThread(db, candidate.threadId, userId)))) return false;
					const requested = yield* turns.requestCancel(turnId);
					if (requested._tag === "Refused") return false;
					// Telling the workflow is the cancellation; it records it. The flag
					// set with it stops the next segment instead if the workflow has
					// just stopped waiting, since the signal would then go unheard.
					if (requested._tag === "SignalOwner") yield* signals.cancel(requested.owner);
					return true;
				}),
			),
	};
}

function notRunnable(reason: string): NotRunnable {
	return { _tag: "NotRunnable", reason, ended: undefined };
}

/** The thread a turn happens in, with its pod, workspace and the agent taking it. */
interface TurnScope {
	threadId: string;
	chatId: string | null;
	workspaceId: string;
	podId: string;
	parentThreadId: string | null;
	threadTitle: string;
	threadType: ThreadType;
	podName: string;
	workspaceName: string;
	routing: PodRouting;
	agentId: string;
	agentName: string;
	agentHandle: string;
	agentColor: AgentColor;
	agentFace: AgentRow["face"];
	/** Null when nobody has chosen one. The turn refuses rather than guessing. */
	agentModel: string | null;
	agentPrompt: string;
	agentDisabledTools: string[];
}

/**
 * The thread and the agent about to speak in it, or nothing if the turn may
 * not run.
 *
 * The agent has to be crew placed in the thread's pod, not the thread's host.
 * A shared thread gives the floor to whoever the facilitator or a mention
 * picks, and that is rarely the host — requiring the host discarded
 * every routed turn, so the person watched a reply that was never coming.
 *
 * Pod membership is still a real check: it is what stops a turn request naming an agent
 * from another pod or another workspace.
 */
const loadTurnScope = Effect.fn("TurnExecution.loadTurnScope")(function* (
	db: Executor,
	request: TurnRequest,
): Effect.fn.Return<TurnScope | undefined, QueryFailure> {
	const [row] = yield* db
		.select({
			threadId: thread.id,
			chatId: thread.chatId,
			workspaceId: thread.workspaceId,
			podId: thread.podId,
			parentThreadId: thread.parentThreadId,
			threadTitle: thread.title,
			threadType: thread.type,
			podName: pod.name,
			routing: pod.routing,
			workspaceName: workspace.name,
			agentId: agent.id,
			agentName: agent.name,
			agentHandle: agent.handle,
			agentColor: agent.color,
			agentFace: agent.face,
			agentModel: agent.model,
			agentPrompt: agent.prompt,
			agentDisabledTools: agent.disabledTools,
		})
		.from(thread)
		.innerJoin(pod, eq(pod.id, thread.podId))
		.innerJoin(workspace, eq(workspace.id, thread.workspaceId))
		.innerJoin(agent, and(eq(agent.id, request.agentId), eq(agent.podId, thread.podId)))
		.where(eq(thread.id, request.threadId))
		.limit(1);
	return row;
});

/** The other crew agents placed in the pod: who this agent may collaborate with. */
const loadCrew = (db: Executor, scope: TurnScope) =>
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
				eq(agent.podId, scope.podId),
				eq(agent.workspaceId, scope.workspaceId),
				isNull(agent.systemAgentKey),
				ne(agent.id, scope.agentId),
			),
		)
		.orderBy(agent.name);

/**
 * loadHistory returns up to one hundred completed messages, excluding the
 * response currently being written.
 */
const loadHistory = Effect.fn("TurnExecution.loadHistory")(function* (
	db: Executor,
	threadId: string,
	responseMessageId: string,
) {
	const newestFirst = yield* db
		.select({ message, ...participantColumns })
		.from(message)
		.leftJoin(user, eq(user.id, message.authorUserId))
		.leftJoin(agent, eq(agent.id, message.authorAgentId))
		.where(
			and(
				eq(message.threadId, threadId),
				ne(message.id, responseMessageId),
				eq(message.status, "complete"),
			),
		)
		.orderBy(desc(message.createdAt), desc(message.id))
		.limit(MAX_HISTORY_MESSAGES);
	const rows = newestFirst.reverse();
	const placed = yield* loadPlacedParts(
		db,
		rows.map(({ message: row }) => row.id),
	);
	return rows.map(({ message: row, ...author }) => toMessage(row, author, placed(row.id)));
});
