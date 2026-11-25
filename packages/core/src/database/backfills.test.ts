import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	seedAutomation,
	seedBot,
	seedMember,
	seedMessage,
	seedProject,
	seedProjectChat,
	seedRun,
	seedTurn,
	seedWorkspace,
} from "../authentication/seed.test-support.ts";
import { turn } from "./schema.ts";
import { closeDatabase, onDatabase } from "./testing.ts";

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "../../drizzle");

/** The statements of the migration `name` that fill in rows it found, as it runs them. */
function backfillsOf(name: string): string[] {
	return readFileSync(join(MIGRATIONS, name, "migration.sql"), "utf8")
		.split("--> statement-breakpoint")
		.map((statement) =>
			statement
				.split("\n")
				.filter((line) => !line.trimStart().startsWith("--"))
				.join("\n")
				.trim(),
		)
		.filter((statement) => statement.startsWith("UPDATE"));
}

/**
 * The asker backfills, run over turns as they were made before turns stored
 * their askers: the one that first stored them, then the one that fixed it
 * for a Personal Assistant's runs and asked turns with nobody to act for to end.
 */
describe.skipIf(!process.env.DATABASE_URL)("the asker backfills", () => {
	let sam: string;
	let pat: string;
	const turns: Record<string, string> = {};

	beforeAll(async () => {
		const workspaceId = await seedWorkspace();
		sam = await seedMember(workspaceId, "editor");
		pat = await seedMember(workspaceId, "editor");
		const lead = await seedBot(workspaceId);
		const helper = await seedBot(workspaceId);
		const projectId = await seedProject(workspaceId, {
			leadBotId: lead.id,
			members: [sam],
			bots: [helper.id],
		});
		const chatId = await seedProjectChat(workspaceId, projectId, sam);

		const asked = await seedMessage(chatId, { member: sam });
		turns.member = await seedTurn(chatId, lead.id, asked, { status: "done" });
		const asking = await seedMessage(chatId, { bot: lead.id, turn: turns.member });
		turns.helper = await seedTurn(chatId, helper.id, asking, { reason: "collaboration" });

		const assistant = await seedBot(workspaceId, { assistantOf: pat, visibility: "personal" });
		const assistantRun = await seedRun(
			workspaceId,
			await seedAutomation(workspaceId, assistant.defaultProject),
			assistant.id,
			"routine",
		);
		turns.assistantRun = await seedTurn(
			assistantRun.chat,
			assistant.id,
			assistantRun.triggerMessage,
			{ reason: "automation" },
		);

		const otherRun = await seedRun(
			workspaceId,
			await seedAutomation(workspaceId, lead.defaultProject),
			lead.id,
			"routine",
		);
		turns.otherRun = await seedTurn(otherRun.chat, lead.id, otherRun.triggerMessage, {
			reason: "automation",
		});
		// A bot's message no turn wrote, in a chat nobody started: nobody to act for.
		const unowned = await seedMessage(otherRun.chat, { bot: lead.id });
		turns.nobodyInFlight = await seedTurn(otherRun.chat, helper.id, unowned);
		turns.nobodyEnded = await seedTurn(otherRun.chat, lead.id, unowned, { status: "done" });

		// As they were before the migrations: no asker stored.
		await onDatabase((db) =>
			db
				.update(turn)
				.set({ askerId: null, askedByAutomation: false })
				.where(inArray(turn.id, Object.values(turns))),
		);
		for (const statement of [
			...backfillsOf("20261125032116_turn_askers_and_joins"),
			...backfillsOf("20261125043508_turn_askers_in_code"),
		]) {
			await onDatabase((db) => db.execute(sql.raw(statement)));
		}
	});

	afterAll(async () => {
		await closeDatabase();
	});

	const stored = async (turnId: string | undefined) => {
		const [row] = await onDatabase((db) =>
			db
				.select({
					askerId: turn.askerId,
					askedByAutomation: turn.askedByAutomation,
					endRequested: turn.endRequested,
				})
				.from(turn)
				.where(eq(turn.id, turnId ?? "")),
		);
		return row;
	};

	it("gives a turn on a member's message that member, and a helper the asking turn's", async () => {
		expect(await stored(turns.member)).toEqual({
			askerId: sam,
			askedByAutomation: false,
			endRequested: null,
		});
		expect(await stored(turns.helper)).toMatchObject({ askerId: sam, askedByAutomation: false });
	});

	it("gives a Personal Assistant's run its member, and another bot's run nobody", async () => {
		expect(await stored(turns.assistantRun)).toMatchObject({
			askerId: pat,
			askedByAutomation: true,
		});
		expect(await stored(turns.otherRun)).toMatchObject({ askerId: null, askedByAutomation: true });
	});

	it("asks a turn still in flight with nobody to act for to end, and leaves one that ended", async () => {
		expect(await stored(turns.nobodyInFlight)).toEqual({
			askerId: null,
			askedByAutomation: false,
			endRequested: "lost_reach",
		});
		expect(await stored(turns.nobodyEnded)).toMatchObject({ endRequested: null });
	});
});
