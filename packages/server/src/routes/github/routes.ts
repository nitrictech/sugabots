import { GITHUB_SETUP_RETURN_PATH, MAX_IDEMPOTENCY_KEY_CHARACTERS } from "@sugabots/contracts";
import { BadRequest, Conflict, NotFound, Unauthorized } from "@sugabots/contracts/http";
import { Routines } from "@sugabots/core/conversations/routines/routines";
import { Installation } from "@sugabots/core/installation/installation";
import { GitHubApps } from "@sugabots/core/providers/connections/github/github-app";
import { GitHubConnections } from "@sugabots/core/providers/connections/github/github-connections";
import { userText } from "@sugabots/errors";
import { Effect } from "effect";
import { HttpServerResponse } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { asSessionUser } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";
import { asHttpError, refusals } from "../../http/errors.ts";

const connectionErrors = {
	...refusals,
	GitHubAppNotInstalled: BadRequest,
	GitHubRequestFailed: BadRequest,
	NotGitHubConnection: NotFound,
	PodHasGitHubConnection: Conflict,
	RepositoryUnreachable: BadRequest,
};

export const gitHubConnectionRoutes = HttpApiBuilder.group(
	ServerApi,
	"gitHubConnections",
	(handlers) =>
		Effect.gen(function* () {
			// GitHub's callbacks redirect on to GitHub's next page, or back to
			// `GITHUB_SETUP_RETURN_PATH` under the web app with the pod's ids and,
			// when setup stopped, why; the web app turns those into its own page.
			const { webAppUrl } = yield* Installation.Service;
			const gitHubApps = yield* GitHubApps.Service;
			const connections = yield* GitHubConnections.Service;
			const redirect = (outcome: GitHubApps.SetupOutcome) => {
				if (outcome.kind === "next") {
					return HttpServerResponse.redirect(outcome.url, { status: 302 });
				}
				const back = new URL(webAppUrl);
				back.pathname = `${back.pathname.replace(/\/$/, "")}${GITHUB_SETUP_RETURN_PATH}`;
				if (outcome.pod) {
					back.searchParams.set("workspace", outcome.pod.workspaceId);
					back.searchParams.set("pod", outcome.pod.podId);
				}
				if (outcome.kind === "done") back.searchParams.set("connection", outcome.connectionId);
				if (outcome.kind === "failed") back.searchParams.set("github_error", outcome.failure);
				return HttpServerResponse.redirect(back.toString(), { status: 302 });
			};
			// A HEAD must not spend the one-time code a GET would.
			const headRefused = Effect.succeed(
				HttpServerResponse.empty({ status: 405, headers: { allow: "GET" } }),
			);
			return handlers
				.handle("start", ({ params, payload }) =>
					gitHubApps
						.start({ podId: params.podId, organization: payload.organization })
						.pipe(asSessionUser, asHttpError(connectionErrors)),
				)
				.handle("installUrl", ({ params }) =>
					gitHubApps.installUrl(params).pipe(
						Effect.map((url) => ({ url })),
						asSessionUser,
						asHttpError(connectionErrors),
					),
				)
				.handle("reachableRepositories", ({ params }) =>
					connections
						.reachableRepositories(params)
						.pipe(asSessionUser, asHttpError(connectionErrors)),
				)
				.handle("repositories", ({ params }) =>
					connections.repositories(params).pipe(asSessionUser, asHttpError(connectionErrors)),
				)
				.handle("addRepository", ({ params, payload }) =>
					connections
						.addRepository({ ...params, repository: payload.repository })
						.pipe(asSessionUser, asHttpError(connectionErrors)),
				)
				.handle("removeRepository", ({ params, payload }) =>
					connections
						.removeRepository({ ...params, repository: payload.repository })
						.pipe(asSessionUser, asHttpError(connectionErrors)),
				)
				.handleRaw("gitHubAppMade", ({ request, query }) =>
					request.method === "HEAD"
						? headRefused
						: gitHubApps
								.made({ code: query.code, state: query.state })
								.pipe(Effect.map(redirect), asSessionUser),
				)
				.handleRaw("gitHubAppInstalled", ({ request, query }) =>
					request.method === "HEAD"
						? headRefused
						: gitHubApps
								.installed({ installationId: query.installation_id, state: query.state })
								.pipe(Effect.map(redirect), asSessionUser),
				);
		}),
);

export const gitHubWebhookRoutes = HttpApiBuilder.group(ServerApi, "gitHubWebhooks", (handlers) =>
	Effect.gen(function* () {
		const connections = yield* GitHubConnections.Service;
		const connectionEvents = yield* Routines.ConnectionEvents;
		// Raw, since the signature is over the body exactly as sent.
		return handlers.handleRaw("delivery", ({ params, request }) =>
			Effect.gen(function* () {
				const refused = () =>
					new Unauthorized({ message: userText`That delivery isn't signed by its app` });
				const body = yield* Effect.mapError(request.text, refused);
				// Deliberately without a session: the signature is what admits it.
				const delivered = yield* connections
					.receiveDelivery({ connectionId: params.connectionId, headers: request.headers, body })
					.pipe(Effect.mapError(refused));
				if (!delivered.activity) return HttpServerResponse.empty({ status: 204 });
				const { deliveryId } = delivered;
				if (!deliveryId || deliveryId.length > MAX_IDEMPOTENCY_KEY_CHARACTERS) {
					return yield* new BadRequest({ message: userText`The delivery has no usable id` });
				}
				yield* connectionEvents.accept({
					workspaceId: delivered.workspaceId,
					connectionId: delivered.connectionId,
					deliveryId,
					activity: delivered.activity,
				});
				return HttpServerResponse.empty({ status: 204 });
			}),
		);
	}),
);
