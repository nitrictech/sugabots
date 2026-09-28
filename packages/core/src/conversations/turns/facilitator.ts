import type { ThreadType } from "@sugabots/contracts";
import { and, desc, eq, isNull } from "drizzle-orm";
import { Duration, Effect, Layer, Ref } from "effect";
import {
	Database,
	type Executor,
	type QueryFailure,
	query,
	transaction,
} from "../../database/database.ts";
import type { DomainEvents } from "../../database/events/domain-events.ts";
import { agent, message, pod, thread, threadParticipant, user } from "../../database/schema.ts";
import {
	FACILITATE_SYSTEM_AGENT,
	findRunnableSystemAgent,
} from "../../workspaces/agents/system-agents.ts";
import { ConversationEvent } from "../events.ts";
import { AnswerTimedOut, retryUnusable, UnusableAnswer } from "./answer.ts";
import {
	type AttemptOutcome,
	type FacilitateRequest,
	FacilitateSteps,
	FacilitationFailed,
} from "./facilitate.workflow.ts";
import {
	forEachDelta,
	type ModelRequestFailed,
	type TurnModel,
	type TurnModelInput,
} from "./model.ts";
import { TurnRequests } from "./requests.ts";

/**
 * The facilitator: a small model call that decides who speaks after a
 * message when nothing else did (ADR 004). Runs as a workflow so the request
 * that committed the message does not wait on a model.
 *
 * It answers one of the handles in the thread, or `nobody`. A person being
 * addressed, or an exchange that is plainly over, is `nobody`; the people get
 * the floor by nothing happening.
 */

const FACILITATOR_TIMEOUT = Duration.seconds(20);
/** The most recent messages the facilitator reads. Enough to see who is talking to whom. */
const CONTEXT_MESSAGES = 8;
const MAX_ANSWER_CHARACTERS = 200;

export interface FacilitatorExecution {
	model: TurnModel;
	emit: DomainEvents.Emit<ConversationEvent>;
	/** How the chosen agent's turn is asked for. */
	requests: Pick<TurnRequests.Interface, "queueTurn">;
}

/** The facilitate workflow's steps, which its activities reach through `FacilitateSteps`. */
export const stepsLayer = (options: Omit<FacilitatorExecution, "requests">) =>
	Layer.effect(
		FacilitateSteps,
		Effect.gen(function* () {
			const database = yield* Database;
			const execution = { ...options, requests: yield* TurnRequests.Service };
			const announce = (event: ConversationEvent) =>
				transaction(execution.emit([event])).pipe(Effect.provideService(Database, database));
			return FacilitateSteps.of({
				attempt: (request, attempt) =>
					attemptFacilitation(request, attempt, execution).pipe(
						Effect.provideService(Database, database),
					),
				abandon: (request) =>
					announce(
						ConversationEvent.FacilitationFailed({
							threadId: request.threadId,
							userMessage: new FacilitationFailed().userMessage,
						}),
					),
				announceReleased: (request) =>
					announce(ConversationEvent.LaneReleased({ threadId: request.threadId })),
			});
		}),
	);

/** What the facilitator sees: who is here, and what was last said. */
export interface FacilitatorScope {
	threadId: string;
	threadType: ThreadType;
	workspaceId: string;
	/** The model the workspace chose for its Facilitator. */
	model: string;
	hostHandle: string;
	routerEnabled: boolean;
	/** Crew placed in the pod, marked with whether they are in the thread yet. */
	crew: Array<{
		id: string;
		name: string;
		handle: string;
		description: string | null;
		inThread: boolean;
	}>;
	people: Array<{ name: string; handle: string }>;
	/** Oldest first. */
	recent: Array<{ speaker: string; kind: "person" | "agent"; content: string }>;
}

export type FacilitatorDecision = { kind: "agent"; agentId: string } | { kind: "nobody" };

/**
 * One attempt at deciding who speaks next, and applying it. A failure is
 * logged and reported as `failed`, having changed nothing. An interruption is
 * left to the workflow, which runs the attempt again when it resumes.
 */
export const attemptFacilitation = (
	request: FacilitateRequest,
	attempt: number,
	execution: FacilitatorExecution,
): Effect.Effect<AttemptOutcome, never, Database> =>
	Effect.gen(function* () {
		const scope = yield* query((db) =>
			loadFacilitatorScope(db, request.threadId, request.triggerMessageId),
		);
		// No scope is a thread that has gone, or a workspace that has chosen no
		// model for its Facilitator. Neither becomes true by waiting, so the
		// facilitation is done rather than failed.
		if (!scope?.routerEnabled || scope.threadType === "chat") return decided;
		const decision = yield* decide(scope, execution.model).pipe(
			// After the last ask, nobody speaks. A facilitator that cannot be
			// understood should not hold up the thread, and a person can always
			// address someone by name.
			Effect.catchTag("UnusableAnswer", (why) =>
				Effect.logInfo(`Facilitator fell back to nobody: ${why.reason}`).pipe(
					Effect.as({ kind: "nobody" } as const),
				),
			),
		);
		yield* applyDecision(execution, request, scope, decision);
		return decided;
	}).pipe(
		Effect.catch((failure) => attemptFailed(attempt, failure)),
		Effect.catchDefect((defect) => attemptFailed(attempt, defect)),
	);

const decided: AttemptOutcome = "decided";

const attemptFailed = (attempt: number, failure: unknown) =>
	Effect.logWarning(`Facilitation attempt ${attempt} failed`, failure).pipe(
		Effect.as<AttemptOutcome>("failed"),
	);

/** Queues the chosen agent's turn, inviting it into the thread first if it is not there yet. */
const applyDecision = (
	execution: FacilitatorExecution,
	request: FacilitateRequest,
	scope: FacilitatorScope,
	decision: FacilitatorDecision,
) => {
	if (decision.kind === "nobody") return Effect.void;
	return transaction(
		Effect.gen(function* () {
			const chosen = scope.crew.find((member) => member.id === decision.agentId);
			if (chosen && !chosen.inThread) {
				yield* query((db) =>
					db
						.insert(threadParticipant)
						.values({ threadId: scope.threadId, agentId: chosen.id })
						.onConflictDoNothing(),
				);
				yield* execution.emit([
					ConversationEvent.AgentsJoined({ threadId: scope.threadId, agentIds: [chosen.id] }),
				]);
			}
			yield* execution.requests.queueTurn({
				threadId: scope.threadId,
				agentId: decision.agentId,
				triggerMessageId: request.triggerMessageId,
				reason: "facilitator",
			});
		}),
	);
};

/** Asks the model, within the time limit, and reads its one-word answer. */
const decide = (
	scope: FacilitatorScope,
	model: TurnModel,
): Effect.Effect<
	FacilitatorDecision,
	ModelRequestFailed | AnswerTimedOut | UnusableAnswer,
	Database
> =>
	Effect.scoped(
		Effect.gen(function* () {
			const stop = new AbortController();
			yield* Effect.addFinalizer(() => Effect.sync(() => stop.abort()));
			const generated = yield* model.stream(facilitatorPrompt(scope, stop.signal));
			const collected = yield* Ref.make("");
			yield* forEachDelta(generated.text, stop, (text) =>
				Ref.updateAndGet(collected, (soFar) => soFar + text).pipe(
					Effect.filterOrFail(
						(soFar) => soFar.length <= MAX_ANSWER_CHARACTERS,
						() => new UnusableAnswer({ reason: "Facilitator returned too much text" }),
					),
					Effect.asVoid,
				),
			);
			const answer = yield* Ref.get(collected);
			const decision = parseDecision(answer, scope);
			return decision === undefined
				? yield* new UnusableAnswer({
						reason: `Facilitator answered with something other than a handle: ${JSON.stringify(answer.slice(0, 60))}`,
					})
				: decision;
		}),
	).pipe(
		Effect.timeoutOrElse({
			duration: FACILITATOR_TIMEOUT,
			orElse: () => Effect.fail(new AnswerTimedOut({ message: "Facilitator timed out" })),
		}),
		// The timeout is inside, so each attempt gets its own budget and a slow
		// model is not asked three times over.
		retryUnusable,
	);

/**
 * A handle from the list, with or without `@`, or `nobody`.
 *
 * `undefined` means the answer was not one of the choices, which is different
 * from the model choosing nobody: one is worth asking again, the other is an
 * answer. Naming a person counts as an answer — the rules ask for `nobody`
 * when a person is addressed, and saying who is the same decision.
 */
export function parseDecision(
	answer: string,
	scope: FacilitatorScope,
): FacilitatorDecision | undefined {
	const word = answer
		.trim()
		.split(/\s+/)[0]
		?.replace(/^@/, "")
		.replace(/[.,;:!]+$/, "")
		.toLowerCase();
	if (!word) {
		return undefined;
	}
	const chosen = scope.crew.find((member) => member.handle === word);
	if (chosen) {
		return { kind: "agent", agentId: chosen.id };
	}
	const addressed = word === "nobody" || scope.people.some((person) => person.handle === word);
	return addressed ? { kind: "nobody" } : undefined;
}

/**
 * Asks who speaks next.
 *
 * Written so the decision is mechanical rather than a judgement. The first
 * version left the model to decide whether "the exchange is plainly over",
 * gave every concrete rule a person's message as its subject, and listed the
 * handles as structure while `nobody` was one word inside a paragraph. Asked
 * after an agent had spoken, no rule applied and the only shaped option was
 * the list — so it picked from the list every time, and two agents talked to
 * each other until the run cap stopped them.
 *
 * So: `nobody` is stated as the default, the case that actually recurs (an
 * agent just spoke) has its own rule, and the message being decided about is
 * named instead of left at the end of a transcript.
 */
export function facilitatorPrompt(scope: FacilitatorScope, signal: AbortSignal): TurnModelInput {
	const agents = scope.crew.map(
		(member) =>
			`- @${member.handle}: ${member.name}, agent${member.inThread ? "" : " (not in the thread yet)"}${member.description ? `. ${member.description}` : ""}`,
	);
	const people = scope.people.map((person) => `- @${person.handle}: ${person.name}, person`);
	const transcript = scope.recent
		.map((entry) => `${entry.speaker} (${entry.kind}): ${entry.content}`)
		.join("\n\n");
	const last = scope.recent.at(-1);
	const question = last
		? `The last message is from ${last.speaker}, ${last.kind === "agent" ? "an agent" : "a person"}. Who speaks next?`
		: "Nobody has spoken yet. Who speaks next?";
	return {
		workspaceId: scope.workspaceId,
		model: scope.model,
		signal,
		system: [
			"You decide who speaks next in a group conversation between people and agents.",
			`Answer with exactly one of: ${[...scope.crew.map((member) => `@${member.handle}`), "nobody"].join(", ")}. No other words, no punctuation, no explanation.`,
			"nobody is the right answer most of the time. The people in the conversation hold the floor; an agent only takes it when there is something specific for it to answer.",
			[
				"Answer with an agent only when one of these is true:",
				"- The last message is from a person and asks something the agents should answer. Choose the agent whose description fits the question best, or the host when none fits.",
				"- The last message names one agent and puts a direct question to them. Choose that agent.",
			].join("\n"),
			[
				"Answer nobody when any of these is true:",
				"- The last message is from an agent and does not put a direct question to another agent. Adding to, agreeing with, reflecting on, or naming other agents as worth asking is not a question to them.",
				"- The last message is addressed to a person, or asks a person something.",
				"- The question that started the exchange has been answered.",
				"An agent that has just answered does not need another agent to follow it.",
			].join("\n"),
			`Host: @${scope.hostHandle}`,
			["Agents:", ...agents].join("\n"),
			["People:", ...people].join("\n"),
		].join("\n\n"),
		messages: [
			{
				role: "user",
				content: transcript ? `${transcript}\n\n---\n${question}` : "(no messages yet)",
			},
		],
	};
}

/**
 * What the facilitator needs to decide, minus the agent that just spoke.
 *
 * An agent answering itself is never the right call, and leaving it on the
 * list meant a small facilitator model picked it — twice in a row, then back and
 * forth with the host until the run cap stopped the thread. Taking it off the
 * list makes that unsayable rather than merely discouraged.
 */
export const loadFacilitatorScope = Effect.fn("Facilitator.loadFacilitatorScope")(function* (
	db: Executor,
	threadId: string,
	triggerMessageId: string,
): Effect.fn.Return<FacilitatorScope | undefined, QueryFailure> {
	const [scope] = yield* db
		.select({
			workspaceId: thread.workspaceId,
			podId: thread.podId,
			threadType: thread.type,
			hostHandle: agent.handle,
			routing: pod.routing,
		})
		.from(thread)
		.innerJoin(pod, eq(pod.id, thread.podId))
		.innerJoin(agent, eq(agent.id, thread.hostAgentId))
		.where(eq(thread.id, threadId))
		.limit(1);
	if (!scope) {
		return undefined;
	}
	// No model, no facilitation. Borrowing the host's would put a question
	// nobody asked in front of a model nobody chose for the job, and a pod
	// cannot switch routing on before this model is chosen anyway.
	const facilitator = yield* findRunnableSystemAgent(
		db,
		scope.workspaceId,
		FACILITATE_SYSTEM_AGENT,
	);
	if (!facilitator) {
		return undefined;
	}
	const [justSpoke] = yield* db
		.select({ agentId: message.authorAgentId })
		.from(message)
		.where(and(eq(message.id, triggerMessageId), eq(message.threadId, threadId)))
		.limit(1);
	// One query at a time: inside a transaction the executor is a single
	// connection, and queries sent concurrently down one are not run concurrently
	// anyway. The driver queues them, and warns that it is about to stop accepting
	// them at all.
	const crewRows = yield* db
		.select({
			id: agent.id,
			name: agent.name,
			handle: agent.handle,
			description: agent.description,
		})
		.from(agent)
		.where(and(eq(agent.podId, scope.podId), isNull(agent.systemAgentKey)))
		.orderBy(agent.name);
	const participantRows = yield* db
		.select({ agentId: threadParticipant.agentId, personName: user.name })
		.from(threadParticipant)
		.leftJoin(user, eq(user.id, threadParticipant.userId))
		.where(eq(threadParticipant.threadId, threadId));
	const recentRows = yield* db
		.select({
			content: message.content,
			personName: user.name,
			agentName: agent.name,
			agentHandle: agent.handle,
		})
		.from(message)
		.leftJoin(user, eq(user.id, message.authorUserId))
		.leftJoin(agent, eq(agent.id, message.authorAgentId))
		.where(and(eq(message.threadId, threadId), eq(message.status, "complete")))
		.orderBy(desc(message.createdAt), desc(message.id))
		.limit(CONTEXT_MESSAGES);
	const inThread = new Set(participantRows.flatMap((row) => (row.agentId ? [row.agentId] : [])));
	return {
		threadId,
		threadType: scope.threadType,
		workspaceId: scope.workspaceId,
		model: facilitator.model,
		hostHandle: scope.hostHandle,
		routerEnabled: scope.routing.facilitator,
		crew: crewRows
			.filter((row) => row.id !== justSpoke?.agentId)
			.map((row) => ({ ...row, inThread: inThread.has(row.id) })),
		people: participantRows.flatMap((row) =>
			row.personName ? [{ name: row.personName, handle: handleOf(row.personName) }] : [],
		),
		recent: recentRows.reverse().map((row) =>
			row.agentHandle
				? { speaker: `@${row.agentHandle}`, kind: "agent" as const, content: row.content }
				: {
						speaker: `@${handleOf(row.personName ?? "someone")}`,
						kind: "person" as const,
						content: row.content,
					},
		),
	};
});

function handleOf(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}
