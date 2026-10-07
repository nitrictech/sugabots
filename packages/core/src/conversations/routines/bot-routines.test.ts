import { eq } from "drizzle-orm";
import { Context } from "effect";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { EventBus } from "../../database/events/bus.ts";
import { EventStore } from "../../database/events/store.ts";
import { podMember, routine, user, workspace, workspaceMember } from "../../database/schema.ts";
import { closeDatabase, onDatabase, onPostgres, type Promised } from "../../database/testing.ts";
import { onPostgresAs } from "../../workspaces/testing.ts";
import { conversationsForTests } from "../testing.ts";
import { BotRoutines } from "./bot-routines.ts";
import { Routines } from "./routines.ts";
import { aRoutineOwner } from "./testing.ts";

/** A bot reading and changing its own routines, for the person it answers, against Postgres. */
describe.skipIf(!process.env.DATABASE_URL)("a bot's own routines, against Postgres", async () => {
	const conversations = await conversationsForTests(
		EventBus.inProcess({ store: EventStore.inMemory() }),
	);
	const bots: Promised<BotRoutines.Interface> = onPostgres(
		Context.get(conversations, BotRoutines.Service),
	);
	let workspaceId: string;
	let podId: string;
	let agentId: string;
	let userId: string;

	const standup = {
		name: "Morning standup",
		instructions: "Ask the team what they are working on today.",
		schedule: "0 9 * * 1-5",
		results: "post_to_chat",
	} as const;

	afterAll(async () => {
		await closeDatabase();
	});

	beforeEach(async () => {
		({ workspaceId, podId, agentId, userId } = await aRoutineOwner());
		await onDatabase((db) =>
			db
				.update(workspace)
				.set({ timeZone: "Australia/Sydney" })
				.where(eq(workspace.id, workspaceId)),
		);
	});

	/** A member of the pod, who may read its routines but not manage them. */
	async function aMember() {
		const [member] = await onDatabase((db) =>
			db
				.insert(user)
				.values({ name: "Pod member", email: `member-${crypto.randomUUID()}@example.com` })
				.returning(),
		);
		if (!member) throw new Error("Could not create the member");
		await onDatabase((db) =>
			db.insert(workspaceMember).values({ workspaceId, userId: member.id, role: "member" }),
		);
		await onDatabase((db) =>
			db.insert(podMember).values({ workspaceId, podId, userId: member.id }),
		);
		return member.id;
	}

	it("sets up a schedule in the workspace's timezone, made by the bot at the asker's request", async () => {
		const made = await bots.create({ agentId, askedBy: userId }, standup);

		expect(made).toMatchObject({
			name: "Morning standup",
			when: {
				kind: "schedule",
				schedule: "0 9 * * 1-5",
				timezone: "Australia/Sydney",
				nextRunAt: expect.any(String),
			},
			paused: false,
			results: "post_to_chat",
			settingsUrl: expect.stringMatching(
				/^http:\/\/sugabots\.test\/routine-[^/]+\/settings\/pods\/routine-[^/]+\/agents\/[^/]+\?tab=routines$/,
			),
		});
		const [stored] = await onDatabase((db) =>
			db.select().from(routine).where(eq(routine.id, made.id)),
		);
		expect(stored).toMatchObject({ createdById: userId, createdByAgentId: agentId });
	});

	it("lists and changes the bot's routines, keeping the schedule in the workspace's timezone", async () => {
		const made = await bots.create({ agentId, askedBy: userId }, standup);

		const changed = await bots.update({ agentId, askedBy: userId }, made.id, {
			schedule: "0 10 * * 1-5",
			paused: true,
		});

		expect(changed).toMatchObject({
			when: { kind: "schedule", schedule: "0 10 * * 1-5", timezone: "Australia/Sydney" },
			paused: true,
			results: "post_to_chat",
		});
		expect(await bots.list({ agentId, askedBy: userId })).toEqual([changed]);
	});

	it("changes a webhook routine's other settings but leaves its trigger to settings", async () => {
		const routines = onPostgresAs(userId)(Context.get(conversations, Routines.Service));
		const hook = await routines.create(
			{ agentId },
			{ name: "Sentry issues", instructions: "Look into it.", trigger: { kind: "webhook" } },
		);
		const bot = { agentId, askedBy: userId };

		await expect(bots.update(bot, hook.routine.id, { schedule: "0 9 * * *" })).rejects.toThrow(
			BotRoutines.WebhookKeepsItsTrigger,
		);
		expect(await bots.update(bot, hook.routine.id, { results: "post_to_chat" })).toMatchObject({
			when: { kind: "webhook" },
			results: "post_to_chat",
		});
	});

	it("refuses when no person asked, as in a routine's run", async () => {
		await expect(bots.create({ agentId, askedBy: null }, standup)).rejects.toThrow(
			BotRoutines.NobodyAsked,
		);
		await expect(bots.list({ agentId, askedBy: null })).rejects.toThrow(BotRoutines.NobodyAsked);
	});

	it("lets a member see the bot's routines but not have it set one up or change one", async () => {
		const made = await bots.create({ agentId, askedBy: userId }, standup);
		const member = await aMember();

		expect(await bots.list({ agentId, askedBy: member })).toHaveLength(1);
		await expect(bots.create({ agentId, askedBy: member }, standup)).rejects.toThrow(
			BotRoutines.MayNotManageRoutines,
		);
		await expect(
			bots.update({ agentId, askedBy: member }, made.id, { paused: true }),
		).rejects.toThrow(BotRoutines.MayNotManageRoutines);
	});
});
