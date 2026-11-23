import { CONNECTOR_SIGN_IN_RETURN_PATH } from "@sugabots/contracts";
import { BadRequest, Conflict, NotFound } from "@sugabots/contracts/http";
import { ConnectorSetup } from "@sugabots/core/providers/connectors/connector-setup";
import { ServerSettings } from "@sugabots/core/server-settings/server-settings";
import { Effect } from "effect";
import { HttpServerResponse } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { asSignedInPerson } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";
import { asHttpError, refusals } from "../../http/errors.ts";

export const connectorRoutes = HttpApiBuilder.group(ServerApi, "connectors", (handlers) =>
	Effect.gen(function* () {
		// A sign-in's callback redirects to `CONNECTOR_SIGN_IN_RETURN_PATH`
		// under the web app with the project's ids and, when it did not finish, the
		// code saying why, and the web app turns those into its own page and words.
		const { webAppUrl } = yield* ServerSettings.Service;
		const connectors = yield* ConnectorSetup.Service;
		return handlers
			.handle("list", ({ params }) =>
				connectors.list(params).pipe(asSignedInPerson, asHttpError(connectorErrors)),
			)
			.handle("create", ({ params, payload }) =>
				connectors
					.create({ ...params, connector: payload })
					.pipe(asSignedInPerson, asHttpError(connectorErrors)),
			)
			.handle("get", ({ params }) =>
				connectors.get(params).pipe(asSignedInPerson, asHttpError(connectorErrors)),
			)
			.handle("update", ({ params, payload }) =>
				connectors
					.update({ ...params, changes: payload })
					.pipe(asSignedInPerson, asHttpError(connectorErrors)),
			)
			.handle("remove", ({ params }) =>
				connectors.remove(params).pipe(asSignedInPerson, asHttpError(connectorErrors)),
			)
			.handle("testUnsaved", ({ params, payload }) =>
				connectors
					.testUnsaved({ ...params, server: payload })
					.pipe(asSignedInPerson, asHttpError(connectorErrors)),
			)
			.handle("test", ({ params }) =>
				connectors.test(params).pipe(asSignedInPerson, asHttpError(connectorErrors)),
			)
			.handle("connectBuiltIn", ({ params, payload }) =>
				connectors
					.connectBuiltIn({ ...params, server: payload })
					.pipe(asSignedInPerson, asHttpError(connectorErrors)),
			)
			.handle("startOAuth", ({ params }) =>
				connectors.startOAuth(params).pipe(asSignedInPerson, asHttpError(connectorErrors)),
			)
			.handle("oauthCallback", ({ request, query }) =>
				Effect.gen(function* () {
					// A HEAD must not spend the one-time code a GET would.
					if (request.method === "HEAD") {
						return HttpServerResponse.empty({ status: 405, headers: { allow: "GET" } });
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
						.pipe(asSignedInPerson, asHttpError(connectorErrors));
					const back = new URL(webAppUrl);
					back.pathname = `${back.pathname.replace(/\/$/, "")}${CONNECTOR_SIGN_IN_RETURN_PATH}`;
					if (outcome.at) {
						back.searchParams.set("workspace", outcome.at.workspaceId);
						back.searchParams.set("project", outcome.at.projectId);
					}
					if ("failure" in outcome) {
						back.searchParams.set("oauth_error", outcome.failure);
					}
					return HttpServerResponse.redirect(back.toString(), { status: 302 });
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
