import { NotFound } from "@sugabots/contracts/http";
import { Accounts } from "@sugabots/core/accounts/accounts";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { asCurrentUser } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";
import { asHttpError } from "../../http/errors.ts";

/** The current user's referral link, and replacing it. */
export const referralRoutes = HttpApiBuilder.group(ServerApi, "referrals", (handlers) =>
	Effect.gen(function* () {
		const accounts = yield* Accounts.Service;
		return handlers
			.handle("link", () =>
				accounts.referralLink.pipe(
					Effect.map((url) => ({ url: url ?? null })),
					asCurrentUser,
				),
			)
			.handle("resetLink", () =>
				accounts.resetReferralLink.pipe(
					Effect.map((url) => ({ url })),
					asCurrentUser,
					asHttpError({ ReferralsOff: NotFound }),
				),
			);
	}),
);
