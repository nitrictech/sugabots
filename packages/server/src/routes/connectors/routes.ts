import { CONNECTOR_SIGN_IN_RETURN_PATH } from "@sugabots/contracts";
import { BadRequest, Conflict, NotFound } from "@sugabots/contracts/http";
import { ServerSettings } from "@sugabots/core/server-settings/server-settings";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { operationCaller } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";
import { asHttpError, refusals } from "../../http/errors.ts";
import { refuseHead, webAppReturn } from "../../http/web-app-return.ts";

/** A project's connectors, a bot's being its default project's, each endpoint its operation. */
export const connectorRoutes = HttpApiBuilder.group(ServerApi, "connectors", (handlers) =>
	Effect.gen(function* () {
		// A sign-in's callback redirects to `CONNECTOR_SIGN_IN_RETURN_PATH`
		// under the web app with the project's ids and, when it did not finish, the
		// code saying why, and the web app turns those into its own page and words.
		const { webAppUrl } = yield* ServerSettings.Service;
		const callOperation = yield* operationCaller;
		return handlers
			.handle("list", ({ params }) =>
				callOperation("connectors.list", params).pipe(asHttpError(connectorErrors)),
			)
			.handle("create", ({ params, payload }) =>
				callOperation("connectors.create", { ...params, connector: payload }).pipe(
					asHttpError(connectorErrors),
				),
			)
			.handle("get", ({ params }) =>
				callOperation("connectors.get", params).pipe(asHttpError(connectorErrors)),
			)
			.handle("update", ({ params, payload }) =>
				callOperation("connectors.update", { ...params, changes: payload }).pipe(
					asHttpError(connectorErrors),
				),
			)
			.handle("remove", ({ params }) =>
				callOperation("connectors.remove", params).pipe(asHttpError(connectorErrors)),
			)
			.handle("testUnsaved", ({ params, payload }) =>
				callOperation("connectors.testUnsaved", { ...params, ...payload }).pipe(
					asHttpError(connectorErrors),
				),
			)
			.handle("test", ({ params }) =>
				callOperation("connectors.test", params).pipe(asHttpError(connectorErrors)),
			)
			.handle("connectBuiltIn", ({ params, payload }) =>
				callOperation("connectors.connectBuiltIn", { ...params, ...payload }).pipe(
					asHttpError(connectorErrors),
				),
			)
			.handle("startOAuth", ({ params }) =>
				callOperation("connectors.startOAuth", params).pipe(asHttpError(connectorErrors)),
			)
			.handle("oauthCallback", ({ request, query }) =>
				Effect.gen(function* () {
					if (request.method === "HEAD") {
						return refuseHead;
					}
					const outcome = yield* callOperation("connectors.oauthCallback", {
						code: query.code,
						state: query.state,
						error: query.error,
						errorDescription: query.error_description,
					}).pipe(asHttpError(connectorErrors));
					return webAppReturn({
						webAppUrl,
						path: CONNECTOR_SIGN_IN_RETURN_PATH,
						at: outcome.at,
						outcome: outcome.kind === "failed" ? { oauth_error: outcome.failure } : {},
					});
				}),
			);
	}),
);

/** What each way a connectors operation can fail means over HTTP. */
const connectorErrors = {
	...refusals,
	ConnectorNameTaken: Conflict,
	UnknownConnectorTool: BadRequest,
	ConnectorNotFound: NotFound,
	UrlNotAllowed: BadRequest,
	ConnectorOAuthStartFailed: BadRequest,
	ConnectorDoesNotUseOAuth: BadRequest,
	ConnectorNeededNoSignIn: BadRequest,
};
