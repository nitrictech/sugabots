import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	type SeededBot,
	seedAutomation,
	seedBot,
	seedConnector,
	seedMember,
	seedProject,
	seedProjectChat,
	seedWebhookTrigger,
} from "../../authentication/seed.test-support.ts";
import { projectBot } from "../../database/schema.ts";
import { closeDatabase, onDatabase } from "../../database/testing.ts";
import type { Principal } from "../../principal.ts";
import {
	authenticators,
	buildWorld,
	everyKindOfPrincipal,
	principals,
	type World,
} from "../../proofs/world.test-support.ts";
import { type CallOperation, operationOutcome, servedOperations } from "../testing.ts";

/**
 * What the automations operations prove beyond the rule `permissions.test.ts`
 * states for each: that an automation or trigger they name is their
 * project's, what an admin may do to a personal bot's automations without
 * reaching them, what a webhook call reaches, and a viewer's own Personal
 * Assistant. What each comes to is "ok" or the tag of its refusal.
 *
 * The world is `buildWorld`'s: in workspace A, Ed (an editor) made the public
 * bot Pub, which leads the private project J with Helper in it, and his
 * personal bot Personal; Ed, Vi (a viewer) and Quinn are in J, and Erin (an
 * editor) isn't.
 */
describe("the automations operations, beyond who may call them", () => {
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

		for (const name of ["automations.list", "projects.listMembers"] as const) {
			await expect(call(acting, name, { projectId }), name).rejects.toMatchObject({
				_tag: "BotCannotReach",
				resource: "project",
			});
		}
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

	describe("a viewer's own bots", () => {
		it("lets a viewer manage and run their own Personal Assistant, but not an ordinary personal bot they made", async () => {
			const viewerId = await seedMember(a.workspace, "viewer");
			const viewer = await as.member(viewerId);
			/** What the viewer comes to on each way of managing `bot` and running its automations. */
			const managing = async (bot: SeededBot) => {
				const automation = await anAutomation(bot.defaultProject);
				return {
					rename: await operationOutcome(call, viewer, "bots.update", {
						botId: bot.id,
						changes: { name: `Mine ${crypto.randomUUID()}` },
					}),
					makeAutomation: await operationOutcome(call, viewer, "automations.create", {
						projectId: bot.defaultProject,
						name: `Automation ${crypto.randomUUID()}`,
						instructions: "Tidy up.",
						triggers: [],
					}),
					runAutomation: await operationOutcome(call, viewer, "automations.run", {
						...automation,
						requestId: crypto.randomUUID(),
					}),
					pauseAutomation: await operationOutcome(call, viewer, "automations.update", {
						...automation,
						changes: { state: "paused" },
					}),
				};
			};

			expect(
				await managing(
					await seedBot(a.workspace, { assistantOf: viewerId, visibility: "personal" }),
				),
			).toEqual({ rename: "ok", makeAutomation: "ok", runAutomation: "ok", pauseAutomation: "ok" });
			expect(
				await managing(
					await seedBot(a.workspace, { createdById: viewerId, visibility: "personal" }),
				),
			).toEqual({
				rename: "ActionForbidden",
				makeAutomation: "ActionForbidden",
				runAutomation: "ActionForbidden",
				pauseAutomation: "ActionForbidden",
			});
		});
	});
});
