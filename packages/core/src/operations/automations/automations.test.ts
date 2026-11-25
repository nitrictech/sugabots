import type { InputOf, RequestOperationName } from "@sugabots/contracts/operations";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	seedAutomation,
	seedBot,
	seedConnector,
	seedMember,
	seedProject,
	seedProjectChat,
	seedWebhookTrigger,
	unique,
} from "../../authentication/seed.test-support.ts";
import { projectBot } from "../../database/schema.ts";
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
 * The automations operations, each called for every kind of principal
 * through the registry, as an entrypoint calls them. What each comes to is
 * "ok" or the tag of its refusal: hidden where the principal doesn't reach
 * the project, forbidden where it does but may not act. Who may do what in
 * detail is the provers' tests'; the automations' own rules are
 * `chats/automations/`'.
 *
 * The world is `buildWorld`'s: in workspace A, Ed (an editor) made the public
 * bot Pub, which leads the private project J with Helper in it, and his
 * personal bot Personal; Ed, Vi (a viewer) and Quinn are in J, and Erin (an
 * editor) isn't.
 */
describe("the automations operations, for each kind of principal", () => {
	let world: World;
	let call: CallOperation;
	let as: ReturnType<typeof principals>;
	let a: World["a"];
	let who: Awaited<ReturnType<typeof everyPrincipal>>;

	const everyPrincipal = async () => {
		const outsider = await seedMember(world.b.workspace, "editor");
		const adminsAssistant = await seedBot(a.workspace, {
			assistantOf: a.admin,
			visibility: "personal",
		});
		const adminsAssistantChat = await seedProjectChat(
			a.workspace,
			adminsAssistant.defaultProject,
			a.admin,
		);
		return {
			owner: await as.member(a.owner),
			admin: await as.member(a.admin),
			ed: await as.member(a.ed),
			vi: await as.member(a.vi),
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
			/** An admin's Personal Assistant in its own chat: member bounds. */
			adminsAssistant: await as.botFor(a.admin, adminsAssistant.id, adminsAssistantChat),
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
		call = await servedOperations();
		as = principals(await authenticators());
		who = await everyPrincipal();
	});

	afterAll(async () => {
		await closeDatabase();
	});

	/** What calling `name` with `input` for `principal` came to: "ok", or its error's tag. */
	const tried = <Name extends RequestOperationName>(
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

	/** A new automation of `projectId`, run only by hand. */
	const anAutomation = async (projectId: string) => ({
		projectId,
		automationId: await seedAutomation(a.workspace, projectId),
	});

	describe("reading a project's automations", () => {
		it("lists them to whoever reaches the project, within a turn's bounds", async () => {
			const list = (principal: Principal) =>
				tried(principal, "automations.list", { projectId: a.project });

			expect(
				await outcomes(
					{
						admin: who.admin,
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
					list,
				),
			).toEqual({
				admin: "ok",
				viewer: "ok",
				notInProject: "ResourceHidden",
				outsider: "ResourceHidden",
				botInBounds: "ok",
				botOutsideBounds: "ResourceHidden",
				run: "ok",
				webhook: "ResourceHidden",
				computerSleep: "ResourceHidden",
				compaction: "ResourceHidden",
				page: "ResourceHidden",
			});
		});

		it("lists a project's runs only to members, askers and runs that reach it", async () => {
			const projectId = await seedProject(a.workspace, {
				leadBotId: a.pub.id,
				members: [a.ed, a.vi],
			});
			const runs = (principal: Principal) =>
				tried(principal, "automations.projectRuns", { projectId, limit: 20 });
			const chatId = await seedProjectChat(a.workspace, projectId, a.ed);
			const { principal: run } = await as.run(a.workspace, projectId, a.pub.id);
			if (run._tag !== "AutomationRun") throw new Error("Expected an automation run");
			await call(who.admin, "chats.openAutomationFeed", {
				workspace: a.workspace,
				automationId: run.automation,
			});

			expect(
				await outcomes(
					{
						admin: who.admin,
						viewer: who.vi,
						asker: await as.botFor(a.ed, a.pub.id, chatId),
						run,
						notInProject: who.erin,
						computerSleep: (await as.computerSleep(a.workspace, projectId)).principal,
						compaction: await as.compaction(chatId, a.pub.id),
					},
					runs,
				),
			).toEqual({
				admin: "ok",
				viewer: "ok",
				asker: "ok",
				run: "ok",
				notInProject: "ResourceHidden",
				computerSleep: "ResourceHidden",
				compaction: "ResourceHidden",
			});
		});

		it("shows an admin only a personal bot’s automation names and states", async () => {
			const own = a.personal.defaultProject;
			const created = await anAutomation(own);
			const listed = await call(who.admin, "automations.list", { projectId: own });

			expect(listed).toEqual([
				{ id: created.automationId, name: expect.any(String), state: "enabled", restricted: true },
			]);
			const ownView = await call(who.ed, "automations.list", { projectId: own });
			expect(ownView[0]).toHaveProperty("instructions");
			expect({
				adminsRuns: await tried(who.admin, "automations.projectRuns", {
					projectId: own,
					limit: 20,
				}),
				editorWhoDidNotMakeIt: await tried(who.erin, "automations.list", { projectId: own }),
				creator: await tried(who.ed, "automations.list", { projectId: own }),
			}).toEqual({
				adminsRuns: "ResourceHidden",
				editorWhoDidNotMakeIt: "ResourceHidden",
				creator: "ok",
			});
		});
	});

	describe("managing a project's automations", () => {
		it("accepts the web app’s automation definition from signed-in project managers", async () => {
			const create = (principal: Principal, projectId = a.project) =>
				tried(principal, "automations.create", {
					projectId,
					name: `Automation ${unique()}`,
					instructions: "Handle it.",
					triggers: [],
				});

			expect({
				...(await outcomes(
					{
						owner: who.owner,
						admin: who.admin,
						editor: who.ed,
						viewer: who.vi,
						notInProject: who.erin,
						adminsBotInChatBounds: who.pubForAdmin,
						adminsAssistant: who.adminsAssistant,
						editorsAssistant: who.edsAssistant,
						run: who.run,
						webhook: who.webhook,
						computerSleep: who.computerSleep,
						compaction: who.compaction,
						page: who.page,
					},
					(principal) => create(principal),
				)),
				creatorInBotsOwnProject: await create(who.ed, a.pub.defaultProject),
				editorInSomeoneElsesBotsProject: await create(who.erin, a.pub.defaultProject),
			}).toEqual({
				owner: "ok",
				admin: "ok",
				editor: "ActionForbidden",
				viewer: "ActionForbidden",
				notInProject: "ResourceHidden",
				adminsBotInChatBounds: "ActionForbidden",
				adminsAssistant: "ActionForbidden",
				editorsAssistant: "ActionForbidden",
				run: "ActionForbidden",
				webhook: "ResourceHidden",
				computerSleep: "ResourceHidden",
				compaction: "ResourceHidden",
				page: "ResourceHidden",
				creatorInBotsOwnProject: "ok",
				editorInSomeoneElsesBotsProject: "ActionForbidden",
			});
		});

		it("lets an admin only switch off a personal bot's automations, which they can't otherwise reach", async () => {
			const automation = await anAutomation(a.personal.defaultProject);

			expect({
				pausing: await call(who.admin, "automations.update", {
					...automation,
					changes: { state: "paused" },
				}),
				missingAutomation: await tried(who.admin, "automations.update", {
					...automation,
					automationId: crypto.randomUUID(),
					changes: { state: "paused" },
				}),
				renaming: await tried(who.admin, "automations.update", {
					...automation,
					changes: { name: "Mine now" },
				}),
				resuming: await tried(who.admin, "automations.update", {
					...automation,
					changes: { state: "enabled" },
				}),
				deleting: await tried(who.admin, "automations.remove", automation),
				editorWhoDidNotMakeIt: await tried(who.erin, "automations.update", {
					...automation,
					changes: { state: "paused" },
				}),
				creator: await tried(who.ed, "automations.update", {
					...automation,
					changes: { name: "Renamed" },
				}),
			}).toEqual({
				pausing: {
					automation: {
						id: automation.automationId,
						name: expect.any(String),
						state: "paused",
						restricted: true,
					},
					secrets: [],
				},
				missingAutomation: "ResourceHidden",
				renaming: "ResourceHidden",
				resuming: "ResourceHidden",
				deleting: "ResourceHidden",
				editorWhoDidNotMakeIt: "ResourceHidden",
				creator: "ok",
			});
		});
	});

	it("hides child ids from a bot that lost reach to a project its asker still reaches", async () => {
		const projectId = await seedProject(a.workspace, {
			leadBotId: a.pub.id,
			bots: [a.helper.id],
			members: [a.ed],
		});
		const chat = await seedProjectChat(a.workspace, projectId, a.ed);
		const acting = await as.botFor(a.ed, a.helper.id, chat);
		const { automationId } = await anAutomation(projectId);
		const triggerId = await seedWebhookTrigger(automationId, a.workspace, { kind: "bearer" }, null);
		const connectorId = await seedConnector(a.workspace, projectId);

		await onDatabase((db) =>
			db
				.delete(projectBot)
				.where(and(eq(projectBot.projectId, projectId), eq(projectBot.botId, a.helper.id))),
		);

		expect(await tried(acting, "automations.list", { projectId })).toBe("BotCannotReach");
		const missing = crypto.randomUUID();
		for (const id of [connectorId, missing]) {
			await expect(
				call(acting, "connectors.get", { projectId, connectorId: id }),
			).rejects.toMatchObject({
				_tag: "ResourceHidden",
				resource: "connector",
			});
		}
		for (const id of [automationId, missing]) {
			await expect(
				call(acting, "automations.remove", { projectId, automationId: id }),
			).rejects.toMatchObject({
				_tag: "ResourceHidden",
				resource: "automation",
			});
		}
		for (const id of [triggerId, missing]) {
			await expect(
				call(acting, "automations.removeTrigger", { projectId, automationId, triggerId: id }),
			).rejects.toMatchObject({
				_tag: "ResourceHidden",
				resource: "automation trigger",
			});
		}
	});

	it("hides foreign and missing automations and triggers from their project operations", async () => {
		const local = await anAutomation(a.project);
		const foreign = await anAutomation(a.otherProject);
		const foreignTrigger = await seedWebhookTrigger(
			foreign.automationId,
			a.workspace,
			{ kind: "bearer" },
			null,
		);
		const sameProjectTrigger = await seedWebhookTrigger(
			(await anAutomation(a.project)).automationId,
			a.workspace,
			{ kind: "bearer" },
			null,
		);
		const missing = crypto.randomUUID();
		for (const automationId of [foreign.automationId, missing]) {
			const address = { projectId: a.project, automationId };
			expect(
				await tried(who.admin, "automations.addTrigger", {
					...address,
					trigger: { kind: "webhook", auth: { kind: "bearer" } },
				}),
			).toBe("ResourceHidden");
			expect(await tried(who.admin, "automations.remove", address)).toBe("ResourceHidden");
			expect(
				await tried(who.admin, "automations.run", { ...address, requestId: crypto.randomUUID() }),
			).toBe("ResourceHidden");
			expect(
				await tried(who.admin, "automations.update", { ...address, changes: { state: "paused" } }),
			).toBe("ResourceHidden");
		}
		for (const triggerId of [foreignTrigger, sameProjectTrigger, missing]) {
			const address = { ...local, triggerId };
			expect(
				await tried(who.admin, "automations.updateTrigger", {
					...address,
					trigger: { kind: "webhook", auth: { kind: "bearer" } },
				}),
			).toBe("ResourceHidden");
			expect(await tried(who.admin, "automations.removeTrigger", address)).toBe("ResourceHidden");
			expect(await tried(who.admin, "automations.getSecret", address)).toBe("ResourceHidden");
			expect(
				await tried(who.admin, "automations.rotateSecret", { ...address, secret: undefined }),
			).toBe("ResourceHidden");
		}
		const anotherWorkspace = await seedAutomation(world.b.workspace, world.b.project);
		for (const automationId of [anotherWorkspace, missing]) {
			expect(
				await tried(who.admin, "chats.openAutomationFeed", {
					workspace: a.workspace,
					automationId,
				}),
			).toBe("ResourceHidden");
		}
	});

	describe("automations.run", () => {
		it("starts a run for anyone in the project but viewers, and for a bot for its asker in its bounds", async () => {
			const automation = await anAutomation(a.project);
			const run = (principal: Principal) =>
				tried(principal, "automations.run", { ...automation, requestId: crypto.randomUUID() });

			expect(
				await outcomes(
					{
						editor: who.ed,
						admin: who.admin,
						viewer: who.vi,
						notInProject: who.erin,
						botInBounds: who.pubForEd,
						botOutsideBounds: who.helperInK,
						run: who.run,
						webhook: who.webhook,
						computerSleep: who.computerSleep,
						page: who.page,
					},
					run,
				),
			).toEqual({
				editor: "ok",
				admin: "ok",
				viewer: "ActionForbidden",
				notInProject: "ResourceHidden",
				botInBounds: "ok",
				botOutsideBounds: "ResourceHidden",
				run: "ActionForbidden",
				webhook: "ResourceHidden",
				computerSleep: "ResourceHidden",
				page: "ResourceHidden",
			});
		});
	});

	describe("automations.webhook", () => {
		it("lets a trigger reach only its own automation’s feed and runs", async () => {
			const projectId = await seedProject(a.workspace, { leadBotId: a.pub.id });
			const projectChat = await seedProjectChat(a.workspace, projectId, a.admin);
			const callFromTrigger = await as.webhook(a.workspace, projectId);
			const anotherTriggerCall = await as.webhook(a.workspace, projectId);
			const start = async (principal: typeof callFromTrigger) => {
				if (principal.source.kind !== "trigger") throw new Error("Expected a trigger");
				const { automation, trigger } = principal.source;
				const feed = await call(principal, "chats.openAutomationFeed", {
					workspace: a.workspace,
					automationId: automation,
				});
				const run = await call(principal, "automations.webhook", {
					triggerId: trigger,
					headers: {},
					payload: {},
				});
				if (!("runId" in run)) throw new Error("The webhook didn't start a run");
				return { automation, feed: feed.id, run: run.runId };
			};
			const own = await start(callFromTrigger);
			const other = await start(anotherTriggerCall);
			const page = { projectId, limit: 20 };
			const runs = await call(who.admin, "automations.projectRuns", page);
			const chatOf = (runId: string) => {
				const run = runs.items.find(({ id }) => id === runId);
				if (!run) throw new Error("Expected the run in the project");
				return run.chatId;
			};

			expect(await tried(callFromTrigger, "automations.projectRuns", page)).toBe("ResourceHidden");
			expect(
				await tried(callFromTrigger, "chats.openAutomationFeed", {
					workspace: a.workspace,
					automationId: other.automation,
				}),
			).toBe("ResourceHidden");
			expect(await tried(callFromTrigger, "chats.messages", { chatId: own.feed, limit: 20 })).toBe(
				"ok",
			);
			expect(
				await call(callFromTrigger, "chats.get", { chatId: chatOf(own.run), limit: 20 }),
			).toMatchObject({
				automationRun: { id: own.run },
				membersReachingProject: [],
				projectBots: [],
			});
			for (const chatId of [
				other.feed,
				chatOf(other.run),
				projectChat,
				a.chat,
				crypto.randomUUID(),
			]) {
				expect(await tried(callFromTrigger, "chats.get", { chatId, limit: 20 })).toBe(
					"ResourceHidden",
				);
			}
		});

		it("starts a run only for a call its own trigger's authenticator accepted", async () => {
			const own = who.webhook._tag === "WebhookCall" ? who.webhook.source : undefined;
			if (own?.kind !== "trigger") throw new Error("Expected a call to a trigger's webhook");
			const otherAutomation = await seedAutomation(a.workspace, a.project);
			const otherTrigger = await seedWebhookTrigger(
				otherAutomation,
				a.workspace,
				{ kind: "bearer" },
				null,
			);
			const webhook = (principal: Principal, triggerId: string) =>
				tried(principal, "automations.webhook", { triggerId, headers: {}, payload: {} });

			expect({
				itsOwnTrigger: await webhook(who.webhook, own.trigger),
				anotherTrigger: await webhook(who.webhook, otherTrigger),
				member: await webhook(who.admin, own.trigger),
				run: await webhook(who.run, own.trigger),
			}).toEqual({
				itsOwnTrigger: "ok",
				anotherTrigger: "WebhookRefused",
				member: "WebhookRefused",
				run: "WebhookRefused",
			});
		});
	});
});
