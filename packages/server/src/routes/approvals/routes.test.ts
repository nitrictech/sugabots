import { ActionForbidden } from "@sugabots/contracts/errors/proofs";
import { Operations } from "@sugabots/core/operations/registry";
import type { Principal } from "@sugabots/core/principal";
import { unimplemented } from "@sugabots/core/testing";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import type { MemberResolver } from "../../http/app.test-support.ts";
import { createTestApp, identifiedBy, signedInWith } from "../../http/app.test-support.ts";

/**
 * The approval route, over a double of `approvals.decide`, which decides who
 * may make which decision; `turns/tool-calls/store.test.ts` tests that.
 */

const MEMBER_ID = "0199a3a0-0000-7000-8000-000000000003";
const CALL_ID = "0199a3a0-0000-7000-8000-000000000005";

const resolveMember: MemberResolver = async () => ({
	id: MEMBER_ID,
	name: "Sam",
	email: "sam@example.com",
	image: null,
});

function app(decide: Operations.Interface["approvals.decide"]) {
	return createTestApp(
		Layer.merge(
			identifiedBy(resolveMember),
			unimplemented(Operations.Service, { "approvals.decide": decide }),
		),
	);
}

const approve = (routes: ReturnType<typeof app>, decision: string) =>
	routes.request(`/tool-calls/${CALL_ID}/approval`, {
		method: "POST",
		headers: { ...signedInWith("sam"), "content-type": "application/json" },
		body: JSON.stringify({ decision }),
	});

/** The member a principal is signed in as, as the session authenticator built it. */
const memberOf = (principal: Principal) =>
	principal._tag === "MemberSession" ? principal.member : undefined;

describe("tool approval routes", () => {
	it("decides the call in the path as the member asking", async () => {
		let asked: unknown;

		const response = await approve(
			app((principal, input) =>
				Effect.sync(() => {
					asked = { ...input, memberId: memberOf(principal) };
				}),
			),
			"allow_once",
		);

		expect(response.status).toBe(202);
		expect(asked).toEqual({ toolCallId: CALL_ID, decision: "allow_once", memberId: MEMBER_ID });
	});

	it("answers a decision the caller may not make as forbidden", async () => {
		const response = await approve(
			app(() => Effect.fail(new ActionForbidden({ proof: "CanDecide" }))),
			"deny",
		);

		expect(response.status).toBe(403);
	});
});
