import { ToolApprovalConflict } from "@sugabots/contracts/errors/approvals";
import { ActionForbidden, ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { userText } from "@sugabots/errors";
import { eq } from "drizzle-orm";
import { Context, Duration, Effect } from "effect";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { query } from "../../../database/database.ts";
import type { CommittedEvent } from "../../../database/events/outbox.ts";
import {
	bot,
	connector,
	member,
	membership,
	toolCall,
	turn,
	workspace,
} from "../../../database/schema.ts";
import {
	closeDatabase,
	holdTransaction,
	onDatabase,
	onPostgres,
	type Promised,
	runOnPostgres,
} from "../../../database/testing.ts";
import { asMember } from "../../../operations/chats/testing.ts";
import { type CallOperation, servedOperations } from "../../../operations/testing.ts";
import { Lanes } from "../../../workflows/lanes.ts";
import { chatServicesForTests, lanesForTests } from "../../testing.ts";
import { releaseParkedLanes } from "../cancel-sweep.ts";
import { TurnRecords } from "../records.ts";
import { TurnSignals } from "../signals.ts";
import {
	aChatAwaitingReply,
	asTheLoop,
	endTurn,
	type OpenedTurnForTests,
	openTurn,
	parkTurn,
	recordToolCall,
	runningTurns,
	runOver,
	writeReply,
} from "../testing.ts";
import { Turns } from "../turns.ts";
import { type ApprovalBinding, ToolCallStore } from "./store.ts";

/**
 * Tool calls against Postgres: what recording and finishing a call write, how
 * the reply reads them back where they were made, how an approval is parked,
 * decided and run, and what a turn ending early does to calls still running.
 */
describe.skipIf(!process.env.DATABASE_URL)("tool calls, against Postgres", async () => {
	let delivered: CommittedEvent[] = [];
	const bus = {
		publishCommitted: async (events: CommittedEvent[]) => {
			delivered.push(...events);
		},
	};
	const services = await chatServicesForTests(bus);
	const run = runOver(services);
	const calls: Promised<ToolCallStore.Interface> = onPostgres(
		Context.get(services, ToolCallStore.Service),
	);
	const call = await servedOperations({ chats: services });
	/** `memberId`, signed in, deciding through the chat services `over`. */
	const approvalsAs = (memberId: string, over: CallOperation = call) => asMember(over, memberId);
	/** The operations over chat services whose turns' workflows hear decisions through `signals`. */
	const signalledBy = async (signals: TurnSignals.Interface) =>
		servedOperations({ chats: await chatServicesForTests(bus, signals) });
	const detailsAs = (memberId: string) => asMember(call, memberId);
	const chatsAs = (memberId: string) => asMember(call, memberId);
	let workspaceId: string;
	let botId: string;
	let adminId: string;
	let chatId: string;
	let connectorId: string;
	let opened: OpenedTurnForTests;

	afterAll(async () => {
		await closeDatabase();
	});

	beforeEach(async () => {
		({ workspaceId, botId, adminId, chatId, connectorId } = await aChatAwaitingReply(chatsAs));
		const [running] = await runOnPostgres(runningTurns(chatId));
		if (!running) throw new Error("no turn running");
		opened = await run(openTurn(running));
		delivered = [];
	});

	/** Records the turn sending a call to `web_fetch`, after the reply's text so far. */
	const fetchCall = () =>
		run(
			recordToolCall(opened, {
				toolCallId: `sdk-${crypto.randomUUID()}`,
				tool: "web_fetch",
				input: { url: "https://example.com" },
			}),
		);

	/** Finishes the recorded call `callId` as the turn's loop does. */
	const close = (
		callId: string,
		outcome: { output: unknown } | { error: ReturnType<typeof userText> },
	) =>
		run(
			asTheLoop(opened, (runsTurn) =>
				Effect.flatMap(ToolCallStore.Service, (store) => store.close(runsTurn, callId, outcome)),
			),
		);

	const storedCall = async (id: string) => {
		const [row] = await onDatabase((db) => db.select().from(toolCall).where(eq(toolCall.id, id)));
		return row;
	};

	/** A call of the turn's step waiting for its approver, as the loop asks for one. */
	interface AskedCall {
		readonly toolCallId: string;
		readonly tool: string;
		readonly input: unknown;
		readonly binding: ApprovalBinding;
		readonly writeOrDelete: boolean;
	}

	const askedCall = (overrides: Partial<AskedCall> = {}): AskedCall => ({
		toolCallId: "sdk-create-1",
		tool: "linear__create_issue",
		input: { title: "Fix mobile navigation" },
		binding: connectorBinding("create_issue"),
		writeOrDelete: true,
		...overrides,
	});

	const connectorBinding = (remoteToolName: string): ApprovalBinding => ({
		kind: "connector",
		connectorId,
		connectorRevision: 1,
		remoteToolName,
	});

	/** Parks `asked` as the turn's one approval; returns its recorded call and approval. */
	async function park(asked: AskedCall) {
		const parked = await run(parkTurn(opened, [asked]));
		if (parked._tag !== "Waiting") throw new Error("the turn may not wait");
		const [approvalId] = parked.approvals;
		const [row] = await onDatabase((db) =>
			db
				.select()
				.from(toolCall)
				.where(eq(toolCall.approvalId, approvalId ?? "")),
		);
		if (!approvalId || !row) throw new Error("no approval parked");
		return { id: row.id, approvalId };
	}

	/** Records a member allowing the parked call, as deciding it does. */
	const allow = (approvalId: string) =>
		calls.recordDecision({
			chatId,
			approvalId,
			decision: { decision: "allow_once", memberId: adminId },
		});

	/** Starts the allowed call `asked` as the turn's next step does. */
	const start = (asked: AskedCall) =>
		run(
			asTheLoop(opened, (runsTurn) =>
				Effect.flatMap(TurnRecords.Service, (records) =>
					records.startApprovedToolCall(runsTurn, asked),
				),
			),
		);

	/** Parks `asked`, allows it, and begins the turn's next step, which runs on. */
	async function allowAndResume(asked: AskedCall) {
		const { approvalId } = await park(asked);
		await allow(approvalId);
		const loaded = await run(
			asTheLoop(opened, (runsTurn) =>
				Effect.flatMap(TurnRecords.Service, (records) => records.load(runsTurn, 1)),
			),
		);
		expect(loaded).toMatchObject({
			_tag: "Begun",
			approvals: [expect.objectContaining({ toolCallId: asked.toolCallId, decision: "allowed" })],
		});
	}

	it("records a call as sent before it runs, and finishes it with its output", async () => {
		await run(writeReply(opened, "Look"));
		const id = await run(
			recordToolCall(opened, {
				toolCallId: "sdk-fetch",
				tool: "web_fetch",
				input: { url: "https://example.com" },
			}),
		);
		expect(await storedCall(id)).toMatchObject({
			tool: "web_fetch",
			step: 0,
			sdkToolCallId: "sdk-fetch",
			input: { url: "https://example.com" },
			output: null,
			status: "running",
			error: null,
			atOffset: 4,
			finishedAt: null,
		});

		const closed = await close(id, { output: { title: "Example Domain" } });

		expect(closed).toMatchObject({
			id,
			status: "completed",
			output: { title: "Example Domain" },
			error: null,
		});
		expect(closed?.finishedAt).not.toBeNull();
	});

	it("keeps the images a call showed the model counted, not their data", async () => {
		const id = await fetchCall();

		const closed = await close(id, {
			output: {
				text: "The image chart.png.",
				images: [{ data: "iVBORw0KGgo".repeat(10_000), mediaType: "image/png" }],
			},
		});

		expect(closed?.output).toEqual({ text: "The image chart.png.", images: "1 shown" });
	});

	it("closes a failed call with the error and no output", async () => {
		const id = await fetchCall();

		const closed = await close(id, { error: userText`Host did not resolve` });

		expect(closed).toMatchObject({ status: "failed", output: null, error: "Host did not resolve" });
	});

	it("composes the call into the reply's parts where it was made", async () => {
		await run(writeReply(opened, "Looking"));
		const id = await fetchCall();
		await close(id, { output: { title: "Example Domain" } });
		await run(
			writeReply(opened, {
				content: "Looking now. Found it.",
				toolCalls: [{ id, atOffset: 7 }],
			}),
		);

		const details = await detailsAs(adminId).get(chatId);
		const reply = details?.messages.find((message) => message.id === opened.replyMessageId);

		expect(reply?.parts).toEqual([
			{ type: "text", text: "Looking" },
			expect.objectContaining({ type: "tool_call", id, status: "completed" }),
			{ type: "text", text: " now. Found it." },
		]);
	});

	it("parks an approval and, once it is allowed, starts it once, as it was approved", async () => {
		const asked = askedCall();
		await allowAndResume(asked);
		const [allowed] = await onDatabase((db) =>
			db.select().from(toolCall).where(eq(toolCall.sdkToolCallId, "sdk-create-1")),
		);
		expect(allowed).toMatchObject({ approvalStatus: "allowed", decidedById: adminId, step: 0 });

		expect(await start({ ...asked, input: { title: "A different issue" } })).toMatchObject({
			_tag: "Refused",
			reason: expect.stringContaining("already claimed"),
		});
		expect(await start(asked)).toEqual({ _tag: "Send", id: allowed?.id });
		// Started already, so starting it again, as an execution resuming the
		// turn would, doesn't send it again: it may have made its change.
		expect(await start(asked)).toMatchObject({ _tag: "Interrupted", id: allowed?.id });
		expect(await start({ ...asked, toolCallId: "sdk-create-never-parked" })).toMatchObject({
			_tag: "Refused",
			reason: expect.stringContaining("no approval record"),
		});
	});

	it("starts an allowed call to a built-in tool, which no connector's settings bind", async () => {
		const asked = askedCall({
			toolCallId: "sdk-built-in",
			tool: "web_fetch",
			input: { url: "https://example.com" },
			binding: { kind: "built-in" },
		});
		await allowAndResume(asked);
		await onDatabase((db) =>
			db
				.update(connector)
				.set({ toolAccess: { create_issue: "off" } })
				.where(eq(connector.id, connectorId)),
		);

		expect(await start(asked)).toMatchObject({ _tag: "Send" });
	});

	it("refuses an approved resend when deletion starts before the execution fence is checked", async () => {
		const asked = askedCall({ toolCallId: "sdk-read-before-deletion", writeOrDelete: false });
		await allowAndResume(asked);
		const started = await start(asked);
		if (started._tag !== "Send") throw new Error("the approved call did not start");

		const resend = await run(
			asTheLoop(opened, (runsTurn) =>
				Effect.gen(function* () {
					yield* Effect.promise(async () => {
						await onDatabase((db) =>
							db.update(workspace).set({ deleting: true }).where(eq(workspace.id, workspaceId)),
						);
						await onDatabase((db) =>
							db
								.update(turn)
								.set({ executionNumber: runsTurn.execution + 1 })
								.where(eq(turn.id, runsTurn.turn.value)),
						);
					});
					const records = yield* TurnRecords.Service;
					return yield* records.startApprovedToolCall(runsTurn, asked);
				}),
			),
		);

		expect(resend).toEqual({ _tag: "Refused", reason: "The chat is unavailable" });
		expect(await storedCall(started.id)).toMatchObject({
			status: "running",
			sentInExecution: opened.principal.executionNumber,
		});
	});

	it("refuses an allowed call after the reviewed connector configuration changes", async () => {
		const asked = askedCall({ toolCallId: "sdk-revision" });
		await allowAndResume(asked);
		await onDatabase((db) =>
			db.update(connector).set({ configurationRevision: 2 }).where(eq(connector.id, connectorId)),
		);

		expect(await start(asked)).toMatchObject({
			_tag: "Refused",
			reason: expect.stringContaining("configuration changed"),
		});
	});

	it("refuses an allowed call to a tool somebody turned off after it was allowed", async () => {
		const asked = askedCall({ toolCallId: "sdk-turned-off" });
		await allowAndResume(asked);
		await onDatabase((db) =>
			db
				.update(connector)
				.set({ toolAccess: { create_issue: "off" } })
				.where(eq(connector.id, connectorId)),
		);

		expect(await start(asked)).toMatchObject({
			_tag: "Refused",
			reason: expect.stringContaining("turned off"),
		});
	});

	it("conceals a pending approval from somebody who cannot reach the bot", async () => {
		const pending = await park(askedCall({ toolCallId: "sdk-stranger" }));
		// A personal bot, which only its creator reaches.
		await onDatabase((db) =>
			db.update(bot).set({ visibility: "personal" }).where(eq(bot.id, botId)),
		);
		const [stranger] = await onDatabase((db) =>
			db
				.insert(member)
				.values({ name: "Kim", email: `stranger-${crypto.randomUUID()}@example.com` })
				.returning(),
		);
		if (!stranger) throw new Error("fixture");
		await onDatabase((db) =>
			db.insert(membership).values({ workspaceId, memberId: stranger.id, role: "editor" }),
		);

		await expect(
			approvalsAs(stranger.id).decide({ toolCallId: pending.id, decision: "allow_once" }),
		).rejects.toBeInstanceOf(ResourceHidden);
	});

	it("refuses a decision to somebody who reaches the bot but may not decide", async () => {
		const pending = await park(askedCall({ toolCallId: "sdk-viewer" }));
		const [viewer] = await onDatabase((db) =>
			db
				.insert(member)
				.values({ name: "Lee", email: `viewer-${crypto.randomUUID()}@example.com` })
				.returning(),
		);
		if (!viewer) throw new Error("fixture");
		await onDatabase((db) =>
			db.insert(membership).values({ workspaceId, memberId: viewer.id, role: "viewer" }),
		);

		await expect(
			approvalsAs(viewer.id).decide({ toolCallId: pending.id, decision: "allow_once" }),
		).rejects.toBeInstanceOf(ActionForbidden);
		const [undecided] = await onDatabase((db) =>
			db.select().from(toolCall).where(eq(toolCall.id, pending.id)),
		);
		expect(undecided).toMatchObject({ approvalStatus: "pending", decidedById: null });
	});

	it("fails calls still running when their turn is cancelled, and records nothing more of them", async () => {
		const id = await fetchCall();

		await run(endTurn(opened, { kind: "cancelled" }));

		const row = await storedCall(id);
		expect(row).toMatchObject({ status: "failed", error: "The turn ended before this finished" });
		expect(row?.finishedAt).not.toBeNull();
		expect(delivered.map(({ event }) => event)).toContainEqual(
			expect.objectContaining({
				type: "tool_call.completed",
				toolCall: expect.objectContaining({ id, status: "failed" }),
			}),
		);
		await expect(close(id, { output: { late: true } })).rejects.toMatchObject({
			_tag: "TurnEnded",
		});
		expect(await storedCall(id)).toMatchObject({
			status: "failed",
			error: "The turn ended before this finished",
		});
	});

	it("forgets the last run's calls when a turn runs again", async () => {
		const id = await fetchCall();
		await run(
			endTurn(opened, { kind: "failed", userMessage: userText`provider down`, mayRunAgain: true }),
		);

		await run(openTurn(opened.run));

		expect(await storedCall(id)).toBeUndefined();
	});

	describe("while its workflow waits for decisions", () => {
		/** What the turn's workflow was told, in order. */
		let heard: Array<
			| { readonly decided: Parameters<TurnSignals.Interface["decide"]>[0] }
			| { readonly cancelled: string }
		>;
		const listening = TurnSignals.Service.of({
			decide: (signal) => Effect.sync(() => void heard.push({ decided: signal })),
			withdraw: () => Effect.void,
			cancel: (executionId) => Effect.sync(() => void heard.push({ cancelled: executionId })),
		});

		beforeEach(() => {
			heard = [];
		});

		const workflowCall = () =>
			askedCall({ toolCallId: "sdk-workflow", input: { title: "Workflow" } });

		it("parks and decides while another approval writer shares the workspace lock", async () => {
			const held = holdTransaction(
				query((db) =>
					db
						.select({ id: workspace.id })
						.from(workspace)
						.where(eq(workspace.id, workspaceId))
						.for("share"),
				),
			);
			await held.held;
			const pending = await park(workflowCall());
			await approvalsAs(adminId).decide({ toolCallId: pending.id, decision: "allow_once" });
			expect(await storedCall(pending.id)).toMatchObject({ approvalStatus: "allowed" });
			await held.release();
		});

		it("records a decision and sends it to the workflow", async () => {
			const pending = await park(workflowCall());

			await approvalsAs(adminId, await signalledBy(listening)).decide({
				toolCallId: pending.id,
				decision: "allow_once",
			});

			expect(await storedCall(pending.id)).toMatchObject({
				approvalStatus: "allowed",
				decidedById: adminId,
			});
			expect(heard).toEqual([
				{
					decided: {
						executionId: opened.run.executionId,
						approvalId: pending.approvalId,
						decision: { decision: "allow_once", memberId: adminId },
					},
				},
			]);
		});

		it("leaves a call to the member its turn acts for, not another administrator", async () => {
			const pending = await park(workflowCall());
			const [administrator] = await onDatabase((db) =>
				db
					.insert(member)
					.values({ name: "Ada", email: `admin-${crypto.randomUUID()}@example.com` })
					.returning(),
			);
			if (!administrator) throw new Error("fixture");
			await onDatabase((db) =>
				db.insert(membership).values({ workspaceId, memberId: administrator.id, role: "admin" }),
			);

			await expect(
				approvalsAs(administrator.id, await signalledBy(listening)).decide({
					toolCallId: pending.id,
					decision: "allow_once",
				}),
			).rejects.toBeInstanceOf(ActionForbidden);
			expect(await storedCall(pending.id)).toMatchObject({
				approvalStatus: "pending",
				decidedById: null,
			});
			expect(heard).toEqual([]);
		});

		it("tells a second member the approval is already decided", async () => {
			const pending = await park(workflowCall());
			const deciding = approvalsAs(adminId, await signalledBy(listening));
			const decide = (decision: "allow_once" | "deny") =>
				deciding.decide({ toolCallId: pending.id, decision });

			await decide("allow_once");

			await expect(decide("deny")).rejects.toBeInstanceOf(ToolApprovalConflict);
		});

		it("tells the chat's watchers of a decision even when the workflow never hears it", async () => {
			const pending = await park(workflowCall());
			const unheard = TurnSignals.Service.of({ ...listening, decide: () => Effect.void });
			delivered = [];

			await approvalsAs(adminId, await signalledBy(unheard)).decide({
				toolCallId: pending.id,
				decision: "allow_once",
			});

			expect(delivered.map(({ event }) => event)).toContainEqual(
				expect.objectContaining({
					type: "tool_call.updated",
					toolCall: expect.objectContaining({
						id: pending.id,
						approval: expect.objectContaining({ status: "allowed" }),
					}),
				}),
			);
		});

		it("frees the lane of a parked turn whose workflow has not released it", async () => {
			const pending = await park(workflowCall());
			expect(await runOnPostgres(runningTurns(chatId))).toHaveLength(1);

			await runOnPostgres(
				releaseParkedLanes.pipe(Effect.provideServiceEffect(Lanes.Service, lanesForTests)),
			);

			expect(await runOnPostgres(runningTurns(chatId))).toHaveLength(0);
			expect(await storedCall(pending.id)).toMatchObject({ approvalStatus: "pending" });
		});

		it.each(["waiting", "cancelled"] as const)(
			"resends a missed cancel to a %s turn without a lane",
			async (status) => {
				await park(workflowCall());
				await runOnPostgres(
					releaseParkedLanes.pipe(Effect.provideServiceEffect(Lanes.Service, lanesForTests)),
				);
				expect(await runOnPostgres(runningTurns(chatId))).toHaveLength(0);
				// Cancelled as its automation run ended and committed, but the process
				// stopped before the signal left.
				await onDatabase((db) =>
					db
						.update(turn)
						.set({
							status,
							endRequested: "run_ended",
							finishedAt: status === "cancelled" ? new Date() : null,
						})
						.where(eq(turn.id, opened.turnId)),
				);

				await runOnPostgres(
					Turns.resendLostCancels.pipe(Effect.provideService(TurnSignals.Service, listening)),
				);

				expect(heard).toContainEqual({ cancelled: opened.run.executionId });
			},
		);

		it("stops resending the cancel of a turn cancelled over a day ago", async () => {
			await park(workflowCall());
			await onDatabase((db) =>
				db
					.update(turn)
					.set({
						status: "cancelled",
						endRequested: "run_ended",
						finishedAt: new Date(Date.now() - Duration.toMillis(Duration.hours(25))),
					})
					.where(eq(turn.id, opened.turnId)),
			);

			await runOnPostgres(
				Turns.resendLostCancels.pipe(Effect.provideService(TurnSignals.Service, listening)),
			);

			expect(heard).not.toContainEqual({ cancelled: opened.run.executionId });
		});
	});
});
