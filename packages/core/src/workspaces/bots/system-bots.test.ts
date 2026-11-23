import { and, eq } from "drizzle-orm";
import { Layer } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { noComputers } from "../../computers/testing.ts";
import { bot, user, workspace, workspaceMember } from "../../database/schema.ts";
import {
	closeDatabase,
	onDatabase,
	type Promised,
	servedOnPostgres,
} from "../../database/testing.ts";
import { servedOnPostgresAs } from "../testing.ts";
import { BotAdministration } from "./bot-administration.ts";
import { BotRepository } from "./bot-repository.ts";

describe.skipIf(!process.env.DATABASE_URL)("the workspace's system bots", () => {
	let bots: Promised<BotRepository.Interface>;
	let administrationAs: (userId: string) => Promised<BotAdministration.Interface>;
	/** The administration as the administrator of both workspaces. */
	let administration: Promised<BotAdministration.Interface>;
	let workspaceId: string;
	let otherWorkspaceId: string;
	let creatorId: string;

	beforeAll(async () => {
		bots = await servedOnPostgres(BotRepository.Service, BotRepository.layer);
		administrationAs = await servedOnPostgresAs(
			BotAdministration.Service,
			BotAdministration.layer.pipe(Layer.provide(noComputers)),
		);
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
		const [person] = await onDatabase((db) =>
			db
				.insert(user)
				.values({ name: "Ada", email: `ada-${stamp}@example.com` })
				.returning(),
		);
		if (!space || !other || !person) throw new Error("could not create the fixtures");
		workspaceId = space.id;
		otherWorkspaceId = other.id;
		creatorId = person.id;
		administration = administrationAs(creatorId);
		await onDatabase((db) =>
			db.insert(workspaceMember).values([
				{ workspaceId, userId: creatorId, role: "admin" },
				{ workspaceId: otherWorkspaceId, userId: creatorId, role: "admin" },
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
		await bots.ensureSystemBots({ workspaceId, createdById: creatorId });

		expect(await placed()).toEqual([{ key: "compact", model: null }]);
	});

	it("creates nothing more when run again", async () => {
		await bots.ensureSystemBots({ workspaceId, createdById: creatorId });
		await bots.ensureSystemBots({ workspaceId, createdById: creatorId });

		expect(await placed()).toHaveLength(1);
	});

	it("does not put a chosen model back to unset when run again", async () => {
		await bots.ensureSystemBots({ workspaceId, createdById: creatorId });
		await bots.setSystemBotModel(workspaceId, "compact", "chosen-model");

		await bots.ensureSystemBots({ workspaceId, createdById: creatorId });

		const [compaction] = await onDatabase((db) =>
			db
				.select({ model: bot.model })
				.from(bot)
				.where(and(eq(bot.workspaceId, workspaceId), eq(bot.systemBotKey, "compact"))),
		);
		expect(compaction?.model).toBe("chosen-model");
	});

	it("gives each workspace its own set", async () => {
		await bots.ensureSystemBots({ workspaceId, createdById: creatorId });
		await bots.ensureSystemBots({ workspaceId: otherWorkspaceId, createdById: creatorId });
		await bots.setSystemBotModel(workspaceId, "compact", "one-workspace-only");

		const listed = await administration.systemBots({ workspace: otherWorkspaceId });
		expect(listed.map(({ key, model }) => ({ key, model }))).toEqual([
			{ key: "compact", model: null },
		]);
	});

	it("reports a workspace with no rows as one that is not set up", async () => {
		const listed = await administration.systemBots({ workspace: workspaceId });

		expect(listed.map(({ key, model }) => ({ key, model }))).toEqual([
			{ key: "compact", model: null },
		]);
	});

	it("refuses a second Compaction bot in the same workspace", async () => {
		await bots.ensureSystemBots({ workspaceId, createdById: creatorId });

		await expect(
			onDatabase((db) =>
				db.insert(bot).values({
					workspaceId,
					name: "Second Compaction",
					handle: "second-compaction",
					systemBotKey: "compact",
					color: "purple",
					face: "square",
					model: null,
				}),
			),
		).rejects.toThrow();
	});
});
