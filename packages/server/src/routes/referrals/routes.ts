import { NotFound } from "@sugabots/contracts/http";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { operationCaller } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";
import { asHttpError, memberOnly } from "../../http/errors.ts";

/** The referral link of the member signed in, and replacing it. */
export const referralRoutes = HttpApiBuilder.group(ServerApi, "referrals", (handlers) =>
	Effect.map(operationCaller, (callOperation) =>
		handlers
			.handle("link", () => callOperation("referrals.link", {}).pipe(memberOnly))
			.handle("resetLink", () =>
				callOperation("referrals.resetLink", {}).pipe(
					memberOnly,
					asHttpError({ ReferralsOff: NotFound }),
				),
			),
	),
);
