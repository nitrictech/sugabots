import { asc, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { bot, member, membership, workspace } from "../database/schema.ts";
import { closeDatabase, onDatabase } from "../database/testing.ts";
import { reachesBotFor } from "./access.ts";

describe.skipIf(!process.env.DATABASE_URL)("reach written as SQL", () => {
	afterAll(async () => {
		await closeDatabase();
	});

	// Drizzle leaves the table off the columns of a query over one table, so
	// this selects the rule beside the bot from a query over bots alone.
	it("is selected beside each bot from a query over bots alone", async () => {
		const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const [space] = await onDatabase((db) =>
			db
				.insert(workspace)
				.values({ name: stamp, slug: `reach-${stamp}` })
				.returning(),
		);
		const [ada, sam] = await onDatabase((db) =>
			db
				.insert(member)
				.values([
					{ name: "Ada", email: `ada-${stamp}@example.com` },
					{ name: "Sam", email: `sam-${stamp}@example.com` },
				])
				.returning(),
		);
		if (!space || !ada || !sam) throw new Error("could not create the fixtures");
		await onDatabase((db) =>
			db.insert(membership).values([
				{ workspaceId: space.id, memberId: ada.id, role: "editor" },
				{ workspaceId: space.id, memberId: sam.id, role: "editor" },
			]),
		);
		await onDatabase((db) =>
			db.insert(bot).values([
				{
					workspaceId: space.id,
					name: "Public",
					handle: `public-${stamp}`,
					color: "green",
					eyes: "pill",
					visibility: "public",
					createdById: sam.id,
				},
				{
					workspaceId: space.id,
					name: "Sam's",
					handle: `sams-${stamp}`,
					color: "sky",
					eyes: "pill",
					visibility: "personal",
					createdById: sam.id,
				},
			]),
		);

		const rows = await onDatabase((db) =>
			db
				.select({ name: bot.name, reached: reachesBotFor(bot.id, ada.id) })
				.from(bot)
				.where(eq(bot.workspaceId, space.id))
				.orderBy(asc(bot.name)),
		);

		expect(rows).toEqual([
			{ name: "Public", reached: true },
			{ name: "Sam's", reached: false },
		]);
	});
});
