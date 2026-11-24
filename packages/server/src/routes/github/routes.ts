import { GITHUB_SETUP_RETURN_PATH, MAX_IDEMPOTENCY_KEY_CHARACTERS } from "@sugabots/contracts";
import { BadRequest, Conflict, NotFound, Unauthorized } from "@sugabots/contracts/http";
import { Automations } from "@sugabots/core/chats/automations/automations";
import { GitHubApps } from "@sugabots/core/providers/connectors/github/github-app";
import { GitHubConnectors } from "@sugabots/core/providers/connectors/github/github-connectors";
import { ServerSettings } from "@sugabots/core/server-settings/server-settings";
import { userText } from "@sugabots/errors";
import { Effect } from "effect";
import { HttpServerResponse } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { asCurrentUser } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";
import { asHttpError, refusals } from "../../http/errors.ts";
import { refuseHead, webAppReturn } from "../../http/web-app-return.ts";

const connectorErrors = {
	...refusals,
	GitHubAppNotInstalled: BadRequest,
	GitHubRequestFailed: BadRequest,
	NotGitHubConnector: NotFound,
	ProjectHasGitHubConnector: Conflict,
	RepositoryUnreachable: BadRequest,
};

export const gitHubConnectorRoutes = HttpApiBuilder.group(
	ServerApi,
	"gitHubConnectors",
	(handlers) =>
		Effect.gen(function* () {
			// GitHub's callbacks redirect on to GitHub's next page, or back to
			// `GITHUB_SETUP_RETURN_PATH` under the web app with the project's ids and,
			// when setup stopped, why; the web app turns those into its own page.
			const { webAppUrl } = yield* ServerSettings.Service;
			const gitHubApps = yield* GitHubApps.Service;
			const connectors = yield* GitHubConnectors.Service;
			const redirect = (outcome: GitHubApps.SetupOutcome) => {
				if (outcome.kind === "next") {
					return HttpServerResponse.redirect(outcome.url, { status: 302 });
				}
				const back = { webAppUrl, path: GITHUB_SETUP_RETURN_PATH, at: outcome.at };
				if (outcome.kind === "done") {
					return webAppReturn({ ...back, outcome: { connector: outcome.connectorId } });
				}
				return webAppReturn({ ...back, outcome: { github_error: outcome.failure } });
			};
			return handlers
				.handle("start", ({ params, payload }) =>
					gitHubApps
						.start({ projectId: params.projectId, organization: payload.organization })
						.pipe(asCurrentUser, asHttpError(connectorErrors)),
				)
				.handle("installUrl", ({ params }) =>
					gitHubApps.installUrl(params).pipe(
						Effect.map((url) => ({ url })),
						asCurrentUser,
						asHttpError(connectorErrors),
					),
				)
				.handle("reachableRepositories", ({ params }) =>
					connectors
						.reachableRepositories(params)
						.pipe(asCurrentUser, asHttpError(connectorErrors)),
				)
				.handle("repositories", ({ params }) =>
					connectors.repositories(params).pipe(asCurrentUser, asHttpError(connectorErrors)),
				)
				.handle("addRepository", ({ params, payload }) =>
					connectors
						.addRepository({ ...params, repository: payload.repository })
						.pipe(asCurrentUser, asHttpError(connectorErrors)),
				)
				.handle("removeRepository", ({ params, payload }) =>
					connectors
						.removeRepository({ ...params, repository: payload.repository })
						.pipe(asCurrentUser, asHttpError(connectorErrors)),
				)
				.handleRaw("gitHubAppMade", ({ request, query }) =>
					request.method === "HEAD"
						? Effect.succeed(refuseHead)
						: gitHubApps
								.made({ code: query.code, state: query.state })
								.pipe(Effect.map(redirect), asCurrentUser),
				)
				.handleRaw("gitHubAppInstalled", ({ request, query }) =>
					request.method === "HEAD"
						? Effect.succeed(refuseHead)
						: gitHubApps
								.installed({ installationId: query.installation_id, state: query.state })
								.pipe(Effect.map(redirect), asCurrentUser),
				);
		}),
);

export const gitHubWebhookRoutes = HttpApiBuilder.group(ServerApi, "gitHubWebhooks", (handlers) =>
	Effect.gen(function* () {
		const connectors = yield* GitHubConnectors.Service;
		const connectorEvents = yield* Automations.ConnectorEvents;
		// Raw, since the signature is over the body exactly as sent.
		return handlers.handleRaw("delivery", ({ params, request }) =>
			Effect.gen(function* () {
				const refused = () =>
					new Unauthorized({ message: userText`That delivery isn't signed by its app` });
				const body = yield* Effect.mapError(request.text, refused);
				// Deliberately without a session: the signature is what admits it.
				const delivered = yield* connectors
					.receiveDelivery({ connectorId: params.connectorId, headers: request.headers, body })
					.pipe(Effect.mapError(refused));
				if (!delivered.activity) return HttpServerResponse.empty({ status: 204 });
				const { deliveryId } = delivered;
				if (!deliveryId || deliveryId.length > MAX_IDEMPOTENCY_KEY_CHARACTERS) {
					return yield* new BadRequest({ message: userText`The delivery has no usable id` });
				}
				yield* connectorEvents.accept({
					workspaceId: delivered.workspaceId,
					connectorId: delivered.connectorId,
					deliveryId,
					activity: delivered.activity,
				});
				return HttpServerResponse.empty({ status: 204 });
			}),
		);
	}),
);
