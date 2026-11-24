import {
	GITHUB_SETUP_RETURN_PATH,
	type GitHubSetupOutcome,
	MAX_IDEMPOTENCY_KEY_CHARACTERS,
} from "@sugabots/contracts";
import { BadRequest, Conflict, NotFound, Unauthorized } from "@sugabots/contracts/http";
import { WebhookAuthentication } from "@sugabots/core/authentication/webhook";
import { Automations } from "@sugabots/core/chats/automations/automations";
import { Ids } from "@sugabots/core/ids/ids";
import { Operations } from "@sugabots/core/operations/registry";
import { ServerSettings } from "@sugabots/core/server-settings/server-settings";
import { userText } from "@sugabots/errors";
import { Effect } from "effect";
import { HttpServerResponse } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { operationCaller } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";
import { asHttpError, refusals } from "../../http/errors.ts";
import { refuseHead, webAppReturn } from "../../http/web-app-return.ts";

/** What each way a GitHub connectors operation can fail means over HTTP. */
const connectorErrors = {
	...refusals,
	GitHubAppNotInstalled: BadRequest,
	GitHubRequestFailed: BadRequest,
	NotGitHubConnector: NotFound,
	ProjectHasGitHubConnector: Conflict,
	RepositoryUnreachable: BadRequest,
};

/** A project's GitHub app, a bot's being its default project's, each endpoint its operation. */
export const gitHubConnectorRoutes = HttpApiBuilder.group(
	ServerApi,
	"gitHubConnectors",
	(handlers) =>
		Effect.gen(function* () {
			// GitHub's callbacks redirect on to GitHub's next page, or back to
			// `GITHUB_SETUP_RETURN_PATH` under the web app with the project's ids and,
			// when setup stopped, why; the web app turns those into its own page.
			const { webAppUrl } = yield* ServerSettings.Service;
			const callOperation = yield* operationCaller;
			const redirect = (outcome: GitHubSetupOutcome) => {
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
					callOperation("gitHubConnectors.start", { ...params, ...payload }).pipe(
						asHttpError(connectorErrors),
					),
				)
				.handle("installUrl", ({ params }) =>
					callOperation("gitHubConnectors.installUrl", params).pipe(asHttpError(connectorErrors)),
				)
				.handle("reachableRepositories", ({ params }) =>
					callOperation("gitHubConnectors.reachableRepositories", params).pipe(
						asHttpError(connectorErrors),
					),
				)
				.handle("repositories", ({ params }) =>
					callOperation("gitHubConnectors.repositories", params).pipe(asHttpError(connectorErrors)),
				)
				.handle("addRepository", ({ params, payload }) =>
					callOperation("gitHubConnectors.addRepository", { ...params, ...payload }).pipe(
						asHttpError(connectorErrors),
					),
				)
				.handle("removeRepository", ({ params, payload }) =>
					callOperation("gitHubConnectors.removeRepository", { ...params, ...payload }).pipe(
						asHttpError(connectorErrors),
					),
				)
				.handleRaw("gitHubAppMade", ({ request, query }) =>
					request.method === "HEAD"
						? Effect.succeed(refuseHead)
						: callOperation("gitHubConnectors.gitHubAppMade", {
								code: query.code,
								state: query.state,
							}).pipe(Effect.map(redirect)),
				)
				.handleRaw("gitHubAppInstalled", ({ request, query }) =>
					request.method === "HEAD"
						? Effect.succeed(refuseHead)
						: callOperation("gitHubConnectors.gitHubAppInstalled", {
								installationId: query.installation_id,
								state: query.state,
							}).pipe(Effect.map(redirect)),
				);
		}),
);

/**
 * The webhooks entrypoint for GitHub apps' deliveries: core's webhook
 * authenticator admits a delivery by its signature under the app's webhook
 * secret, over the body exactly as sent, and its principal reads the
 * delivery through its operation. What it says happened runs the
 * connector's automations.
 */
export const gitHubWebhookRoutes = HttpApiBuilder.group(ServerApi, "gitHubWebhooks", (handlers) =>
	Effect.gen(function* () {
		const webhooks = yield* WebhookAuthentication.Service;
		const operations = yield* Operations.Service;
		const ids = yield* Ids.Service;
		const connectorEvents = yield* Automations.ConnectorEvents;
		// Raw, since the signature is over the body exactly as sent.
		return handlers.handleRaw("delivery", ({ params, request }) =>
			Effect.gen(function* () {
				// Answered alike, so a connector's address can't be probed for.
				const refused = () =>
					new Unauthorized({ message: userText`That delivery isn't signed by its app` });
				const body = yield* Effect.mapError(request.text, refused);
				const { headers } = request;
				const principal = yield* webhooks
					.github(params.connectorId, { headers, body })
					.pipe(Effect.mapError(refused));
				const call = { kind: "request", request: yield* ids.next } as const;
				const delivered = yield* operations["gitHubWebhooks.delivery"](
					principal,
					{
						connectorId: params.connectorId,
						event: headers["x-github-event"],
						deliveryId: headers["x-github-delivery"],
						body,
					},
					call,
				).pipe(Effect.mapError(refused));
				if (!delivered.activity) return HttpServerResponse.empty({ status: 204 });
				const { deliveryId } = delivered;
				if (!deliveryId || deliveryId.length > MAX_IDEMPOTENCY_KEY_CHARACTERS) {
					return yield* new BadRequest({ message: userText`The delivery has no usable id` });
				}
				yield* connectorEvents.accept({
					workspaceId: delivered.workspaceId,
					connectorId: params.connectorId,
					deliveryId,
					activity: delivered.activity,
				});
				return HttpServerResponse.empty({ status: 204 });
			}),
		);
	}),
);
