import {
	CONNECTOR_SIGN_IN_RETURN_PATH,
	GITHUB_SETUP_RETURN_PATH,
	type GitHubSetupOutcome,
} from "@sugabots/contracts";
import { ServerSettings } from "@sugabots/core/server-settings/server-settings";
import { Effect } from "effect";
import { HttpServerResponse } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { operationCaller } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";
import { answerAsHttp } from "../../http/errors.ts";
import { refuseHead, webAppReturn } from "../../http/web-app-return.ts";

/**
 * Where a sign-in the member's session started finishes, each its operation,
 * answered with a redirect, since a browser is reading it. A `HEAD` is
 * refused, so a link checker can't spend a one-time code.
 */
export const signInCallbackRoutes = HttpApiBuilder.group(ServerApi, "signInCallbacks", (handlers) =>
	Effect.gen(function* () {
		const { webAppUrl } = yield* ServerSettings.Service;
		const callOperation = yield* operationCaller;
		// GitHub's callbacks redirect on to GitHub's next page, or back to
		// `GITHUB_SETUP_RETURN_PATH` under the web app with the project's ids and,
		// when setup stopped, why; the web app turns those into its own page.
		const gitHubRedirect = (outcome: GitHubSetupOutcome) => {
			if (outcome.kind === "next") {
				return HttpServerResponse.redirect(outcome.url, { status: 302 });
			}
			const back = { webAppUrl, path: GITHUB_SETUP_RETURN_PATH, at: outcome.at };
			if (outcome.kind === "done") {
				return webAppReturn({ ...back, outcome: { connector: outcome.connectorId } });
			}
			return webAppReturn({ ...back, outcome: { github_error: outcome.failure } });
		};
		return (
			handlers
				// A connector's sign-in redirects to `CONNECTOR_SIGN_IN_RETURN_PATH` under
				// the web app with the project's ids and, when it did not finish, the
				// code saying why, and the web app turns those into its own page and words.
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
						}).pipe(answerAsHttp);
						return webAppReturn({
							webAppUrl,
							path: CONNECTOR_SIGN_IN_RETURN_PATH,
							at: outcome.at,
							outcome: outcome.kind === "failed" ? { oauth_error: outcome.failure } : {},
						});
					}),
				)
				.handleRaw("gitHubAppMade", ({ request, query }) =>
					request.method === "HEAD"
						? Effect.succeed(refuseHead)
						: callOperation("gitHubConnectors.gitHubAppMade", {
								code: query.code,
								state: query.state,
							}).pipe(Effect.map(gitHubRedirect)),
				)
				.handleRaw("gitHubAppInstalled", ({ request, query }) =>
					request.method === "HEAD"
						? Effect.succeed(refuseHead)
						: callOperation("gitHubConnectors.gitHubAppInstalled", {
								installationId: query.installation_id,
								state: query.state,
							}).pipe(Effect.map(gitHubRedirect)),
				)
		);
	}),
);
