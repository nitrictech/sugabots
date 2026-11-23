import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ActionForbidden } from "../../authorization/access.ts";
import {
	bot,
	modelProvider,
	providerModel,
	user,
	workspace,
	workspaceDefaultModel,
	workspaceMember,
} from "../../database/schema.ts";
import { closeDatabase, onDatabase, runOnPostgres } from "../../database/testing.ts";
import { onPostgresAs } from "../testing.ts";
import { Onboarding } from "./onboarding.ts";

describe.skipIf(!process.env.DATABASE_URL)("onboarding, against Postgres", () => {
	let onboarding: Onboarding.Interface;
	let workspaceId: string;
	let adminId: string;
	let memberId: string;
	let customBotId: string;
	let systemBotId: string;

	beforeAll(async () => {
		onboarding = await runOnPostgres(Effect.provide(Onboarding.Service, Onboarding.layer));
	});

	afterAll(async () => {
		await closeDatabase();
	});

	const as = (userId: string) =>
		onPostgresAs(userId)({
			complete: onboarding.complete,
		});
	const complete = (userId: string, botId: string) => as(userId).complete({ workspaceId, botId });

	beforeEach(async () => {
		const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const [madeWorkspace] = await onDatabase((db) =>
			db
				.insert(workspace)
				.values({ name: `Test ${stamp}`, slug: `onboarding-${stamp}` })
				.returning(),
		);
		const people = await onDatabase((db) =>
			db
				.insert(user)
				.values([
					{ name: "Admin", email: `admin-${stamp}@example.com` },
					{ name: "Member", email: `member-${stamp}@example.com` },
				])
				.returning(),
		);
		const [admin, member] = people;
		if (!madeWorkspace || !admin || !member)
			throw new Error("could not create onboarding fixtures");
		workspaceId = madeWorkspace.id;
		adminId = admin.id;
		memberId = member.id;
		await onDatabase((db) =>
			db.insert(workspaceMember).values([
				{ workspaceId, userId: adminId, role: "admin" },
				{ workspaceId, userId: memberId, role: "member" },
			]),
		);
		const [provider] = await onDatabase((db) =>
			db
				.insert(modelProvider)
				.values({
					workspaceId,
					preset: null,
					name: "Test provider",
					baseUrl: "https://models.example.com",
					apiFormat: "openai",
					active: true,
					createdById: adminId,
				})
				.returning(),
		);
		if (!provider) throw new Error("could not create model provider");
		await onDatabase((db) =>
			db.insert(providerModel).values({
				workspaceId,
				providerId: provider.id,
				modelId: "model",
				enabled: true,
				source: "manual",
			}),
		);
		const madeBots = await onDatabase((db) =>
			db
				.insert(bot)
				.values([
					{
						workspaceId,
						name: "Coordinator",
						handle: "coordinator",
						color: "green",
						face: "pill",
						model: "model",
						createdById: adminId,
					},
					{
						workspaceId,
						// The workspace's Compaction bot, with no model until the workspace
						// settles on one.
						name: "Compaction",
						handle: "compaction",
						systemBotKey: "compact",
						color: "purple",
						face: "square",
						model: null,
						createdById: adminId,
					},
				])
				.returning(),
		);
		const [custom, system] = madeBots;
		if (!custom || !system) throw new Error("could not create onboarding bots");
		customBotId = custom.id;
		systemBotId = system.id;
	});

	it("does not complete for a bot with no model the workspace offers", async () => {
		await onDatabase((db) =>
			db.update(bot).set({ model: "not-switched-on" }).where(eq(bot.id, customBotId)),
		);
		await expect(complete(adminId, customBotId)).rejects.toBeInstanceOf(Onboarding.NoModelChosen);

		await onDatabase((db) => db.update(bot).set({ model: null }).where(eq(bot.id, customBotId)));
		await expect(complete(adminId, customBotId)).rejects.toBeInstanceOf(Onboarding.NoModelChosen);
	});

	it("makes the first bot's model the workspace's default and Compaction's", async () => {
		await complete(adminId, customBotId);

		const [compaction] = await onDatabase((db) =>
			db.select({ model: bot.model }).from(bot).where(eq(bot.id, systemBotId)),
		);
		expect(compaction?.model).toBe("model");
		const [chosen] = await onDatabase((db) =>
			db
				.select({ modelId: workspaceDefaultModel.modelId })
				.from(workspaceDefaultModel)
				.where(eq(workspaceDefaultModel.workspaceId, workspaceId)),
		);
		expect(chosen?.modelId).toBe("model");
	});

	it("records when the workspace's setup was completed, the first time only", async () => {
		const setupCompletedAt = () =>
			onDatabase((db) =>
				db
					.select({ at: workspace.setupCompletedAt })
					.from(workspace)
					.where(eq(workspace.id, workspaceId)),
			).then(([row]) => row?.at);
		await expect(complete(adminId, systemBotId)).rejects.toBeInstanceOf(
			Onboarding.NotReadyToFinish,
		);
		expect(await setupCompletedAt()).toBeNull();

		await complete(adminId, customBotId);
		const first = await setupCompletedAt();
		await complete(adminId, customBotId);

		expect(first).toBeInstanceOf(Date);
		expect(await setupCompletedAt()).toEqual(first);
	});

	it("does not accept a system bot or a member who may not choose the workspace's models", async () => {
		await expect(complete(adminId, systemBotId)).rejects.toBeInstanceOf(
			Onboarding.NotReadyToFinish,
		);
		await expect(complete(memberId, customBotId)).rejects.toBeInstanceOf(ActionForbidden);
	});

	it("does not accept a bot somebody else created", async () => {
		await onDatabase((db) =>
			db.update(bot).set({ createdById: memberId }).where(eq(bot.id, customBotId)),
		);

		await expect(complete(adminId, customBotId)).rejects.toBeInstanceOf(
			Onboarding.NotReadyToFinish,
		);
	});
});
