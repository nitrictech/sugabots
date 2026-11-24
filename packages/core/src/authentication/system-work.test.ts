import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDatabase, runOnPostgres } from "../database/testing.ts";
import {
	seedAutomation,
	seedBot,
	seedComputer,
	seedMember,
	seedMessage,
	seedProject,
	seedProjectChat,
	seedRoutine,
	seedRun,
	seedWebhookTrigger,
	seedWorkspace,
} from "./seed.test-support.ts";
import { SystemWorkAuthentication } from "./system-work.ts";

describe("SystemWorkAuthentication", () => {
	let auth: SystemWorkAuthentication.Interface;
	let workspaceId: string;
	let leadId: string;
	let projectId: string;
	let chatId: string;

	beforeAll(async () => {
		auth = await runOnPostgres(
			Effect.provide(SystemWorkAuthentication.Service, SystemWorkAuthentication.layer),
		);
		workspaceId = await seedWorkspace();
		const memberId = await seedMember(workspaceId, "editor");
		leadId = (await seedBot(workspaceId)).id;
		projectId = await seedProject(workspaceId, { leadBotId: leadId, members: [memberId] });
		chatId = await seedProjectChat(workspaceId, projectId, memberId);
	});

	afterAll(async () => {
		await closeDatabase();
	});

	const refused = (
		work: Effect.Effect<unknown, SystemWorkAuthentication.StoredWorkGone>,
		kind: string,
	) => expect(runOnPostgres(work)).rejects.toMatchObject({ _tag: "StoredWorkGone", work: kind });

	describe("a compaction", () => {
		it("reaches the chat its request names, when the request's message is that bot's there", async () => {
			const reply = await seedMessage(chatId, { bot: leadId });

			const principal = await runOnPostgres(
				auth.compaction({ chatId, botId: leadId, sourceMessageId: reply }),
			);

			expect(principal._tag).toBe("SystemWork");
			expect(principal.workspace).toBe(workspaceId);
			expect(principal.work).toEqual({ kind: "compaction", chat: chatId });
		});

		it("refuses a request whose message is another bot's, in another chat, or gone", async () => {
			const otherBot = (await seedBot(workspaceId)).id;
			const reply = await seedMessage(chatId, { bot: leadId });
			const elsewhere = await seedProjectChat(
				workspaceId,
				projectId,
				await seedMember(workspaceId, "editor"),
			);

			for (const request of [
				{ chatId, botId: otherBot, sourceMessageId: reply },
				{ chatId: elsewhere, botId: leadId, sourceMessageId: reply },
				{ chatId, botId: leadId, sourceMessageId: randomUUID() },
				{ chatId, botId: leadId, sourceMessageId: "not-an-id" },
			]) {
				await refused(auth.compaction(request), "compaction");
			}
		});
	});

	describe("putting a computer to sleep", () => {
		it("reaches the computer it names, in its project", async () => {
			const computerId = await seedComputer(workspaceId, projectId);

			const principal = await runOnPostgres(auth.computerSleep(computerId));

			expect(principal.work).toEqual({
				kind: "computerSleep",
				computer: computerId,
				project: projectId,
			});
		});

		it("refuses a computer that is gone", async () => {
			await refused(auth.computerSleep(randomUUID()), "computerSleep");
		});
	});

	describe("a routine that fell due", () => {
		it("reaches the automation whose routine is due", async () => {
			const automationId = await seedAutomation(workspaceId, projectId);
			const triggerId = await seedRoutine(automationId, workspaceId, -60);

			const principal = await runOnPostgres(auth.dueRoutine(triggerId));

			expect(principal.work).toEqual({
				kind: "dueRoutine",
				automation: automationId,
				trigger: triggerId,
				project: projectId,
			});
		});

		it("refuses a routine not yet due, a paused or deleted automation's, and a webhook", async () => {
			const automationId = await seedAutomation(workspaceId, projectId);
			const notDue = await seedRoutine(automationId, workspaceId, 3600);
			const paused = await seedRoutine(
				await seedAutomation(workspaceId, projectId, { state: "paused" }),
				workspaceId,
				-60,
			);
			const deleted = await seedRoutine(
				await seedAutomation(workspaceId, projectId, { deleted: true }),
				workspaceId,
				-60,
			);
			const webhook = await seedWebhookTrigger(automationId, workspaceId, { kind: "bearer" }, null);

			for (const triggerId of [notDue, paused, deleted, webhook]) {
				await refused(auth.dueRoutine(triggerId), "dueRoutine");
			}
		});
	});

	describe("pausing an automation after failures", () => {
		const runsEnding = async (
			automationId: string,
			states: readonly ("completed" | "failed")[],
		) => {
			for (const [index, state] of states.entries()) {
				await seedRun(workspaceId, automationId, leadId, "routine", {
					state,
					acceptedAt: new Date(Date.now() - (states.length - index) * 60_000),
				});
			}
		};

		it("reaches an automation whose last runs all failed", async () => {
			const automationId = await seedAutomation(workspaceId, projectId);
			await runsEnding(automationId, ["completed", "failed", "failed"]);

			const principal = await runOnPostgres(auth.pauseAfterFailures(automationId));

			expect(principal.work).toEqual({
				kind: "pauseAfterFailures",
				automation: automationId,
				project: projectId,
			});
		});

		it("refuses one whose latest run completed, or that failed only once", async () => {
			const recovered = await seedAutomation(workspaceId, projectId);
			await runsEnding(recovered, ["failed", "failed", "completed"]);
			const once = await seedAutomation(workspaceId, projectId);
			await runsEnding(once, ["failed"]);

			for (const automationId of [recovered, once]) {
				await refused(auth.pauseAfterFailures(automationId), "pauseAfterFailures");
			}
		});
	});
});
