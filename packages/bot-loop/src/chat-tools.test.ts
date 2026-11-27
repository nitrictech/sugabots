import {
	ActionForbidden,
	ApprovalRefused,
	ResourceHidden,
} from "@sugabots/contracts/errors/proofs";
import {
	seedMessage,
	seedProject,
	seedProjectChat,
} from "@sugabots/core/authentication/seed.test-support";
import { aChatAwaitingReply } from "@sugabots/core/chats/turns/testing";
import { Turns } from "@sugabots/core/chats/turns/turns";
import type { CommittedEvent } from "@sugabots/core/database/events/outbox";
import { membership, message, placedChat } from "@sugabots/core/database/schema";
import { closeDatabase, onDatabase, runOnPostgres } from "@sugabots/core/database/testing";
import { asMember } from "@sugabots/core/operations/chats/testing";
import { operationsForTests } from "@sugabots/core/operations/testing";
import { eq } from "drizzle-orm";
import { Context, Stream } from "effect";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { botLoopOnPostgres, callsOf, failedCall, scriptedSteps, toolResultFor } from "./testing.ts";

/**
 * The chat tools through the bot loop on Postgres: what a turn may change or
 * read of the chats within its bounds, as its asker could.
 */
describe.skipIf(!process.env.DATABASE_URL)("a turn's chat tools, against Postgres", async () => {
	const delivered: CommittedEvent[] = [];
	let afterCommit: ((events: readonly CommittedEvent[]) => Promise<void>) | undefined;
	const loop = await botLoopOnPostgres(delivered, async (events) => afterCommit?.(events));
	const chatsAs = (memberId: string) => asMember(loop.call, memberId);
	let chatId: string;
	let workspaceId: string;
	let botId: string;
	let adminId: string;

	afterAll(async () => {
		await closeDatabase();
	});

	beforeEach(async () => {
		({ chatId, workspaceId, botId, adminId } = await aChatAwaitingReply(chatsAs));
		delivered.length = 0;
		afterCommit = undefined;
	});

	const resolvedAt = async (target: string) => {
		const [stored] = await onDatabase((db) =>
			db
				.select({ resolvedAt: placedChat.resolvedAt })
				.from(placedChat)
				.where(eq(placedChat.id, target)),
		);
		return stored?.resolvedAt;
	};

	const resolveFromTurn = (target: string) =>
		scriptedSteps(
			{
				calls: [
					{
						toolCallId: "resolve",
						toolName: "mark_resolved",
						input: { chatId: target, resolved: true },
					},
				],
			},
			{ text: ["Done."] },
		);

	it("resolves a chat through the operation for an asker who may change it", async () => {
		const { model } = resolveFromTurn(chatId);
		await loop.runTurn(chatId, { model });

		expect(await resolvedAt(chatId)).toBeInstanceOf(Date);
	});

	it("refuses to resolve for a viewer and returns the operation's user message to the model", async () => {
		await onDatabase((db) =>
			db.update(membership).set({ role: "viewer" }).where(eq(membership.memberId, adminId)),
		);
		const { model, requests } = resolveFromTurn(chatId);
		const ran = await loop.runTurn(chatId, { model });

		const error = new ActionForbidden({ proof: "CanChangeChat" }).userMessage;
		expect(await callsOf(ran.turnId)).toMatchObject([{ status: "failed", error }]);
		expect(await resolvedAt(chatId)).toBeNull();
		expect(JSON.stringify(requests[1]?.continuationMessages)).toContain(error);
	});

	it("hides a chat outside the turn's bounds even when the bot and asker both reach it", async () => {
		const project = await seedProject(workspaceId, { leadBotId: botId });
		const elsewhere = await seedProjectChat(workspaceId, project, adminId);
		const { model, requests } = resolveFromTurn(elsewhere);
		await loop.runTurn(chatId, { model });

		expect(await resolvedAt(elsewhere)).toBeNull();
		expect(JSON.stringify(requests[1]?.continuationMessages)).toContain(
			new ResourceHidden({ resource: "chat" }).userMessage,
		);
	});

	it("offers and runs read-only operations for a viewer within the turn's bounds", async () => {
		const current = await chatsAs(adminId).get(chatId);
		if (!current.chat.projectId) throw new Error("The fixture chat needs a project");
		const sibling = await seedProjectChat(workspaceId, current.chat.projectId, adminId);
		const outsideProject = await seedProject(workspaceId, {
			leadBotId: botId,
			visibility: "public",
		});
		const outside = await seedProjectChat(workspaceId, outsideProject, adminId);
		const member = chatsAs(adminId);
		const attachmentIn = async (chatId: string, content: string) => {
			const attached = await member.chatFiles.upload({
				chatId,
				name: "notes.txt",
				type: "text/plain",
				stream: Stream.succeed(new TextEncoder().encode(content)),
			});
			await member.send({
				chatId,
				retryKey: crypto.randomUUID(),
				message: content,
				attachments: [attached.id],
			});
			return attached.id;
		};
		const reachedFile = await attachmentIn(sibling, "Budget: 150 euros");
		const hiddenFile = await attachmentIn(outside, "Budget: private");
		await onDatabase((db) =>
			db.insert(message).values({
				chatId,
				authorMemberId: adminId,
				content: "Budget: later",
				status: "complete",
				parts: [],
			}),
		);
		await onDatabase((db) =>
			db.update(membership).set({ role: "viewer" }).where(eq(membership.memberId, adminId)),
		);
		await expect(member.get(outside)).resolves.toMatchObject({ chat: { id: outside } });
		const { model, requests } = scriptedSteps(
			{
				calls: [
					{
						toolCallId: "search",
						toolName: "search_history",
						input: { chat: "all", query: "budget" },
					},
					{
						toolCallId: "read",
						toolName: "read_chat_file",
						input: { file: reachedFile, chat: sibling },
					},
					{
						toolCallId: "docs",
						toolName: "read_docs",
						input: { page: "members-and-roles", sections: ["Roles"] },
					},
					{ toolCallId: "role", toolName: "workspace_role", input: { member: "@sam" } },
					{
						toolCallId: "hidden-chat",
						toolName: "search_history",
						input: { chat: outside, query: "budget" },
					},
					{ toolCallId: "hidden-file", toolName: "read_chat_file", input: { file: hiddenFile } },
					{
						toolCallId: "wrong-chat",
						toolName: "read_chat_file",
						input: { file: reachedFile, chat: chatId },
					},
				],
			},
			{ text: ["Done."] },
		);

		const ran = await loop.runTurn(chatId, { model });

		expect(ran.outcomes).toEqual([{ _tag: "Continue" }, { _tag: "Finished" }]);
		for (const name of ["search_history", "read_chat_file", "read_docs", "workspace_role"]) {
			expect(requests[0]?.tools).toHaveProperty(name);
		}
		expect(requests[0]?.tools?.read_docs?.description).toContain("members-and-roles");
		const calls = await callsOf(ran.turnId);
		expect(calls).toHaveLength(7);
		expect(
			calls.every(({ writeOrDelete, approvalStatus }) => !writeOrDelete && approvalStatus === null),
		).toBe(true);
		// What the model is given back for each call, by the id it called it with.
		const resultOf = (id: string) => toolResultFor(requests[1], id);
		expect(resultOf("search")).toMatchObject({
			type: "json",
			value: {
				messages: [
					expect.objectContaining({
						chatId: sibling,
						text: expect.stringContaining("Budget: 150 euros"),
					}),
				],
				more: false,
			},
		});
		expect(resultOf("read")).toMatchObject({
			type: "json",
			value: { lines: "1\tBudget: 150 euros", totalLines: 1 },
		});
		expect(resultOf("docs")).toMatchObject({
			type: "json",
			value: { markdown: expect.stringContaining("## Roles") },
		});
		expect(resultOf("role")).toMatchObject({
			type: "json",
			value: { member: { name: "Sam", handle: "sam", role: "viewer" } },
		});
		const chatHidden = new ResourceHidden({ resource: "chat" }).userMessage;
		const fileHidden = new ResourceHidden({ resource: "file" }).userMessage;
		expect(resultOf("hidden-chat")).toEqual(failedCall(chatHidden));
		expect(resultOf("hidden-file")).toEqual(failedCall(fileHidden));
		expect(resultOf("wrong-chat")).toEqual(failedCall(fileHidden));
		expect(JSON.stringify(requests[1]?.continuationMessages)).not.toContain("Budget: private");
	}, 15_000);

	it("resumes a read-only tool call after inherited approval for the recorded arguments", async () => {
		const project = await seedProject(workspaceId, { leadBotId: botId });
		const destination = await seedProjectChat(workspaceId, project, adminId);
		const triggerMessageId = await seedMessage(destination, { bot: botId });
		await onDatabase((db) =>
			db
				.update(message)
				.set({ briefTurnRule: "askBeforeAllTools" })
				.where(eq(message.id, triggerMessageId)),
		);
		await runOnPostgres(
			Context.get(loop.services, Turns.Service).ask({
				chatId: destination,
				botId,
				triggerMessageId,
				reason: "brief",
			}),
		);
		const input = { page: "members-and-roles", sections: ["Roles"] };
		const { model, requests } = scriptedSteps(
			{ calls: [{ toolCallId: "docs", toolName: "read_docs", input }] },
			{ text: ["Done."] },
		);

		const ran = await loop.runTurn(destination, { model });
		const [parked] = await callsOf(ran.turnId);

		if (!parked) throw new Error("No call parked");
		expect(ran.outcomes).toEqual([
			{ _tag: "Waiting", approvals: [parked.approvalId], taken: true },
		]);
		expect(parked).toMatchObject({
			tool: "read_docs",
			input,
			approvalStatus: "pending",
			writeOrDelete: false,
		});
		await chatsAs(adminId).decide({ toolCallId: parked.id, decision: "allow_once" });
		const principal = await ran.authentication.authenticate(ran.turnId);
		const operations = await operationsForTests({ chats: loop.services });
		await expect(
			runOnPostgres(
				operations["chats.readDocs"](
					principal,
					{ ...input, sections: [] },
					{ kind: "toolCall", toolCall: parked.id },
				),
			),
		).rejects.toBeInstanceOf(ApprovalRefused);

		expect(
			await ran.steps.step(ran.run.request, principal, {
				turnId: ran.turnId,
				attempt: 0,
				step: 1,
			}),
		).toEqual({ _tag: "Finished" });
		expect(await callsOf(ran.turnId)).toMatchObject([
			{ id: parked.id, status: "completed", approvalStatus: "allowed", input },
		]);
		expect(JSON.stringify(requests[1]?.continuationMessages)).toContain("## Roles");
	});
});
