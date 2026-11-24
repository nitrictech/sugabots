import { ActionForbidden } from "@sugabots/core/authorization/access";
import { CurrentActor } from "@sugabots/core/authorization/current-actor";
import { Turns } from "@sugabots/core/chats/turns/turns";
import { unimplemented } from "@sugabots/core/testing";
import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { MemberResolver } from "../../http/app.test-support.ts";
import { createTestApp, identifiedBy, signedInWith } from "../../http/app.test-support.ts";

/**
 * The approval route, over a double of `Turns.Controls`, which decides who may
 * make which decision; `turns/tool-calls/store.test.ts` tests that.
 */

const MEMBER_ID = "0199a3a0-0000-7000-8000-000000000003";
const CALL_ID = "0199a3a0-0000-7000-8000-000000000005";

const resolveMember: MemberResolver = async () => ({
	id: MEMBER_ID,
	name: "Sam",
	email: "sam@example.com",
	image: null,
});

function app(decide: Turns.ControlsInterface["decide"]) {
	return createTestApp(
		Layer.merge(identifiedBy(resolveMember), unimplemented(Turns.Controls, { decide })),
	);
}

const approve = (routes: ReturnType<typeof app>, decision: string) =>
	routes.request(`/tool-calls/${CALL_ID}/approval`, {
		method: "POST",
		headers: { ...signedInWith("sam"), "content-type": "application/json" },
		body: JSON.stringify({ decision }),
	});

describe("tool approval routes", () => {
	it("decides the call in the path as the member asking", async () => {
		let decidedAs: string | undefined;
		const decide = vi.fn<Turns.ControlsInterface["decide"]>(() =>
			Effect.map(CurrentActor.Service, ({ memberId }) => {
				decidedAs = memberId;
			}),
		);

		const response = await approve(app(decide), "allow_once");

		expect(response.status).toBe(202);
		expect(decide).toHaveBeenCalledWith({
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
});
