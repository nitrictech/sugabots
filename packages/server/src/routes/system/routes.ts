import { CurrentUser } from "@sugabots/contracts/http";
import { Membership } from "@sugabots/core/workspaces/membership/membership";
import { Onboarding } from "@sugabots/core/workspaces/onboarding/onboarding";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { asSessionUser } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";
import { asHttpError, refusals } from "../../http/errors.ts";
import { health } from "../../version.ts";

export const systemRoutes = HttpApiBuilder.group(ServerApi, "system", (handlers) =>
	Effect.gen(function* () {
		const membership = yield* Membership.Service;
		const onboarding = yield* Onboarding.Service;
		return handlers
			.handle("health", () => Effect.sync(health))
			.handle("me", () =>
				Effect.all(
					{
						user: Effect.service(CurrentUser),
						onboarding: onboarding.isCompleted.pipe(Effect.map((completed) => ({ completed }))),
						workspaces: membership.workspaces,
					},
					{ concurrency: "unbounded" },
				).pipe(asSessionUser),
			)
			.handle("workspaceAccess", ({ params }) =>
				membership
					.access({ workspace: params.workspace })
					.pipe(asSessionUser, asHttpError(refusals)),
			);
	}),
);
