import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bot, member, membership, workspace } from "../../database/schema.ts";
import {
	closeDatabase,
	onDatabase,
	type Promised,
	servedOnPostgres,
} from "../../database/testing.ts";
import { type CallOperation, servedOperations } from "../../operations/testing.ts";
import { authenticators, principals } from "../../proofs/world.test-support.ts";
import { BotStore } from "./bot-store.ts";

describe.skipIf(!process.env.DATABASE_URL)("the workspace's system bots", () => {
	let bots: Promised<BotStore.Interface>;
	let callOperation: CallOperation;
	let signedIn: ReturnType<typeof principals>;
	let workspaceId: string;
	let otherWorkspaceId: string;
	let creatorId: string;

	beforeAll(async () => {
		bots = await servedOnPostgres(BotStore.Service, BotStore.layer);
		callOperation = await servedOperations();
		signedIn = principals(await authenticators());
	});

	afterAll(async () => {
		await closeDatabase();
	});

	beforeEach(async () => {
		const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const made = await onDatabase((db) =>
			db
				.insert(workspace)
				.values([
					{ name: `Test ${stamp}`, slug: `system-${stamp}` },
					{ name: `Other ${stamp}`, slug: `system-other-${stamp}` },
				])
				.returning(),
		);
		const [space, other] = made;
		const [somebody] = await onDatabase((db) =>
			db
				.insert(member)
				.values({ name: "Ada", email: `ada-${stamp}@example.com` })
				.returning(),
		);
		if (!space || !other || !somebody) throw new Error("could not create the fixtures");
		workspaceId = space.id;
		otherWorkspaceId = other.id;
		creatorId = somebody.id;
		await onDatabase((db) =>
			db.insert(membership).values([
				{ workspaceId, memberId: creatorId, role: "admin" },
				{ workspaceId: otherWorkspaceId, memberId: creatorId, role: "admin" },
			]),
		);
	});

	const placed = () =>
		onDatabase((db) =>
			db
				.select({ key: bot.systemBotKey, model: bot.model })
				.from(bot)
				.where(eq(bot.workspaceId, workspaceId))
				.orderBy(bot.name),
		);

	it("gives a workspace one of each, with no model", async () => {
		await bots.createSystemBots({ workspaceId, createdById: creatorId });

		expect(await placed()).toEqual([{ key: "compact", model: null }]);
	});

	it("gives each workspace its own set, whose model is chosen for it alone", async () => {
		await bots.createSystemBots({ workspaceId, createdById: creatorId });
		await bots.createSystemBots({ workspaceId: otherWorkspaceId, createdById: creatorId });
		await bots.setSystemBotModel(workspaceId, "compact", "one-workspace-only");

		const principal = await signedIn.member(creatorId);
		const listedIn = async (workspace: string) =>
			(await callOperation(principal, "systemBots.list", { workspace })).map(({ key, model }) => ({
				key,
				model,
			}));
		expect(await listedIn(workspaceId)).toEqual([{ key: "compact", model: "one-workspace-only" }]);
		expect(await listedIn(otherWorkspaceId)).toEqual([{ key: "compact", model: null }]);
	});
});
