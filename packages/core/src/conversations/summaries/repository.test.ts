import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { botSummary, bot as botTable, workspace } from "../../database/schema.ts";
import { closeDatabase, onDatabase, runOnPostgres } from "../../database/testing.ts";
import { unimplemented } from "../../testing.ts";
import { ConversationEvents } from "../conversation-events.ts";
import { makeRecords } from "./repository.ts";

/** A bot's summary as the Summariser writes it, against Postgres. */
describe.skipIf(!process.env.DATABASE_URL)("a bot's summary, against Postgres", () => {
	let botId: string;

	afterAll(closeDatabase);

	beforeEach(async () => {
		const suffix = crypto.randomUUID();
		const [space] = await onDatabase((db) =>
			db
				.insert(workspace)
				.values({ name: "Summaries", slug: `summaries-${suffix}` })
				.returning(),
		);
		if (!space) throw new Error("fixture");
		const [bot] = await onDatabase((db) =>
			db
				.insert(botTable)
				.values({
					workspaceId: space.id,
					name: "Scout",
					handle: `scout-${suffix}`,
					color: "sky",
					face: "pill",
				})
				.returning(),
		);
		if (!bot) throw new Error("fixture");
		botId = bot.id;
	});

	const save = (content: string, coversThrough: Date) =>
		runOnPostgres(
			Effect.flatMap(makeRecords, (records) =>
				records.saveBotSummary({ botId, content, coversThrough }),
			).pipe(Effect.provide(unimplemented(ConversationEvents.Service, {}))),
		);

	const saved = async () => {
		const [row] = await onDatabase((db) =>
			db.select().from(botSummary).where(eq(botSummary.botId, botId)),
		);
		return row?.content;
	};

	it("keeps a summary written from newer conversations when an older one arrives after it", async () => {
		await save("Shipping the release.", new Date("2026-11-18T10:00:00Z"));
		await save("Planning the release.", new Date("2026-11-18T09:00:00Z"));

		expect(await saved()).toBe("Shipping the release.");

		await save("Released.", new Date("2026-11-18T10:00:00Z"));

		expect(await saved()).toBe("Released.");
	});
});
