import { CurrentUserOfRequest } from "@sugabots/contracts/http";
import { COMMIT, VERSION } from "@sugabots/core/version";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { operationCaller } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";
import { asHttpError, memberOnly, refusals } from "../../http/errors.ts";

/**
 * Liveness, which needs nobody signed in and so is no operation, and who the
 * caller is: the member better-auth found, and the workspaces they are in.
 */
export const systemRoutes = HttpApiBuilder.group(ServerApi, "system", (handlers) =>
	Effect.map(operationCaller, (callOperation) =>
		handlers
			.handle("health", () =>
				Effect.succeed({ status: "ok" as const, version: VERSION, commit: COMMIT }),
			)
			.handle("me", () =>
				Effect.all(
					{
						member: Effect.service(CurrentUserOfRequest),
						workspaces: callOperation("workspaces.list", {}).pipe(memberOnly),
					},
					{ concurrency: "unbounded" },
				),
			)
			.handle("workspaceAccess", ({ params }) =>
				callOperation("system.workspaceAccess", { workspace: params.workspace }).pipe(
					asHttpError(refusals),
				),
			),
	),
);
