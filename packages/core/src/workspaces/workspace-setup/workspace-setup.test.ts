import { ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { NoModelChosen } from "@sugabots/contracts/errors/workspace";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { seedBot, seedMember, seedWorkspace } from "../../authentication/seed.test-support.ts";
import { query } from "../../database/database.ts";
import {
	bot,
	modelProvider,
	providerModel,
	workspace,
	workspaceDefaultModel,
} from "../../database/schema.ts";
import {
	closeDatabase,
	holdTransaction,
	onDatabase,
	waitUntilWaitingOnLocks,
} from "../../database/testing.ts";
import { createWorkspaceFixture } from "../../database/workspace.test-support.ts";
import { type CallOperation, servedOperations } from "../../operations/testing.ts";
import type { MemberSession } from "../../principal.ts";
import { authenticators, principals } from "../../proofs/world.test-support.ts";

describe.skipIf(!process.env.DATABASE_URL)("workspace setup, against Postgres", () => {
	let callOperation: CallOperation;
	let signIn: (memberId: string) => Promise<MemberSession>;
	let workspaceId: string;
	let adminId: string;
	let editorId: string;
	let customBotId: string;
	let systemBotId: string;

	beforeAll(async () => {
		callOperation = await servedOperations();
		const signedIn = principals(await authenticators());
		signIn = (memberId) => signedIn.member(memberId);
	});

	afterAll(async () => {
		await closeDatabase();
	});

	/** `workspaceSetup.complete` called for `memberId` signed in. */
	const complete = async (memberId: string, botId: string) =>
		callOperation(await signIn(memberId), "workspaceSetup.complete", { workspaceId, botId });

	beforeEach(async () => {
		const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const {
			workspace: madeWorkspace,
			members: { admin, editor },
		} = await createWorkspaceFixture(
			{ name: `Test ${stamp}`, slug: `workspace-setup-${stamp}` },
			{
				admin: { name: "Admin", email: `admin-${stamp}@example.com`, role: "admin" },
				editor: { name: "Editor", email: `editor-${stamp}@example.com`, role: "editor" },
			},
		);
		workspaceId = madeWorkspace.id;
		adminId = admin.id;
		editorId = editor.id;
		const [provider] = await onDatabase((db) =>
			db
				.insert(modelProvider)
				.values({
					workspaceId,
					builtIn: null,
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
						eyes: "pill",
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
						eyes: "square",
						model: null,
						createdById: adminId,
					},
				])
				.returning(),
		);
		const [custom, system] = madeBots;
		if (!custom || !system) throw new Error("could not create workspace setup bots");
		customBotId = custom.id;
		systemBotId = system.id;
	});

	it("hides a bot in another workspace and a missing bot", async () => {
		const elsewhere = await seedBot(await seedWorkspace());
		for (const botId of [elsewhere.id, crypto.randomUUID()]) {
			await expect(complete(adminId, botId)).rejects.toBeInstanceOf(ResourceHidden);
		}
	});

	it("does not complete for a bot with no model the workspace offers", async () => {
		await onDatabase((db) =>
			db.update(bot).set({ model: "not-switched-on" }).where(eq(bot.id, customBotId)),
		);
		await expect(complete(adminId, customBotId)).rejects.toBeInstanceOf(NoModelChosen);

		await onDatabase((db) => db.update(bot).set({ model: null }).where(eq(bot.id, customBotId)));
		await expect(complete(adminId, customBotId)).rejects.toBeInstanceOf(NoModelChosen);
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

	it("waits for the workspace's models before it locks the chosen bot, as a change of models does", async () => {
		// A change of models takes the workspace's lock, then the bots' rows it moves.
		const changingModels = holdTransaction(
			query((db) =>
				db
					.select({ id: workspace.id })
					.from(workspace)
					.where(eq(workspace.id, workspaceId))
					.for("update"),
			),
		);
		await changingModels.held;
		const completing = complete(adminId, customBotId);
		await waitUntilWaitingOnLocks(1);

		const movingTheBot = holdTransaction(
			query((db) =>
				db
					.select({ id: bot.id })
					.from(bot)
					.where(eq(bot.id, customBotId))
					.for("update", { noWait: true }),
			),
		);
		const botFree = await movingTheBot.held.then(
			() => true,
			() => false,
		);
		await movingTheBot.release().catch(() => undefined);
		await changingModels.release();
		await completing;

		expect(botFree).toBe(true);
	});

	it("records when the workspace's setup was completed, the first time only", async () => {
		const setUpAt = () =>
			onDatabase((db) =>
				db.select({ at: workspace.setUpAt }).from(workspace).where(eq(workspace.id, workspaceId)),
			).then(([row]) => row?.at);
		await expect(complete(adminId, systemBotId)).rejects.toBeInstanceOf(ResourceHidden);
		expect(await setUpAt()).toBeNull();
		// Signed in on the real clock: a session made on the frozen one has long expired in the database.
		const admin = await signIn(adminId);
		const completeAdmin = () =>
			callOperation(admin, "workspaceSetup.complete", { workspaceId, botId: customBotId });
		const firstCompletion = new Date("2026-09-15T12:00:00Z");
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			vi.setSystemTime(firstCompletion);
			await completeAdmin();
			vi.setSystemTime(new Date("2026-09-15T13:00:00Z"));
			await completeAdmin();
		} finally {
			vi.useRealTimers();
		}

		expect(await setUpAt()).toEqual(firstCompletion);
	});

	it("refuses editors and viewers before looking up the bot", async () => {
		const viewerId = await seedMember(workspaceId, "viewer");
		const personal = await seedBot(workspaceId, { createdById: adminId, visibility: "personal" });
		for (const memberId of [editorId, viewerId]) {
			for (const botId of [customBotId, personal.id, crypto.randomUUID()]) {
				await expect(complete(memberId, botId)).rejects.toMatchObject({
					_tag: "ActionForbidden",
					proof: "CanManageWorkspace",
				});
			}
		}
	});

	it("hides bots the admin cannot finish setup for, including another member's Personal Assistant", async () => {
		const personal = await seedBot(workspaceId, { createdById: editorId, visibility: "personal" });
		const assistant = await seedBot(workspaceId, {
			createdById: editorId,
			assistantOf: editorId,
			visibility: "personal",
		});
		await onDatabase((db) =>
			db.update(bot).set({ createdById: editorId }).where(eq(bot.id, customBotId)),
		);

		for (const botId of [
			systemBotId,
			customBotId,
			personal.id,
			assistant.id,
			crypto.randomUUID(),
		]) {
			await expect(complete(adminId, botId)).rejects.toMatchObject({
				_tag: "ResourceHidden",
				resource: "bot",
			});
		}
	});
});
