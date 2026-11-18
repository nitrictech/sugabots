import { COMPUTER_OPENSANDBOX_DEFAULT_SIZE, type RunState } from "@sugabots/contracts";
import { Effect, Layer, Redacted } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { anAutomationOwner } from "../conversations/automations/testing.ts";
import { seedConversation } from "../conversations/seed.test-support.ts";
import { automation, message, type TurnStatus, turn } from "../database/schema.ts";
import { closeDatabase, onDatabase, runOnPostgres } from "../database/testing.ts";
import { Ids } from "../ids/ids.ts";
import {
	BOT_CACHES,
	clearingOrder,
	freeDiskSpace,
	MAX_FOLDERS_CLEARED_AT_ONCE,
	SET_ASIDE_DIRECTORY,
} from "./computer-disk-clearing.ts";
import { Computers } from "./computers.ts";
import { removeWorkVolumes } from "./testing.ts";

const env = process.env;
const SLOW = 180_000;
/** No disk is ever less than nothing full, so clearing goes on to the end. */
const ALWAYS_FULL = 0;
/** A disk with any space free is less than entirely full, so clearing stops at once. */
const NEVER_FULL = 1;

describe.skipIf(!env.DATABASE_URL)("what may be cleared from a computer, against Postgres", () => {
	let workspaceId: string;
	let botId: string;
	let userId: string;

	afterAll(async () => {
		await closeDatabase();
	});

	beforeEach(async () => {
		({ workspaceId, botId, userId } = await anAutomationOwner());
	});

	const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000);

	async function aTurn(conversationId: string, startedAt: Date, status: TurnStatus = "done") {
		const [trigger] = await onDatabase((db) =>
			db
				.insert(message)
				.values({
					conversationId,
					authorUserId: userId,
					kind: "text",
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
					conversationId,
					botId,
					triggerMessageId: trigger.id,
					status,
					model: "test/model",
					startedAt,
					finishedAt: status === "done" ? startedAt : null,
				})
				.returning(),
		);
		if (!taken) throw new Error("Could not create a turn");
		return { messageId: trigger.id, turnId: taken.id };
	}

	/** A conversation with the bot whose last turn started at `lastTurnAt`. */
	async function aConversation(done: boolean, lastTurnAt: Date, status?: TurnStatus) {
		const id = crypto.randomUUID();
		await onDatabase((db) =>
			seedConversation(db, {
				id,
				workspaceId,
				kind: "task",
				botId,
				title: "Conversation",
				doneAt: done ? lastTurnAt : null,
			}),
		);
		await aTurn(id, lastTurnAt, status);
		return id;
	}

	/** A collaboration asked from `conversationId`, the bot asking itself for help. */
	async function aCollaboration(conversationId: string, lastTurnAt: Date) {
		// Asked long ago, so the conversation's own latest turn still places it.
		const asking = await aTurn(conversationId, new Date(0));
		const made = await onDatabase((db) =>
			seedConversation(db, {
				workspaceId,
				kind: "collaboration",
				title: "Collaboration",
				collaboration: {
					parentConversationId: conversationId,
					rootConversationId: conversationId,
					parentMessageId: asking.messageId,
					turnId: asking.turnId,
					collaboratorBotId: botId,
					brief: "Help.",
					atOffset: 0,
				},
			}),
		);
		await aTurn(made.id, lastTurnAt);
		return made.id;
	}

	/** An automation run in `state`, whose turn started at `startedAt`. */
	async function anAutomationRun(state: RunState, startedAt: Date) {
		const [defined] = await onDatabase((db) =>
			db
				.insert(automation)
				.values({
					workspaceId,
					botId,
					name: `Checks ${crypto.randomUUID()}`,
					instructions: "Check.",
				})
				.returning(),
		);
		if (!defined) throw new Error("Could not create an automation run");
		const requestId = crypto.randomUUID();
		const ended = state === "completed" || state === "failed" || state === "cancelled";
		const run = await onDatabase((db) =>
			seedConversation(db, {
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
						requestedByUserId: userId,
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

	it("clears deleted conversations' folders, then deleted bots' homes, then ended runs', then bots' caches, then done conversations', oldest first", async () => {
		const deleted = crypto.randomUUID();
		const deletedBot = crypto.randomUUID();
		const newerRun = await anAutomationRun("completed", at(30));
		const olderRun = await anAutomationRun("failed", at(90));
		const newerDone = await aConversation(true, at(20));
		const olderDone = await aConversation(true, at(120));
		const helpWithNewerDone = await aCollaboration(newerDone, at(10));

		const order = await runOnPostgres(
			clearingOrder(workspaceId, {
				conversationIds: [helpWithNewerDone, newerDone, newerRun, olderDone, deleted, olderRun],
				botIds: [botId, deletedBot],
			}),
		);

		expect(order).toEqual([
			{ conversationId: deleted, reason: "conversation_deleted" },
			{ botId: deletedBot, reason: "bot_deleted" },
			{ conversationId: olderRun, reason: "automation_run_ended" },
			{ conversationId: newerRun, reason: "automation_run_ended" },
			...BOT_CACHES.map((cache) => ({ botId, cache, reason: "bot_cache" })),
			{ conversationId: olderDone, reason: "conversation_done" },
			{ conversationId: newerDone, reason: "conversation_done" },
			{ conversationId: helpWithNewerDone, reason: "conversation_done" },
		]);
	});

	it("leaves the folders of conversations that may still be worked in", async () => {
		const open = await aConversation(false, at(600));
		const running = await anAutomationRun("running", at(600));
		const waitingForApproval = await aConversation(true, at(600), "waiting");

		expect(
			await runOnPostgres(
				clearingOrder(workspaceId, {
					conversationIds: [open, running, waitingForApproval],
					botIds: [],
				}),
			),
		).toEqual([]);
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
					computers.forConnection({
						provider: "opensandbox",
						baseUrl: env.OPENSANDBOX_URL ?? "",
						apiKey: Redacted.make(env.OPENSANDBOX_API_KEY ?? ""),
						image: "debian:bookworm-slim",
						size: COMPUTER_OPENSANDBOX_DEFAULT_SIZE,
						networkMode: "allowlist",
					}),
				).pipe(Effect.provide(Computers.layer.pipe(Layer.provide(Ids.layer)))),
			);
			computer = await Effect.runPromise(
				provider.create({
					labels: {},
					reach: { kind: "allowlist", hosts: [] },
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
			await run(`rm -rf ${Computers.CONVERSATIONS_DIRECTORY} ${Computers.BOTS_DIRECTORY}`);
		});

		/** Every path under `directory`, relative to it. */
		const pathsUnder = async (directory: string) =>
			(await run(`cd ${directory} && find . -mindepth 1 | sort`)).split("\n").filter(Boolean);

		const conversationFolders = () => pathsUnder(Computers.CONVERSATIONS_DIRECTORY);

		it(
			"removes finished conversations' folders, and leaves open conversations' alone",
			async () => {
				const deleted = crypto.randomUUID();
				const ended = await anAutomationRun("completed", at(60));
				const open = await aConversation(false, at(60));
				await run(
					[
						`mkdir -p ${Computers.CONVERSATIONS_DIRECTORY}`,
						`cd ${Computers.CONVERSATIONS_DIRECTORY}`,
						`mkdir -p ${deleted}/repo ${ended}/repo ${open}/repo`,
						`touch ${deleted}/repo/a ${ended}/repo/a ${open}/repo/a`,
					].join(" && "),
				);

				const clearing = await runOnPostgres(freeDiskSpace(computer, workspaceId, ALWAYS_FULL));

				expect(clearing).toEqual({
					cleared: [
						{ conversationId: deleted, reason: "conversation_deleted" },
						{ conversationId: ended, reason: "automation_run_ended" },
					],
					stoppedAtTimeout: false,
				});
				expect(await conversationFolders()).toEqual([
					`./${open}`,
					`./${open}/repo`,
					`./${open}/repo/a`,
				]);
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
				await run(`mkdir -p ${Computers.CONVERSATIONS_DIRECTORY}/${ended}/repo`);

				const clearing = await runOnPostgres(freeDiskSpace(computer, workspaceId, NEVER_FULL));

				expect(clearing).toEqual({ cleared: [], stoppedAtTimeout: false });
				expect(await conversationFolders()).toContain(`./${ended}/repo`);
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
				const deleted = Array.from({ length: MAX_FOLDERS_CLEARED_AT_ONCE + 1 }, () =>
					crypto.randomUUID(),
				);
				await run(
					[
						`mkdir -p ${Computers.CONVERSATIONS_DIRECTORY}`,
						`cd ${Computers.CONVERSATIONS_DIRECTORY}`,
						`mkdir ${deleted.join(" ")}`,
					].join(" && "),
				);

				const first = await runOnPostgres(freeDiskSpace(computer, workspaceId, ALWAYS_FULL));
				const second = await runOnPostgres(freeDiskSpace(computer, workspaceId, ALWAYS_FULL));

				expect(first.cleared).toHaveLength(MAX_FOLDERS_CLEARED_AT_ONCE);
				expect(second.cleared).toHaveLength(1);
				expect(await conversationFolders()).toEqual([]);
			},
			SLOW,
		);
	});
});
