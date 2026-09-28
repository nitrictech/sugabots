import { ActionForbidden } from "@sugabots/core/authorization/access";
import { CurrentActor } from "@sugabots/core/authorization/current-actor";
import { ToolApprovals } from "@sugabots/core/conversations/turns/approvals/tool-approvals";
import { unimplemented } from "@sugabots/core/testing";
import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { UserResolver } from "../../http/app.test-support.ts";
import { createTestApp, identifiedBy } from "../../http/app.test-support.ts";

/**
 * The approval route, over a double of `ToolApprovals`, which decides who may
 * make which decision; `tools/calls/repository.test.ts` tests that.
 */

const MEMBER_ID = "0199a3a0-0000-7000-8000-000000000003";
const POD_ID = "0199a3a0-0000-7000-8000-000000000004";
const CALL_ID = "0199a3a0-0000-7000-8000-000000000005";

const resolveUser: UserResolver = async () => ({
	id: MEMBER_ID,
	name: "Sam",
	email: "sam@example.com",
	image: null,
});

function app(decide: ToolApprovals.Interface["decide"]) {
	return createTestApp(
		Layer.merge(identifiedBy(resolveUser), unimplemented(ToolApprovals.Service, { decide })),
	);
}

const approve = (routes: ReturnType<typeof app>, decision: string) =>
	routes.request(`/pods/${POD_ID}/tool-calls/${CALL_ID}/approval`, {
		method: "POST",
		headers: { authorization: "Bearer member", "content-type": "application/json" },
		body: JSON.stringify({ decision }),
	});

describe("tool approval routes", () => {
	it("decides the call in the path as the person asking", async () => {
		let decidedAs: string | undefined;
		const decide = vi.fn<ToolApprovals.Interface["decide"]>(() =>
			Effect.map(CurrentActor.Service, ({ userId }) => {
				decidedAs = userId;
			}),
		);

		const response = await approve(app(decide), "allow_once");

		expect(response.status).toBe(202);
		expect(decide).toHaveBeenCalledWith({
			podId: POD_ID,
			toolCallId: CALL_ID,
			decision: "allow_once",
		});
		expect(decidedAs).toBe(MEMBER_ID);
	});

	it("answers a decision the caller may not make as forbidden", async () => {
		const response = await approve(
			app(() => Effect.fail(new ActionForbidden({ permission: "approval.decide" }))),
			"deny",
		);

		expect(response.status).toBe(403);
	});

	it("has no standing approval to give: every call that changes things is decided on its own", async () => {
		const decide = vi.fn<ToolApprovals.Interface["decide"]>(() => Effect.void);

		const response = await approve(app(decide), "always_allow");

		expect(response.status).toBe(400);
		expect(decide).not.toHaveBeenCalled();
	});
});
