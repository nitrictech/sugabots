import type { WorkspaceUsage } from "@sugabots/contracts";
import { Operations } from "@sugabots/core/operations/registry";
import { unimplemented } from "@sugabots/core/testing";
import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { MemberResolver } from "../../http/app.test-support.ts";
import { createTestApp, identifiedBy, signedInWith } from "../../http/app.test-support.ts";

/**
 * The usage route, over a double of `usage.month`. What a month adds up to is
 * `accounting/usage.test.ts`'s.
 */

const WORKSPACE = "0199a3a0-0000-7000-8000-000000000001";

const resolveMember: MemberResolver = async () => ({
	id: "0199a3a0-0000-7000-8000-000000000002",
	name: "Ada",
	email: "ada@example.com",
	image: null,
});

const usageOf = (month: Operations.Interface["usage.month"], query: string) =>
	createTestApp(
		Layer.merge(
			identifiedBy(resolveMember),
			unimplemented(Operations.Service, { "usage.month": month }),
		),
	).request(`/workspaces/${WORKSPACE}/usage?${query}`, {
		headers: signedInWith("admin-token"),
	});

const september: WorkspaceUsage = {
	month: "2026-09",
	timeZone: "Australia/Sydney",
	usd: 94.2,
	unknownCostRequests: 0,
	days: [],
	bots: [],
	models: [],
	systemBots: { usd: 5.65, unknownCostRequests: 0 },
	personalAssistants: { usd: 0, unknownCostRequests: 0 },
};

describe("reading what the workspace's models cost", () => {
	it("reads the month it is asked for", async () => {
		const month = vi.fn<Operations.Interface["usage.month"]>(() => Effect.succeed(september));

		const response = await usageOf(month, "month=2026-09");

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ usd: 94.2 });
		expect(month).toHaveBeenCalledWith(
			expect.anything(),
			{ workspace: WORKSPACE, month: "2026-09" },
			expect.anything(),
		);
	});

	it("refuses a month that isn't one", async () => {
		const month = vi.fn<Operations.Interface["usage.month"]>(() => Effect.succeed(september));

		const response = await usageOf(month, "month=2026-13");

		expect(response.status).toBe(400);
		expect(month).not.toHaveBeenCalled();
	});
});
