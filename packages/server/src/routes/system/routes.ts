import { CurrentPerson } from "@sugabots/contracts/http";
import { COMMIT, VERSION } from "@sugabots/core/version";
import { Membership } from "@sugabots/core/workspaces/membership/membership";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { asSignedInPerson } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";
import { asHttpError, refusals } from "../../http/errors.ts";

export const systemRoutes = HttpApiBuilder.group(ServerApi, "system", (handlers) =>
	Effect.gen(function* () {
		const membership = yield* Membership.Service;
		return handlers
			.handle("health", () =>
				Effect.succeed({ status: "ok" as const, version: VERSION, commit: COMMIT }),
			)
			.handle("me", () =>
				Effect.all(
					{ person: Effect.service(CurrentPerson), workspaces: membership.workspaces },
					{ concurrency: "unbounded" },
				).pipe(asSignedInPerson),
			)
			.handle("workspaceAccess", ({ params }) =>
				membership
					.access({ workspace: params.workspace })
					.pipe(asSignedInPerson, asHttpError(refusals)),
			);
	}),
);
