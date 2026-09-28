import type { WorkspaceUsage } from "@sugabots/contracts";
import { Usage } from "@sugabots/core/accounting/usage";
import { ActionForbidden } from "@sugabots/core/authorization/access";
import { unimplemented } from "@sugabots/core/testing";
import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { UserResolver } from "../../http/app.test-support.ts";
import { createTestApp, identifiedBy } from "../../http/app.test-support.ts";

/**
 * The usage route, over a double of `Usage`. What a month adds up to is
 * `accounting/usage.test.ts`'s.
 */

const WORKSPACE = "0199a3a0-0000-7000-8000-000000000001";

const resolveUser: UserResolver = async () => ({
	id: "0199a3a0-0000-7000-8000-000000000002",
	name: "Ada",
	email: "ada@example.com",
	image: null,
});

const usageOf = (month: Usage.Interface["month"], query: string) =>
	createTestApp(
		Layer.merge(identifiedBy(resolveUser), unimplemented(Usage.Service, { month })),
	).request(`/workspaces/${WORKSPACE}/usage?${query}`, {
		headers: { authorization: "Bearer admin-token" },
	});

const september: WorkspaceUsage = {
	month: "2026-09",
	timeZone: "Australia/Sydney",
	usd: 94.2,
	unpricedRequests: 0,
	days: [],
	bots: [],
	models: [],
	pods: [],
	systemAgents: { usd: 5.65, unpricedRequests: 0 },
};

describe("reading what the workspace's models cost", () => {
	it("reads the month it is asked for", async () => {
		const month = vi.fn<Usage.Interface["month"]>(() => Effect.succeed(september));

		const response = await usageOf(month, "month=2026-09");

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ usd: 94.2 });
		expect(month).toHaveBeenCalledWith({
			workspace: WORKSPACE,
			month: "2026-09",
		});
	});

	it("refuses a month that isn't one", async () => {
		const month = vi.fn<Usage.Interface["month"]>(() => Effect.succeed(september));

		const response = await usageOf(month, "month=2026-13");

		expect(response.status).toBe(400);
		expect(month).not.toHaveBeenCalled();
	});

	it("answers somebody who may not see the workspace's spend as forbidden", async () => {
		const response = await usageOf(
			() => Effect.fail(new ActionForbidden({ permission: "workspace.usage.manage" })),
			"month=2026-09",
		);

		expect(response.status).toBe(403);
	});
});
