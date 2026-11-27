import { HOST_REQUEST_TOOL } from "@sugabots/contracts";
import { eq } from "drizzle-orm";
import { Stream } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	seedMessage,
	seedProjectChat,
	seedTurnAnswering,
} from "../../authentication/seed.test-support.ts";
import { file, message, toolCall } from "../../database/schema.ts";
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
 * The chat operations whose rules the table in `permissions.test.ts` can't
 * state: an attachment, which is its chat's and, until sent, its uploader's
 * alone, and deciding an approval, which only the call's approvers may. What
 * each comes to is "ok" or the tag of its refusal.
 *
 * The world is `buildWorld`'s: in workspace A, Ed (an editor) made the public
 * bot Pub, which leads the private project J with Helper in it; Ed, Vi (a
 * viewer) and Quinn are in J, and Erin (an editor) isn't. Ed started a chat in
 * J and one in K.
 */
describe("attachments and approvals in a chat", () => {
	let call: CallOperation;
	let a: World["a"];
	/** The members the cases call for. */
	let who: { admin: Principal; ed: Principal; erin: Principal };

	beforeAll(async () => {
		const world = await buildWorld();
		a = world.a;
		call = await servedOperations();
		const as = principals(await authenticators());
		who = {
			admin: await as.member(a.admin),
			ed: await as.member(a.ed),
			erin: await as.member(a.erin),
		};
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

	it("never runs an operation on an input its contract refuses, whatever calls it", async () => {
		const retryKey = crypto.randomUUID();
		// Well typed, but neither text nor a file, which `chats.send`'s schema refuses.
		const empty = { chatId: a.chat, retryKey, message: "" };

		await expect(call(who.ed, "chats.send", empty)).rejects.toThrow(
			"chats.send was called with an input its contract refuses",
		);
		const sent = await onDatabase((db) =>
			db.select().from(message).where(eq(message.retryKey, retryKey)),
		);
		expect(sent).toEqual([]);
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
