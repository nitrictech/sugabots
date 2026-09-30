import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { referralLinkSchema, resetReferralLinkSchema } from "../../referrals.ts";
import { NotFound } from "../errors.ts";
import { Session } from "../middleware.ts";

/** The link the signed-in person can send somebody to let them sign up, and replacing it. */
export class ReferralsApi extends HttpApiGroup.make("referrals")
	.add(
		HttpApiEndpoint.get("link", "/referral-link", { success: referralLinkSchema }),
		HttpApiEndpoint.post("resetLink", "/referral-link/reset", {
			success: resetReferralLinkSchema,
			error: NotFound,
		}),
	)
	.middleware(Session) {}
