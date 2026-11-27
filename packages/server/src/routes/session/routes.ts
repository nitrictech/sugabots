import { CurrentUserOfRequest } from "@sugabots/contracts/http";
import { COMMIT, VERSION } from "@sugabots/core/version";
import { Effect } from "effect";
import { HttpEffect, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { Authentication } from "../../auth/authentication.ts";
import { operationCaller } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";
import { memberOnly } from "../../http/errors.ts";

/**
 * Liveness, which needs nobody signed in and so is no operation, and the
 * member the session is for: who they are, read from the session's row, and
 * renaming them, which renews the session's cookie. `SessionApi` says why
 * each is written by hand.
 */
export const sessionRoutes = HttpApiBuilder.group(ServerApi, "session", (handlers) =>
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
			);
	}),
);
