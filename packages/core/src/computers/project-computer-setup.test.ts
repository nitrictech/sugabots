import { eq } from "drizzle-orm";
import { Layer } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	bot,
	computer,
	computerProvider,
	member,
	membership,
	project,
	workspace,
} from "../database/schema.ts";
import { closeDatabase, onDatabase, type Promised } from "../database/testing.ts";
import { Egress } from "../providers/network/egress.ts";
import { unimplemented } from "../testing.ts";
import { servedOnPostgresAs } from "../workspaces/testing.ts";
import { ComputerSignIn } from "./computer-sign-in.ts";
import type { Computers } from "./computers.ts";
import { ProjectComputerSetup } from "./project-computer-setup.ts";

/**
 * Which projects' computers' disks a member is shown, against Postgres: the
 * scoping is SQL a fake can't check. Skips without a migrated database.
 */
describe.skipIf(!process.env.DATABASE_URL)("projects' computers' disks, against Postgres", () => {
	let setupAs: (memberId: string) => Promised<ProjectComputerSetup.Interface>;

	beforeAll(async () => {
		setupAs = await servedOnPostgresAs(
			ProjectComputerSetup.Service,
			ProjectComputerSetup.layer.pipe(
				Layer.provide([
					unimplemented(ComputerSignIn.Service, {}),
					unimplemented(Egress.Service, {}),
				]),
			),
		);
	});

	afterAll(async () => {
		await closeDatabase();
	});

	it("leaves out the computers of another member's personal bots, even for a workspace admin", async () => {
		const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const [space] = await onDatabase((db) =>
			db
				.insert(workspace)
				.values({ name: `Disks ${stamp}`, slug: `disks-${stamp}` })
				.returning(),
		);
		const [ada, sam] = await onDatabase((db) =>
			db
				.insert(member)
				.values([
					{ name: "Ada", email: `ada-disks-${stamp}@example.com` },
					{ name: "Sam", email: `sam-disks-${stamp}@example.com` },
				])
				.returning(),
		);
		if (!space || !ada || !sam) throw new Error("fixture");
		const workspaceId = space.id;
		await onDatabase((db) =>
			db.insert(membership).values([
				{ workspaceId, memberId: ada.id, role: "admin" },
				{ workspaceId, memberId: sam.id, role: "editor" },
			]),
		);
		const [provider] = await onDatabase((db) =>
			db
				.insert(computerProvider)
				.values({
					workspaceId,
					settings: { builtIn: "opensandbox", serverUrl: "http://computers.test", image: "debian" },
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
						{ visibility: "personal" as const, createdById: ada.id },
						{ visibility: "personal" as const, createdById: sam.id },
					].map((placement, index) => ({
						...placement,
						workspaceId,
						name: `Bot ${index}`,
						handle: `bot-${index}`,
						color: "sky" as const,
						eyes: "pill" as const,
					})),
				)
				.returning(),
		);
		const defaultProjects = await onDatabase((db) =>
			db
				.select({ id: project.id, botId: project.defaultOfBotId })
				.from(project)
				.where(eq(project.workspaceId, workspaceId)),
		);
		const [publicBot, adasBot, samsBot] = bots.map((made) => {
			const own = defaultProjects.find((candidate) => candidate.botId === made.id);
			if (!own) throw new Error("fixture");
			return own;
		});
		if (!publicBot || !adasBot || !samsBot) throw new Error("fixture");
		await onDatabase((db) =>
			db.insert(computer).values(
				[publicBot, adasBot, samsBot].map((measured) => ({
					workspaceId,
					projectId: measured.id,
					computerProviderId: provider.id,
					providerComputerId: `computer-${measured.id}` as Computers.ComputerId,
					image: "debian",
					diskUsage: { usedBytes: 1_000, totalBytes: 10_000, folders: [] },
					diskMeasuredAt: new Date(),
				})),
			),
		);

		const shown = await setupAs(sam.id).disks(workspaceId);
		const shownToAdmin = await setupAs(ada.id).disks(workspaceId);

		expect(shown.map(({ projectId }) => projectId).toSorted()).toEqual(
			[publicBot.id, samsBot.id].toSorted(),
		);
		expect(shownToAdmin.map(({ projectId }) => projectId).toSorted()).toEqual(
			[publicBot.id, adasBot.id].toSorted(),
		);
	});
});
