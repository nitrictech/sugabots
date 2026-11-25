import { HOST_REQUEST_TOOL } from "@sugabots/contracts";
import { eq } from "drizzle-orm";
import { Stream } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	seedMember,
	seedMessage,
	seedPage,
	seedProjectChat,
	seedTurnAnswering,
} from "../../authentication/seed.test-support.ts";
import { bot, file, toolCall } from "../../database/schema.ts";
import { closeDatabase, onDatabase } from "../../database/testing.ts";
import type { Principal } from "../../principal.ts";
import {
	authenticators,
	buildWorld,
	outcomesFor,
	principals,
	type World,
} from "../../proofs/world.test-support.ts";
import { type CallOperation, operationOutcome, servedOperations } from "../testing.ts";

/**
 * The chats, chat-reads and approvals operations, each called for every kind
 * of principal through the registry, as an entrypoint calls them. What each
 * comes to is "ok" or the tag of its refusal: hidden where the principal
 * doesn't reach the chat, message or file, forbidden where it does but may
 * not act. Who may do what in detail is the provers' tests'; what each
 * service does is `chats/`' and `files/`'.
 *
 * The world is `buildWorld`'s: in workspace A, Ed (an editor) made the public
 * bot Pub, which leads the private project J with Helper in it; Ed, Vi (a
 * viewer) and Quinn are in J, and Erin (an editor) isn't. Ed started a chat in
 * J and one with Pub.
 */
describe("the chat operations, for each kind of principal", () => {
	let world: World;
	let call: CallOperation;
	let as: ReturnType<typeof principals>;
	let a: World["a"];
	/** Every principal the cases call for, in J's chat unless its name says otherwise. */
	let who: Awaited<ReturnType<typeof principalsInJ>>;

	const principalsInJ = async () => {
		const outsider = await seedMember(world.b.workspace, "editor");
		return {
			owner: await as.member(a.owner),
			admin: await as.member(a.admin),
			ed: await as.member(a.ed),
			vi: await as.member(a.vi),
			quinn: await as.member(a.quinn),
			erin: await as.member(a.erin),
			outsider: await as.member(outsider),
			/** Pub answering Ed in J's chat: chat bounds, J. */
			pubForEd: await as.botFor(a.ed, a.pub.id, a.chat),
			/** Pub answering an admin in J's chat: chat bounds, J. */
			pubForAdmin: await as.botFor(a.admin, a.pub.id, a.chat),
			/** Helper answering Ed in K's chat: chat bounds, K, though both reach J. */
			helperInK: await as.botFor(a.ed, a.helper.id, a.otherChat),
			/** Ed's Personal Assistant in its own chat: member bounds. */
			edsAssistant: await as.botFor(a.ed, a.assistant.id, a.assistantChat),
			run: (await as.run(a.workspace, a.project, a.pub.id)).principal,
			webhook: await as.webhook(a.workspace, a.project),
			computerSleep: (await as.computerSleep(a.workspace, a.project)).principal,
			compaction: await as.compaction(a.chat, a.pub.id),
			page: await as.page(a.chat),
		};
	};

	beforeAll(async () => {
		world = await buildWorld();
		a = world.a;
		// Pub answers what members post in its chats.
		await onDatabase((db) =>
			db.update(bot).set({ model: "test/model" }).where(eq(bot.id, a.pub.id)),
		);
		call = await servedOperations();
		as = principals(await authenticators());
		who = await principalsInJ();
	});

	afterAll(async () => {
		await closeDatabase();
	});

	it("hides a file in another chat and a missing file when reading or removing attachments", async () => {
		const [elsewhere] = await onDatabase((db) =>
			db
				.insert(file)
				.values({
					chatId: a.otherChat,
					kind: "attachment",
					uploaderId: a.admin,
					name: "notes.txt",
					contentType: "text/plain",
					size: 5,
				})
				.returning({ id: file.id }),
		);
		if (!elsewhere) throw new Error("Expected a file in the other chat");
		for (const fileId of [elsewhere.id, crypto.randomUUID()]) {
			const address = { chatId: a.chat, fileId };
			expect(await operationOutcome(call, who.admin, "chats.file", address)).toBe("ResourceHidden");
			expect(await operationOutcome(call, who.admin, "chats.removeFile", address)).toBe(
				"ResourceHidden",
			);
		}
	});

	it("hides an unsent upload like a missing file and lets only its uploader remove it", async () => {
		const uploaded = await call(who.ed, "chats.uploadFile", {
			chatId: a.chat,
			name: "notes.txt",
			type: "text/plain",
			content: Stream.make(new TextEncoder().encode("notes")),
		});
		for (const fileId of [uploaded.id, crypto.randomUUID()]) {
			const address = { chatId: a.chat, fileId };
			for (const principal of [who.ed, who.admin]) {
				await expect(call(principal, "chats.file", address)).rejects.toMatchObject({
					_tag: "ResourceHidden",
					resource: "file",
				});
			}
			await expect(call(who.admin, "chats.removeFile", address)).rejects.toMatchObject({
				_tag: "ResourceHidden",
				resource: "file",
			});
		}
		const address = { chatId: a.chat, fileId: uploaded.id };
		expect(await operationOutcome(call, who.ed, "chats.removeFile", address)).toBe("ok");
		expect(await operationOutcome(call, who.ed, "chats.removeFile", address)).toBe(
			"ResourceHidden",
		);
	});

	it("allows reading an attachment on a message and hides it from removal", async () => {
		const chatId = await seedProjectChat(a.workspace, a.project, a.ed);
		const uploaded = await call(who.ed, "chats.uploadFile", {
			chatId,
			name: "notes.txt",
			type: "text/plain",
			content: Stream.make(new TextEncoder().encode("notes")),
		});
		const messageId = await seedMessage(chatId, { member: a.ed });
		await onDatabase((db) =>
			db.update(file).set({ messageId, position: 0 }).where(eq(file.id, uploaded.id)),
		);

		const address = { chatId, fileId: uploaded.id };
		expect(await call(who.admin, "chats.file", address)).toMatchObject({ id: uploaded.id });
		expect(await operationOutcome(call, who.ed, "chats.removeFile", address)).toBe(
			"ResourceHidden",
		);
	});

	describe("chats.setResolved", () => {
		it("shows a chat resolved and then reopened in its project", async () => {
			const chatId = await seedProjectChat(a.workspace, a.project, a.ed);
			const listed = async () =>
				(await call(who.ed, "chats.projectChats", { projectId: a.project })).chats.find(
					({ chat }) => chat.id === chatId,
				)?.chat;

			const input = { chatId, resolved: true };
			await expect(call(who.vi, "chats.setResolved", input)).rejects.toMatchObject({
				_tag: "ActionForbidden",
			});
			await expect(call(who.erin, "chats.setResolved", input)).rejects.toMatchObject({
				_tag: "ResourceHidden",
			});

			await call(who.ed, "chats.setResolved", { chatId, resolved: true });
			expect(await listed()).toMatchObject({ resolvedAt: expect.any(String) });
			await call(who.ed, "chats.setResolved", { chatId, resolved: false });
			expect(await listed()).toMatchObject({ resolvedAt: null });
		});
	});

	describe("chats.renameChat", () => {
		it("lists the chat under the name set by its project admin", async () => {
			const chatId = await seedProjectChat(a.workspace, a.project, a.ed);
			const input = { chatId, name: "Launch notes" };
			await expect(call(who.ed, "chats.renameChat", input)).rejects.toMatchObject({
				_tag: "ActionForbidden",
			});
			await expect(call(who.erin, "chats.renameChat", input)).rejects.toMatchObject({
				_tag: "ResourceHidden",
			});

			await call(who.admin, "chats.renameChat", input);

			const { chats } = await call(who.ed, "chats.projectChats", { projectId: a.project });
			expect(chats.find(({ chat }) => chat.id === chatId)?.chat).toMatchObject({
				title: input.name,
			});
		});
	});

	describe("posting and reading in a chat", () => {
		it("lets the members who reach a chat post in it, a viewer among them, and no other principal", async () => {
			expect(
				await outcomesFor(
					{
						viewer: who.vi,
						notInProject: who.erin,
						botInBounds: who.pubForEd,
					},
					(principal) =>
						operationOutcome(call, principal, "chats.send", {
							chatId: a.chat,
							retryKey: crypto.randomUUID(),
							message: "Ship it?",
						}),
				),
			).toEqual({
				viewer: "ok",
				notInProject: "ResourceHidden",
				botInBounds: "ActionForbidden",
			});
		});

		it("shows a chat's pages to whoever reaches it, within a turn's bounds", async () => {
			expect(
				await outcomesFor(
					{
						viewer: who.vi,
						notInProject: who.erin,
						botOutsideBounds: who.helperInK,
					},
					(principal) =>
						operationOutcome(call, principal, "chats.messages", { chatId: a.chat, limit: 10 }),
				),
			).toEqual({
				viewer: "ok",
				notInProject: "ResourceHidden",
				botOutsideBounds: "ResourceHidden",
			});
		});

		it("lets a member react to a message in a chat they reach, and hides one in a chat they don't", async () => {
			const asked = await seedMessage(a.chat, { member: a.ed });
			const react = (principal: Principal) =>
				operationOutcome(call, principal, "chats.react", { messageId: asked, emoji: "👍" });

			expect(
				await outcomesFor(
					{ viewer: who.vi, notInProject: who.erin, botInBounds: who.pubForEd },
					react,
				),
			).toEqual({ viewer: "ok", notInProject: "ResourceHidden", botInBounds: "ActionForbidden" });
			expect(
				await operationOutcome(call, who.ed, "chats.react", {
					messageId: "not-a-message",
					emoji: "👍",
				}),
			).toBe("ResourceHidden");
		});
	});

	describe("what waits for a member across a workspace", () => {
		it("counts it for a member, and for a bot only in member bounds", async () => {
			expect(
				await outcomesFor(
					{
						viewer: who.vi,
						outsider: who.outsider,
						botInChatBounds: who.pubForEd,
						botInMemberBounds: who.edsAssistant,
						run: who.run,
						webhook: who.webhook,
						page: who.page,
					},
					(principal) =>
						operationOutcome(call, principal, "chats.attention", { workspace: a.workspace }),
				),
			).toEqual({
				viewer: "ok",
				outsider: "ResourceHidden",
				botInChatBounds: "ActionForbidden",
				botInMemberBounds: "ok",
				run: "ActionForbidden",
				webhook: "ActionForbidden",
				page: "ActionForbidden",
			});
		});
	});

	describe("files bots wrote", () => {
		it("shows a file to whoever reaches its chat, and lets only those who manage the chats delete it", async () => {
			const shown = await seedPage(a.chat);

			expect(
				await outcomesFor(
					{
						viewer: who.vi,
						notInProject: who.erin,
						botInBounds: who.pubForEd,
						botOutsideBounds: who.helperInK,
						page: who.page,
					},
					(principal) => operationOutcome(call, principal, "files.versions", { fileId: shown }),
				),
			).toEqual({
				viewer: "ok",
				notInProject: "ResourceHidden",
				botInBounds: "ok",
				botOutsideBounds: "ResourceHidden",
				page: "ResourceHidden",
			});
			expect(
				await outcomesFor(
					{ editor: who.ed, viewer: who.vi, notInProject: who.erin, botInBounds: who.pubForEd },
					async (principal) =>
						operationOutcome(call, principal, "files.remove", { fileId: await seedPage(a.chat) }),
				),
			).toEqual({
				editor: "ActionForbidden",
				viewer: "ActionForbidden",
				notInProject: "ResourceHidden",
				botInBounds: "ActionForbidden",
			});
			expect(await operationOutcome(call, who.admin, "files.remove", { fileId: shown })).toBe("ok");
		});
	});

	describe("approvals.decide", () => {
		/** A call waiting for approval in a turn of Pub's answering `askerId` in J's chat. */
		const waitingCall = async (askerId: string, tool = "create_issue") => {
			const turnId = await seedTurnAnswering(a.chat, a.pub.id, { member: askerId });
			const reply = await seedMessage(a.chat, { bot: a.pub.id, turn: turnId });
			const [row] = await onDatabase((db) =>
				db
					.insert(toolCall)
					.values({
						chatId: a.chat,
						messageId: reply,
						turnId,
						tool,
						approvalComputerProjectId: tool === HOST_REQUEST_TOOL ? a.project : null,
						input: {},
						executionInput: {},
						approvalStatus: "pending",
						status: "awaiting_approval",
						atOffset: 0,
					})
					.returning({ id: toolCall.id }),
			);
			if (!row) throw new Error("fixture");
			return row.id;
		};

		it("lets only the member a turn acts for decide its call, now that an admin or another editor may not", async () => {
			const toolCallId = await waitingCall(a.ed);
			const decide = (principal: Principal) =>
				operationOutcome(call, principal, "approvals.decide", { toolCallId, decision: "deny" });

			expect(
				await outcomesFor(
					{
						asker: who.ed,
						admin: who.admin,
						notInProject: who.erin,
					},
					decide,
				),
			).toEqual({
				// Past the approver's check: the seeded turn waits for nothing, so nothing is pending.
				asker: "ToolApprovalNotFound",
				admin: "ActionForbidden",
				notInProject: "ResourceHidden",
			});
		});

		it("leaves a request to change the project's computer to those who manage the project", async () => {
			const toolCallId = await waitingCall(a.ed, HOST_REQUEST_TOOL);

			expect(
				await outcomesFor({ asker: who.ed, admin: who.admin }, (principal) =>
					operationOutcome(call, principal, "approvals.decide", {
						toolCallId,
						decision: "allow_once",
					}),
				),
			).toEqual({ asker: "ActionForbidden", admin: "ToolApprovalNotFound" });
		});
	});
});
