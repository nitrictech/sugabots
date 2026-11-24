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
	bot,
	laneRequest,
	message,
	placedChat,
	projectBot,
	toolCall,
	turn,
} from "../../database/schema.ts";
import {
	closeDatabase,
	holdTransaction,
	onDatabase,
	onPostgres,
	type Promised,
	runOnPostgres,
} from "../../database/testing.ts";
import { onPostgresAs } from "../../workspaces/testing.ts";
import { ChatEvents } from "../chat-events.ts";
import { ChatView } from "../chats/chat-view.ts";
import { ChatEvent } from "../events.ts";
import { seedChat } from "../seed.test-support.ts";
import { chatServicesForTests } from "../testing.ts";
import {
	prepareRunnable,
	queueTurnForTests,
	releaseTurn,
	replyTurnOf,
	runningTurns,
	ToolCallStore,
	type TurnCheckpoint,
	TurnExecution,
	TurnStore,
	turnLane,
} from "../turns/testing.ts";
import type { Turns } from "../turns/turns.ts";
import { AutomationRunner } from "./automation-runner.ts";
import { Automations } from "./automations.ts";
import { AutomationSettlement } from "./settlement.ts";
import { anAutomationAdmin, finishTurnsIn, releaseRun, startRunning } from "./testing.ts";

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
	const services = await chatServicesForTests(bus);
	const { emit } = Context.get(services, ChatEvents.Service);
	/** As an admin of the automations' workspace. */
	let automations: Promised<Automations.Interface>;
	const { settleRun, failRun } = Context.get(services, AutomationSettlement.Service);
	const settlement = onPostgres({ settleRun, failRun });
	const runner = onPostgres(Context.get(services, AutomationRunner.Service));
	const turns = onPostgres(Context.get(services, TurnStore.Service));
	const toolCalls = onPostgres(Context.get(services, ToolCallStore.Service));
	const execution = onPostgres({
		prepare: Context.get(services, TurnExecution.Service).prepare,
	});
	/** Emits `events` in a transaction of their own, as a service would. */
	const announce = (...events: ChatEvent[]) => runOnPostgres(transaction(emit(events)));
	/** An event ending the turn in `chatId` early, as `outcome`. */
	const ended = (chatId: string, outcome: Turns.Ended) =>
		ChatEvent.TurnAbandoned({ chatId, botId, outcome });
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
	/** A project members made, which the automation bot leads. */
	let projectId: string;
	let memberId: string;

	afterAll(async () => {
		await closeDatabase();
	});

	beforeEach(async () => {
		delivered = [];
		({ workspaceId, botId, memberId, ownProjectId, projectId } = await anAutomationAdmin());
		automations = onPostgresAs(memberId)(Context.get(services, Automations.Service));
	});

	/**
	 * An automation of the project `inProject`, the bot's own by default, with
	 * one accepted manual trigger, whose run has started and asked for its turn.
	 */
	async function aRunningRun(inProject = ownProjectId) {
		const created = await automations.create(
			{ projectId: inProject },
			{
				name: `Settlement ${crypto.randomUUID()}`,
				instructions: "Complete the delegated work.",
				triggers: [{ kind: "webhook" }],
			},
		);
		const requestId = crypto.randomUUID();
		const accepted = await automations.run({
			projectId: inProject,
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
	 * A running run of a project's automation whose bot asked another of the
	 * project's bots for help: its asking turn is done, with the reply that
	 * mentioned the helper, and the helper's turn on that reply is asked for in
	 * the run's chat, holding its lane, as the run's own turn workflow still
	 * holds its.
	 */
	async function aRunWithHelper() {
		const { accepted, run } = await aRunningRun(projectId);
		const [triggerMessage] = await onDatabase((db) =>
			db.select({ id: message.id }).from(message).where(eq(message.chatId, accepted.chatId)),
		);
		if (!triggerMessage) throw new Error("Settlement test trigger message is missing");
		const [helper] = await onDatabase((db) =>
			db
				.insert(bot)
				.values({
					workspaceId,
					name: "Helper Bot",
					handle: `helper-${crypto.randomUUID()}`,
					color: "rose",
					eyes: "dot",
					model: "test/model",
					createdById: memberId,
				})
				.returning(),
		);
		if (!helper) throw new Error("Could not create settlement test helper");
		await onDatabase((db) =>
			db.insert(projectBot).values({ workspaceId, projectId, botId: helper.id }),
		);
		const now = new Date();
		const [askingTurn] = await onDatabase((db) =>
			db
				.insert(turn)
				.values({
					chatId: accepted.chatId,
					botId,
					triggerMessageId: triggerMessage.id,
					status: "done",
					reason: "automation",
					model: "test/model",
					startedAt: now,
					finishedAt: now,
				})
				.returning(),
		);
		if (!askingTurn) throw new Error("Could not create settlement test turn");
		const [askingMessage] = await onDatabase((db) =>
			db
				.insert(message)
				.values({
					chatId: accepted.chatId,
					authorBotId: botId,
					status: "complete",
					parts: [],
					content: `@${helper.handle} Complete the delegated work.`,
					turnId: askingTurn.id,
				})
				.returning(),
		);
		if (!askingMessage) throw new Error("Could not create settlement test asking message");
		const [runningTurn] = await runOnPostgres(runningTurns(accepted.chatId));
		await runOnPostgres(
			queueTurnForTests({
				chatId: accepted.chatId,
				botId: helper.id,
				triggerMessageId: askingMessage.id,
				reason: "collaboration",
			}),
		);
		const helperTurn = (await runOnPostgres(runningTurns(accepted.chatId))).find(
			({ request }) => request.botId === helper.id,
		);
		if (!runningTurn || !helperTurn) {
			throw new Error("Could not create settlement test active work");
		}
		return { accepted, run, askingTurn, askingMessage, helper, runningTurn, helperTurn };
	}

	/**
	 * Ends the run's turn with `content` as its reply, which completes the run,
	 * after it wrote each of `writes` with `file_write`, in order.
	 */
	async function replyAndFinish(
		chatId: string,
		content: string,
		writes: readonly Omit<WrittenFilePart, "type">[] = [],
	) {
		const [turnRun] = await runOnPostgres(runningTurns(chatId));
		if (!turnRun) throw new Error("The run asked for no turn");
		const prepared = await prepareRunnable(execution, turnRun);
		const calls = [];
		for (const written of writes) {
			const opened = await toolCalls.open({
				chatId,
				messageId: prepared.responseMessage.id,
				turnId: prepared.turnId,
				tool: "file_write",
				input: {},
				atOffset: 0,
				writeOrDelete: true,
			});
			await toolCalls.close(opened.id, { output: { status: "written", ...written } });
			calls.push({ id: opened.id, atOffset: 0 });
		}
		// Freed first, so completing the turn finishes the run's work.
		await runOnPostgres(releaseTurn(turnRun));
		await turns.complete(
			replyTurnOf(prepared),
			{ content, toolCalls: calls },
			{ contextCapacity: 128_000, readKeptFrom: null },
		);
	}

	/**
	 * A turn of the run, done a minute ago, whose reply wrote each of `writes`
	 * with `file_write`: the run asked somebody something and carried on
	 * in a later turn.
	 */
	async function anEarlierTurnWrote(
		chatId: string,
		writes: readonly Omit<WrittenFilePart, "type">[],
	) {
		const finishedAt = new Date(Date.now() - 60_000);
		// Its own trigger, so the run's turn waiting on the run's trigger still runs.
		const [trigger] = await onDatabase((db) =>
			db
				.insert(message)
				.values({
					chatId,
					authorBotId: botId,
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
					chatId,
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
					chatId,
					authorBotId: botId,
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
					chatId,
					messageId: reply.id,
					turnId: earlier.id,
					tool: "file_write",
					input: {},
					output: { status: "written", ...written },
					status: "completed" as const,
					writeOrDelete: true,
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
					chatKind: placedChat.kind,
					rootChatId: placedChat.rootChatId,
				})
				.from(message)
				.innerJoin(placedChat, eq(placedChat.id, message.chatId))
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
		{ outcome: failed(userText`Model failed`) },
		{ outcome: { state: "cancelled" } as const },
	])(
		"ends a run early as $outcome.state despite a helper's turn still to run",
		async ({ outcome }) => {
			const fixture = await aRunWithHelper();
			// Asked for while the first turn runs, so it waits in the lane.
			await runOnPostgres(
				queueTurnForTests({
					chatId: fixture.accepted.chatId,
					botId,
					triggerMessageId: crypto.randomUUID(),
					reason: "automation",
				}),
			);

			await announce(ended(fixture.accepted.chatId, outcome));

			const waitingTurns = await onDatabase((db) =>
				db
					.select()
					.from(laneRequest)
					.where(eq(laneRequest.laneKey, turnLane({ chatId: fixture.accepted.chatId, botId }))),
			);
			expect(await executionOf(fixture.accepted.runId)).toMatchObject({
				state: outcome.state,
				error: outcome.state === "failed" ? outcome.error : null,
				finishedAt: expect.any(Date),
			});
			expect(waitingTurns).toEqual([]);
			// The helper's turn is refused once its workflow starts it.
			expect(await execution.prepare(fixture.helperTurn)).toMatchObject({
				_tag: "NotRunnable",
				reason: "The automation run has ended",
			});
		},
	);

	it("settles without waiting on the Compaction bot compacting the run's chat", async () => {
		const { accepted, run } = await aRunningRun();
		await finishTurnsIn(accepted.chatId);
		const [triggerMessage] = await onDatabase((db) =>
			db.select({ id: message.id }).from(message).where(eq(message.chatId, accepted.chatId)),
		);
		if (!triggerMessage) throw new Error("Settlement test trigger message is missing");
		const compactionChat = await onDatabase((db) =>
			seedChat(db, {
				workspaceId,
				kind: "system_chat",
				botId,
				systemBotKey: "compact",
				title: "Compaction",
				servedChatId: accepted.chatId,
			}),
		);
		await onDatabase((db) =>
			db.insert(turn).values({
				chatId: compactionChat.id,
				botId,
				triggerMessageId: triggerMessage.id,
				status: "running",
				model: "test/model",
				startedAt: new Date(),
			}),
		);

		expect(await settlement.settleRun(run)).toBe(true);
	});

	it("keeps a run going while a bot it asked for help still has a turn to take", async () => {
		const fixture = await aRunWithHelper();
		await runOnPostgres(releaseTurn(fixture.runningTurn));

		expect(await settlement.settleRun(fixture.run)).toBe(false);
		expect(await executionOf(fixture.accepted.runId)).toMatchObject({
			state: "running",
			finishedAt: null,
		});
	});

	it("settles a run once its helper's lane is free, when the helper took no turn", async () => {
		const fixture = await aRunWithHelper();
		await runOnPostgres(releaseTurn(fixture.runningTurn));
		expect(await settlement.settleRun(fixture.run)).toBe(false);

		await runOnPostgres(releaseTurn(fixture.helperTurn));
		await announce(ChatEvent.LaneReleased(fixture.helperTurn.request));

		// No helper's turn ever ran, so its asking bot is owed no hand-back.
		expect(await executionOf(fixture.accepted.runId)).toMatchObject({ state: "completed" });
	});

	it("tells the workflows of waiting turns to stop once a run ending early commits", async () => {
		const fixture = await aRunWithHelper();
		await onDatabase((db) =>
			db
				.update(turn)
				.set({ status: "waiting", executionId: "workflow-execution" })
				.where(eq(turn.chatId, fixture.accepted.chatId)),
		);
		const sentBeforeCommit: number[] = [];
		const cancel = vi.fn((_owner: string) => Effect.void);
		const ending = await chatServicesForTests(bus, { decide: () => Effect.void, cancel });

		await runOnPostgres(
			transaction(
				Effect.gen(function* () {
					yield* Context.get(ending, ChatEvents.Service).emit([
						ended(fixture.accepted.chatId, { state: "cancelled" }),
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
		const fixture = await aRunWithHelper();
		await runAgain(fixture.askingTurn.id);

		await announce(ended(fixture.accepted.chatId, failed(userText`Helper's model failed`)));

		const [stopping] = await onDatabase((db) =>
			db.select().from(turn).where(eq(turn.id, fixture.askingTurn.id)),
		);
		expect(await executionOf(fixture.accepted.runId)).toMatchObject({
			state: "running",
			pendingTerminalState: "failed",
			pendingTerminalError: "Helper's model failed",
			finishedAt: null,
		});
		expect(stopping?.interruptRequested).toBe(true);
		// The workflow running it hears at once, rather than on its next poll.
		expect(delivered).toContainEqual(
			expect.objectContaining({
				event: expect.objectContaining({
					type: "turn.interrupt_requested",
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
			error: userText`Helper's model failed`,
			pendingTerminalState: null,
			pendingTerminalError: null,
			finishedAt: expect.any(Date),
		});
	});

	it("refuses to open a turn once a run has started ending", async () => {
		const fixture = await aRunWithHelper();
		await runAgain(fixture.askingTurn.id);

		await announce(ended(fixture.accepted.chatId, failed(userText`Helper's model failed`)));

		expect(await execution.prepare(fixture.helperTurn)).toMatchObject({
			_tag: "NotRunnable",
			reason: "The automation run has ended",
		});
	});

	it("does not wait for a turn another transaction holds, and the turn's next step is refused", async () => {
		const { accepted, run } = await aRunningRun();
		const [turnRun] = await runOnPostgres(runningTurns(accepted.chatId));
		if (!turnRun) throw new Error("The run asked for no turn");
		const prepared = await prepareRunnable(execution, turnRun);
		const holder = holdTransaction(
			query((db) =>
				db.select({ id: turn.id }).from(turn).where(eq(turn.id, prepared.turnId)).for("update"),
			),
		);
		await holder.held;

		// Settles while the holder still has the turn locked: a wait here would never end.
		await announce(ended(accepted.chatId, failed(userText`Model failed`)));
		await holder.release();

		const [skipped] = await onDatabase((db) =>
			db.select().from(turn).where(eq(turn.id, prepared.turnId)),
		);
		expect(skipped).toMatchObject({ status: "running", interruptRequested: false });
		expect(await executionOf(run.runId)).toMatchObject({
			state: "running",
			pendingTerminalState: "failed",
		});
		const draft = { content: "Half a reply", toolCalls: [] };
		const replyTurn = replyTurnOf(prepared);
		expect(await turns.suspend(replyTurn, checkpointFor(draft), [])).toBe(false);

		await turns.cancel(replyTurn, draft);

		expect(await executionOf(run.runId)).toMatchObject({
			state: "failed",
			error: userText`Model failed`,
		});
	});

	it("lets a transaction holding a turn record the run's ending while settlement waits on that turn", async () => {
		const fixture = await aRunWithHelper();
		await onDatabase((db) =>
			db.update(turn).set({ status: "waiting" }).where(eq(turn.id, fixture.askingTurn.id)),
		);
		const holder = holdTransaction(
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
				return backend?.pid ?? 0;
			}),
			// Ends a turn in the run, as a turn writer holding its turn does.
			emit([ended(fixture.accepted.chatId, { state: "cancelled" })]),
		);
		const pid = await holder.held;

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
		await Promise.all([holder.release(), failing]);

		expect(await executionOf(fixture.run.runId)).toMatchObject({ state: "failed" });
		const [asking] = await onDatabase((db) =>
			db.select().from(turn).where(eq(turn.id, fixture.askingTurn.id)),
		);
		expect(asking?.status).toBe("cancelled");
	});

	it("tells watching clients a turn completed before it tells them the run settled", async () => {
		const { accepted, run } = await aRunningRun();
		const [turnRun] = await runOnPostgres(runningTurns(accepted.chatId));
		if (!turnRun) throw new Error("The run asked for no turn");
		const prepared = await prepareRunnable(execution, turnRun);
		// Freed first, so completing the turn finishes the run's work.
		await runOnPostgres(releaseTurn(turnRun));
		delivered = [];

		await turns.complete(
			replyTurnOf(prepared),
			{ content: "Done.", toolCalls: [] },
			{ contextCapacity: 128_000, readKeptFrom: null },
		);

		const types = delivered.map(({ event }) => event.type);
		const completed = types.indexOf("turn.completed");
		const settled = delivered.findIndex(
			({ event }) =>
				event.type === "chat.nested_chat_changed" &&
				"chatId" in event &&
				event.chatId === accepted.chatId,
		);
		expect(completed).toBeGreaterThanOrEqual(0);
		expect(settled).toBeGreaterThan(completed);
		expect(await executionOf(run.runId)).toMatchObject({ state: "completed" });
	});

	it("posts a completed run's last reply in the automation's feed", async () => {
		const { accepted, run } = await aRunningRun();
		delivered = [];

		await replyAndFinish(accepted.chatId, "Morning! Two PRs merged overnight.");

		expect(await executionOf(run.runId)).toMatchObject({ state: "completed" });
		const posted = await resultsOf(run.runId);
		expect(posted.map((row) => row.chatKind)).toEqual(["automation_feed"]);
		const inFeed = posted.find((row) => row.chatKind === "automation_feed");
		const chatId = inFeed?.rootChatId;
		if (!chatId) throw new Error("The result was posted outside a chat");
		const page = await onPostgresAs(memberId)(Context.get(services, ChatView.Service)).messages(
			chatId,
		);
		expect(page.items).toContainEqual({
			kind: "message",
			message: expect.objectContaining({
				content: "Morning! Two PRs merged overnight.",
				automationResultOf: {
					runId: run.runId,
					chatId: accepted.chatId,
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
							chatId: accepted.chatId,
						}),
					}),
				}),
			}),
		);
	});

	it("tells the bot its last reply goes to the automation's feed", async () => {
		const { accepted } = await aRunningRun();

		const [trigger] = await onDatabase((db) =>
			db.select().from(message).where(eq(message.chatId, accepted.chatId)),
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
			kind: "markdown" as const,
			title: "Traction notes",
			version: 1,
		};

		await anEarlierTurnWrote(accepted.chatId, [{ ...dashboard, version: 7 }, notes]);
		await replyAndFinish(accepted.chatId, "Dashboard updated.", [{ ...dashboard, version: 8 }]);

		const posted = await resultsOf(run.runId);
		expect(posted.map((row) => row.chatKind)).toEqual(["automation_feed"]);
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
			kind: "markdown" as const,
			title: "Weekly report",
			version: 2,
		};

		await replyAndFinish(accepted.chatId, "", [report]);

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

		await replyAndFinish(accepted.chatId, "  ");

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
			await announce(ended(accepted.chatId, failed(userText`Model failed`)));
			await finishTurnsIn(accepted.chatId);
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

		await announce(ended(accepted.chatId, failed(userText`Model failed`)));
		await finishTurnsIn(accepted.chatId);
		await settlement.settleRun(run);

		expect(await executionOf(run.runId)).toMatchObject({ state: "failed" });
		expect(await resultsOf(run.runId)).toEqual([]);
	});

	it("settles a run once when its last two pieces of work finish together", async () => {
		const { accepted } = await aRunningRun();
		const [runningTurn] = await runOnPostgres(runningTurns(accepted.chatId));
		if (!runningTurn) throw new Error("The run asked for no turn");
		const pieces = await Promise.all(
			["First piece.", "Second piece."].map(async (content) => {
				const [trigger] = await onDatabase((db) =>
					db
						.insert(message)
						.values({
							chatId: accepted.chatId,
							authorBotId: botId,
							status: "complete",
							parts: [],
							content,
						})
						.returning(),
				);
				if (!trigger) throw new Error("Could not create settlement test trigger");
				const [piece] = await onDatabase((db) =>
					db
						.insert(turn)
						.values({
							chatId: accepted.chatId,
							botId,
							triggerMessageId: trigger.id,
							status: "running",
							model: "test/model",
							startedAt: new Date(),
						})
						.returning(),
				);
				if (!piece) throw new Error("Could not create settlement test turn");
				return piece;
			}),
		);
		const [first, second] = pieces;
		if (!first || !second) throw new Error("Could not create settlement test work");

		let arrivals = 0;
		let release: (() => void) | undefined;
		const bothWorkersFinished = new Promise<void>((resolve) => {
			release = resolve;
		});
		const finish = (turnId: string, endWork: Effect.Effect<unknown, unknown, Database>) =>
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
						yield* emit([ChatEvent.LaneReleased(runningTurn.request)]);
					}),
				),
			);

		delivered = [];
		await Promise.all([finish(first.id, releaseTurn(runningTurn)), finish(second.id, Effect.void)]);

		expect(await executionOf(accepted.runId)).toMatchObject({
			state: "completed",
			finishedAt: expect.any(Date),
		});
		const settledAnnouncements = delivered.filter(
			({ event }) =>
				event.type === "chat.nested_chat_changed" &&
				"chatId" in event &&
				event.chatId === accepted.chatId,
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
		modelRequests: 1,
	};
}
