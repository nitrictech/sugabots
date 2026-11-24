import type { InputOf, OperationName } from "@sugabots/contracts/operations";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	seedMember,
	seedMessage,
	seedPage,
	seedTurnAnswering,
} from "../../authentication/seed.test-support.ts";
import { HOST_REQUEST_TOOL } from "../../chats/tools/host-request/name.ts";
import { bot, toolCall } from "../../database/schema.ts";
import { closeDatabase, onDatabase } from "../../database/testing.ts";
import type { Principal } from "../../principal.ts";
import {
	authenticators,
	buildWorld,
	principals,
	type World,
} from "../../proofs/world.test-support.ts";
import { type CallOperation, servedOperations } from "../testing.ts";

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

	/** What calling `name` with `input` for `principal` came to: "ok", or its error's tag. */
	const tried = <Name extends OperationName>(
		principal: Principal,
		name: Name,
		input: InputOf<Name>,
	): Promise<string> =>
		call(principal, name, input).then(
			() => "ok",
			(failure: { readonly _tag: string }) => failure._tag,
		);

	/** What `attempt` came to for each principal of `principals`, by its name. */
	const outcomes = async <Key extends string>(
		principals: Record<Key, Principal>,
		attempt: (principal: Principal) => Promise<string>,
	) => {
		const entries = await Promise.all(
			Object.entries<Principal>(principals).map(async ([key, principal]) => [
				key,
				await attempt(principal),
			]),
		);
		return Object.fromEntries(entries) as Record<Key, string>;
	};

	describe("chats.setResolved", () => {
		it("lets whoever may change what is in the chat's project resolve it: not a viewer, a webhook or system work", async () => {
			expect(
				await outcomes(
					{
						admin: who.admin,
						editor: who.ed,
						viewer: who.vi,
						notInProject: who.erin,
						outsider: who.outsider,
						botInBounds: who.pubForEd,
						botOutsideBounds: who.helperInK,
						run: who.run,
						webhook: who.webhook,
						computerSleep: who.computerSleep,
						compaction: who.compaction,
						page: who.page,
					},
					(principal) => tried(principal, "chats.setResolved", { chatId: a.chat, resolved: true }),
				),
			).toEqual({
				admin: "ok",
				editor: "ok",
				viewer: "ActionForbidden",
				notInProject: "ResourceHidden",
				outsider: "ResourceHidden",
				botInBounds: "ok",
				botOutsideBounds: "ResourceHidden",
				run: "ok",
				webhook: "ActionForbidden",
				computerSleep: "ResourceHidden",
				compaction: "ActionForbidden",
				page: "ResourceHidden",
			});
		});
	});

	describe("chats.renameChat", () => {
		it("leaves renaming a chat to whoever manages its project's chats: admins in J, the bot's managers in its own", async () => {
			const rename = (chatId: string) => (principal: Principal) =>
				tried(principal, "chats.renameChat", { chatId, name: "Renamed" });

			expect(
				await outcomes(
					{
						admin: who.admin,
						editor: who.ed,
						viewer: who.vi,
						notInProject: who.erin,
						adminsBot: who.pubForAdmin,
						editorsBot: who.pubForEd,
						run: who.run,
						page: who.page,
					},
					rename(a.chat),
				),
			).toEqual({
				admin: "ok",
				editor: "ActionForbidden",
				viewer: "ActionForbidden",
				notInProject: "ResourceHidden",
				adminsBot: "ok",
				editorsBot: "ActionForbidden",
				run: "ActionForbidden",
				page: "ResourceHidden",
			});
			expect(
				await outcomes({ creator: who.ed, admin: who.admin, talker: who.erin }, rename(a.pubChat)),
			).toEqual({ creator: "ok", admin: "ok", talker: "ActionForbidden" });
		});
	});

	describe("posting and reading in a chat", () => {
		it("lets the members who reach a chat post in it, a viewer among them, and no other principal", async () => {
			expect(
				await outcomes(
					{
						editor: who.ed,
						viewer: who.vi,
						notInProject: who.erin,
						botInBounds: who.pubForEd,
						run: who.run,
						page: who.page,
					},
					(principal) =>
						tried(principal, "chats.send", {
							chatId: a.chat,
							id: crypto.randomUUID(),
							message: "Ship it?",
						}),
				),
			).toEqual({
				editor: "ok",
				viewer: "ok",
				notInProject: "ResourceHidden",
				botInBounds: "ActionForbidden",
				run: "ActionForbidden",
				page: "ActionForbidden",
			});
		});

		it("shows a chat's pages to whoever reaches it, within a turn's bounds", async () => {
			expect(
				await outcomes(
					{
						viewer: who.vi,
						notInProject: who.erin,
						outsider: who.outsider,
						botInBounds: who.pubForEd,
						botOutsideBounds: who.helperInK,
						run: who.run,
						compaction: who.compaction,
						computerSleep: who.computerSleep,
						page: who.page,
					},
					(principal) => tried(principal, "chats.messages", { chatId: a.chat, limit: 10 }),
				),
			).toEqual({
				viewer: "ok",
				notInProject: "ResourceHidden",
				outsider: "ResourceHidden",
				botInBounds: "ok",
				botOutsideBounds: "ResourceHidden",
				run: "ok",
				compaction: "ok",
				computerSleep: "ResourceHidden",
				page: "ResourceHidden",
			});
		});

		it("lets a member react to a message in a chat they reach, and hides one in a chat they don't", async () => {
			const asked = await seedMessage(a.chat, { member: a.ed });
			const react = (principal: Principal) =>
				tried(principal, "chats.react", { messageId: asked, emoji: "👍" });

			expect(
				await outcomes(
					{ viewer: who.vi, notInProject: who.erin, botInBounds: who.pubForEd },
					react,
				),
			).toEqual({ viewer: "ok", notInProject: "ResourceHidden", botInBounds: "ActionForbidden" });
			expect(await tried(who.ed, "chats.react", { messageId: "not-a-message", emoji: "👍" })).toBe(
				"ResourceHidden",
			);
		});
	});

	describe("what waits for a member across a workspace", () => {
		it("counts it for a member, and for a bot only in member bounds", async () => {
			expect(
				await outcomes(
					{
						viewer: who.vi,
						outsider: who.outsider,
						botInChatBounds: who.pubForEd,
						botInMemberBounds: who.edsAssistant,
						run: who.run,
						webhook: who.webhook,
						page: who.page,
					},
					(principal) => tried(principal, "chats.attention", { workspace: a.workspace }),
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
				await outcomes(
					{
						viewer: who.vi,
						notInProject: who.erin,
						botInBounds: who.pubForEd,
						botOutsideBounds: who.helperInK,
						page: who.page,
					},
					(principal) => tried(principal, "files.versions", { fileId: shown }),
				),
			).toEqual({
				viewer: "ok",
				notInProject: "ResourceHidden",
				botInBounds: "ok",
				botOutsideBounds: "ResourceHidden",
				page: "ResourceHidden",
			});
			expect(
				await outcomes(
					{ editor: who.ed, viewer: who.vi, notInProject: who.erin, botInBounds: who.pubForEd },
					async (principal) => tried(principal, "files.remove", { fileId: await seedPage(a.chat) }),
				),
			).toEqual({
				editor: "ActionForbidden",
				viewer: "ActionForbidden",
				notInProject: "ResourceHidden",
				botInBounds: "ActionForbidden",
			});
			expect(await tried(who.admin, "files.remove", { fileId: shown })).toBe("ok");
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
				tried(principal, "approvals.decide", { toolCallId, decision: "deny" });

			expect(
				await outcomes(
					{
						asker: who.ed,
						owner: who.owner,
						admin: who.admin,
						otherEditor: who.quinn,
						notInProject: who.erin,
						botForAsker: who.pubForEd,
						run: who.run,
					},
					decide,
				),
			).toEqual({
				// Past the approver's check: the seeded turn waits for nothing, so nothing is pending.
				asker: "ToolApprovalNotFound",
				owner: "ActionForbidden",
				admin: "ActionForbidden",
				otherEditor: "ActionForbidden",
				notInProject: "ResourceHidden",
				botForAsker: "ActionForbidden",
				run: "ActionForbidden",
			});
		});

		it("leaves a request to change the project's computer to those who manage the project", async () => {
			const toolCallId = await waitingCall(a.ed, HOST_REQUEST_TOOL);

			expect(
				await outcomes({ asker: who.ed, admin: who.admin }, (principal) =>
					tried(principal, "approvals.decide", { toolCallId, decision: "allow_once" }),
				),
			).toEqual({ asker: "ActionForbidden", admin: "ToolApprovalNotFound" });
		});
	});
});
