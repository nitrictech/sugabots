import type { Bot, Project } from "@sugabots/contracts";
import { HOST_REQUEST_TOOL } from "@sugabots/contracts";
import type { FailureOf, InputOf, RequestOperationName } from "@sugabots/contracts/operations";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
	type Author,
	type SeededBot,
	seedAutomation,
	seedBot,
	seedConnector,
	seedMember,
	seedMessage,
	seedProject,
	seedProjectChat,
	seedTurnAnswering,
} from "../authentication/seed.test-support.ts";
import { seedChat } from "../chats/seed.test-support.ts";
import { automationRun, project, toolCall } from "../database/schema.ts";
import { closeDatabase, onDatabase } from "../database/testing.ts";
import type { Principal } from "../principal.ts";
import {
	authenticators,
	buildWorld,
	principals,
	type World,
} from "../proofs/world.test-support.ts";
import { type CallOperation, servedOperations } from "./testing.ts";

/** The refusals a prover makes: anything else means the principal got past them. */
const REFUSALS: ReadonlySet<string> = new Set([
	"ResourceHidden",
	"ActionForbidden",
	"BotCannotReach",
]);

/**
 * What the API tells a member they may do, against what its operations let
 * them do. For each flag a view returns, the operation it offers is called for
 * the same principal through the registry, as an entrypoint calls it, and the
 * flag must say whether that call got past its provers.
 *
 * The world is `buildWorld`'s: in workspace A, Ed (an editor) made the public
 * bot Pub, which leads the private project J, his personal bot Personal, and
 * has a Personal Assistant; Ed, Vi (a viewer) and Quinn (an editor) are in J,
 * and Erin (an editor) is not.
 */
describe("what the API tells a member agrees with what its operations let them do", () => {
	let world: World;
	let a: World["a"];
	let call: CallOperation;
	let as: ReturnType<typeof principals>;

	beforeAll(async () => {
		world = await buildWorld();
		a = world.a;
		call = await servedOperations();
		as = principals(await authenticators());
	});

	afterAll(async () => {
		await closeDatabase();
	});

	/** Whether `principal` got past the provers of `name`, accepting only the named post-proof failure, when supplied. */
	const allowed = <Name extends RequestOperationName>(
		principal: Principal,
		name: Name,
		input: InputOf<Name>,
		postProofFailure?: FailureOf<Name>["_tag"],
	): Promise<boolean> =>
		call(principal, name, input).then(
			() => {
				if (postProofFailure === undefined) return true;
				throw new Error(`${name} unexpectedly succeeded; expected ${postProofFailure}`);
			},
			(failure: { readonly _tag?: string }) => {
				if (REFUSALS.has(failure._tag ?? "")) return false;
				if (postProofFailure !== undefined && failure._tag === postProofFailure) return true;
				throw failure;
			},
		);

	describe("on a bot, as the bot list tells it", () => {
		/** The bot as the workspace's bot list shows it to `principal`, if it does. */
		const listed = async (principal: Principal, botId: string): Promise<Bot | undefined> =>
			(await call(principal, "bots.list", { workspace: a.workspace })).find(
				(shown) => shown.id === botId,
			);

		/** The flags the bot list gives `principal` on `bot` that these cases check. */
		const told = async (principal: Principal, bot: SeededBot) => {
			const shown = await listed(principal, bot.id);
			if (!shown) return undefined;
			const { resources } = shown.permissions;
			return {
				update: shown.permissions.update,
				talk: shown.permissions.talk,
				readHistory: resources.readHistory,
				resolveChats: resources.resolveChats,
				manageConnectors: resources.manageConnectors,
				manageComputer: resources.manageComputer,
				manageAutomations: resources.manageAutomations,
				pauseAutomations: resources.pauseAutomations,
				delete: shown.permissions.delete,
			};
		};

		/** What `principal` may do with `bot`, by calling the operation each flag offers. */
		const tried = async (principal: Principal, bot: SeededBot, chatStartedBy: string) => {
			const projectId = bot.defaultProject;
			const chatId = await seedProjectChat(a.workspace, projectId, chatStartedBy);
			const automationId = await seedAutomation(a.workspace, projectId);
			const connectorId = await seedConnector(a.workspace, projectId);
			return {
				update: await allowed(principal, "bots.update", {
					botId: bot.id,
					changes: { name: "Checked" },
				}),
				talk: await allowed(principal, "bots.pin", { botId: bot.id }),
				readHistory: await allowed(principal, "chats.projectChats", { projectId }),
				resolveChats: await allowed(principal, "chats.setResolved", { chatId, resolved: true }),
				manageConnectors: await allowed(principal, "connectors.update", {
					projectId,
					connectorId,
					changes: { name: "Checked" },
				}),
				manageComputer: await allowed(principal, "projectComputer.reset", { projectId }),
				manageAutomations: await allowed(principal, "automations.update", {
					projectId,
					automationId,
					changes: { name: "Checked" },
				}),
				pauseAutomations: await allowed(principal, "automations.update", {
					projectId,
					automationId,
					changes: { state: "paused" },
				}),
				// Last, as it deletes the bot.
				delete: await allowed(principal, "bots.remove", { botId: bot.id }),
			};
		};

		it("reports each permission exactly where the corresponding operation permits it", async () => {
			const cases = [
				{ member: a.admin, creator: a.ed, visibility: "personal" },
				{ member: a.owner, creator: a.ed, visibility: "personal" },
				{ member: a.ed, creator: a.ed, visibility: "personal" },
				{ member: a.admin, creator: a.ed, visibility: "public" },
				{ member: a.erin, creator: a.ed, visibility: "public" },
				{ member: a.vi, creator: a.ed, visibility: "public" },
				{ member: a.viewerCreator, creator: a.viewerCreator, visibility: "public" },
			] as const;
			const results: Array<NonNullable<Awaited<ReturnType<typeof told>>>> = [];
			for (const { member, creator, visibility } of cases) {
				const bot = await seedBot(a.workspace, { createdById: creator, visibility });
				const principal = await as.member(member);
				const shown = await told(principal, bot);
				expect(shown, `${visibility} bot for ${member}`).toEqual(
					await tried(principal, bot, creator),
				);
				if (!shown) throw new Error("Expected bot permissions");
				results.push(shown);
			}

			const pam = await seedMember(a.workspace, "viewer");
			const assistant = await seedBot(a.workspace, { assistantOf: pam, visibility: "personal" });
			const member = await as.member(pam);
			const shown = await told(member, assistant);
			expect(shown, "Personal Assistant for its member").toEqual(
				await tried(member, assistant, pam),
			);
			if (!shown) throw new Error("Expected Personal Assistant permissions");
			results.push(shown);

			for (const permission of Object.keys(shown) as Array<keyof typeof shown>) {
				const values = results.map((flags) => flags[permission]);
				expect(values, permission).toContain(true);
				expect(values, permission).toContain(false);
			}
		});

		it("shows an admin no other member's Personal Assistant, which every operation hides", async () => {
			const admin = await as.member(a.admin);
			expect(await told(admin, a.assistant)).toBeUndefined();
			expect(await tried(admin, a.assistant, a.ed)).toEqual({
				update: false,
				talk: false,
				readHistory: false,
				resolveChats: false,
				manageConnectors: false,
				manageComputer: false,
				manageAutomations: false,
				pauseAutomations: false,
				delete: false,
			});
		});
	});

	describe("on a project members made, as the project list tells it", () => {
		/** The project as the workspace's project list shows it to `principal`, if it does. */
		const listed = async (principal: Principal, projectId: string): Promise<Project | undefined> =>
			(await call(principal, "projects.list", { workspace: a.workspace })).find(
				(shown) => shown.id === projectId,
			);

		/** The flags the project list gives `principal` on the project that these cases check. */
		const told = async (principal: Principal, projectId: string) => {
			const shown = await listed(principal, projectId);
			if (!shown) return undefined;
			const { permissions } = shown;
			return {
				readHistory: permissions.resources.readHistory,
				resolveChats: permissions.resources.resolveChats,
				rename: permissions.rename,
				manageMembers: permissions.manageMembers,
				manageAutomations: permissions.resources.manageAutomations,
				pauseAutomations: permissions.resources.pauseAutomations,
				leave: permissions.leave,
				delete: permissions.delete,
			};
		};

		/** What `principal` may do in the project, by calling the operation each flag offers. */
		const tried = async (principal: Principal, projectId: string) => {
			const chatId = await seedProjectChat(a.workspace, projectId, a.ed);
			const automationId = await seedAutomation(a.workspace, projectId);
			return {
				readHistory: await allowed(principal, "chats.projectChats", { projectId }),
				resolveChats: await allowed(principal, "chats.setResolved", { chatId, resolved: true }),
				rename: await allowed(principal, "projects.update", {
					projectId,
					changes: { description: "Checked" },
				}),
				manageMembers: await allowed(principal, "projects.addMember", {
					projectId,
					memberId: a.erin,
				}),
				manageAutomations: await allowed(principal, "automations.update", {
					projectId,
					automationId,
					changes: { name: "Checked" },
				}),
				pauseAutomations: await allowed(principal, "automations.update", {
					projectId,
					automationId,
					changes: { state: "paused" },
				}),
				// Last, as each takes the member or the project away.
				leave: await allowed(principal, "projects.leave", { projectId }),
				delete: await allowed(principal, "projects.remove", { projectId }),
			};
		};

		const agrees = async (
			memberId: string,
			expected: NonNullable<Awaited<ReturnType<typeof told>>>,
		) => {
			const projectId = await seedProject(a.workspace, {
				leadBotId: a.pub.id,
				members: [a.ed, a.vi, a.quinn],
			});
			const principal = await as.member(memberId);
			expect(await told(principal, projectId)).toEqual(expected);
			expect(await tried(principal, projectId)).toEqual(expected);
		};

		it("tells an admin they manage the project and may not leave it", async () => {
			await agrees(a.admin, {
				readHistory: true,
				resolveChats: true,
				rename: true,
				manageMembers: true,
				manageAutomations: true,
				pauseAutomations: true,
				leave: false,
				delete: true,
			});
		});

		it("tells an editor in the project they may resolve its chats, staff it and leave it, and manage nothing", async () => {
			await agrees(a.quinn, {
				readHistory: true,
				resolveChats: true,
				rename: false,
				manageMembers: true,
				manageAutomations: false,
				pauseAutomations: false,
				leave: true,
				delete: false,
			});
		});

		it("tells a viewer in the project they may read it and leave it, and not resolve its chats", async () => {
			await agrees(a.vi, {
				readHistory: true,
				resolveChats: false,
				rename: false,
				manageMembers: false,
				manageAutomations: false,
				pauseAutomations: false,
				leave: true,
				delete: false,
			});
		});
	});

	describe("on an approval", () => {
		/** A call to `tool` waiting for approval, in a turn of `botId` answering what `askedBy` wrote in `chatId`. */
		const waitingCall = async (
			chatId: string,
			botId: string,
			askedBy: Author,
			tool = "create_issue",
		) => {
			const turnId = await seedTurnAnswering(chatId, botId, askedBy);
			return waitingCallIn(chatId, botId, turnId, tool);
		};

		/** A call to `tool` waiting for approval in the turn `turnId` of `botId` in `chatId`. */
		const waitingCallIn = async (chatId: string, botId: string, turnId: string, tool: string) => {
			const reply = await seedMessage(chatId, { bot: botId, turn: turnId });
			const [row] = await onDatabase((db) =>
				db
					.insert(toolCall)
					.values({
						chatId,
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
			waiting.push(row.id);
			return { id: row.id, chatId, reply, turnId };
		};

		/** The calls a case left waiting, decided once it ends, so no other case counts them. */
		const waiting: string[] = [];
		afterEach(async () => {
			for (const id of waiting.splice(0)) {
				await onDatabase((db) =>
					db.update(toolCall).set({ approvalStatus: "denied" }).where(eq(toolCall.id, id)),
				);
			}
		});

		/**
		 * Whether `principal` is told the call waits on them, everywhere it is
		 * told: the Approvals page, the attention count, the project's mark and
		 * the chat's details; and whether deciding it gets past `CanDecide`.
		 */
		const seenAndDecided = async (
			principal: Principal,
			waitingOn: { id: string; chatId: string; reply: string },
			projectId: string,
			kind: "call" | "computerRequest" = "call",
		) => {
			const workspace = a.workspace;
			const approvals = await call(principal, "chats.approvals", { workspace });
			const attention = await call(principal, "chats.attention", { workspace });
			const marks = await call(principal, "chats.attentionMarks", { workspace });
			const details = await call(principal, "chats.get", {
				chatId: waitingOn.chatId,
				limit: 50,
			}).catch((failure: { readonly _tag?: string }) => {
				if (failure._tag === "ResourceHidden") return undefined;
				throw failure;
			});
			const inChat =
				kind === "call"
					? (details?.permissions?.approveToolCallsIn.includes(waitingOn.reply) ?? false)
					: (details?.permissions?.approveComputerRequests ?? false);
			return {
				listed: approvals.waiting.some((request) => request.call.id === waitingOn.id),
				counted: attention.waitingApprovals === 1,
				projectMarked: marks.projects[projectId]?.needsApproval ?? false,
				inChat,
				decides: await allowed(
					principal,
					"approvals.decide",
					{
						toolCallId: waitingOn.id,
						decision: "deny",
					},
					"ToolApprovalNotFound",
				),
			};
		};

		const deciding = {
			listed: true,
			counted: true,
			projectMarked: true,
			inChat: true,
			decides: true,
		};
		const notDeciding = {
			listed: false,
			counted: false,
			projectMarked: false,
			inChat: false,
			decides: false,
		};

		it("tells only the member who asked that a turn's call waits on them, not another member in the chat", async () => {
			const asked = await waitingCall(a.chat, a.pub.id, { member: a.quinn });
			// Quinn asked; Ed made Pub and is in J too; the owner and admin manage J.
			expect(await seenAndDecided(await as.member(a.quinn), asked, a.project)).toEqual(deciding);
			for (const other of [a.ed, a.owner, a.admin, a.vi]) {
				expect(await seenAndDecided(await as.member(other), asked, a.project)).toEqual(notDeciding);
			}
		});

		it("tells a viewer who asked that their turn's call waits on them", async () => {
			const asked = await waitingCall(a.chat, a.pub.id, { member: a.vi });
			expect(await seenAndDecided(await as.member(a.vi), asked, a.project)).toEqual(deciding);
			expect(await seenAndDecided(await as.member(a.quinn), asked, a.project)).toEqual(notDeciding);
		});

		it("tells a bot acting for the member who asked that nothing waits on it, as only a member decides", async () => {
			const asked = await waitingCall(a.chat, a.pub.id, { member: a.ed });
			const pubForEd = await as.botFor(a.ed, a.pub.id, a.chat);
			const details = await call(pubForEd, "chats.get", { chatId: a.chat, limit: 50 });
			expect(details.permissions).toEqual({
				approveToolCallsIn: [],
				approveComputerRequests: false,
				interruptTurns: [],
			});
			expect(
				await allowed(pubForEd, "approvals.decide", { toolCallId: asked.id, decision: "deny" }),
			).toBe(false);
		});

		it("tells those who manage the project, and not the member who asked, that a request to change its computer waits on them", async () => {
			const asked = await waitingCall(a.chat, a.pub.id, { member: a.quinn }, HOST_REQUEST_TOOL);
			for (const manager of [a.owner, a.admin]) {
				expect(
					await seenAndDecided(await as.member(manager), asked, a.project, "computerRequest"),
				).toEqual(deciding);
			}
			for (const other of [a.quinn, a.ed, a.vi]) {
				expect(
					await seenAndDecided(await as.member(other), asked, a.project, "computerRequest"),
				).toEqual(notDeciding);
			}
		});

		it("shows a computer manager only the fixed fields of an approval in a chat they cannot reach", async () => {
			const turnId = await seedTurnAnswering(a.assistantChat, a.assistant.id, { member: a.ed });
			const asked = await waitingCallIn(a.assistantChat, a.assistant.id, turnId, HOST_REQUEST_TOOL);
			await onDatabase((db) =>
				db
					.update(toolCall)
					.set({
						input: { host: "display.example", text: "private model input" },
						executionInput: { host: "docs.example", text: "private model input" },
						output: "private output",
						approvalComputerProjectId: a.project,
						atOffset: 41,
					})
					.where(eq(toolCall.id, asked.id)),
			);

			const [computerProject] = await onDatabase((db) =>
				db.select({ name: project.name }).from(project).where(eq(project.id, a.project)),
			);
			if (!computerProject) throw new Error("No computer project");
			const owner = await as.member(a.owner);
			const listed = (
				await call(owner, "chats.approvals", { workspace: a.workspace })
			).waiting.find(({ call: listed }) => listed.id === asked.id);
			expect(listed).toMatchObject({
				chatId: null,
				rootChatId: null,
				projectId: a.project,
				projectName: computerProject.name,
				bot: { id: a.assistant.id },
				call: { input: { host: "docs.example" }, output: null, atOffset: 0 },
			});
			expect(JSON.stringify(listed)).not.toContain("private");
			await expect(
				call(owner, "chats.get", { chatId: a.assistantChat, limit: 10 }),
			).rejects.toMatchObject({ _tag: "ResourceHidden" });
		});

		it("lists calls from the same turn for their respective approvers", async () => {
			const asked = await waitingCall(a.chat, a.pub.id, { member: a.quinn });
			const computerRequest = await waitingCallIn(
				a.chat,
				a.pub.id,
				asked.turnId,
				HOST_REQUEST_TOOL,
			);
			const asker = await as.member(a.quinn);
			const admin = await as.member(a.admin);

			expect(await seenAndDecided(asker, asked, a.project)).toEqual(deciding);
			expect(await seenAndDecided(admin, computerRequest, a.project, "computerRequest")).toEqual(
				deciding,
			);
		});

		it("tells only its member that a Personal Assistant's call waits on them", async () => {
			const asked = await waitingCall(a.assistantChat, a.assistant.id, { member: a.ed });
			const projectId = a.assistant.defaultProject;
			expect(await seenAndDecided(await as.member(a.ed), asked, projectId)).toEqual(deciding);
			expect(await seenAndDecided(await as.member(a.owner), asked, projectId)).toEqual(notDeciding);
		});

		it("tells admins and the run's bot's managers, and no other member in the project, that a run's call waits on them", async () => {
			const { run, turnId } = await as.run(a.workspace, a.project, a.pub.id);
			// The feed its run belongs to, which the Approvals page and the project's mark list it under.
			const [started] = await onDatabase((db) =>
				db
					.select({ automationId: automationRun.automationId })
					.from(automationRun)
					.where(eq(automationRun.id, run.run)),
			);
			if (!started) throw new Error("fixture");
			await onDatabase((db) =>
				seedChat(db, {
					workspaceId: a.workspace,
					kind: "automation_feed",
					automationId: started.automationId,
					title: "Feed",
				}),
			);
			const asked = await waitingCallIn(run.chat, a.pub.id, turnId, "create_issue");
			for (const approver of [a.admin, a.owner, a.ed]) {
				expect(await seenAndDecided(await as.member(approver), asked, a.project)).toEqual(deciding);
			}
			for (const other of [a.quinn, a.vi]) {
				expect(await seenAndDecided(await as.member(other), asked, a.project)).toEqual(notDeciding);
			}
		});
	});
});
