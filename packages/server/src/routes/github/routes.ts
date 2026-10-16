import { GITHUB_SETUP_RETURN_PATH } from "@sugabots/contracts";
import { Conflict, NotFound } from "@sugabots/contracts/http";
import { Installation } from "@sugabots/core/installation/installation";
import { GitHubApps } from "@sugabots/core/providers/connections/github/github-app";
import { Effect } from "effect";
import { HttpServerResponse } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { asSessionUser } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";
import { asHttpError, refusals } from "../../http/errors.ts";

const connectionErrors = {
	...refusals,
	NotGitHubConnection: NotFound,
	PodHasGitHubConnection: Conflict,
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
