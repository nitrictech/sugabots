import { ReferralsOff } from "@sugabots/contracts/errors/workspace";
import { Operations } from "@sugabots/core/operations/registry";
import { unimplemented } from "@sugabots/core/testing";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import type { MemberResolver } from "../../http/app.test-support.ts";
import { createTestApp, identifiedBy, signedInWith } from "../../http/app.test-support.ts";

/** The referral routes, over doubles of their operations. */

const resolveMember: MemberResolver = async () => ({
	id: "0199a3a0-0000-7000-8000-000000000002",
	name: "Ada",
	email: "ada@example.com",
	image: null,
});

/** The app with `operations` as the only operations it has. */
const app = (operations: Partial<Operations.Interface>) =>
	createTestApp(
		Layer.merge(identifiedBy(resolveMember), unimplemented(Operations.Service, operations)),
	);

describe("a member's referral link", () => {
	it("answers a server that doesn't sign members up by referral as not found", async () => {
		const response = await app({
			"referrals.resetLink": () => Effect.fail(new ReferralsOff()),
		}).request("/referral-link/reset", { method: "POST", headers: signedInWith("token") });

		expect(response.status).toBe(404);
	});

	it("reads none where sign-up isn't by referral", async () => {
		const response = await app({
			"referrals.link": () => Effect.succeed({ url: null }),
		}).request("/referral-link", { headers: signedInWith("token") });

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ url: null });
	});
});
