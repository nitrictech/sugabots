import { type RoutineExecutionState, SANDBOX_OPENSANDBOX_DEFAULT_SIZE } from "@sugabots/contracts";
import { Effect, Layer, Redacted } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { aRoutineOwner } from "../conversations/routines/testing.ts";
import {
	message,
	routine,
	routineExecution,
	type TurnStatus,
	thread,
	turn,
} from "../database/schema.ts";
import { closeDatabase, onDatabase, runOnPostgres } from "../database/testing.ts";
import { Ids } from "../ids/ids.ts";
import {
	clearFinishedThreadFolders,
	clearingOrder,
	MAX_FOLDERS_CLEARED_AT_ONCE,
} from "./sandbox-disk-clearing.ts";
import { Sandboxes } from "./sandboxes.ts";

const env = process.env;
const SLOW = 180_000;
/** No disk is ever less than nothing full, so clearing goes on to the end. */
const ALWAYS_FULL = 0;
/** A disk with any space free is less than entirely full, so clearing stops at once. */
const NEVER_FULL = 1;

describe.skipIf(!env.DATABASE_URL)("which thread folders may be cleared, against Postgres", () => {
	let workspaceId: string;
	let podId: string;
	let agentId: string;
	let userId: string;

	afterAll(async () => {
		await closeDatabase();
	});

	beforeEach(async () => {
		({ workspaceId, podId, agentId, userId } = await aRoutineOwner());
	});

	const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000);

	async function aTurn(threadId: string, startedAt: Date, status: TurnStatus = "done") {
		const [trigger] = await onDatabase((db) =>
			db
				.insert(message)
				.values({
					threadId,
					authorUserId: userId,
					kind: "text",
					status: "complete",
					parts: [],
					content: "Go.",
				})
				.returning(),
		);
		if (!trigger) throw new Error("Could not create a turn's trigger");
		await onDatabase((db) =>
			db.insert(turn).values({
				threadId,
				agentId,
				triggerMessageId: trigger.id,
				status,
				model: "test/model",
				startedAt,
				finishedAt: status === "done" ? startedAt : null,
			}),
		);
	}

	/** A conversation with the agent whose last turn started at `lastTurnAt`. */
	async function aConversation(done: boolean, lastTurnAt: Date, status?: TurnStatus) {
		const id = crypto.randomUUID();
		await onDatabase((db) =>
			db.insert(thread).values({
				id,
				workspaceId,
				podId,
				hostAgentId: agentId,
				type: "conversation",
				title: "Conversation",
				conversationId: id,
				doneAt: done ? lastTurnAt : null,
			}),
		);
		await aTurn(id, lastTurnAt, status);
		return id;
	}

	/** A thread under `conversationId`, such as one agent asking another for help. */
	async function aCollaboration(conversationId: string, lastTurnAt: Date) {
		const [made] = await onDatabase((db) =>
			db
				.insert(thread)
				.values({
					workspaceId,
					podId,
					hostAgentId: agentId,
					type: "collaboration",
					title: "Collaboration",
					conversationId,
					parentThreadId: conversationId,
				})
				.returning(),
		);
		if (!made) throw new Error("Could not create a collaboration");
		await aTurn(made.id, lastTurnAt);
		return made.id;
	}

	/** A routine run in `state`, whose turn started at `startedAt`. */
	async function aRoutineRun(state: RoutineExecutionState, startedAt: Date) {
		const [defined] = await onDatabase((db) =>
			db
				.insert(routine)
				.values({
					workspaceId,
					agentId,
					name: `Checks ${crypto.randomUUID()}`,
					instructions: "Check.",
				})
				.returning(),
		);
		const [run] = await onDatabase((db) =>
			db
				.insert(thread)
				.values({ workspaceId, podId, hostAgentId: agentId, type: "routine", title: "Checks" })
				.returning(),
		);
		if (!defined || !run) throw new Error("Could not create a routine run");
		const requestId = crypto.randomUUID();
		const ended = state === "completed" || state === "failed" || state === "cancelled";
		await onDatabase((db) =>
			db.insert(routineExecution).values({
				routineId: defined.id,
				workspaceId,
				agentId,
				threadId: run.id,
				triggerKind: "manual",
				triggerIdentity: requestId,
				trigger: {
					kind: "manual",
					requestId,
					requestedAt: startedAt.toISOString(),
					requestedByUserId: userId,
				},
				routineName: "Checks",
				instructions: "Check.",
				state,
				startedAt,
				finishedAt: ended ? startedAt : null,
			}),
		);
		await aTurn(run.id, startedAt, ended ? "done" : "running");
		return run.id;
	}

	it("clears deleted threads' folders, then ended runs', then done conversations', oldest first", async () => {
		const deleted = crypto.randomUUID();
		const newerRun = await aRoutineRun("completed", at(30));
		const olderRun = await aRoutineRun("failed", at(90));
		const newerDone = await aConversation(true, at(20));
		const olderDone = await aConversation(true, at(120));
		const helpWithNewerDone = await aCollaboration(newerDone, at(10));

		const order = await runOnPostgres(
			clearingOrder(workspaceId, [
				helpWithNewerDone,
				newerDone,
				newerRun,
				olderDone,
				deleted,
				olderRun,
			]),
		);

		expect(order).toEqual([
			{ threadId: deleted, reason: "thread_deleted" },
			{ threadId: olderRun, reason: "routine_run_ended" },
			{ threadId: newerRun, reason: "routine_run_ended" },
			{ threadId: olderDone, reason: "conversation_done" },
			{ threadId: newerDone, reason: "conversation_done" },
			{ threadId: helpWithNewerDone, reason: "conversation_done" },
		]);
	});

	it("leaves the folders of threads that may still be worked in", async () => {
		const open = await aConversation(false, at(600));
		const running = await aRoutineRun("running", at(600));
		const waitingForApproval = await aConversation(true, at(600), "waiting");

		expect(
			await runOnPostgres(clearingOrder(workspaceId, [open, running, waitingForApproval])),
		).toEqual([]);
	});

	/**
	 * In a real sandbox (`docker compose --profile sandboxes up -d`, with
	 * OPENSANDBOX_URL and OPENSANDBOX_API_KEY set).
	 */
	describe.skipIf(!env.OPENSANDBOX_URL || !env.OPENSANDBOX_API_KEY)("in a sandbox", () => {
		let sandbox: Sandboxes.Sandbox;
		let provider: Sandboxes.Provider;

		beforeAll(async () => {
			provider = await Effect.runPromise(
				Effect.map(Sandboxes.Service, (sandboxes) =>
					sandboxes.forConnection({
						provider: "opensandbox",
						baseUrl: env.OPENSANDBOX_URL ?? "",
						apiKey: Redacted.make(env.OPENSANDBOX_API_KEY ?? ""),
						image: "debian:bookworm-slim",
						size: SANDBOX_OPENSANDBOX_DEFAULT_SIZE,
						networkMode: "allowlist",
					}),
				).pipe(Effect.provide(Sandboxes.layer.pipe(Layer.provide(Ids.layer)))),
			);
			sandbox = await Effect.runPromise(
				provider.create({
					labels: {},
					reach: { kind: "allowlist", hosts: [] },
					workName: `clearing-${crypto.randomUUID()}`,
				}),
			);
		}, SLOW);

		afterAll(async () => {
			if (sandbox) await Effect.runPromise(provider.destroy(sandbox.id));
		}, SLOW);

		const run = async (command: string) => {
			const ran = await Effect.runPromise(
				sandbox.exec(command, { timeout: "30 seconds", maxOutputCharacters: 20_000 }),
			);
			return ran.stdout.text;
		};

		/** Every path under the threads' folders, relative to them. */
		const threadFolders = async () =>
			(await run(`cd ${Sandboxes.THREADS_DIRECTORY} && find . -mindepth 1 | sort`))
				.split("\n")
				.filter(Boolean);

		it(
			"removes finished threads' folders, and leaves open threads' alone",
			async () => {
				const deleted = crypto.randomUUID();
				const ended = await aRoutineRun("completed", at(60));
				const open = await aConversation(false, at(60));
				await run(
					[
						`rm -rf ${Sandboxes.THREADS_DIRECTORY}`,
						`mkdir -p ${Sandboxes.THREADS_DIRECTORY}`,
						`cd ${Sandboxes.THREADS_DIRECTORY}`,
						`mkdir -p ${deleted}/repo ${ended}/repo ${open}/repo`,
						`touch ${deleted}/repo/a ${ended}/repo/a ${open}/repo/a`,
					].join(" && "),
				);

				const clearing = await runOnPostgres(
					clearFinishedThreadFolders(sandbox, workspaceId, ALWAYS_FULL),
				);

				expect(clearing).toEqual({
					cleared: [
						{ threadId: deleted, reason: "thread_deleted" },
						{ threadId: ended, reason: "routine_run_ended" },
					],
					stoppedAtTimeout: false,
				});
				expect(await threadFolders()).toEqual([`./${open}`, `./${open}/repo`, `./${open}/repo/a`]);
			},
			SLOW,
		);

		it(
			"clears nothing once the workspace is below the share",
			async () => {
				const ended = await aRoutineRun("completed", at(60));
				await run(`mkdir -p ${Sandboxes.THREADS_DIRECTORY}/${ended}/repo`);

				const clearing = await runOnPostgres(
					clearFinishedThreadFolders(sandbox, workspaceId, NEVER_FULL),
				);

				expect(clearing).toEqual({ cleared: [], stoppedAtTimeout: false });
				expect(await threadFolders()).toContain(`./${ended}/repo`);
			},
			SLOW,
		);

		it(
			"clears a backlog a batch at a time, leaving the rest for the next clearing",
			async () => {
				const deleted = Array.from({ length: MAX_FOLDERS_CLEARED_AT_ONCE + 1 }, () =>
					crypto.randomUUID(),
				);
				await run(
					[
						`rm -rf ${Sandboxes.THREADS_DIRECTORY}`,
						`mkdir -p ${Sandboxes.THREADS_DIRECTORY}`,
						`cd ${Sandboxes.THREADS_DIRECTORY}`,
						`mkdir ${deleted.join(" ")}`,
					].join(" && "),
				);

				const first = await runOnPostgres(
					clearFinishedThreadFolders(sandbox, workspaceId, ALWAYS_FULL),
				);
				const second = await runOnPostgres(
					clearFinishedThreadFolders(sandbox, workspaceId, ALWAYS_FULL),
				);

				expect(first.cleared).toHaveLength(MAX_FOLDERS_CLEARED_AT_ONCE);
				expect(second.cleared).toHaveLength(1);
				expect(await threadFolders()).toEqual([]);
			},
			SLOW,
		);
	});
});
