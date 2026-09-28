import { CONNECTION_SIGN_IN_RETURN_PATH } from "@sugabots/contracts";
import { BadRequest, Conflict, NotFound } from "@sugabots/contracts/http";
import { ConnectionSetup } from "@sugabots/core/providers/connections/connection-setup";
import { Effect } from "effect";
import { HttpServerResponse } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { asSessionUser } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";
import { asHttpError, refusals } from "../../http/errors.ts";

export interface ConnectionRoutesOptions {
	/**
	 * Where the web app is served. A sign-in's callback redirects to
	 * `CONNECTION_SIGN_IN_RETURN_PATH` under it with the pod's ids and, when it
	 * did not finish, the code saying why, and the web app turns those into
	 * its own page and words.
	 */
	webAppUrl: string;
}

export function connectionRoutes({ webAppUrl }: ConnectionRoutesOptions) {
	return HttpApiBuilder.group(ServerApi, "connections", (handlers) =>
		Effect.gen(function* () {
			const connections = yield* ConnectionSetup.Service;
			return handlers
				.handle("list", ({ params }) =>
					connections.list(params).pipe(asSessionUser, asHttpError(connectionErrors)),
				)
				.handle("create", ({ params, payload }) =>
					connections
						.create({ ...params, connection: payload })
						.pipe(asSessionUser, asHttpError(connectionErrors)),
				)
				.handle("get", ({ params }) =>
					connections.get(params).pipe(asSessionUser, asHttpError(connectionErrors)),
				)
				.handle("update", ({ params, payload }) =>
					connections
						.update({ ...params, changes: payload })
						.pipe(asSessionUser, asHttpError(connectionErrors)),
				)
				.handle("remove", ({ params }) =>
					connections.remove(params).pipe(asSessionUser, asHttpError(connectionErrors)),
				)
				.handle("test", ({ params }) =>
					connections.test(params).pipe(asSessionUser, asHttpError(connectionErrors)),
				)
				.handle("connectFromCatalog", ({ params, payload }) =>
					connections
						.connectFromCatalog({ ...params, server: payload })
						.pipe(asSessionUser, asHttpError(connectionErrors)),
				)
				.handle("startOAuth", ({ params }) =>
					connections.startOAuth(params).pipe(asSessionUser, asHttpError(connectionErrors)),
				)
				.handle("oauthCallback", ({ request, query }) =>
					Effect.gen(function* () {
						// A HEAD must not spend the one-time code a GET would.
						if (request.method === "HEAD") {
							return HttpServerResponse.empty({ status: 405, headers: { allow: "GET" } });
						}
						const outcome = yield* connections
							.completeOAuth({
								callback: {
									code: query.code,
									state: query.state,
									error: query.error,
									errorDescription: query.error_description,
								},
							})
							.pipe(asSessionUser, asHttpError(connectionErrors));
						const back = new URL(webAppUrl);
						back.pathname = `${back.pathname.replace(/\/$/, "")}${CONNECTION_SIGN_IN_RETURN_PATH}`;
						if (outcome.pod) {
							back.searchParams.set("workspace", outcome.pod.workspaceId);
							back.searchParams.set("pod", outcome.pod.podId);
						}
						if ("failure" in outcome) {
							back.searchParams.set("oauth_error", outcome.failure);
						}
						return HttpServerResponse.redirect(back.toString(), { status: 302 });
					}),
				);
		}),
	);
}

const connectionErrors = {
	...refusals,
	ConnectionNameTaken: Conflict,
	ConnectionNotFound: NotFound,
	UrlNotAllowed: BadRequest,
	ConnectionOAuthStartFailed: BadRequest,
	ConnectionDoesNotUseOAuth: BadRequest,
	ConnectionNeededNoSignIn: BadRequest,
};
