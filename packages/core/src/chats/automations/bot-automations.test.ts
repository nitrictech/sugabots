import { eq } from "drizzle-orm";
import { Context } from "effect";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { seedWebhookTrigger } from "../../authentication/seed.test-support.ts";
import { CurrentActor } from "../../authorization/current-actor.ts";
import { EventBus } from "../../database/events/bus.ts";
import { EventStore } from "../../database/events/store.ts";
import {
	automation,
	bot as botTable,
	member,
	membership,
	project,
	projectMember,
	workspace,
} from "../../database/schema.ts";
import { closeDatabase, onDatabase, onPostgres, type Promised } from "../../database/testing.ts";
import { onPostgresAs } from "../../workspaces/testing.ts";
import { chatServicesForTests } from "../testing.ts";
import { TriggerSetInSettings } from "./automation.ts";
import { Automations } from "./automations.ts";
import { BotAutomations } from "./bot-automations.ts";
import { anAutomationAdmin } from "./testing.ts";

/**
 * A bot reading and changing the automations of the project it works in, its
 * own in its own chats, for the member it answers, against Postgres.
 */
describe.skipIf(!process.env.DATABASE_URL)(
	"a bot's automation tools, against Postgres",
	async () => {
		const services = await chatServicesForTests(
			EventBus.inProcess({ store: EventStore.inMemory() }),
		);
		const bots: Promised<BotAutomations.Interface> = onPostgres(
			Context.get(services, BotAutomations.Service),
		);
		let workspaceId: string;
		let projectId: string;
		let botId: string;
		let ownProjectId: string;
		let memberId: string;

		const standup = {
			name: "Morning standup",
			instructions: "Ask the team what they are working on today.",
			routineExpression: "0 9 * * 1-5",
		} as const;

		afterAll(async () => {
			await closeDatabase();
		});

		beforeEach(async () => {
			({ workspaceId, projectId, botId, memberId, ownProjectId } = await anAutomationAdmin());
			await onDatabase((db) =>
				db
					.update(workspace)
					.set({ timeZone: "Australia/Sydney" })
					.where(eq(workspace.id, workspaceId)),
			);
		});

		/** An editor in the workspace and the project, who may read the bot's automations but not manage them. */
		async function anEditor() {
			const [editor] = await onDatabase((db) =>
				db
					.insert(member)
					.values({ name: "Project member", email: `editor-${crypto.randomUUID()}@example.com` })
					.returning(),
			);
			if (!editor) throw new Error("Could not create the editor");
			await onDatabase((db) =>
				db.insert(membership).values({ workspaceId, memberId: editor.id, role: "editor" }),
			);
			await onDatabase((db) =>
				db.insert(projectMember).values({ workspaceId, projectId, memberId: editor.id }),
			);
			return editor.id;
		}

		it("sets up a routine in the workspace's timezone, made by the bot at the asker's request", async () => {
			const made = await bots.create(
				{ botId, projectId: ownProjectId, askerId: memberId },
				standup,
			);

			expect(made).toMatchObject({
				name: "Morning standup",
				when: [
					{
						kind: "routine",
						schedule: { repeat: "cron", expression: "0 9 * * 1-5" },
						timezone: "Australia/Sydney",
						nextRunAt: expect.any(String),
					},
				],
				paused: false,
			});
			const [bot] = await onDatabase((db) =>
				db.select({ handle: botTable.handle }).from(botTable).where(eq(botTable.id, botId)),
			);
			expect(made.settingsUrl).toMatch(
				new RegExp(
					`^http://sugabots\\.test/automation-[^/]+/bots/${bot?.handle}/automations/${made.id}$`,
				),
			);
			const [stored] = await onDatabase((db) =>
				db.select().from(automation).where(eq(automation.id, made.id)),
			);
			expect(stored).toMatchObject({ createdById: memberId, createdByBotId: botId });
		});

		it("lists and changes the bot's automations, keeping the routine in the workspace's timezone", async () => {
			const made = await bots.create(
				{ botId, projectId: ownProjectId, askerId: memberId },
				standup,
			);

			const changed = await bots.update(
				{ botId, projectId: ownProjectId, askerId: memberId },
				made.id,
				{
					routineExpression: "0 10 * * 1-5",
					paused: true,
				},
			);

			expect(changed).toMatchObject({
				when: [
					{
						kind: "routine",
						schedule: { repeat: "cron", expression: "0 10 * * 1-5" },
						timezone: "Australia/Sydney",
					},
				],
				paused: true,
			});
			expect(await bots.list({ botId, projectId: ownProjectId, askerId: memberId })).toEqual([
				changed,
			]);
		});

		it("changes nothing when the new routine is refused", async () => {
			const bot = { botId, projectId: ownProjectId, askerId: memberId };
			const made = await bots.create(bot, standup);

			await expect(
				bots.update(bot, made.id, {
					name: "Evening standup",
					paused: true,
					routineExpression: "not a cron expression",
				}),
			).rejects.toMatchObject({ _tag: "InvalidRoutineSchedule" });
			expect(await bots.list(bot)).toEqual([made]);
		});

		it("changes a webhook automation's other settings but leaves its trigger to settings", async () => {
			const automations = onPostgresAs(memberId)(Context.get(services, Automations.Service));
			const webhookAutomation = await automations.create(
				{ projectId: ownProjectId },
				{ name: "Sentry issues", instructions: "Look into it.", triggers: [{ kind: "webhook" }] },
			);
			const bot = { botId, projectId: ownProjectId, askerId: memberId };

			await expect(
				bots.update(bot, webhookAutomation.automation.id, { routineExpression: "0 9 * * *" }),
			).rejects.toThrow(TriggerSetInSettings);
			expect(
				await bots.update(bot, webhookAutomation.automation.id, { name: "Sentry triage" }),
			).toMatchObject({
				name: "Sentry triage",
				when: [{ kind: "webhook" }],
			});
		});

		it("gives a routine to an automation nothing starts yet", async () => {
			const automations = onPostgresAs(memberId)(Context.get(services, Automations.Service));
			const manual = await automations.create(
				{ projectId: ownProjectId },
				{ name: "Weekly summary", instructions: "Sum up the week.", triggers: [] },
			);
			const bot = { botId, projectId: ownProjectId, askerId: memberId };

			expect(
				await bots.update(bot, manual.automation.id, { routineExpression: "0 17 * * 5" }),
			).toMatchObject({
				when: [
					{
						kind: "routine",
						schedule: { repeat: "cron", expression: "0 17 * * 5" },
						timezone: "Australia/Sydney",
						nextRunAt: expect.any(String),
					},
				],
			});
		});

		it("leaves a routine to settings once the automation has another routine or trigger", async () => {
			const made = await bots.create(
				{ botId, projectId: ownProjectId, askerId: memberId },
				standup,
			);
			// A trigger set up in settings, as the web app would add it.
			await seedWebhookTrigger(made.id, workspaceId, { kind: "bearer" }, null);

			await expect(
				bots.update({ botId, projectId: ownProjectId, askerId: memberId }, made.id, {
					routineExpression: "0 10 * * 1-5",
				}),
			).rejects.toThrow(TriggerSetInSettings);
			expect(await bots.list({ botId, projectId: ownProjectId, askerId: memberId })).toEqual([
				expect.objectContaining({
					when: [
						expect.objectContaining({ schedule: { repeat: "cron", expression: "0 9 * * 1-5" } }),
						{ kind: "webhook" },
					],
				}),
			]);
		});

		it("refuses when no member asked, as in an automation's run", async () => {
			await expect(
				bots.create({ botId, projectId: ownProjectId, askerId: null }, standup),
			).rejects.toThrow(CurrentActor.NobodyAsked);
			await expect(bots.list({ botId, projectId: ownProjectId, askerId: null })).rejects.toThrow(
				CurrentActor.NobodyAsked,
			);
		});

		it("lets an editor see the bot's automations but not have it set one up or change one", async () => {
			const made = await bots.create(
				{ botId, projectId: ownProjectId, askerId: memberId },
				standup,
			);
			const editor = await anEditor();

			expect(await bots.list({ botId, projectId: ownProjectId, askerId: editor })).toHaveLength(1);
			await expect(
				bots.create({ botId, projectId: ownProjectId, askerId: editor }, standup),
			).rejects.toThrow(BotAutomations.MayNotManageAutomations);
			await expect(
				bots.update({ botId, projectId: ownProjectId, askerId: editor }, made.id, { paused: true }),
			).rejects.toThrow(BotAutomations.MayNotManageAutomations);
		});

		it("manages the automations of a project members made while working in one of its chats", async () => {
			await onDatabase((db) =>
				db.update(project).set({ leadBotId: botId }).where(eq(project.id, projectId)),
			);
			const inProject = { botId, projectId, askerId: memberId };

			const made = await bots.create(inProject, standup);

			const [stored] = await onDatabase((db) =>
				db.select().from(automation).where(eq(automation.id, made.id)),
			);
			expect(stored).toMatchObject({ projectId, createdByBotId: botId });
			expect(made.settingsUrl).toMatch(
				new RegExp(`/projects/automation-[^/]+/automations/${made.id}$`),
			);
			expect(await bots.list(inProject)).toEqual([made]);
			expect(await bots.list({ botId, projectId: ownProjectId, askerId: memberId })).toEqual([]);
		});
	},
);
