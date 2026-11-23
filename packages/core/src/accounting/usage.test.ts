import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ActionForbidden } from "../authorization/access.ts";
import {
	bot,
	membership,
	modelProvider,
	modelRequest,
	person,
	workspace,
} from "../database/schema.ts";
import { closeDatabase, onDatabase, type Promised } from "../database/testing.ts";
import { servedOnPostgresAs } from "../workspaces/testing.ts";
import { Usage } from "./usage.ts";

/**
 * A month's usage, read from the request ledger in Postgres: how requests are
 * grouped, which month and day a request falls on in the workspace's time zone,
 * and which requests count as of unknown cost. Needs a migrated database and skips
 * without one; CI always has one.
 */
describe.skipIf(!process.env.DATABASE_URL)("usage, against Postgres", () => {
	let usageAs: (personId: string) => Promised<Usage.Interface>;
	let workspaceId: string;
	let adminId: string;
	let editorId: string;
	let growthDeskId: string;
	let accountManagerId: string;
	let providerId: string;

	beforeAll(async () => {
		usageAs = await servedOnPostgresAs(Usage.Service, Usage.layer);
	});
	afterAll(closeDatabase);

	beforeEach(async () => {
		const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const [space] = await onDatabase((db) =>
			db
				.insert(workspace)
				.values({ name: "Usage", slug: `usage-${suffix}` })
				.returning(),
		);
		const [admin, editor] = await onDatabase((db) =>
			db
				.insert(person)
				.values([
					{ name: "Ada", email: `ada-${suffix}@example.com` },
					{ name: "Sam", email: `sam-${suffix}@example.com` },
				])
				.returning(),
		);
		if (!space || !admin || !editor) throw new Error("fixture");
		workspaceId = space.id;
		adminId = admin.id;
		editorId = editor.id;
		await onDatabase((db) =>
			db.insert(membership).values([
				{ workspaceId, personId: adminId, role: "admin" },
				{ workspaceId, personId: editorId, role: "editor" },
			]),
		);
		const [growthDesk, accountManager] = await onDatabase((db) =>
			db
				.insert(bot)
				.values([
					{
						workspaceId,
						name: "Growth Desk",
						handle: `growth-desk-${suffix}`,
						color: "green",
						eyes: "pill",
					},
					{
						workspaceId,
						name: "Account Manager",
						handle: `account-manager-${suffix}`,
						color: "sky",
						eyes: "dot",
					},
				])
				.returning(),
		);
		if (!growthDesk || !accountManager) throw new Error("fixture");
		growthDeskId = growthDesk.id;
		accountManagerId = accountManager.id;
		const [provider] = await onDatabase((db) =>
			db
				.insert(modelProvider)
				.values({
					workspaceId,
					builtIn: "anthropic",
					name: "Anthropic",
					baseUrl: "https://api.anthropic.com",
					apiFormat: "anthropic",
				})
				.returning(),
		);
		if (!provider) throw new Error("fixture");
		providerId = provider.id;
	});

	type Recorded = Partial<typeof modelRequest.$inferInsert> &
		Pick<typeof modelRequest.$inferInsert, "startedAt">;

	/** Requests in the ledger: completed bot turns of Growth Desk's by default. */
	const recorded = (...requests: Recorded[]) =>
		onDatabase((db) =>
			db.insert(modelRequest).values(
				requests.map((request) => ({
					workspaceId,
					purpose: "bot-turn" as const,
					botId: growthDeskId,
					step: 0,
					providerId,
					builtIn: "anthropic" as const,
					model: "claude-sonnet",
					outcome: "completed" as const,
					endedAt: request.startedAt,
					...request,
				})),
			),
		);

	const priced = (usd: number) => ({ costUsd: usd, costSource: "models.dev@test" });

	it("adds up a month by bot and model, with the system bots apart", async () => {
		await recorded(
			{ startedAt: new Date("2026-09-03T01:00:00Z"), ...priced(1.5) },
			{ startedAt: new Date("2026-09-03T02:00:00Z"), ...priced(0.75) },
			{ startedAt: new Date("2026-09-10T02:00:00Z"), botId: accountManagerId, ...priced(2) },
			{
				startedAt: new Date("2026-09-10T03:00:00Z"),
				purpose: "compaction",
				botId: null,
				...priced(0.25),
			},
			// Answered, but its cost can't be known.
			{ startedAt: new Date("2026-09-11T00:00:00Z") },
			// Refused, so nothing was charged.
			{ startedAt: new Date("2026-09-11T01:00:00Z"), outcome: "failed" },
			{ startedAt: new Date("2026-10-01T01:00:00Z"), ...priced(9) },
		);

		const usage = await usageAs(adminId).month({ workspace: workspaceId, month: "2026-09" });

		expect(usage).toMatchObject({ usd: 4.5, unknownCostRequests: 1 });
		expect(usage.bots).toEqual([
			{
				botId: growthDeskId,
				name: "Growth Desk",
				color: "green",
				eyes: "pill",
				shape: "circle",
				usd: 2.25,
				unknownCostRequests: 1,
			},
			{
				botId: accountManagerId,
				name: "Account Manager",
				color: "sky",
				eyes: "dot",
				shape: "circle",
				usd: 2,
				unknownCostRequests: 0,
			},
		]);
		// The bots' requests and Compaction's to the same model are one line.
		expect(usage.models).toEqual([
			expect.objectContaining({
				model: "claude-sonnet",
				providerName: "Anthropic",
				usd: 4.5,
				unknownCostRequests: 1,
			}),
		]);
		expect(usage.systemBots).toEqual({ usd: 0.25, unknownCostRequests: 0 });
		expect(usage.days).toHaveLength(30);
		expect(usage.days.filter((day) => day.usd > 0)).toEqual([
			{ date: "2026-09-03", usd: 2.25 },
			{ date: "2026-09-10", usd: 2.25 },
		]);
	});

	it("counts people's Personal Assistants together, naming none", async () => {
		const [assistant] = await onDatabase((db) =>
			db
				.insert(bot)
				.values({
					workspaceId,
					name: "Personal Assistant",
					handle: "personal-assistant",
					color: "sky",
					eyes: "pill",
					visibility: "private",
					assistantOf: editorId,
				})
				.returning(),
		);
		if (!assistant) throw new Error("fixture");
		await recorded(
			{ startedAt: new Date("2026-09-03T01:00:00Z"), ...priced(1.5) },
			{ startedAt: new Date("2026-09-04T01:00:00Z"), botId: assistant.id, ...priced(0.5) },
		);

		const usage = await usageAs(adminId).month({ workspace: workspaceId, month: "2026-09" });

		expect(usage).toMatchObject({ usd: 2, unknownCostRequests: 0 });
		expect(usage.bots.map((bot) => bot.botId)).toEqual([growthDeskId]);
		expect(usage.personalAssistants).toEqual({ usd: 0.5, unknownCostRequests: 0 });
	});

	it("puts a request in the month and on the day of the workspace's time zone", async () => {
		// 1:30 on the first of September in Sydney, still August in UTC.
		await recorded({ startedAt: new Date("2026-08-31T15:30:00Z"), ...priced(1) });

		const inUtc = await usageAs(adminId).month({ workspace: workspaceId, month: "2026-09" });
		await onDatabase((db) =>
			db
				.update(workspace)
				.set({ timeZone: "Australia/Sydney" })
				.where(eq(workspace.id, workspaceId)),
		);
		const inSydney = await usageAs(adminId).month({ workspace: workspaceId, month: "2026-09" });

		expect(inUtc).toMatchObject({ timeZone: "UTC", usd: 0 });
		expect(inSydney).toMatchObject({ timeZone: "Australia/Sydney", usd: 1 });
		expect(inSydney.days[0]).toEqual({ date: "2026-09-01", usd: 1 });
	});

	it("counts a request cut off long ago as of unknown cost, and leaves one still going out", async () => {
		const now = Date.now();
		const cutOff = new Date(now - 20 * 60_000);
		await recorded(
			{ startedAt: cutOff, outcome: "started", endedAt: null },
			{ startedAt: new Date(now - 60_000), outcome: "started", endedAt: null },
		);

		const usage = await usageAs(adminId).month({
			workspace: workspaceId,
			month: cutOff.toISOString().slice(0, 7),
		});

		expect(usage.unknownCostRequests).toBe(1);
	});

	it("refuses somebody who may not see what the workspace's models cost", async () => {
		await expect(
			usageAs(editorId).month({ workspace: workspaceId, month: "2026-09" }),
		).rejects.toBeInstanceOf(ActionForbidden);
	});
});
