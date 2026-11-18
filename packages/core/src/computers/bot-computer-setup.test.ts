import { Layer } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	bot,
	computer,
	computerProvider,
	user,
	workspace,
	workspaceMember,
} from "../database/schema.ts";
import { closeDatabase, onDatabase, type Promised } from "../database/testing.ts";
import { Egress } from "../providers/network/egress.ts";
import { unimplemented } from "../testing.ts";
import { servedOnPostgresAs } from "../workspaces/testing.ts";
import { BotComputerSetup } from "./bot-computer-setup.ts";
import { ComputerCredentials } from "./computer-credentials.ts";
import type { Computers } from "./computers.ts";

/**
 * Which bots' computers' disks a person is shown, against Postgres: the
 * scoping is SQL a fake can't check. Skips without a migrated database.
 */
describe.skipIf(!process.env.DATABASE_URL)("bots' computers' disks, against Postgres", () => {
	let setupAs: (userId: string) => Promised<BotComputerSetup.Interface>;

	beforeAll(async () => {
		setupAs = await servedOnPostgresAs(
			BotComputerSetup.Service,
			BotComputerSetup.layer.pipe(
				Layer.provide([
					unimplemented(ComputerCredentials.Service, {}),
					unimplemented(Egress.Service, {}),
				]),
			),
		);
	});

	afterAll(async () => {
		await closeDatabase();
	});

	it("leaves out the computers of another person's private bots, even for a workspace admin", async () => {
		const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const [space] = await onDatabase((db) =>
			db
				.insert(workspace)
				.values({ name: `Disks ${stamp}`, slug: `disks-${stamp}` })
				.returning(),
		);
		const [ada, sam] = await onDatabase((db) =>
			db
				.insert(user)
				.values([
					{ name: "Ada", email: `ada-disks-${stamp}@example.com` },
					{ name: "Sam", email: `sam-disks-${stamp}@example.com` },
				])
				.returning(),
		);
		if (!space || !ada || !sam) throw new Error("fixture");
		const workspaceId = space.id;
		await onDatabase((db) =>
			db.insert(workspaceMember).values([
				{ workspaceId, userId: ada.id, role: "admin" },
				{ workspaceId, userId: sam.id, role: "member" },
			]),
		);
		const [provider] = await onDatabase((db) =>
			db
				.insert(computerProvider)
				.values({
					workspaceId,
					settings: { preset: "opensandbox", serverUrl: "http://computers.test", image: "debian" },
					enabled: true,
				})
				.returning(),
		);
		if (!provider) throw new Error("fixture");
		const bots = await onDatabase((db) =>
			db
				.insert(bot)
				.values(
					[
						{ visibility: "public" as const, createdById: ada.id },
						{ visibility: "private" as const, createdById: ada.id },
						{ visibility: "private" as const, createdById: sam.id },
					].map((placement, index) => ({
						...placement,
						workspaceId,
						name: `Bot ${index}`,
						handle: `bot-${index}`,
						color: "sky" as const,
						face: "pill" as const,
					})),
				)
				.returning(),
		);
		const [publicBot, adasBot, samsBot] = bots;
		if (!publicBot || !adasBot || !samsBot) throw new Error("fixture");
		await onDatabase((db) =>
			db.insert(computer).values(
				bots.map((measured) => ({
					workspaceId,
					botId: measured.id,
					computerProviderId: provider.id,
					providerComputerId: `computer-${measured.id}` as Computers.ComputerId,
					diskUsage: { usedBytes: 1_000, totalBytes: 10_000, folders: [] },
					diskMeasuredAt: new Date(),
				})),
			),
		);

		const shown = await setupAs(sam.id).disks(workspaceId);
		const shownToAdmin = await setupAs(ada.id).disks(workspaceId);

		expect(shown.map(({ botId }) => botId).toSorted()).toEqual(
			[publicBot.id, samsBot.id].toSorted(),
		);
		expect(shownToAdmin.map(({ botId }) => botId).toSorted()).toEqual(
			[publicBot.id, adasBot.id].toSorted(),
		);
	});
});
