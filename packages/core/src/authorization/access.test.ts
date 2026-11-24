import type { WorkspaceRole } from "@sugabots/contracts";
import { asc, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import type * as schema from "../database/schema.ts";
import { bot, member, membership, workspace } from "../database/schema.ts";
import { closeDatabase, onDatabase } from "../database/testing.ts";
import { mayDecideToolCall, type ProjectStanding, reachesBotFor } from "./access.ts";
import { type BotFacts, mayInProject, type ProjectFacts } from "./permissions.ts";

describe("who decides a call raised in an automation's run", () => {
	const ALICE = "0199a3a0-0000-7000-8000-00000000a11c";
	const BOB = "0199a3a0-0000-7000-8000-00000000b0b0";
	const publicBotBy = (createdById: string): BotFacts => ({
		visibility: "public",
		createdById,
		assistantOf: null,
	});
	/** `memberId`'s standing, with `role`, in a project with `facts`. */
	const standing = (
		role: WorkspaceRole,
		memberId: string,
		facts: ProjectFacts,
	): ProjectStanding => {
		const actor = { memberId, workspaceRole: role };
		return {
			project: {} as schema.ProjectRow,
			actor,
			facts,
			may: (permission) => mayInProject(actor, permission, facts),
		};
	};
	/** Whether `memberId` may decide a call in a chat of the project, raised in a run `runBot` does. */
	const decides = (
		role: WorkspaceRole,
		memberId: string,
		facts: ProjectFacts,
		runBot: BotFacts | undefined,
	) => mayDecideToolCall(standing(role, memberId, facts), runBot, "chat");

	describe("in a project members made, led by Alice's public bot", () => {
		const member: ProjectFacts = { isMember: true, defaultOf: null };
		const lead = publicBotBy(ALICE);

		it("lets the lead bot's creator, an editor in the project, decide", () => {
			expect(decides("editor", ALICE, member, lead)).toBe(true);
		});

		it("lets an admin or the owner decide", () => {
			expect(decides("admin", BOB, member, lead)).toBe(true);
			expect(decides("owner", BOB, member, lead)).toBe(true);
		});

		it("refuses another editor, though they decide the project's calls outside runs", () => {
			expect(decides("editor", BOB, member, lead)).toBe(false);
			expect(decides("editor", BOB, member, undefined)).toBe(true);
		});

		it("refuses the creator once a viewer, and when not in the project", () => {
			expect(decides("viewer", ALICE, member, lead)).toBe(false);
			expect(decides("editor", ALICE, { isMember: false, defaultOf: null }, lead)).toBe(false);
		});
	});

	describe("in a bot's default project", () => {
		it("lets its creator and admins decide its own runs' calls, and no other editor", () => {
			const bot = publicBotBy(ALICE);
			const own: ProjectFacts = { isMember: false, defaultOf: bot };
			expect(decides("editor", ALICE, own, bot)).toBe(true);
			expect(decides("admin", BOB, own, bot)).toBe(true);
			expect(decides("editor", BOB, own, bot)).toBe(false);
			expect(decides("viewer", ALICE, own, bot)).toBe(false);
		});

		it("refuses an admin a personal bot's runs, whose chats they don't reach", () => {
			const bot: BotFacts = { visibility: "personal", createdById: ALICE, assistantOf: null };
			expect(decides("admin", BOB, { isMember: false, defaultOf: bot }, bot)).toBe(false);
		});

		it("lets only its member decide a Personal Assistant's runs' calls, a viewer included", () => {
			const assistant: BotFacts = { visibility: "personal", createdById: null, assistantOf: ALICE };
			const own: ProjectFacts = { isMember: false, defaultOf: assistant };
			expect(decides("viewer", ALICE, own, assistant)).toBe(true);
			expect(decides("owner", BOB, own, assistant)).toBe(false);
		});
	});
});

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
