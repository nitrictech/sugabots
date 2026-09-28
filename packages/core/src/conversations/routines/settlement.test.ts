import { eq } from "drizzle-orm";
import { Context, Effect } from "effect";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { beforeCommit, type Database, query, transaction } from "../../database/database.ts";
import type { CommittedEvent } from "../../database/events/outbox.ts";
import {
	collaboration,
	lane,
	laneRequest,
	message,
	routineExecution,
	thread,
	turn,
} from "../../database/schema.ts";
import {
	closeDatabase,
	onDatabase,
	onPostgres,
	type Promised,
	runOnPostgres,
} from "../../database/testing.ts";
import { UserMessage } from "../../user-message.ts";
import { onPostgresAs } from "../../workspaces/testing.ts";
import { ConversationEvents } from "../conversation-events.ts";
import { ConversationEvent } from "../events.ts";
import { conversationsForTests } from "../testing.ts";
import { replyTurnOf, TurnExecution } from "../turns/execution.ts";
import type { Ended } from "../turns/lifecycle.ts";
import { type TurnCheckpoint, TurnRepository } from "../turns/repository.ts";
import {
	prepareRunnable,
	queueFacilitationForTests,
	queueTurnForTests,
	releaseFacilitation,
	releaseTurn,
	runningTurns,
	waitingFacilitation,
} from "../turns/testing.ts";
import { Turn, turnLane } from "../turns/turn.workflow.ts";
import { RoutineRunner } from "./routine-runner.ts";
import { Routines } from "./routines.ts";
import { RoutineSettlement } from "./settlement.ts";
import { aRoutineOwner, finishTurnsIn, releaseRun, startRunning } from "./testing.ts";

/**
 * Routine settlement against Postgres, driven by the events that settle a
 * run, as the services and workflows emit them.
 */
describe.skipIf(!process.env.DATABASE_URL)("routine settlement, against Postgres", async () => {
	let delivered: CommittedEvent[] = [];
	const bus = {
		publishCommitted: async (events: CommittedEvent[]) => {
			delivered.push(...events);
		},
	};
	const conversations = await conversationsForTests(bus);
	const { emit } = Context.get(conversations, ConversationEvents.Service);
	/** As the routines' owner, who administers their workspace. */
	let routines: Promised<Routines.Interface>;
	const { settleRun, failRun } = Context.get(conversations, RoutineSettlement.Service);
	const settlement = onPostgres({ settleRun, failRun });
	const runner = onPostgres(Context.get(conversations, RoutineRunner.Service));
	const turns = onPostgres(Context.get(conversations, TurnRepository.Service));
	const execution = onPostgres({
		prepare: Context.get(conversations, TurnExecution.Service).prepare,
	});
	/** Emits `events` in a transaction of their own, as a service would. */
	const announce = (...events: ConversationEvent[]) => runOnPostgres(transaction(emit(events)));
	/** An event ending the thread's routine run early, as `outcome`. */
	const ended = (threadId: string, outcome: Ended) =>
		ConversationEvent.TurnAbandoned({ threadId, agentId, outcome });
	const failed = (error: UserMessage): Ended => ({ state: "failed", error });
	const executionOf = async (executionId: string) => {
		const [row] = await onDatabase((db) =>
			db.select().from(routineExecution).where(eq(routineExecution.id, executionId)),
		);
		return row;
	};
	let workspaceId: string;
	let podId: string;
	let agentId: string;
	let userId: string;

	afterAll(async () => {
		await closeDatabase();
	});

	beforeEach(async () => {
		delivered = [];
		({ workspaceId, podId, agentId, userId } = await aRoutineOwner());
		routines = onPostgresAs(userId)(Context.get(conversations, Routines.Service));
	});

	/** A routine with one accepted manual trigger, whose run has started and asked for its turn. */
	async function aRunningRun() {
		const created = await routines.create(
			{ agentId },
			{
				name: `Settlement ${crypto.randomUUID()}`,
				instructions: "Complete the delegated work.",
				trigger: { kind: "webhook" },
			},
		);
		const requestId = crypto.randomUUID();
		const accepted = await routines.run({ agentId, routineId: created.routine.id, requestId });
		const started = await startRunning(runner, created.routine.id);
		if (started.execution.id !== accepted.executionId) {
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
			db.select({ id: message.id }).from(message).where(eq(message.threadId, accepted.threadId)),
		);
		if (!triggerMessage) throw new Error("Settlement test trigger message is missing");
		const now = new Date();
		const [askingTurn] = await onDatabase((db) =>
			db
				.insert(turn)
				.values({
					threadId: accepted.threadId,
					agentId,
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
					threadId: accepted.threadId,
					authorAgentId: agentId,
					kind: "text",
					status: "complete",
					parts: [],
					content: "Delegating.",
					turnId: askingTurn.id,
				})
				.returning(),
		);
		const [childThread] = await onDatabase((db) =>
			db
				.insert(thread)
				.values({
					workspaceId,
					podId,
					hostAgentId: agentId,
					type: "collaboration",
					title: "Delegated work",
					parentThreadId: accepted.threadId,
				})
				.returning(),
		);
		if (!parentMessage || !childThread) {
			throw new Error("Could not create settlement test collaboration thread");
		}
		const [activeCollaboration] = await onDatabase((db) =>
			db
				.insert(collaboration)
				.values({
					parentThreadId: accepted.threadId,
					parentMessageId: parentMessage.id,
					turnId: askingTurn.id,
					childThreadId: childThread.id,
					collaboratorAgentId: agentId,
					brief: "Complete delegated work",
					status,
					atOffset: 0,
				})
				.returning(),
		);
		const [runningTurn] = await runOnPostgres(runningTurns(accepted.threadId));
		if (!activeCollaboration || !runningTurn) {
			throw new Error("Could not create settlement test active work");
		}
		return { accepted, run, askingTurn, childThread, activeCollaboration, runningTurn };
	}

	/** Marks the fixture's asking turn as running again, as a workflow holding it would. */
	const runAgain = (turnId: string) =>
		onDatabase((db) =>
			db.update(turn).set({ status: "running", finishedAt: null }).where(eq(turn.id, turnId)),
		);

	it("fails a run whose workflow failed at once, while its turn still runs, so the next run can start", async () => {
		const created = await routines.create(
			{ agentId },
			{
				name: "Failing run",
				instructions: "Do the work.",
				trigger: { kind: "webhook" },
			},
		);
		const accepted = [];
		for (let run = 0; run < 2; run++) {
			const requestId = crypto.randomUUID();
			accepted.push(await routines.run({ agentId, routineId: created.routine.id, requestId }));
		}
		const first = await startRunning(runner, created.routine.id);

		await settlement.failRun(first.run);
		await runOnPostgres(releaseRun(first.run));

		expect(await executionOf(first.execution.id)).toMatchObject({
			state: "failed",
			error: "The routine run stopped unexpectedly",
			finishedAt: expect.any(Date),
		});
		const next = await startRunning(runner, created.routine.id);
		expect(next.execution).toMatchObject({ id: accepted[1]?.executionId, state: "running" });
	});

	it("fails a run whose workflow failed before starting it", async () => {
		const created = await routines.create(
			{ agentId },
			{
				name: "Never started",
				instructions: "Do the work.",
				trigger: { kind: "webhook" },
			},
		);
		const requestId = crypto.randomUUID();
		const accepted = await routines.run({ agentId, routineId: created.routine.id, requestId });

		await settlement.failRun({ routineId: created.routine.id, executionId: accepted.executionId });

		expect(await executionOf(accepted.executionId)).toMatchObject({
			state: "failed",
			error: "The routine run stopped unexpectedly",
		});
	});

	it.each([
		{
			outcome: failed(UserMessage.of`Model failed`),
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
					threadId: fixture.accepted.threadId,
					agentId,
					triggerMessageId: crypto.randomUUID(),
					reason: "routine",
				}),
			);

			await announce(ended(fixture.childThread.id, outcome));

			const [settledCollaboration] = await onDatabase((db) =>
				db.select().from(collaboration).where(eq(collaboration.id, fixture.activeCollaboration.id)),
			);
			const waitingTurns = await onDatabase((db) =>
				db
					.select()
					.from(laneRequest)
					.where(
						eq(laneRequest.laneKey, turnLane({ threadId: fixture.accepted.threadId, agentId })),
					),
			);
			expect(await executionOf(fixture.accepted.executionId)).toMatchObject({
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

	it("settles without waiting on the Scribe summarising the run's thread", async () => {
		const { accepted, run } = await aRunningRun();
		await finishTurnsIn(accepted.threadId);
		const [triggerMessage] = await onDatabase((db) =>
			db.select({ id: message.id }).from(message).where(eq(message.threadId, accepted.threadId)),
		);
		const [summaryThread] = await onDatabase((db) =>
			db
				.insert(thread)
				.values({
					workspaceId,
					podId,
					hostAgentId: agentId,
					type: "system_agent",
					systemAgentKey: "summarise",
					title: "Summary",
					parentThreadId: accepted.threadId,
				})
				.returning(),
		);
		if (!triggerMessage || !summaryThread) throw new Error("Could not create summary thread");
		await onDatabase((db) =>
			db.insert(turn).values({
				threadId: summaryThread.id,
				agentId,
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
		expect(await executionOf(fixture.accepted.executionId)).toMatchObject({
			state: "running",
			finishedAt: null,
		});
		expect(activeCollaboration?.status).toBe("waiting");
	});

	it("keeps a run going while a turn lane in its thread is busy", async () => {
		const fixture = await aRunWithCollaboration("waiting");
		await runOnPostgres(releaseTurn(fixture.runningTurn));
		await onDatabase((db) =>
			db
				.update(collaboration)
				.set({ status: "answered" })
				.where(eq(collaboration.id, fixture.activeCollaboration.id)),
		);
		const busy = {
			key: turnLane({ threadId: fixture.childThread.id, agentId }),
			subject: fixture.childThread.id,
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
		await announce(ConversationEvent.LaneReleased({ threadId: fixture.childThread.id }));
		expect(await executionOf(fixture.accepted.executionId)).toMatchObject({ state: "completed" });
	});

	it("drops a waiting facilitation and waits for the running one when a run ends early", async () => {
		const fixture = await aRunWithCollaboration("waiting");
		await runOnPostgres(releaseTurn(fixture.runningTurn));
		await onDatabase((db) =>
			db
				.update(collaboration)
				.set({ status: "answered" })
				.where(eq(collaboration.id, fixture.activeCollaboration.id)),
		);
		const running = { threadId: fixture.childThread.id, triggerMessageId: crypto.randomUUID() };
		await runOnPostgres(queueFacilitationForTests(running));
		await runOnPostgres(
			queueFacilitationForTests({
				threadId: fixture.childThread.id,
				triggerMessageId: crypto.randomUUID(),
			}),
		);

		expect(await settlement.settleRun(fixture.run)).toBe(false);
		await announce(
			ConversationEvent.FacilitationFailed({
				threadId: fixture.childThread.id,
				userMessage: UserMessage.of`Model failed`,
			}),
		);
		expect(await executionOf(fixture.accepted.executionId)).toMatchObject({ state: "running" });
		expect(await runOnPostgres(waitingFacilitation(fixture.childThread.id))).toBeUndefined();

		await runOnPostgres(releaseFacilitation(running));
		await announce(ConversationEvent.LaneReleased({ threadId: fixture.childThread.id }));
		expect(await executionOf(fixture.accepted.executionId)).toMatchObject({
			state: "failed",
			error: UserMessage.of`Model failed`,
		});
	});

	it("tells the workflows of waiting turns to stop once a run ending early commits", async () => {
		const fixture = await aRunWithCollaboration("waiting");
		await onDatabase((db) =>
			db
				.update(turn)
				.set({ status: "waiting", owner: "workflow-execution" })
				.where(eq(turn.threadId, fixture.accepted.threadId)),
		);
		const sentBeforeCommit: number[] = [];
		const cancel = vi.fn((_owner: string) => Effect.void);
		const ending = await conversationsForTests(bus, { decide: () => Effect.void, cancel });

		await runOnPostgres(
			transaction(
				Effect.gen(function* () {
					yield* Context.get(ending, ConversationEvents.Service).emit([
						ended(fixture.childThread.id, { state: "cancelled" }),
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

		await announce(ended(fixture.childThread.id, failed(UserMessage.of`Child model failed`)));

		const [stopping] = await onDatabase((db) =>
			db.select().from(turn).where(eq(turn.id, fixture.askingTurn.id)),
		);
		expect(await executionOf(fixture.accepted.executionId)).toMatchObject({
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
		expect(await executionOf(fixture.accepted.executionId)).toMatchObject({
			state: "failed",
			error: UserMessage.of`Child model failed`,
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
					threadId: fixture.childThread.id,
					authorAgentId: agentId,
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
				threadId: fixture.childThread.id,
				agentId,
				triggerMessageId: childTrigger.id,
				reason: "collaboration",
			}),
		);
		const [childRun] = await runOnPostgres(runningTurns(fixture.childThread.id));
		if (!childRun) throw new Error("Could not start settlement test child turn");

		await announce(ended(fixture.childThread.id, failed(UserMessage.of`Child model failed`)));

		expect(await execution.prepare(childRun)).toMatchObject({
			_tag: "NotRunnable",
			reason: "The Routine execution has ended",
		});
	});

	it("does not wait for a turn another transaction holds, and the turn's next step is refused", async () => {
		const { accepted, run } = await aRunningRun();
		const [turnRun] = await runOnPostgres(runningTurns(accepted.threadId));
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
		await announce(
			ConversationEvent.FacilitationFailed({
				threadId: accepted.threadId,
				userMessage: UserMessage.of`Model failed`,
			}),
		);
		letGo();
		await holder;

		const [skipped] = await onDatabase((db) =>
			db.select().from(turn).where(eq(turn.id, prepared.turnId)),
		);
		expect(skipped).toMatchObject({ status: "running", cancelRequested: false });
		expect(await executionOf(run.executionId)).toMatchObject({
			state: "running",
			pendingTerminalState: "failed",
		});
		const draft = { content: "Half a reply", collaborations: [], toolCalls: [] };
		const replyTurn = replyTurnOf(prepared);
		expect(await turns.suspend(replyTurn, checkpointFor(draft), [])).toBe(false);

		await turns.cancel(replyTurn, draft);

		expect(await executionOf(run.executionId)).toMatchObject({
			state: "failed",
			error: UserMessage.of`Model failed`,
		});
	});

	it("tells watching clients a turn completed before it tells them the run settled", async () => {
		const { accepted, run } = await aRunningRun();
		const [turnRun] = await runOnPostgres(runningTurns(accepted.threadId));
		if (!turnRun) throw new Error("The run asked for no turn");
		const prepared = await prepareRunnable(execution, turnRun);
		// Freed first, so completing the turn finishes the run's work.
		await runOnPostgres(releaseTurn(turnRun));
		delivered = [];

		await turns.complete(
			replyTurnOf(prepared),
			{ content: "Done.", collaborations: [], toolCalls: [] },
			{},
		);

		const types = delivered.map(({ event }) => event.type);
		const completed = types.indexOf("turn.completed");
		const settled = delivered.findIndex(
			({ event }) =>
				event.type === "chat.thread_changed" &&
				"threadType" in event &&
				event.threadType === "routine",
		);
		expect(completed).toBeGreaterThanOrEqual(0);
		expect(settled).toBeGreaterThan(completed);
		expect(await executionOf(run.executionId)).toMatchObject({ state: "completed" });
	});

	it("settles a run once when its last two pieces of work finish together", async () => {
		const fixture = await aRunWithCollaboration("waiting");
		await runAgain(fixture.askingTurn.id);
		const [childTrigger] = await onDatabase((db) =>
			db
				.insert(message)
				.values({
					threadId: fixture.childThread.id,
					authorAgentId: agentId,
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
					threadId: fixture.childThread.id,
					agentId,
					triggerMessageId: childTrigger.id,
					status: "running",
					model: "test/model",
					startedAt: new Date(),
				})
				.returning(),
		);
		if (!childTurn) throw new Error("Could not create settlement test child turn");
		const childFacilitation = {
			threadId: fixture.childThread.id,
			triggerMessageId: childTrigger.id,
		};
		await runOnPostgres(queueFacilitationForTests(childFacilitation));
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
			threadId: string,
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
						yield* emit([ConversationEvent.LaneReleased({ threadId })]);
					}),
				),
			);

		delivered = [];
		await Promise.all([
			finish(fixture.askingTurn.id, releaseTurn(fixture.runningTurn), fixture.accepted.threadId),
			finish(childTurn.id, releaseFacilitation(childFacilitation), fixture.childThread.id),
		]);

		expect(await executionOf(fixture.accepted.executionId)).toMatchObject({
			state: "completed",
			finishedAt: expect.any(Date),
		});
		const settledAnnouncements = delivered.filter(
			({ event }) =>
				event.type === "chat.thread_changed" &&
				"threadId" in event &&
				event.threadId === fixture.accepted.threadId,
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
