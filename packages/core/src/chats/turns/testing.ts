import { handleFromName, type Message } from "@sugabots/contracts";
import { and, asc, eq, ne } from "drizzle-orm";
import { type Context, Effect, Layer, Schema } from "effect";
import { TurnAuthentication } from "../../authentication/turn.ts";
import { query } from "../../database/database.ts";
import { EventBus } from "../../database/events/bus.ts";
import { bot, connector } from "../../database/schema.ts";
import { onDatabase, runOnPostgres, type TestInfrastructure } from "../../database/testing.ts";
import { createWorkspaceFixture } from "../../database/workspace.test-support.ts";
import type { AsMember } from "../../operations/chats/testing.ts";
import { askForApprovals, asRunningTurn } from "../../operations/running-turn.ts";
import type { BotPrincipal } from "../../principal.ts";
import type { RunsTurn } from "../../proofs/runs-turn.ts";
import { Models } from "../../providers/models/models.ts";
import { unusedModel } from "../../providers/models/testing.ts";
import { unimplemented } from "../../testing.ts";
import { lane, laneRequest } from "../../workflows/sql.ts";
import { startBotChat } from "../chats/testing.ts";
import { lanesForTests } from "../testing.ts";
import { turnWorkflowForTests } from "../turn-workflow.test-support.ts";
import { type TurnContext, TurnExecution, type TurnRun } from "./execution.ts";
import type { ApprovalBinding, TurnEnding } from "./loop-values.ts";
import { TurnRecords } from "./records.ts";
import { TURN_WORKFLOW, TurnRequest, TurnRequests, turnLane } from "./requests.ts";
import { TurnRuns } from "./runs.ts";
import { type ReplyDraft, type ReplyTurn, TurnStore } from "./store.ts";
import { ToolCallStore } from "./tool-calls/store.ts";

export {
	turnRequestsForTests,
	turnSignalsForTests,
	turnWorkflowForTests,
} from "../turn-workflow.test-support.ts";
// Turn internals the cases outside `turns/` drive or inspect directly.
export { modelPrompt } from "./context.ts";
export { type TurnContext, TurnExecution, type TurnRun } from "./execution.ts";
export { TurnRecords } from "./records.ts";
export { turnLane } from "./requests.ts";
export { TurnRuns } from "./runs.ts";
export { TurnSignals } from "./signals.ts";
export { AUTOMATION_RUN_ENDED, type TurnCheckpoint, TurnStore } from "./store.ts";
export { ToolCallStore } from "./tool-calls/store.ts";

/**
 * The services a case drives a turn through as the bot loop would, which
 * `Turns.layer` hides; built over the chat services. Their model requests
 * reach no model.
 */
export const turnInternalsForTests = Layer.mergeAll(
	TurnRecords.layer.pipe(
		Layer.provide(
			Layer.mergeAll(
				Layer.succeed(Models.Service, unusedModel()),
				unimplemented(EventBus.Service, {}),
			),
		),
	),
	TurnRuns.layer,
	TurnExecution.layer,
	TurnStore.layer,
	ToolCallStore.layer,
	TurnAuthentication.layer,
);

/*
 * Turns for the Postgres cases. They are asked for through real lanes, but
 * their workflows here only hold their lanes: a case runs a turn itself, with
 * `openTurn` and the helpers after it, and frees the lane with `releaseTurn`.
 * `lanesForTests` is read only when a helper runs, as `../testing.ts` imports
 * this file.
 */

export const queueTurnForTests = (request: TurnRequest) =>
	Effect.flatMap(lanesForTests, (lanes) =>
		lanes.admit({
			...TurnRequests.admission(request),
			workflow: turnWorkflowForTests,
			payload: request,
		}),
	);

/** The run of the turn `request` asks for, by the workflow execution running it. */
export const turnRunFor = (request: TurnRequest) =>
	Effect.map(
		turnWorkflowForTests.executionId(request),
		(executionId): TurnRun => ({ executionId, request }),
	);

/** The turns running in the chat, each as its workflow runs it. */
export const runningTurns = (chatId: string) =>
	query((db) =>
		db
			.select()
			.from(lane)
			.where(
				and(eq(lane.subject, chatId), eq(lane.workflow, TURN_WORKFLOW), ne(lane.state, "idle")),
			),
	).pipe(
		Effect.flatMap((rows) => Effect.forEach(rows, (row) => turnRunFor(decodeRequest(row.payload)))),
	);

/** The turns asked for while the bot's turn in the chat runs, oldest first. */
export const waitingTurns = (request: Pick<TurnRequest, "chatId" | "botId">) =>
	Effect.map(
		query((db) =>
			db
				.select()
				.from(laneRequest)
				.where(eq(laneRequest.laneKey, turnLane(request)))
				.orderBy(asc(laneRequest.createdAt), asc(laneRequest.id)),
		),
		(rows) => rows.map((row) => decodeRequest(row.payload)),
	);

/** Frees the turn's lane, as its workflow's last step does, starting the turn waiting in it. */
export const releaseTurn = (run: TurnRun) =>
	Effect.flatMap(lanesForTests, (lanes) =>
		lanes.release({ key: turnLane(run.request), executionId: run.executionId }),
	);

/** A turn opened for its run and authenticated, as the bot loop's workflow has it before its first step. */
export interface OpenedTurnForTests {
	readonly run: TurnRun;
	readonly turnId: string;
	readonly replyMessageId: string;
	/** The reply as opening the turn left it: `writing`. */
	readonly reply: Message;
	readonly principal: BotPrincipal;
}

/**
 * Opens the turn for `run` and authenticates its principal, as the bot loop's
 * workflow does before its first step. Dies when the turn may not run.
 */
export const openTurn = (run: TurnRun) =>
	Effect.gen(function* () {
		const runs = yield* TurnRuns.Service;
		const opened = yield* runs.open(run);
		if (opened._tag !== "Opened") {
			return yield* Effect.die(new Error(`The turn may not run: ${opened.reason}`));
		}
		const authentication = yield* TurnAuthentication.Service;
		const principal = yield* Effect.orDie(authentication.authenticate(opened.turnId));
		const turn: OpenedTurnForTests = {
			run,
			turnId: opened.turnId,
			replyMessageId: opened.reply.id,
			reply: opened.reply,
			principal,
		};
		return turn;
	});

/** Where `turn` and its reply are, as the store's commands with no principal take it. */
export function replyTurnOf(turn: OpenedTurnForTests): ReplyTurn {
	return {
		turnId: turn.turnId,
		chatId: turn.run.request.chatId,
		workspaceId: turn.principal.workspace,
		botId: turn.principal.bot,
		messageId: turn.replyMessageId,
	};
}

/**
 * Runs an Effect against the test database over `services`, the chat services
 * and turn internals a case built with `chatServicesForTests`, so a case can
 * drive a turn with the helpers here.
 */
export const runOver =
	<Services>(services: Context.Context<Services>) =>
	<A, E>(effect: Effect.Effect<A, E, Services | TestInfrastructure>): Promise<A> =>
		runOnPostgres(
			// What `services` doesn't hold, the test infrastructure does.
			Effect.provideContext(effect, services) as Effect.Effect<A, E, TestInfrastructure>,
		);

/** Runs `use` with the proof that `turn`'s principal runs it, as `RunningTurn` does. */
export const asTheLoop = <A, E, R>(
	turn: OpenedTurnForTests,
	use: <P, T>(runsTurn: RunsTurn<P, T>) => Effect.Effect<A, E, R>,
) => asRunningTurn(turn.principal, use).pipe(Effect.orDie);

/** What the model is told for `turn`, as its step loads it. */
export const contextOf = (turn: OpenedTurnForTests) =>
	Effect.flatMap(TurnExecution.Service, (execution) => execution.context(turn.turnId));

/** A turn opened for its run, with what the model is told, as its first step has them. */
export interface PreparedTurnForTests extends OpenedTurnForTests {
	readonly context: TurnContext;
}

/**
 * Opens the turn for `run`, authenticates it and loads what the model is
 * told, as the bot loop's workflow and first step do. Dies when the turn may
 * not run.
 */
export const prepareTurn = (run: TurnRun) =>
	Effect.gen(function* () {
		const opened = yield* openTurn(run);
		const context = yield* contextOf(opened);
		const prepared: PreparedTurnForTests = { ...opened, context };
		return prepared;
	});

/** Writes `draft` as `turn`'s reply, as its step's model request does. */
export const writeReply = (turn: OpenedTurnForTests, draft: ReplyDraft | string) =>
	asTheLoop(turn, (runsTurn) =>
		Effect.flatMap(TurnStore.Service, (turns) =>
			turns.keepReply(
				runsTurn,
				typeof draft === "string" ? { content: draft, toolCalls: [] } : draft,
			),
		),
	);

/** Ends `turn`'s run as `ending` says, as the loop does; says whether a failed turn runs again. */
export const endTurn = (turn: OpenedTurnForTests, ending: TurnEnding) =>
	asTheLoop(turn, (runsTurn) =>
		Effect.flatMap(TurnRecords.Service, (records) => records.end(runsTurn, ending)),
	);

/**
 * Answers `turn` with `text` and completes it, as a step whose model request
 * answers without calling a tool does: the text follows what the reply says
 * already, and the calls placed in it, and that request's prompt measured
 * `contextTokens`, when given.
 */
export const completeTurn = (turn: OpenedTurnForTests, text: string, contextTokens?: number) =>
	asTheLoop(turn, (runsTurn) =>
		Effect.gen(function* () {
			const turns = yield* TurnStore.Service;
			const { checkpoint } = yield* turns.current(runsTurn);
			const earlier = checkpoint?.reply ?? { content: "", toolCalls: [] };
			yield* turns.recordModelRequest(runsTurn, {
				modelInput: { model: "test", system: "", messages: [] },
				messages: [{ role: "assistant", content: text }],
				reply: { ...earlier, content: earlier.content + text },
				contextTokens,
				calls: [],
				last: false,
			});
			const records = yield* TurnRecords.Service;
			return yield* records.end(runsTurn, { kind: "answered" });
		}),
	);

/**
 * Parks `turn` until its approvers decide `approvals`, as a step whose calls
 * wait for approval does. Says which approvals it waits for.
 */
export const parkTurn = (
	turn: OpenedTurnForTests,
	approvals: Parameters<TurnRecords.Interface["askForApprovals"]>[2],
	step = 0,
) => askForApprovals(turn.principal, step, approvals).pipe(Effect.orDie);

/**
 * Records that `turn`'s step `step` is sending a call to `tool`, as the loop
 * does before it sends one. Returns the recorded call's id.
 */
export const recordToolCall = (
	turn: OpenedTurnForTests,
	call: {
		readonly toolCallId: string;
		readonly tool: string;
		readonly input: unknown;
		readonly writeOrDelete?: boolean;
		readonly binding?: ApprovalBinding;
	},
	step = 0,
) =>
	asTheLoop(turn, (runsTurn) =>
		Effect.flatMap(TurnRecords.Service, (records) =>
			Effect.map(
				records.recordToolCall(runsTurn, {
					writeOrDelete: false,
					binding: { kind: "built-in" },
					...call,
					step,
				}),
				({ id }) => id,
			),
		),
	);

/** A stored lane payload, as the turn's request. */
function decodeRequest(payload: unknown): TurnRequest {
	return Schema.decodeUnknownSync(Schema.toCodecJson(TurnRequest))(payload);
}

/**
 * A bot whose admin has asked it something in a chat, so
 * its turn is asked for in the chat.
 */
export async function aChatAwaitingReply(
	chatsAs: (memberId: string) => Pick<AsMember, "startProjectChat">,
) {
	const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const {
		workspace: created,
		members: { admin },
	} = await createWorkspaceFixture(
		{ name: `Turns ${suffix}`, slug: `turns-${suffix}` },
		{ admin: { name: "Sam", email: `turns-${suffix}@example.com`, role: "admin" } },
	);
	const workspaceId = created.id;
	const adminId = admin.id;
	const [chatBot] = await onDatabase((db) =>
		db
			.insert(bot)
			.values({
				workspaceId,
				name: `Bot ${suffix}`,
				handle: handleFromName(`Bot ${suffix}`),
				color: "rose",
				eyes: "pill",
				model: "m",
				createdById: adminId,
			})
			.returning({ id: bot.id }),
	);
	if (!chatBot) throw new Error("fixture");
	const started = await startBotChat(chatsAs(adminId), {
		botId: chatBot.id,
		messageId: crypto.randomUUID(),
		content: "What does example.com say?",
	});
	const opened = started.chat;
	if (!opened.projectId) throw new Error("The fixture chat needs a project");
	return {
		workspaceId,
		adminId,
		botId: chatBot.id,
		chatId: opened.id,
		projectId: opened.projectId,
	};
}

export async function aChatWithConnectorAwaitingReply(
	chatsAs: Parameters<typeof aChatAwaitingReply>[0],
) {
	const chat = await aChatAwaitingReply(chatsAs);
	const { workspaceId, botId, adminId, projectId } = chat;
	const suffix = botId;
	const [connected] = await onDatabase((db) =>
		db
			.insert(connector)
			.values({
				workspaceId,
				projectId,
				name: `Linear ${suffix}`,
				handle: `linear-${suffix}`,
				url: "https://linear.example.com/mcp",
				authKind: "header",
				createdById: adminId,
			})
			.returning({ id: connector.id }),
	);
	if (!connected) throw new Error("fixture");
	return { ...chat, connectorId: connected.id };
}
