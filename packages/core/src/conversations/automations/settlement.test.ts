import type { WrittenFilePart } from "@sugabots/contracts";
import { type UserText, userText } from "@sugabots/errors";
import { eq, sql } from "drizzle-orm";
import { Context, Effect } from "effect";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { beforeCommit, type Database, query, transaction } from "../../database/database.ts";
import type { CommittedEvent } from "../../database/events/outbox.ts";
import {
	automation,
	automationRun,
	collaboration,
	lane,
	laneRequest,
	message,
	placedConversation,
	toolCall,
	turn,
} from "../../database/schema.ts";
import {
	closeDatabase,
	onDatabase,
	onPostgres,
	type Promised,
	runOnPostgres,
} from "../../database/testing.ts";
import { onPostgresAs } from "../../workspaces/testing.ts";
import { ChatView } from "../chats/chat-view.ts";
import { ConversationEvents } from "../conversation-events.ts";
import { ConversationEvent } from "../events.ts";
import { seedConversation } from "../seed.test-support.ts";
import { conversationsForTests } from "../testing.ts";
import {
	prepareRunnable,
	queueTurnForTests,
	releaseTurn,
	replyTurnOf,
	runningTurns,
	ToolCallRepository,
	Turn,
	type TurnCheckpoint,
	TurnExecution,
	TurnRepository,
	turnLane,
} from "../turns/testing.ts";
import type { Turns } from "../turns/turns.ts";
import { AutomationRunner } from "./automation-runner.ts";
import { Automations } from "./automations.ts";
import { AutomationSettlement } from "./settlement.ts";
import { anAutomationOwner, finishTurnsIn, releaseRun, startRunning } from "./testing.ts";

/**
 * Automation settlement against Postgres, driven by the events that settle a
 * run, as the services and workflows emit them.
 */
describe.skipIf(!process.env.DATABASE_URL)("automation settlement, against Postgres", async () => {
	let delivered: CommittedEvent[] = [];
	const bus = {
		publishCommitted: async (events: CommittedEvent[]) => {
			delivered.push(...events);
		},
	};
	const conversations = await conversationsForTests(bus);
	const { emit } = Context.get(conversations, ConversationEvents.Service);
	/** As the automations' owner, who administers their workspace. */
	let automations: Promised<Automations.Interface>;
	const { settleRun, failRun } = Context.get(conversations, AutomationSettlement.Service);
	const settlement = onPostgres({ settleRun, failRun });
	const runner = onPostgres(Context.get(conversations, AutomationRunner.Service));
	const turns = onPostgres(Context.get(conversations, TurnRepository.Service));
	const toolCalls = onPostgres(Context.get(conversations, ToolCallRepository.Service));
	const execution = onPostgres({
		prepare: Context.get(conversations, TurnExecution.Service).prepare,
	});
	/** Emits `events` in a transaction of their own, as a service would. */
	const announce = (...events: ConversationEvent[]) => runOnPostgres(transaction(emit(events)));
	/** An event ending the turn in `conversationId` early, as `outcome`. */
	const ended = (conversationId: string, outcome: Turns.Ended) =>
		ConversationEvent.TurnAbandoned({ conversationId, botId, outcome });
	const failed = (error: UserText): Turns.Ended => ({ state: "failed", error });
	const executionOf = async (runId: string) => {
		const [row] = await onDatabase((db) =>
			db.select().from(automationRun).where(eq(automationRun.id, runId)),
		);
		return row;
	};
	let workspaceId: string;
	let botId: string;
	let ownProjectId: string;
	let userId: string;

	afterAll(async () => {
		await closeDatabase();
	});

	beforeEach(async () => {
		delivered = [];
		({ workspaceId, botId, userId, ownProjectId } = await anAutomationOwner());
		automations = onPostgresAs(userId)(Context.get(conversations, Automations.Service));
	});

	/** An automation with one accepted manual trigger, whose run has started and asked for its turn. */
	async function aRunningRun() {
		const created = await automations.create(
			{ projectId: ownProjectId },
			{
				name: `Settlement ${crypto.randomUUID()}`,
				instructions: "Complete the delegated work.",
				triggers: [{ kind: "webhook" }],
			},
		);
		const requestId = crypto.randomUUID();
		const accepted = await automations.run({
			projectId: ownProjectId,
			automationId: created.automation.id,
			requestId,
		});
		const started = await startRunning(runner, created.automation.id);
		if (started.execution.id !== accepted.runId) {
			throw new Error("Could not start settlement test execution");
		}
		return { accepted, run: started.run };
	}

	/**
	 * A running run whose turn delegated to a collaborator: the asking turn is
	 * done, its collaboration is `status`, and the run's turn workflow still
	 * holds its lane.
	 */
	async function aRunWithCollaboration(status: "waiting" | "pending") {
		const { accepted, run } = await aRunningRun();
		const [triggerMessage] = await onDatabase((db) =>
			db
				.select({ id: message.id })
				.from(message)
				.where(eq(message.conversationId, accepted.conversationId)),
		);
		if (!triggerMessage) throw new Error("Settlement test trigger message is missing");
		const now = new Date();
		const [askingTurn] = await onDatabase((db) =>
			db
				.insert(turn)
				.values({
					conversationId: accepted.conversationId,
					botId,
					triggerMessageId: triggerMessage.id,
					status: "done",
					model: "test/model",
					startedAt: now,
					finishedAt: now,
				})
				.returning(),
		);
		if (!askingTurn) throw new Error("Could not create settlement test turn");
		const [parentMessage] = await onDatabase((db) =>
			db
				.insert(message)
				.values({
					conversationId: accepted.conversationId,
					authorBotId: botId,
					kind: "text",
					status: "complete",
					parts: [],
					content: "Delegating.",
					turnId: askingTurn.id,
				})
				.returning(),
		);
		if (!parentMessage) throw new Error("Could not create settlement test asking message");
		const [placedRun] = await onDatabase((db) =>
			db
				.select({ rootConversationId: placedConversation.rootConversationId })
				.from(placedConversation)
				.where(eq(placedConversation.id, accepted.conversationId)),
		);
		const rootConversationId = placedRun?.rootConversationId;
		if (!rootConversationId) throw new Error("The run has no root conversation");
		const childConversation = await onDatabase((db) =>
			seedConversation(db, {
				workspaceId,
				kind: "collaboration",
				title: "Delegated work",
				collaboration: {
					parentConversationId: accepted.conversationId,
					rootConversationId,
					parentMessageId: parentMessage.id,
					turnId: askingTurn.id,
					collaboratorBotId: botId,
					brief: "Complete delegated work",
					status,
					atOffset: 0,
				},
			}),
		);
		const [activeCollaboration] = await onDatabase((db) =>
			db.select().from(collaboration).where(eq(collaboration.conversationId, childConversation.id)),
		);
		const [runningTurn] = await runOnPostgres(runningTurns(accepted.conversationId));
		if (!activeCollaboration || !runningTurn) {
			throw new Error("Could not create settlement test active work");
		}
		return { accepted, run, askingTurn, childConversation, activeCollaboration, runningTurn };
	}

	/**
	 * Ends the run's turn with `content` as its reply, which completes the run,
	 * after it wrote each of `writes` with `file_write`, in order.
	 */
	async function replyAndFinish(
		conversationId: string,
		content: string,
		writes: readonly Omit<WrittenFilePart, "type">[] = [],
	) {
		const [turnRun] = await runOnPostgres(runningTurns(conversationId));
		if (!turnRun) throw new Error("The run asked for no turn");
		const prepared = await prepareRunnable(execution, turnRun);
		const calls = [];
		for (const written of writes) {
			const opened = await toolCalls.open({
				conversationId,
				messageId: prepared.responseMessage.id,
				turnId: prepared.turnId,
				tool: "file_write",
				input: {},
				atOffset: 0,
				mutating: true,
			});
			await toolCalls.close(opened.id, { output: { status: "written", ...written } });
			calls.push({ id: opened.id, atOffset: 0 });
		}
		// Freed first, so completing the turn finishes the run's work.
		await runOnPostgres(releaseTurn(turnRun));
		await turns.complete(
			replyTurnOf(prepared),
			{ content, collaborations: [], toolCalls: calls },
			{ contextCapacity: 128_000, readKeptFrom: null },
		);
	}

	/**
	 * A turn of the run, done a minute ago, whose reply wrote each of `writes`
	 * with `file_write`: the run asked somebody something and carried on
	 * in a later turn.
	 */
	async function anEarlierTurnWrote(
		conversationId: string,
		writes: readonly Omit<WrittenFilePart, "type">[],
	) {
		const finishedAt = new Date(Date.now() - 60_000);
		// Its own trigger, so the run's turn waiting on the run's trigger still runs.
		const [trigger] = await onDatabase((db) =>
			db
				.insert(message)
				.values({
					conversationId,
					authorBotId: botId,
					kind: "text",
					status: "complete",
					parts: [],
					content: "Earlier work.",
					createdAt: finishedAt,
				})
				.returning(),
		);
		if (!trigger) throw new Error("Could not create the earlier turn's trigger");
		const [earlier] = await onDatabase((db) =>
			db
				.insert(turn)
				.values({
					conversationId,
					botId,
					triggerMessageId: trigger.id,
					status: "done",
					model: "test/model",
					startedAt: finishedAt,
					finishedAt,
				})
				.returning(),
		);
		if (!earlier) throw new Error("Could not create the earlier turn");
		const [reply] = await onDatabase((db) =>
			db
				.insert(message)
				.values({
					conversationId,
					authorBotId: botId,
					kind: "text",
					status: "complete",
					parts: [],
					content: "Asking first.",
					turnId: earlier.id,
					createdAt: finishedAt,
				})
				.returning(),
		);
		if (!reply) throw new Error("Could not create the earlier reply");
		await onDatabase((db) =>
			db.insert(toolCall).values(
				writes.map((written) => ({
					conversationId,
					messageId: reply.id,
					turnId: earlier.id,
					tool: "file_write",
					input: {},
					output: { status: "written", ...written },
					status: "completed" as const,
					mutating: true,
					atOffset: 0,
					startedAt: finishedAt,
					finishedAt,
				})),
			),
		);
	}

	/** The messages posted as the run's result, which open the run. */
	const resultsOf = (runId: string) =>
		onDatabase((db) =>
			db
				.select({
					message,
					conversationKind: placedConversation.kind,
					rootConversationId: placedConversation.rootConversationId,
				})
				.from(message)
				.innerJoin(placedConversation, eq(placedConversation.id, message.conversationId))
				.where(eq(message.runId, runId)),
		);

	/** Marks the fixture's asking turn as running again, as a workflow holding it would. */
	const runAgain = (turnId: string) =>
		onDatabase((db) =>
			db.update(turn).set({ status: "running", finishedAt: null }).where(eq(turn.id, turnId)),
		);

	it("fails a run whose workflow failed at once, while its turn still runs, so the next run can start", async () => {
		const created = await automations.create(
			{ projectId: ownProjectId },
			{
				name: "Failing run",
				instructions: "Do the work.",
				triggers: [{ kind: "webhook" }],
			},
		);
		const accepted = [];
		for (let run = 0; run < 2; run++) {
			const requestId = crypto.randomUUID();
			accepted.push(
				await automations.run({
					projectId: ownProjectId,
					automationId: created.automation.id,
					requestId,
				}),
			);
		}
		const first = await startRunning(runner, created.automation.id);

		await settlement.failRun(first.run);
		await runOnPostgres(releaseRun(first.run));

		expect(await executionOf(first.execution.id)).toMatchObject({
			state: "failed",
			error: "The automation run stopped unexpectedly",
			finishedAt: expect.any(Date),
		});
		const next = await startRunning(runner, created.automation.id);
		expect(next.execution).toMatchObject({ id: accepted[1]?.runId, state: "running" });
	});

	it("fails a run whose workflow failed before starting it", async () => {
		const created = await automations.create(
			{ projectId: ownProjectId },
			{
				name: "Never started",
				instructions: "Do the work.",
				triggers: [{ kind: "webhook" }],
			},
		);
		const requestId = crypto.randomUUID();
		const accepted = await automations.run({
			projectId: ownProjectId,
			automationId: created.automation.id,
			requestId,
		});

		await settlement.failRun({ automationId: created.automation.id, runId: accepted.runId });

		expect(await executionOf(accepted.runId)).toMatchObject({
			state: "failed",
			error: "The automation run stopped unexpectedly",
		});
	});

	it.each([
		{
			outcome: failed(userText`Model failed`),
			collaborationStatus: "waiting" as const,
		},
		{ outcome: { state: "cancelled" } as const, collaborationStatus: "pending" as const },
	])(
		"ends a run early as $outcome.state despite a $collaborationStatus collaboration",
		async ({ outcome, collaborationStatus }) => {
			const fixture = await aRunWithCollaboration(collaborationStatus);
			// Asked for while the first turn runs, so it waits in the lane.
			await runOnPostgres(
				queueTurnForTests({
					conversationId: fixture.accepted.conversationId,
					botId,
					triggerMessageId: crypto.randomUUID(),
					reason: "automation",
				}),
			);

			await announce(ended(fixture.childConversation.id, outcome));

			const [settledCollaboration] = await onDatabase((db) =>
				db.select().from(collaboration).where(eq(collaboration.id, fixture.activeCollaboration.id)),
			);
			const waitingTurns = await onDatabase((db) =>
				db
					.select()
					.from(laneRequest)
					.where(
						eq(
							laneRequest.laneKey,
							turnLane({ conversationId: fixture.accepted.conversationId, botId }),
						),
					),
			);
			expect(await executionOf(fixture.accepted.runId)).toMatchObject({
				state: outcome.state,
				error: outcome.state === "failed" ? outcome.error : null,
				finishedAt: expect.any(Date),
			});
			expect(settledCollaboration?.status).toBe("failed");
			expect(delivered).toContainEqual(
				expect.objectContaining({
					event: expect.objectContaining({
						type: "collaboration.updated",
						collaboration: expect.objectContaining({ status: "failed" }),
					}),
				}),
			);
			expect(waitingTurns).toEqual([]);
		},
	);

	it("settles without waiting on the Summariser summarising the run's conversation", async () => {
		const { accepted, run } = await aRunningRun();
		await finishTurnsIn(accepted.conversationId);
		const [triggerMessage] = await onDatabase((db) =>
			db
				.select({ id: message.id })
				.from(message)
				.where(eq(message.conversationId, accepted.conversationId)),
		);
		if (!triggerMessage) throw new Error("Settlement test trigger message is missing");
		const summaryConversation = await onDatabase((db) =>
			seedConversation(db, {
				workspaceId,
				kind: "system",
				botId,
				systemBotKey: "summarise",
				title: "Summary",
				servedConversationId: accepted.conversationId,
			}),
		);
		await onDatabase((db) =>
			db.insert(turn).values({
				conversationId: summaryConversation.id,
				botId,
				triggerMessageId: triggerMessage.id,
				status: "running",
				model: "test/model",
				startedAt: new Date(),
			}),
		);

		expect(await settlement.settleRun(run)).toBe(true);
	});

	it("keeps a run going while its work remains active", async () => {
		const fixture = await aRunWithCollaboration("waiting");
		await runOnPostgres(releaseTurn(fixture.runningTurn));

		expect(await settlement.settleRun(fixture.run)).toBe(false);

		const [activeCollaboration] = await onDatabase((db) =>
			db.select().from(collaboration).where(eq(collaboration.id, fixture.activeCollaboration.id)),
		);
		expect(await executionOf(fixture.accepted.runId)).toMatchObject({
			state: "running",
			finishedAt: null,
		});
		expect(activeCollaboration?.status).toBe("waiting");
	});

	it("keeps a run going while a turn lane in its collaboration is busy", async () => {
		const fixture = await aRunWithCollaboration("waiting");
		await runOnPostgres(releaseTurn(fixture.runningTurn));
		await onDatabase((db) =>
			db
				.update(collaboration)
				.set({ status: "answered" })
				.where(eq(collaboration.id, fixture.activeCollaboration.id)),
		);
		const busy = {
			key: turnLane({ conversationId: fixture.childConversation.id, botId }),
			subject: fixture.childConversation.id,
			workflow: Turn._tag,
			state: "running" as const,
			executionId: crypto.randomUUID(),
		};
		await onDatabase((db) => db.insert(lane).values(busy));

		expect(await settlement.settleRun(fixture.run)).toBe(false);

		await onDatabase((db) =>
			db
				.update(lane)
				.set({ state: "idle", workflow: null, executionId: null })
				.where(eq(lane.key, busy.key)),
		);
		await announce(
			ConversationEvent.LaneReleased({ conversationId: fixture.childConversation.id }),
		);
		expect(await executionOf(fixture.accepted.runId)).toMatchObject({ state: "completed" });
	});

	it("tells the workflows of waiting turns to stop once a run ending early commits", async () => {
		const fixture = await aRunWithCollaboration("waiting");
		await onDatabase((db) =>
			db
				.update(turn)
				.set({ status: "waiting", owner: "workflow-execution" })
				.where(eq(turn.conversationId, fixture.accepted.conversationId)),
		);
		const sentBeforeCommit: number[] = [];
		const cancel = vi.fn((_owner: string) => Effect.void);
		const ending = await conversationsForTests(bus, { decide: () => Effect.void, cancel });

		await runOnPostgres(
			transaction(
				Effect.gen(function* () {
					yield* Context.get(ending, ConversationEvents.Service).emit([
						ended(fixture.childConversation.id, { state: "cancelled" }),
					]);
					// Queued behind the handlers, so it runs after settlement and before the commit.
					yield* beforeCommit(Effect.sync(() => sentBeforeCommit.push(cancel.mock.calls.length)));
				}),
			),
		);

		expect(sentBeforeCommit).toEqual([0]);
		expect(cancel).toHaveBeenCalledWith("workflow-execution");
		const [cancelled] = await onDatabase((db) =>
			db.select().from(turn).where(eq(turn.id, fixture.askingTurn.id)),
		);
		expect(cancelled?.status).toBe("cancelled");
	});

	it("asks a running turn to stop, and waits for it, before ending a run as failed", async () => {
		const fixture = await aRunWithCollaboration("waiting");
		await runAgain(fixture.askingTurn.id);

		await announce(ended(fixture.childConversation.id, failed(userText`Child model failed`)));

		const [stopping] = await onDatabase((db) =>
			db.select().from(turn).where(eq(turn.id, fixture.askingTurn.id)),
		);
		expect(await executionOf(fixture.accepted.runId)).toMatchObject({
			state: "running",
			pendingTerminalState: "failed",
			pendingTerminalError: "Child model failed",
			finishedAt: null,
		});
		expect(stopping?.cancelRequested).toBe(true);
		// The workflow running it hears at once, rather than on its next poll.
		expect(delivered).toContainEqual(
			expect.objectContaining({
				event: expect.objectContaining({
					type: "turn.cancel_requested",
					turnId: fixture.askingTurn.id,
				}),
			}),
		);

		await onDatabase((db) =>
			db
				.update(turn)
				.set({ status: "cancelled", finishedAt: new Date() })
				.where(eq(turn.id, fixture.askingTurn.id)),
		);
		await runOnPostgres(releaseTurn(fixture.runningTurn));
		expect(await settlement.settleRun(fixture.run)).toBe(true);
		expect(await executionOf(fixture.accepted.runId)).toMatchObject({
			state: "failed",
			error: userText`Child model failed`,
			pendingTerminalState: null,
			pendingTerminalError: null,
			finishedAt: expect.any(Date),
		});
	});

	it("refuses to open a turn once a run has started ending", async () => {
		const fixture = await aRunWithCollaboration("waiting");
		await runAgain(fixture.askingTurn.id);
		const [childTrigger] = await onDatabase((db) =>
			db
				.insert(message)
				.values({
					conversationId: fixture.childConversation.id,
					authorBotId: botId,
					kind: "text",
					status: "complete",
					parts: [],
					content: "Start child work.",
				})
				.returning(),
		);
		if (!childTrigger) throw new Error("Could not create settlement test child trigger");
		await runOnPostgres(
			queueTurnForTests({
				conversationId: fixture.childConversation.id,
				botId,
				triggerMessageId: childTrigger.id,
				reason: "collaboration",
			}),
		);
		const [childRun] = await runOnPostgres(runningTurns(fixture.childConversation.id));
		if (!childRun) throw new Error("Could not start settlement test child turn");

		await announce(ended(fixture.childConversation.id, failed(userText`Child model failed`)));

		expect(await execution.prepare(childRun)).toMatchObject({
			_tag: "NotRunnable",
			reason: "The automation run has ended",
		});
	});

	it("does not wait for a turn another transaction holds, and the turn's next step is refused", async () => {
		const { accepted, run } = await aRunningRun();
		const [turnRun] = await runOnPostgres(runningTurns(accepted.conversationId));
		if (!turnRun) throw new Error("The run asked for no turn");
		const prepared = await prepareRunnable(execution, turnRun);
		let letGo: () => void = () => {};
		const heldUntil = new Promise<void>((resolve) => {
			letGo = resolve;
		});
		let held: () => void = () => {};
		const holding = new Promise<void>((resolve) => {
			held = resolve;
		});
		const holder = runOnPostgres(
			transaction(
				Effect.gen(function* () {
					yield* query((db) =>
						db.select({ id: turn.id }).from(turn).where(eq(turn.id, prepared.turnId)).for("update"),
					);
					held();
					yield* Effect.promise(() => heldUntil);
				}),
			),
		);
		await holding;

		// Settles while the holder still has the turn locked: a wait here would never end.
		await announce(ended(accepted.conversationId, failed(userText`Model failed`)));
		letGo();
		await holder;

		const [skipped] = await onDatabase((db) =>
			db.select().from(turn).where(eq(turn.id, prepared.turnId)),
		);
		expect(skipped).toMatchObject({ status: "running", cancelRequested: false });
		expect(await executionOf(run.runId)).toMatchObject({
			state: "running",
			pendingTerminalState: "failed",
		});
		const draft = { content: "Half a reply", collaborations: [], toolCalls: [] };
		const replyTurn = replyTurnOf(prepared);
		expect(await turns.suspend(replyTurn, checkpointFor(draft), [])).toBe(false);

		await turns.cancel(replyTurn, draft);

		expect(await executionOf(run.runId)).toMatchObject({
			state: "failed",
			error: userText`Model failed`,
		});
	});

	it("lets a transaction holding a turn record the run's ending while settlement waits on that turn", async () => {
		const fixture = await aRunWithCollaboration("waiting");
		await onDatabase((db) =>
			db.update(turn).set({ status: "waiting" }).where(eq(turn.id, fixture.askingTurn.id)),
		);
		let letGo: () => void = () => {};
		const heldUntil = new Promise<void>((resolve) => {
			letGo = resolve;
		});
		let held: (pid: number) => void = () => {};
		const holderPid = new Promise<number>((resolve) => {
			held = resolve;
		});
		const holder = runOnPostgres(
			transaction(
				Effect.gen(function* () {
					yield* query((db) =>
						db
							.select({ id: turn.id })
							.from(turn)
							.where(eq(turn.id, fixture.askingTurn.id))
							.for("update"),
					);
					const [backend] = yield* query((db) =>
						db.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`, "objects"),
					);
					held(backend?.pid ?? 0);
					yield* Effect.promise(() => heldUntil);
					// Ends a turn in the run, as a turn writer holding its turn does.
					yield* emit([ended(fixture.childConversation.id, { state: "cancelled" })]);
				}),
			),
		);
		const pid = await holderPid;

		const failing = settlement.failRun(fixture.run);
		await vi.waitFor(async () => {
			const blocked = await onDatabase((db) =>
				db.execute<{ pid: number }>(
					sql`select pid from pg_stat_activity where ${pid} = any(pg_blocking_pids(pid))`,
					"objects",
				),
			);
			expect(blocked.length).toBeGreaterThan(0);
		});
		letGo();
		await Promise.all([holder, failing]);

		expect(await executionOf(fixture.run.runId)).toMatchObject({ state: "failed" });
		const [asking] = await onDatabase((db) =>
			db.select().from(turn).where(eq(turn.id, fixture.askingTurn.id)),
		);
		expect(asking?.status).toBe("cancelled");
	});

	it("tells watching clients a turn completed before it tells them the run settled", async () => {
		const { accepted, run } = await aRunningRun();
		const [turnRun] = await runOnPostgres(runningTurns(accepted.conversationId));
		if (!turnRun) throw new Error("The run asked for no turn");
		const prepared = await prepareRunnable(execution, turnRun);
		// Freed first, so completing the turn finishes the run's work.
		await runOnPostgres(releaseTurn(turnRun));
		delivered = [];

		await turns.complete(
			replyTurnOf(prepared),
			{ content: "Done.", collaborations: [], toolCalls: [] },
			{ contextCapacity: 128_000, readKeptFrom: null },
		);

		const types = delivered.map(({ event }) => event.type);
		const completed = types.indexOf("turn.completed");
		const settled = delivered.findIndex(
			({ event }) =>
				event.type === "conversation.item_changed" &&
				"conversationId" in event &&
				event.conversationId === accepted.conversationId,
		);
		expect(completed).toBeGreaterThanOrEqual(0);
		expect(settled).toBeGreaterThan(completed);
		expect(await executionOf(run.runId)).toMatchObject({ state: "completed" });
	});

	it("posts a completed run's last reply in the automation's feed", async () => {
		const { accepted, run } = await aRunningRun();
		delivered = [];

		await replyAndFinish(accepted.conversationId, "Morning! Two PRs merged overnight.");

		expect(await executionOf(run.runId)).toMatchObject({ state: "completed" });
		const posted = await resultsOf(run.runId);
		expect(posted.map((row) => row.conversationKind)).toEqual(["automation_feed"]);
		const inFeed = posted.find((row) => row.conversationKind === "automation_feed");
		const conversationId = inFeed?.rootConversationId;
		if (!conversationId) throw new Error("The result was posted outside a conversation");
		const page = await onPostgresAs(userId)(Context.get(conversations, ChatView.Service)).messages(
			conversationId,
		);
		expect(page.items).toContainEqual({
			kind: "message",
			message: expect.objectContaining({
				content: "Morning! Two PRs merged overnight.",
				automationResultOf: {
					runId: run.runId,
					conversationId: accepted.conversationId,
					automationId: expect.any(String),
					automationName: expect.any(String),
				},
			}),
		});
		expect(inFeed).toMatchObject({
			message: {
				authorBotId: botId,
				status: "complete",
				content: "Morning! Two PRs merged overnight.",
			},
		});
		expect(delivered).toContainEqual(
			expect.objectContaining({
				event: expect.objectContaining({
					type: "message.created",
					message: expect.objectContaining({
						content: "Morning! Two PRs merged overnight.",
						automationResultOf: expect.objectContaining({
							runId: run.runId,
							conversationId: accepted.conversationId,
						}),
					}),
				}),
			}),
		);
	});

	it("tells the bot its last reply goes to the automation's feed", async () => {
		const { accepted } = await aRunningRun();

		const [trigger] = await onDatabase((db) =>
			db.select().from(message).where(eq(message.conversationId, accepted.conversationId)),
		);

		expect(trigger?.content).toContain("your last reply is posted in this automation's feed");
	});

	it("posts each file a run wrote with its result, at the last version any of its turns wrote", async () => {
		const { accepted, run } = await aRunningRun();
		const dashboard = {
			fileId: crypto.randomUUID(),
			kind: "html" as const,
			title: "Traction dashboard",
		};
		const notes = {
			fileId: crypto.randomUUID(),
			kind: "document" as const,
			title: "Traction notes",
			version: 1,
		};

		await anEarlierTurnWrote(accepted.conversationId, [{ ...dashboard, version: 7 }, notes]);
		await replyAndFinish(accepted.conversationId, "Dashboard updated.", [
			{ ...dashboard, version: 8 },
		]);

		const posted = await resultsOf(run.runId);
		expect(posted.map((row) => row.conversationKind)).toEqual(["automation_feed"]);
		for (const { message: result } of posted) {
			expect(result.parts).toEqual([
				{ type: "text", text: "Dashboard updated." },
				{ type: "written_file", ...dashboard, version: 8 },
				{ type: "written_file", ...notes },
			]);
		}
	});

	it("posts the files a run wrote when its last reply has no text", async () => {
		const { accepted, run } = await aRunningRun();
		const report = {
			fileId: crypto.randomUUID(),
			kind: "document" as const,
			title: "Weekly report",
			version: 2,
		};

		await replyAndFinish(accepted.conversationId, "", [report]);

		expect(await resultsOf(run.runId)).toEqual([
			expect.objectContaining({
				message: expect.objectContaining({
					content: "",
					parts: [{ type: "written_file", ...report }],
				}),
			}),
		]);
	});

	it("posts nothing when the run's last reply has no text and it wrote no file", async () => {
		const { accepted, run } = await aRunningRun();

		await replyAndFinish(accepted.conversationId, "  ");

		expect(await executionOf(run.runId)).toMatchObject({ state: "completed" });
		expect(await resultsOf(run.runId)).toEqual([]);
	});

	it("pauses an automation after two failed runs in a row, and running it again turns it back on", async () => {
		const created = await automations.create(
			{ projectId: ownProjectId },
			{
				name: `Failing ${crypto.randomUUID()}`,
				instructions: "Try it.",
				triggers: [{ kind: "webhook" }],
			},
		);
		const automationId = created.automation.id;
		const failOnce = async () => {
			const accepted = await automations.run({
				projectId: ownProjectId,
				automationId,
				requestId: crypto.randomUUID(),
			});
			const started = await startRunning(runner, automationId);
			await announce(ended(accepted.conversationId, failed(userText`Model failed`)));
			await finishTurnsIn(accepted.conversationId);
			await settlement.settleRun(started.run);
			// As the run's workflow does once it ends, so the next run can start.
			await runOnPostgres(releaseRun(started.run));
		};
		const standing = async () => {
			const [row] = await onDatabase((db) =>
				db
					.select({
						state: automation.state,
						pausedAfterFailuresAt: automation.pausedAfterFailuresAt,
					})
					.from(automation)
					.where(eq(automation.id, automationId)),
			);
			return row;
		};

		await failOnce();
		expect(await standing()).toEqual({ state: "enabled", pausedAfterFailuresAt: null });
		await failOnce();
		expect(await standing()).toEqual({ state: "paused", pausedAfterFailuresAt: expect.any(Date) });

		await automations.run({
			projectId: ownProjectId,
			automationId,
			requestId: crypto.randomUUID(),
		});
		expect(await standing()).toEqual({ state: "enabled", pausedAfterFailuresAt: null });
	});

	it("posts nothing for a run that failed", async () => {
		const { accepted, run } = await aRunningRun();

		await announce(ended(accepted.conversationId, failed(userText`Model failed`)));
		await finishTurnsIn(accepted.conversationId);
		await settlement.settleRun(run);

		expect(await executionOf(run.runId)).toMatchObject({ state: "failed" });
		expect(await resultsOf(run.runId)).toEqual([]);
	});

	it("settles a run once when its last two pieces of work finish together", async () => {
		const fixture = await aRunWithCollaboration("waiting");
		await runAgain(fixture.askingTurn.id);
		const [childTrigger] = await onDatabase((db) =>
			db
				.insert(message)
				.values({
					conversationId: fixture.childConversation.id,
					authorBotId: botId,
					kind: "text",
					status: "complete",
					parts: [],
					content: "Start child work.",
				})
				.returning(),
		);
		if (!childTrigger) throw new Error("Could not create settlement test child trigger");
		const [childTurn] = await onDatabase((db) =>
			db
				.insert(turn)
				.values({
					conversationId: fixture.childConversation.id,
					botId,
					triggerMessageId: childTrigger.id,
					status: "running",
					model: "test/model",
					startedAt: new Date(),
				})
				.returning(),
		);
		if (!childTurn) throw new Error("Could not create settlement test child turn");
		await onDatabase((db) =>
			db
				.update(collaboration)
				.set({ status: "failed" })
				.where(eq(collaboration.id, fixture.activeCollaboration.id)),
		);

		let arrivals = 0;
		let release: (() => void) | undefined;
		const bothWorkersFinished = new Promise<void>((resolve) => {
			release = resolve;
		});
		const finish = (
			turnId: string,
			endWork: Effect.Effect<unknown, unknown, Database>,
			conversationId: string,
		) =>
			runOnPostgres(
				transaction(
					Effect.gen(function* () {
						yield* query((executor) =>
							executor
								.update(turn)
								.set({ status: "done", finishedAt: new Date() })
								.where(eq(turn.id, turnId)),
						);
						yield* endWork;
						arrivals += 1;
						if (arrivals === 2) release?.();
						yield* Effect.promise(() => bothWorkersFinished);
						yield* emit([ConversationEvent.LaneReleased({ conversationId })]);
					}),
				),
			);

		delivered = [];
		await Promise.all([
			finish(
				fixture.askingTurn.id,
				releaseTurn(fixture.runningTurn),
				fixture.accepted.conversationId,
			),
			finish(childTurn.id, Effect.void, fixture.childConversation.id),
		]);

		expect(await executionOf(fixture.accepted.runId)).toMatchObject({
			state: "completed",
			finishedAt: expect.any(Date),
		});
		const settledAnnouncements = delivered.filter(
			({ event }) =>
				event.type === "conversation.item_changed" &&
				"conversationId" in event &&
				event.conversationId === fixture.accepted.conversationId,
		);
		expect(settledAnnouncements).toHaveLength(1);
	});
});

/** A parked transcript with nothing in it but `reply`, for a turn asking to wait. */
function checkpointFor(reply: TurnCheckpoint["reply"]): TurnCheckpoint {
	return {
		messages: [],
		approvals: [],
		modelInput: { model: "test/model", system: "", messages: [] },
		reply,
		modelCalls: 1,
	};
}
