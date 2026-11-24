import { CONNECTOR_SIGN_IN_RETURN_PATH } from "@sugabots/contracts";
import { BadRequest, Conflict, NotFound } from "@sugabots/contracts/http";
import { ConnectorSetup } from "@sugabots/core/providers/connectors/connector-setup";
import { ServerSettings } from "@sugabots/core/server-settings/server-settings";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { asCurrentUser } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";
import { asHttpError, refusals } from "../../http/errors.ts";
import { refuseHead, webAppReturn } from "../../http/web-app-return.ts";

export const connectorRoutes = HttpApiBuilder.group(ServerApi, "connectors", (handlers) =>
	Effect.gen(function* () {
		// A sign-in's callback redirects to `CONNECTOR_SIGN_IN_RETURN_PATH`
		// under the web app with the project's ids and, when it did not finish, the
		// code saying why, and the web app turns those into its own page and words.
		const { webAppUrl } = yield* ServerSettings.Service;
		const connectors = yield* ConnectorSetup.Service;
		return handlers
			.handle("list", ({ params }) =>
				connectors.list(params).pipe(asCurrentUser, asHttpError(connectorErrors)),
			)
			.handle("create", ({ params, payload }) =>
				connectors
					.create({ ...params, connector: payload })
					.pipe(asCurrentUser, asHttpError(connectorErrors)),
			)
			.handle("get", ({ params }) =>
				connectors.get(params).pipe(asCurrentUser, asHttpError(connectorErrors)),
			)
			.handle("update", ({ params, payload }) =>
				connectors
					.update({ ...params, changes: payload })
					.pipe(asCurrentUser, asHttpError(connectorErrors)),
			)
			.handle("remove", ({ params }) =>
				connectors.remove(params).pipe(asCurrentUser, asHttpError(connectorErrors)),
			)
			.handle("testUnsaved", ({ params, payload }) =>
				connectors
					.testUnsaved({ ...params, server: payload })
					.pipe(asCurrentUser, asHttpError(connectorErrors)),
			)
			.handle("test", ({ params }) =>
				connectors.test(params).pipe(asCurrentUser, asHttpError(connectorErrors)),
			)
			.handle("connectBuiltIn", ({ params, payload }) =>
				connectors
					.connectBuiltIn({ ...params, server: payload })
					.pipe(asCurrentUser, asHttpError(connectorErrors)),
			)
			.handle("startOAuth", ({ params }) =>
				connectors.startOAuth(params).pipe(asCurrentUser, asHttpError(connectorErrors)),
			)
			.handle("oauthCallback", ({ request, query }) =>
				Effect.gen(function* () {
					if (request.method === "HEAD") {
						return refuseHead;
					}
					const outcome = yield* connectors
						.completeOAuth({
							callback: {
								code: query.code,
								state: query.state,
								error: query.error,
								errorDescription: query.error_description,
							},
						})
						.pipe(asCurrentUser, asHttpError(connectorErrors));
					return webAppReturn({
						webAppUrl,
						path: CONNECTOR_SIGN_IN_RETURN_PATH,
						at: outcome.at,
						outcome: "failure" in outcome ? { oauth_error: outcome.failure } : {},
					});
				}),
			);
	}),
);

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
