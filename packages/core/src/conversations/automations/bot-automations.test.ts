import { eq } from "drizzle-orm";
import { Context } from "effect";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { EventBus } from "../../database/events/bus.ts";
import { EventStore } from "../../database/events/store.ts";
import {
	automation,
	bot as botTable,
	channelMember,
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

/** A bot reading and changing its own automations, for the person it answers, against Postgres. */
describe.skipIf(!process.env.DATABASE_URL)(
	"a bot's own automations, against Postgres",
	async () => {
		const conversations = await conversationsForTests(
			EventBus.inProcess({ store: EventStore.inMemory() }),
		);
		const bots: Promised<BotAutomations.Interface> = onPostgres(
			Context.get(conversations, BotAutomations.Service),
		);
		let workspaceId: string;
		let channelId: string;
		let botId: string;
		let userId: string;

		const standup = {
			name: "Morning standup",
			instructions: "Ask the team what they are working on today.",
			schedule: "0 9 * * 1-5",
		} as const;

		afterAll(async () => {
			await closeDatabase();
		});

		beforeEach(async () => {
			({ workspaceId, channelId, botId, userId } = await anAutomationOwner());
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
					.values({ name: "Channel member", email: `member-${crypto.randomUUID()}@example.com` })
					.returning(),
			);
			if (!member) throw new Error("Could not create the member");
			await onDatabase((db) =>
				db.insert(workspaceMember).values({ workspaceId, userId: member.id, role: "member" }),
			);
			await onDatabase((db) =>
				db.insert(channelMember).values({ workspaceId, channelId, userId: member.id }),
			);
			return member.id;
		}

		it("sets up a schedule in the workspace's timezone, made by the bot at the asker's request", async () => {
			const made = await bots.create({ botId, askedBy: userId }, standup);

			expect(made).toMatchObject({
				name: "Morning standup",
				when: [
					{
						kind: "schedule",
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

		it("lists and changes the bot's automations, keeping the schedule in the workspace's timezone", async () => {
			const made = await bots.create({ botId, askedBy: userId }, standup);

			const changed = await bots.update({ botId, askedBy: userId }, made.id, {
				schedule: "0 10 * * 1-5",
				paused: true,
			});

			expect(changed).toMatchObject({
				when: [
					{
						kind: "schedule",
						schedule: { repeat: "cron", expression: "0 10 * * 1-5" },
						timezone: "Australia/Sydney",
					},
				],
				paused: true,
			});
			expect(await bots.list({ botId, askedBy: userId })).toEqual([changed]);
		});

		it("changes a webhook automation's other settings but leaves its trigger to settings", async () => {
			const automations = onPostgresAs(userId)(Context.get(conversations, Automations.Service));
			const hook = await automations.create(
				{ botId },
				{ name: "Sentry issues", instructions: "Look into it.", triggers: [{ kind: "webhook" }] },
			);
			const bot = { botId, askedBy: userId };

			await expect(bots.update(bot, hook.automation.id, { schedule: "0 9 * * *" })).rejects.toThrow(
				BotAutomations.TriggerSetInSettings,
			);
			expect(await bots.update(bot, hook.automation.id, { name: "Sentry triage" })).toMatchObject({
				name: "Sentry triage",
				when: [{ kind: "webhook" }],
			});
		});

		it("leaves a schedule to settings once the automation has another trigger", async () => {
			const made = await bots.create({ botId, askedBy: userId }, standup);
			const automations = onPostgresAs(userId)(Context.get(conversations, Automations.Service));
			await automations.addTrigger({ botId, automationId: made.id }, { kind: "webhook" });

			await expect(
				bots.update({ botId, askedBy: userId }, made.id, { schedule: "0 10 * * 1-5" }),
			).rejects.toThrow(BotAutomations.TriggerSetInSettings);
			expect(await bots.list({ botId, askedBy: userId })).toEqual([
				expect.objectContaining({
					when: [
						expect.objectContaining({ schedule: { repeat: "cron", expression: "0 9 * * 1-5" } }),
						{ kind: "webhook" },
					],
				}),
			]);
		});

		it("refuses when no person asked, as in an automation's run", async () => {
			await expect(bots.create({ botId, askedBy: null }, standup)).rejects.toThrow(
				BotAutomations.NobodyAsked,
			);
			await expect(bots.list({ botId, askedBy: null })).rejects.toThrow(BotAutomations.NobodyAsked);
		});

		it("lets a member see the bot's automations but not have it set one up or change one", async () => {
			const made = await bots.create({ botId, askedBy: userId }, standup);
			const member = await aMember();

			expect(await bots.list({ botId, askedBy: member })).toHaveLength(1);
			await expect(bots.create({ botId, askedBy: member }, standup)).rejects.toThrow(
				BotAutomations.MayNotManageAutomations,
			);
			await expect(
				bots.update({ botId, askedBy: member }, made.id, { paused: true }),
			).rejects.toThrow(BotAutomations.MayNotManageAutomations);
		});
	},
);
