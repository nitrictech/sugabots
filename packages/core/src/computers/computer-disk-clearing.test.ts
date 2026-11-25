import { COMPUTER_OPENSANDBOX_DEFAULT_SIZE, type RunState } from "@sugabots/contracts";
import { Effect, Layer, Redacted } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { askerColumns } from "../authentication/turn-facts.ts";
import { anAutomationAdmin } from "../chats/automations/testing.ts";
import { seedChat } from "../chats/seed.test-support.ts";
import { automation, message, type TurnStatus, turn } from "../database/schema.ts";
import { closeDatabase, onDatabase, runOnPostgres } from "../database/testing.ts";
import { Ids } from "../ids/ids.ts";
import { defaultProjectOf } from "../workspaces/projects/project-reads.ts";
import {
	BOT_CACHES,
	clearingOrder,
	prepareDiskClearing,
	SET_ASIDE_DIRECTORY,
	type WorkFolders,
} from "./computer-disk-clearing.ts";
import { Computers } from "./computers.ts";
import { removeWorkVolumes } from "./testing.ts";

const env = process.env;
const SLOW = 180_000;
/** No disk is ever less than nothing full, so clearing goes on to the end. */
const ALWAYS_FULL = 0;
/** A disk with any space free is less than entirely full, so clearing stops at once. */
const NEVER_FULL = 1;
/** More folders than one clearing removes, so the rest wait for the next. */
const BACKLOG = 1_200;

/** Clears `computer` of what may go, while its disk is at least `belowShare` full. */
const freeDiskSpace = (computer: Computers.Computer, workspaceId: string, belowShare: number) =>
	prepareDiskClearing(computer, workspaceId, belowShare).pipe(Effect.flatten);

describe.skipIf(!env.DATABASE_URL)("what may be cleared from a computer, against Postgres", () => {
	let workspaceId: string;
	let botId: string;
	let memberId: string;

	afterAll(async () => {
		await closeDatabase();
	});

	beforeEach(async () => {
		({ workspaceId, botId, memberId } = await anAutomationAdmin());
	});

	const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000);

	/** What may be cleared from the folders of the chats `chatIds` and the bots `botIds`, in the order it goes. */
	const clearable = (folders: WorkFolders) => runOnPostgres(clearingOrder(workspaceId, folders));

	async function aTurn(chatId: string, startedAt: Date, status: TurnStatus = "done") {
		const [trigger] = await onDatabase((db) =>
			db
				.insert(message)
				.values({
					chatId,
					authorMemberId: memberId,
					status: "complete",
					parts: [],
					content: "Go.",
				})
				.returning(),
		);
		if (!trigger) throw new Error("Could not create a turn's trigger");
		const [taken] = await onDatabase((db) =>
			db
				.insert(turn)
				.values({
					chatId,
					botId,
					triggerMessageId: trigger.id,
					status,
					model: "test/model",
					startedAt,
					finishedAt: status === "done" ? startedAt : null,
					...askerColumns({ chatId: chatId, botId: botId, triggerMessageId: trigger.id }),
				})
				.returning(),
		);
		if (!taken) throw new Error("Could not create a turn");
		return { messageId: trigger.id, turnId: taken.id };
	}

	/** A chat with the bot whose last turn started at `lastTurnAt`. */
	async function aChat(resolved: boolean, lastTurnAt: Date, status?: TurnStatus) {
		const id = crypto.randomUUID();
		await onDatabase((db) =>
			seedChat(db, {
				id,
				workspaceId,
				kind: "project_chat",
				botId,
				title: "Chat",
				resolvedAt: resolved ? lastTurnAt : null,
				startedById: memberId,
			}),
		);
		await aTurn(id, lastTurnAt, status);
		return id;
	}

	/** An automation run in `state`, whose turn started at `startedAt`. */
	async function anAutomationRun(state: RunState, startedAt: Date) {
		const projectId = await runOnPostgres(defaultProjectOf(botId));
		const [defined] = await onDatabase((db) =>
			db
				.insert(automation)
				.values({
					workspaceId,
					projectId,
					name: `Checks ${crypto.randomUUID()}`,
					instructions: "Check.",
				})
				.returning(),
		);
		if (!defined) throw new Error("Could not create an automation run");
		const requestId = crypto.randomUUID();
		const ended = state === "completed" || state === "failed" || state === "cancelled";
		const run = await onDatabase((db) =>
			seedChat(db, {
				workspaceId,
				kind: "run",
				title: "Checks",
				run: {
					automationId: defined.id,
					botId,
					triggerKind: "manual",
					triggerIdentity: requestId,
					trigger: {
						kind: "manual",
						requestId,
						requestedAt: startedAt.toISOString(),
						requestedByMemberId: memberId,
					},
					automationName: "Checks",
					instructions: "Check.",
					state,
					startedAt,
					finishedAt: ended ? startedAt : null,
				},
			}),
		);
		await aTurn(run.id, startedAt, ended ? "done" : "running");
		return run.id;
	}

	it("clears deleted chats' folders, then deleted bots' homes, then ended runs', then bots' caches, then resolved chats', oldest first", async () => {
		const deleted = crypto.randomUUID();
		const deletedBot = crypto.randomUUID();
		const newerRun = await anAutomationRun("completed", at(30));
		const olderRun = await anAutomationRun("failed", at(90));
		const newerResolved = await aChat(true, at(20));
		const olderResolved = await aChat(true, at(120));

		const order = await clearable({
			chatIds: [newerResolved, newerRun, olderResolved, deleted, olderRun],
			botIds: [botId, deletedBot],
		});

		expect(order).toEqual([
			{ chatId: deleted, reason: "chat_deleted" },
			{ botId: deletedBot, reason: "bot_deleted" },
			{ chatId: olderRun, reason: "automation_run_ended" },
			{ chatId: newerRun, reason: "automation_run_ended" },
			...BOT_CACHES.map((cache) => ({ botId, cache, reason: "bot_cache" })),
			{ chatId: olderResolved, reason: "chat_resolved" },
			{ chatId: newerResolved, reason: "chat_resolved" },
		]);
	});

	it("leaves the folders of chats that may still be worked in", async () => {
		const open = await aChat(false, at(600));
		const running = await anAutomationRun("running", at(600));
		const waitingForApproval = await aChat(true, at(600), "waiting");

		const order = await clearable({ chatIds: [open, running, waitingForApproval], botIds: [] });

		expect(order).toEqual([]);
	});

	/**
	 * In a real computer (`docker compose --profile computers up -d`, with
	 * OPENSANDBOX_URL and OPENSANDBOX_API_KEY set).
	 */
	describe.skipIf(!env.OPENSANDBOX_URL || !env.OPENSANDBOX_API_KEY)("in a computer", () => {
		let computer: Computers.Computer;
		let provider: Computers.Provider;
		const workName = `clearing-${crypto.randomUUID()}`;

		beforeAll(async () => {
			provider = await Effect.runPromise(
				Effect.map(Computers.Service, (computers) =>
					computers.forAccess({
						provider: "opensandbox",
						baseUrl: env.OPENSANDBOX_URL ?? "",
						apiKey: Redacted.make(env.OPENSANDBOX_API_KEY ?? ""),
						image: "debian:bookworm-slim",
						size: COMPUTER_OPENSANDBOX_DEFAULT_SIZE,
						networkMode: "allowed-hosts-only",
					}),
				).pipe(Effect.provide(Computers.layer.pipe(Layer.provide(Ids.layer)))),
			);
			computer = await Effect.runPromise(
				provider.create({
					labels: {},
					reach: { kind: "allowed-hosts-only", hosts: [] },
					workName,
				}),
			);
		}, SLOW);

		afterAll(async () => {
			if (computer) await Effect.runPromise(provider.destroy(computer.id));
			removeWorkVolumes([workName]);
		}, SLOW);

		const run = async (command: string) => {
			const ran = await Effect.runPromise(
				computer.exec(command, { timeout: "30 seconds", maxOutputCharacters: 20_000 }),
			);
			return ran.stdout.text;
		};

		beforeEach(async () => {
			await run(`rm -rf ${Computers.CHATS_DIRECTORY} ${Computers.BOTS_DIRECTORY}`);
		});

		/** Every path under `directory`, relative to it. */
		const pathsUnder = async (directory: string) =>
			(await run(`cd ${directory} && find . -mindepth 1 | sort`)).split("\n").filter(Boolean);

		const chatFolders = () => pathsUnder(Computers.CHATS_DIRECTORY);

		it(
			"removes finished chats' folders, and leaves open chats' alone",
			async () => {
				const deleted = crypto.randomUUID();
				const ended = await anAutomationRun("completed", at(60));
				const open = await aChat(false, at(60));
				await run(
					[
						`mkdir -p ${Computers.CHATS_DIRECTORY}`,
						`cd ${Computers.CHATS_DIRECTORY}`,
						`mkdir -p ${deleted}/repo ${ended}/repo ${open}/repo`,
						`touch ${deleted}/repo/a ${ended}/repo/a ${open}/repo/a`,
					].join(" && "),
				);

				const clearing = await runOnPostgres(freeDiskSpace(computer, workspaceId, ALWAYS_FULL));

				expect(clearing).toEqual({
					cleared: [
						{ chatId: deleted, reason: "chat_deleted" },
						{ chatId: ended, reason: "automation_run_ended" },
					],
					stoppedAtTimeout: false,
				});
				expect(await chatFolders()).toEqual([`./${open}`, `./${open}/repo`, `./${open}/repo/a`]);
			},
			SLOW,
		);

		it(
			"removes deleted bots' homes, read-only folders and all, and the caches the rest have, and leaves the rest of their homes alone",
			async () => {
				const deletedBot = crypto.randomUUID();
				const goModule = `${deletedBot}/go/pkg/mod/example.com/module@v1.0.0`;
				await run(
					[
						`mkdir -p ${Computers.BOTS_DIRECTORY}`,
						`cd ${Computers.BOTS_DIRECTORY}`,
						`mkdir -p ${goModule} ${botId}/notes ${botId}/.cache/pip ${botId}/.bun/install/cache/a ${botId}/.bun/bin`,
						`touch ${goModule}/go.mod ${botId}/notes/a ${botId}/.cache/pip/a ${botId}/.bun/install/cache/a/b ${botId}/.bun/bin/bun`,
						// As Go leaves its module cache.
						`chmod 555 ${goModule}`,
					].join(" && "),
				);

				const clearing = await runOnPostgres(freeDiskSpace(computer, workspaceId, ALWAYS_FULL));

				expect(clearing).toEqual({
					cleared: [
						{ botId: deletedBot, reason: "bot_deleted" },
						{ botId, cache: ".cache", reason: "bot_cache" },
						{ botId, cache: ".bun/install/cache", reason: "bot_cache" },
					],
					stoppedAtTimeout: false,
				});
				expect(await pathsUnder(Computers.BOTS_DIRECTORY)).toEqual([
					`./${botId}`,
					`./${botId}/.bun`,
					`./${botId}/.bun/bin`,
					`./${botId}/.bun/bin/bun`,
					`./${botId}/.bun/install`,
					`./${botId}/notes`,
					`./${botId}/notes/a`,
				]);
				expect(await pathsUnder(SET_ASIDE_DIRECTORY)).toEqual([]);
			},
			SLOW,
		);

		it(
			"clears nothing once the workspace is below the share",
			async () => {
				const ended = await anAutomationRun("completed", at(60));
				await run(`mkdir -p ${Computers.CHATS_DIRECTORY}/${ended}/repo`);

				const clearing = await runOnPostgres(freeDiskSpace(computer, workspaceId, NEVER_FULL));

				expect(clearing).toEqual({ cleared: [], stoppedAtTimeout: false });
				expect(await chatFolders()).toContain(`./${ended}/repo`);
			},
			SLOW,
		);

		it(
			"removes what a clearing cut short set aside, even with nothing else to clear",
			async () => {
				await run(
					`mkdir -p ${SET_ASIDE_DIRECTORY}/1/node_modules && touch ${SET_ASIDE_DIRECTORY}/1/node_modules/a && chmod 555 ${SET_ASIDE_DIRECTORY}/1/node_modules`,
				);

				const clearing = await runOnPostgres(freeDiskSpace(computer, workspaceId, NEVER_FULL));

				expect(clearing).toEqual({ cleared: [], stoppedAtTimeout: false });
				expect(await pathsUnder(SET_ASIDE_DIRECTORY)).toEqual([]);
			},
			SLOW,
		);

		it(
			"clears a backlog a batch at a time, leaving the rest for the next clearing",
			async () => {
				const deleted = Array.from({ length: BACKLOG }, () => crypto.randomUUID());
				await run(
					[
						`mkdir -p ${Computers.CHATS_DIRECTORY}`,
						`cd ${Computers.CHATS_DIRECTORY}`,
						`mkdir ${deleted.join(" ")}`,
					].join(" && "),
				);

				const first = await runOnPostgres(freeDiskSpace(computer, workspaceId, ALWAYS_FULL));
				const leftAfterFirst = (await chatFolders()).length;
				const second = await runOnPostgres(freeDiskSpace(computer, workspaceId, ALWAYS_FULL));

				expect(first.cleared.length).toBeGreaterThan(0);
				expect(leftAfterFirst).toBe(BACKLOG - first.cleared.length);
				expect(leftAfterFirst).toBeGreaterThan(0);
				expect(second.cleared).toHaveLength(leftAfterFirst);
				expect(await chatFolders()).toEqual([]);
			},
			SLOW,
		);
	});
});
