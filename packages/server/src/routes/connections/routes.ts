import { CONNECTION_SIGN_IN_RETURN_PATH } from "@sugabots/contracts";
import { BadRequest, Conflict, CurrentUser, NotFound } from "@sugabots/contracts/http";
import { ConnectionSetup } from "@sugabots/core/providers/connections/connection-setup";
import { Effect } from "effect";
import { HttpServerResponse } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { ServerApi } from "../../http/api.ts";
import { grantedPod } from "../../http/authorisation.ts";
import { asHttpError } from "../../http/errors.ts";

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
			const inPod = (pod: { workspaceId: string; id: string }) => ({
				workspaceId: pod.workspaceId,
				podId: pod.id,
			});

			return handlers
				.handle("list", () => Effect.flatMap(grantedPod, ({ pod }) => connections.list(inPod(pod))))
				.handle("create", ({ payload }) =>
					Effect.flatMap(grantedPod, ({ pod, actor }) =>
						connections
							.create({ ...inPod(pod), createdById: actor.userId, connection: payload })
							.pipe(asHttpError(connectionErrors)),
					),
				)
				.handle("get", ({ params }) =>
					Effect.flatMap(grantedPod, ({ pod }) =>
						connections
							.get({ ...inPod(pod), connectionId: params.connectionId })
							.pipe(asHttpError(connectionErrors)),
					),
				)
				.handle("update", ({ params, payload }) =>
					Effect.flatMap(grantedPod, ({ pod }) =>
						connections
							.update({ ...inPod(pod), connectionId: params.connectionId, changes: payload })
							.pipe(asHttpError(connectionErrors)),
					),
				)
				.handle("remove", ({ params }) =>
					Effect.flatMap(grantedPod, ({ pod }) =>
						connections
							.remove({ ...inPod(pod), connectionId: params.connectionId })
							.pipe(asHttpError(connectionErrors)),
					),
				)
				.handle("test", ({ params }) =>
					Effect.flatMap(grantedPod, ({ pod }) =>
						connections
							.test({ ...inPod(pod), connectionId: params.connectionId })
							.pipe(asHttpError(connectionErrors)),
					),
				)
				.handle("connectFromCatalog", ({ payload }) =>
					Effect.flatMap(grantedPod, ({ pod, actor }) =>
						connections
							.connectFromCatalog({ ...inPod(pod), createdById: actor.userId, server: payload })
							.pipe(asHttpError(connectionErrors)),
					),
				)
				.handle("startOAuth", ({ params }) =>
					Effect.flatMap(grantedPod, ({ pod }) =>
						connections
							.startOAuth({ ...inPod(pod), connectionId: params.connectionId })
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
						const outcome = yield* connections
							.completeOAuth({
								userId,
								callback: {
									code: query.code,
									state: query.state,
									error: query.error,
									errorDescription: query.error_description,
								},
							})
							.pipe(asHttpError(connectionErrors));
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
	ConnectionNameTaken: Conflict,
	ConnectionNotFound: NotFound,
	UrlNotAllowed: BadRequest,
	ConnectionOAuthStartFailed: BadRequest,
	ConnectionDoesNotUseOAuth: BadRequest,
	ConnectionNeededNoSignIn: BadRequest,
};
