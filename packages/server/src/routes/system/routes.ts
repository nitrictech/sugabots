import { CurrentUserOfRequest } from "@sugabots/contracts/http";
import { COMMIT, VERSION } from "@sugabots/core/version";
import { Effect } from "effect";
import { HttpEffect, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { Authentication } from "../../auth/authentication.ts";
import { operationCaller } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";
import { asHttpError, memberOnly, refusals } from "../../http/errors.ts";

/**
 * Liveness, which needs nobody signed in and so is no operation, and who the
 * caller is: the member better-auth found, and the workspaces they are in.
 */
export const systemRoutes = HttpApiBuilder.group(ServerApi, "system", (handlers) =>
	Effect.gen(function* () {
		const callOperation = yield* operationCaller;
		const authentication = yield* Authentication.Service;
		return handlers
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
			.handle("rename", ({ payload }) =>
				Effect.gen(function* () {
					const renamed = yield* callOperation("system.rename", payload).pipe(memberOnly);
					// The session's cookie cache holds the old name; renewed, `/me` answers with the new one.
					const request = yield* HttpServerRequest.HttpServerRequest;
					const refreshed = yield* authentication.refreshedCookies(new Headers(request.headers));
					yield* HttpEffect.appendPreResponseHandler((_request, response) =>
						Effect.succeed(HttpServerResponse.mergeCookies(response, refreshed)),
					);
					return renamed;
				}),
			)
			.handle("workspaceAccess", ({ params }) =>
				callOperation("system.workspaceAccess", { workspace: params.workspace }).pipe(
					asHttpError(refusals),
				),
			);
	}),
);
