import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	seedAutomation,
	seedBot,
	seedConnector,
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
	everyKindOfPrincipal,
	outcomesFor,
	principals,
	type World,
} from "../../proofs/world.test-support.ts";
import { type CallOperation, operationOutcome, servedOperations } from "../testing.ts";

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
	let who: Awaited<ReturnType<typeof everyKindOfPrincipal>>;

	beforeAll(async () => {
		world = await buildWorld();
		a = world.a;
		call = await servedOperations();
		as = principals(await authenticators());
		who = await everyKindOfPrincipal(world, as);
	});

	afterAll(async () => {
		await closeDatabase();
	});

	/** A new automation of `projectId`, run only by hand. */
	const anAutomation = async (projectId: string) => ({
		projectId,
		automationId: await seedAutomation(a.workspace, projectId),
	});

	describe("reading a project's automations", () => {
		it("lists them to whoever reaches the project, within a turn's bounds", async () => {
			const list = (principal: Principal) =>
				operationOutcome(call, principal, "automations.list", { projectId: a.project });

			expect(
				await outcomesFor(
					{
						viewer: who.vi,
						notInProject: who.erin,
						botOutsideBounds: who.helperInK,
					},
					list,
				),
			).toEqual({
				viewer: "ok",
				notInProject: "ResourceHidden",
				botOutsideBounds: "ResourceHidden",
			});
		});

		it("lists project runs for a viewer and hides them from a non-member and computer sleep", async () => {
			const projectId = await seedProject(a.workspace, {
				leadBotId: a.pub.id,
				members: [a.ed, a.vi],
			});
			const runs = (principal: Principal) =>
				operationOutcome(call, principal, "automations.projectRuns", { projectId, limit: 20 });
			const { principal: run } = await as.run(a.workspace, projectId, a.pub.id);
			if (run._tag !== "AutomationRun") throw new Error("Expected an automation run");
			await call(who.admin, "chats.openAutomationFeed", {
				workspace: a.workspace,
				automationId: run.automation,
			});

			expect(
				await outcomesFor(
					{
						viewer: who.vi,
						notInProject: who.erin,
						computerSleep: (await as.computerSleep(a.workspace, projectId)).principal,
					},
					runs,
				),
			).toEqual({
				viewer: "ok",
				notInProject: "ResourceHidden",
				computerSleep: "ResourceHidden",
			});
		});

		it("shows an admin only a personal bot’s automation names and states", async () => {
			const { defaultProject: own } = await seedBot(a.workspace, {
				createdById: a.ed,
				visibility: "personal",
			});
			const created = await anAutomation(own);
			const listed = await call(who.admin, "automations.list", { projectId: own });

			expect(listed).toEqual([
				{ id: created.automationId, name: expect.any(String), state: "enabled", restricted: true },
			]);
			const ownView = await call(who.ed, "automations.list", { projectId: own });
			expect(ownView[0]).toHaveProperty("instructions");
			expect({
				adminsRuns: await operationOutcome(call, who.admin, "automations.projectRuns", {
					projectId: own,
					limit: 20,
				}),
				editorWhoDidNotMakeIt: await operationOutcome(call, who.erin, "automations.list", {
					projectId: own,
				}),
				creator: await operationOutcome(call, who.ed, "automations.list", { projectId: own }),
			}).toEqual({
				adminsRuns: "ResourceHidden",
				editorWhoDidNotMakeIt: "ResourceHidden",
				creator: "ok",
			});
		});
	});

	describe("managing a project's automations", () => {
		it("lists the automation created by a signed-in project manager", async () => {
			const input = {
				projectId: a.project,
				name: `Automation ${unique()}`,
				instructions: "Summarize open issues.",
				triggers: [],
			};
			await expect(call(who.adminsAssistant, "automations.create", input)).rejects.toMatchObject({
				_tag: "ActionForbidden",
			});
			await expect(call(who.erin, "automations.create", input)).rejects.toMatchObject({
				_tag: "ResourceHidden",
			});

			const created = await call(who.admin, "automations.create", input);

			expect(
				await call(who.admin, "automations.list", { projectId: input.projectId }),
			).toContainEqual(
				expect.objectContaining({ name: input.name, instructions: input.instructions }),
			);
			expect(created).toMatchObject({ automation: { name: input.name } });
		});

		it("lets an admin only switch off a personal bot's automations, which they can't otherwise reach", async () => {
			const automation = await anAutomation(a.personal.defaultProject);

			expect({
				pausing: await call(who.admin, "automations.update", {
					...automation,
					changes: { state: "paused" },
				}),
				missingAutomation: await operationOutcome(call, who.admin, "automations.update", {
					...automation,
					automationId: crypto.randomUUID(),
					changes: { state: "paused" },
				}),
				renaming: await operationOutcome(call, who.admin, "automations.update", {
					...automation,
					changes: { name: "Mine now" },
				}),
				resuming: await operationOutcome(call, who.admin, "automations.update", {
					...automation,
					changes: { state: "enabled" },
				}),
				deleting: await operationOutcome(call, who.admin, "automations.remove", automation),
				editorWhoDidNotMakeIt: await operationOutcome(call, who.erin, "automations.update", {
					...automation,
					changes: { state: "paused" },
				}),
				creator: await operationOutcome(call, who.ed, "automations.update", {
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

		expect(await operationOutcome(call, acting, "automations.list", { projectId })).toBe(
			"BotCannotReach",
		);
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
				await operationOutcome(call, who.admin, "automations.addTrigger", {
					...address,
					trigger: { kind: "webhook", auth: { kind: "bearer" } },
				}),
				"automations.addTrigger",
			).toBe("ResourceHidden");
			expect(
				await operationOutcome(call, who.admin, "automations.remove", address),
				"automations.remove",
			).toBe("ResourceHidden");
			expect(
				await operationOutcome(call, who.admin, "automations.run", {
					...address,
					requestId: crypto.randomUUID(),
				}),
				"automations.run",
			).toBe("ResourceHidden");
			expect(
				await operationOutcome(call, who.admin, "automations.update", {
					...address,
					changes: { state: "paused" },
				}),
				"automations.update",
			).toBe("ResourceHidden");
		}
		for (const triggerId of [foreignTrigger, sameProjectTrigger, missing]) {
			const address = { ...local, triggerId };
			expect(
				await operationOutcome(call, who.admin, "automations.updateTrigger", {
					...address,
					trigger: { kind: "webhook", auth: { kind: "bearer" } },
				}),
				"automations.updateTrigger",
			).toBe("ResourceHidden");
			expect(
				await operationOutcome(call, who.admin, "automations.removeTrigger", address),
				"automations.removeTrigger",
			).toBe("ResourceHidden");
			expect(
				await operationOutcome(call, who.admin, "automations.getSecret", address),
				"automations.getSecret",
			).toBe("ResourceHidden");
			expect(
				await operationOutcome(call, who.admin, "automations.rotateSecret", {
					...address,
					secret: undefined,
				}),
				"automations.rotateSecret",
			).toBe("ResourceHidden");
		}
		const anotherWorkspace = await seedAutomation(world.b.workspace, world.b.project);
		for (const automationId of [anotherWorkspace, missing]) {
			expect(
				await operationOutcome(call, who.admin, "chats.openAutomationFeed", {
					workspace: a.workspace,
					automationId,
				}),
				"chats.openAutomationFeed",
			).toBe("ResourceHidden");
		}
	});

	describe("automations.run", () => {
		it("lists the accepted manual run in its project", async () => {
			const projectId = await seedProject(a.workspace, { leadBotId: a.pub.id, members: [a.ed] });
			const target = await anAutomation(projectId);
			await call(who.ed, "chats.openAutomationFeed", {
				workspace: a.workspace,
				automationId: target.automationId,
			});
			const accepted = await call(who.ed, "automations.run", {
				...target,
				requestId: crypto.randomUUID(),
			});

			const { items } = await call(who.ed, "automations.projectRuns", {
				projectId: target.projectId,
				limit: 20,
			});
			expect(items).toContainEqual(
				expect.objectContaining({
					id: accepted.runId,
					chatId: accepted.chatId,
					automationId: target.automationId,
					trigger: expect.objectContaining({ kind: "manual" }),
				}),
			);
		});

		it("refuses a viewer who reaches the automation and hides it from a non-member of the project", async () => {
			const automation = await anAutomation(a.project);
			const run = (principal: Principal) =>
				operationOutcome(call, principal, "automations.run", {
					...automation,
					requestId: crypto.randomUUID(),
				});

			expect(await run(who.vi)).toBe("ActionForbidden");
			expect(await run(who.erin)).toBe("ResourceHidden");
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

			expect(await operationOutcome(call, callFromTrigger, "automations.projectRuns", page)).toBe(
				"ResourceHidden",
			);
			expect(
				await operationOutcome(call, callFromTrigger, "chats.openAutomationFeed", {
					workspace: a.workspace,
					automationId: other.automation,
				}),
			).toBe("ResourceHidden");
			expect(
				await operationOutcome(call, callFromTrigger, "chats.messages", {
					chatId: own.feed,
					limit: 20,
				}),
			).toBe("ok");
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
				expect(
					await operationOutcome(call, callFromTrigger, "chats.get", { chatId, limit: 20 }),
				).toBe("ResourceHidden");
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
				operationOutcome(call, principal, "automations.webhook", {
					triggerId,
					headers: {},
					payload: {},
				});

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
