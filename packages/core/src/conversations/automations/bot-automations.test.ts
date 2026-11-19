import { eq } from "drizzle-orm";
import { Context } from "effect";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { EventBus } from "../../database/events/bus.ts";
import { EventStore } from "../../database/events/store.ts";
import {
	automation,
	bot as botTable,
	project,
	projectMember,
	user,
	workspace,
	workspaceMember,
} from "../../database/schema.ts";
import { closeDatabase, onDatabase, onPostgres, type Promised } from "../../database/testing.ts";
import { onPostgresAs } from "../../workspaces/testing.ts";
import { conversationsForTests } from "../testing.ts";
import { Automations } from "./automations.ts";
import { BotAutomations } from "./bot-automations.ts";
import { anAutomationOwner } from "./testing.ts";

/**
 * A bot reading and changing the automations of the project it works in, its
 * own in its own threads, for the person it answers, against Postgres.
 */
describe.skipIf(!process.env.DATABASE_URL)(
	"a bot's automation tools, against Postgres",
	async () => {
		const conversations = await conversationsForTests(
			EventBus.inProcess({ store: EventStore.inMemory() }),
		);
		const bots: Promised<BotAutomations.Interface> = onPostgres(
			Context.get(conversations, BotAutomations.Service),
		);
		let workspaceId: string;
		let projectId: string;
		let botId: string;
		let ownProjectId: string;
		let userId: string;

		const standup = {
			name: "Morning standup",
			instructions: "Ask the team what they are working on today.",
			routineExpression: "0 9 * * 1-5",
		} as const;

		afterAll(async () => {
			await closeDatabase();
		});

		beforeEach(async () => {
			({ workspaceId, projectId, botId, userId, ownProjectId } = await anAutomationOwner());
			await onDatabase((db) =>
				db
					.update(workspace)
					.set({ timeZone: "Australia/Sydney" })
					.where(eq(workspace.id, workspaceId)),
			);
		});

		/** A member of the workspace, who may read the bot's automations but not manage them. */
		async function aMember() {
			const [member] = await onDatabase((db) =>
				db
					.insert(user)
					.values({ name: "Project member", email: `member-${crypto.randomUUID()}@example.com` })
					.returning(),
			);
			if (!member) throw new Error("Could not create the member");
			await onDatabase((db) =>
				db.insert(workspaceMember).values({ workspaceId, userId: member.id, role: "member" }),
			);
			await onDatabase((db) =>
				db.insert(projectMember).values({ workspaceId, projectId, userId: member.id }),
			);
			return member.id;
		}

		it("sets up a routine in the workspace's timezone, made by the bot at the asker's request", async () => {
			const made = await bots.create({ botId, projectId: ownProjectId, askedBy: userId }, standup);

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
			expect(stored).toMatchObject({ createdById: userId, createdByBotId: botId });
		});

		it("lists and changes the bot's automations, keeping the routine in the workspace's timezone", async () => {
			const made = await bots.create({ botId, projectId: ownProjectId, askedBy: userId }, standup);

			const changed = await bots.update(
				{ botId, projectId: ownProjectId, askedBy: userId },
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
			expect(await bots.list({ botId, projectId: ownProjectId, askedBy: userId })).toEqual([
				changed,
			]);
		});

		it("changes a webhook automation's other settings but leaves its trigger to settings", async () => {
			const automations = onPostgresAs(userId)(Context.get(conversations, Automations.Service));
			const hook = await automations.create(
				{ projectId: ownProjectId },
				{ name: "Sentry issues", instructions: "Look into it.", triggers: [{ kind: "webhook" }] },
			);
			const bot = { botId, projectId: ownProjectId, askedBy: userId };

			await expect(
				bots.update(bot, hook.automation.id, { routineExpression: "0 9 * * *" }),
			).rejects.toThrow(BotAutomations.TriggerSetInSettings);
			expect(await bots.update(bot, hook.automation.id, { name: "Sentry triage" })).toMatchObject({
				name: "Sentry triage",
				when: [{ kind: "webhook" }],
			});
		});

		it("leaves a routine to settings once the automation has another routine or trigger", async () => {
			const made = await bots.create({ botId, projectId: ownProjectId, askedBy: userId }, standup);
			const automations = onPostgresAs(userId)(Context.get(conversations, Automations.Service));
			await automations.addTrigger(
				{ projectId: ownProjectId, automationId: made.id },
				{ kind: "webhook" },
			);

			await expect(
				bots.update({ botId, projectId: ownProjectId, askedBy: userId }, made.id, {
					routineExpression: "0 10 * * 1-5",
				}),
			).rejects.toThrow(BotAutomations.TriggerSetInSettings);
			expect(await bots.list({ botId, projectId: ownProjectId, askedBy: userId })).toEqual([
				expect.objectContaining({
					when: [
						expect.objectContaining({ schedule: { repeat: "cron", expression: "0 9 * * 1-5" } }),
						{ kind: "webhook" },
					],
				}),
			]);
		});

		it("refuses when no person asked, as in an automation's run", async () => {
			await expect(
				bots.create({ botId, projectId: ownProjectId, askedBy: null }, standup),
			).rejects.toThrow(BotAutomations.NobodyAsked);
			await expect(bots.list({ botId, projectId: ownProjectId, askedBy: null })).rejects.toThrow(
				BotAutomations.NobodyAsked,
			);
		});

		it("lets a member see the bot's automations but not have it set one up or change one", async () => {
			const made = await bots.create({ botId, projectId: ownProjectId, askedBy: userId }, standup);
			const member = await aMember();

			expect(await bots.list({ botId, projectId: ownProjectId, askedBy: member })).toHaveLength(1);
			await expect(
				bots.create({ botId, projectId: ownProjectId, askedBy: member }, standup),
			).rejects.toThrow(BotAutomations.MayNotManageAutomations);
			await expect(
				bots.update({ botId, projectId: ownProjectId, askedBy: member }, made.id, { paused: true }),
			).rejects.toThrow(BotAutomations.MayNotManageAutomations);
		});

		it("manages the automations of a project people made while working in one of its threads", async () => {
			await onDatabase((db) =>
				db.update(project).set({ leadBotId: botId }).where(eq(project.id, projectId)),
			);
			const inProject = { botId, projectId, askedBy: userId };

			const made = await bots.create(inProject, standup);

			const [stored] = await onDatabase((db) =>
				db.select().from(automation).where(eq(automation.id, made.id)),
			);
			expect(stored).toMatchObject({ projectId, createdByBotId: botId });
			expect(made.settingsUrl).toMatch(/\/projects\/automation-[^/]+$/);
			expect(await bots.list(inProject)).toEqual([made]);
			expect(await bots.list({ botId, projectId: ownProjectId, askedBy: userId })).toEqual([]);
		});
	},
);
