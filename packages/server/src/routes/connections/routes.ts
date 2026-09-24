import { CONNECTION_SIGN_IN_RETURN_PATH } from "@sugabots/contracts";
import { BadRequest, Conflict, CurrentUser, NotFound } from "@sugabots/contracts/http";
import type { Database } from "@sugabots/core/database/database";
import type { listServerTools } from "@sugabots/core/providers/connections/mcp";
import {
	beginAuthorization,
	finishAuthorization,
	type OAuthProviders,
	oauthProviders,
} from "@sugabots/core/providers/connections/oauth";
import { connectionOperations } from "@sugabots/core/providers/connections/operations";
import type { ConnectionStore } from "@sugabots/core/providers/connections/store";
import type {
	EgressHttpClient,
	EgressHttpClients,
	EgressUrlValidator,
} from "@sugabots/core/providers/network/egress";
import type { Authorization } from "@sugabots/core/workspaces/access";
import { Effect } from "effect";
import { HttpServerResponse } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { ServerApi } from "../../http/api.ts";
import { grantedPod } from "../../http/authorisation.ts";
import { asHttpError } from "../../http/errors.ts";

export interface ConnectionRoutesOptions {
	connections: ConnectionStore;
	/** Asked again when a sign-in comes back, since authority can lapse while the caller is away. */
	authorization: Authorization;
	httpClients: EgressHttpClients;
	validateProviderUrl: EgressUrlValidator;
	listTools?: typeof listServerTools;
	oauth: {
		redirectUrl: string;
		fetch: EgressHttpClient;
		/**
		 * Where the web app is served. A finished sign-in redirects to
		 * `CONNECTION_SIGN_IN_RETURN_PATH` under it with ids, and the web app
		 * turns those into its own URL, because only it knows its routes.
		 */
		webAppUrl: string;
		begin?: typeof beginAuthorization;
		finish?: typeof finishAuthorization;
		providers?: OAuthProviders;
	};
}

export function connectionRoutes({
	connections,
	authorization,
	httpClients,
	validateProviderUrl,
	listTools,
	oauth,
}: ConnectionRoutesOptions) {
	return HttpApiBuilder.group(ServerApi, "connections", (handlers) =>
		Effect.gen(function* () {
			// The OAuth library calls back with promises, so the stored providers
			// run their queries against the database the routes were built with.
			const database = yield* Effect.context<Database>();
			const providers =
				oauth.providers ??
				oauthProviders({
					connections,
					run: (effect) => Effect.runPromise(Effect.provideContext(effect, database)),
					redirectUrl: oauth.redirectUrl,
				});
			const operations = connectionOperations({
				connections,
				authorization,
				httpClients,
				validateProviderUrl,
				listTools,
				oauth: {
					providers,
					fetch: oauth.fetch,
					begin: oauth.begin ?? beginAuthorization,
					finish: oauth.finish ?? finishAuthorization,
				},
			});

			return handlers
				.handle("list", () =>
					Effect.flatMap(grantedPod, ({ pod }) => operations.list(pod.workspaceId, pod.id)),
				)
				.handle("create", ({ payload }) =>
					Effect.flatMap(grantedPod, ({ pod, actor }) =>
						operations
							.create(pod.workspaceId, pod.id, actor.userId, payload)
							.pipe(asHttpError(connectionErrors)),
					),
				)
				.handle("get", ({ params }) =>
					Effect.flatMap(grantedPod, ({ pod }) =>
						operations
							.get(pod.workspaceId, pod.id, params.connectionId)
							.pipe(asHttpError(connectionErrors)),
					),
				)
				.handle("update", ({ params, payload }) =>
					Effect.flatMap(grantedPod, ({ pod }) =>
						operations
							.update(pod.workspaceId, pod.id, params.connectionId, payload)
							.pipe(asHttpError(connectionErrors)),
					),
				)
				.handle("remove", ({ params }) =>
					Effect.flatMap(grantedPod, ({ pod }) =>
						operations
							.remove(pod.workspaceId, pod.id, params.connectionId)
							.pipe(asHttpError(connectionErrors)),
					),
				)
				.handle("test", ({ params }) =>
					Effect.flatMap(grantedPod, ({ pod }) =>
						operations
							.test(pod.workspaceId, pod.id, params.connectionId)
							.pipe(asHttpError(connectionErrors)),
					),
				)
				.handle("connectFromCatalog", ({ payload }) =>
					Effect.flatMap(grantedPod, ({ pod, actor }) =>
						operations
							.connectFromCatalog(pod.workspaceId, pod.id, actor.userId, payload)
							.pipe(asHttpError(connectionErrors)),
					),
				)
				.handle("startOAuth", ({ params }) =>
					Effect.flatMap(grantedPod, ({ pod }) =>
						operations
							.startOAuth(pod.workspaceId, pod.id, params.connectionId)
							.pipe(asHttpError(connectionErrors)),
					),
				)
				.handle("oauthCallback", ({ request, query }) =>
					Effect.gen(function* () {
						// A HEAD must not spend the one-time code a GET would.
						if (request.method === "HEAD") {
							return HttpServerResponse.empty({ status: 405, headers: { allow: "GET" } });
						}
						const { id: userId } = yield* CurrentUser;
						const outcome = yield* operations
							.completeOAuth(userId, {
								code: query.code,
								state: query.state,
								error: query.error,
								errorDescription: query.error_description,
							})
							.pipe(asHttpError(connectionErrors));
						const back = new URL(oauth.webAppUrl);
						back.pathname = `${back.pathname.replace(/\/$/, "")}${CONNECTION_SIGN_IN_RETURN_PATH}`;
						if (outcome.pod) {
							back.searchParams.set("workspace", outcome.pod.workspaceId);
							back.searchParams.set("pod", outcome.pod.podId);
						}
						if ("failed" in outcome) {
							back.searchParams.set("oauth_error", outcome.failed);
						}
						return HttpServerResponse.redirect(back.toString(), { status: 302 });
					}),
				);
		}),
	);
}

const connectionErrors = {
	ConnectionNameTaken: (failure: { message: string }) => new Conflict({ message: failure.message }),
	ConnectionNotFound: (failure: { message: string }) => new NotFound({ message: failure.message }),
	ConnectionUrlNotAllowed: (failure: { message: string }) =>
		new BadRequest({ message: failure.message }),
	ConnectionOAuthStartFailed: (failure: { message: string }) =>
		new BadRequest({ message: failure.message }),
	ConnectionDoesNotUseOAuth: (failure: { message: string }) =>
		new BadRequest({ message: failure.message }),
	ConnectionNeededNoSignIn: (failure: { message: string }) =>
		new BadRequest({ message: failure.message }),
};
