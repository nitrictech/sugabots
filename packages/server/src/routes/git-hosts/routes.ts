import { GIT_HOSTS_RETURN_PATH } from "@sugabots/contracts";
import { BadRequest, NotFound } from "@sugabots/contracts/http";
import { GitHosts } from "@sugabots/core/git-hosts/git-hosts";
import { Installation } from "@sugabots/core/installation/installation";
import { Effect } from "effect";
import { HttpServerResponse } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { asSessionUser } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";
import { asHttpError, refusals } from "../../http/errors.ts";

export const gitHostRoutes = HttpApiBuilder.group(ServerApi, "gitHosts", (handlers) =>
	Effect.gen(function* () {
		// GitHub's callbacks redirect on to GitHub's next page, or back to
		// `GIT_HOSTS_RETURN_PATH` under the web app with the workspace's id and,
		// when setup stopped, why; the web app turns those into its own page.
		const { webAppUrl } = yield* Installation.Service;
		const gitHosts = yield* GitHosts.Service;
		const redirect = (outcome: GitHosts.SetupOutcome) => {
			if (outcome.kind === "next") {
				return HttpServerResponse.redirect(outcome.url, { status: 302 });
			}
			const back = new URL(webAppUrl);
			back.pathname = `${back.pathname.replace(/\/$/, "")}${GIT_HOSTS_RETURN_PATH}`;
			if (outcome.workspaceId) back.searchParams.set("workspace", outcome.workspaceId);
			if (outcome.kind === "failed") back.searchParams.set("git_host_error", outcome.failure);
			return HttpServerResponse.redirect(back.toString(), { status: 302 });
		};
		// A HEAD must not spend the one-time code a GET would.
		const headRefused = Effect.succeed(
			HttpServerResponse.empty({ status: 405, headers: { allow: "GET" } }),
		);
		return handlers
			.handle("list", ({ params }) =>
				gitHosts.list(params.workspace).pipe(asSessionUser, asHttpError(refusals)),
			)
			.handle("startGitHubApp", ({ params, payload }) =>
				gitHosts
					.startGitHubApp({ workspace: params.workspace, organization: payload.organization })
					.pipe(asSessionUser, asHttpError(refusals)),
			)
			.handle("installUrl", ({ params }) =>
				gitHosts.installUrl(params).pipe(
					Effect.map((url) => ({ url })),
					asSessionUser,
					asHttpError({ ...refusals, GitHostNotFound: NotFound }),
				),
			)
			.handle("remove", ({ params }) =>
				gitHosts.remove(params).pipe(asSessionUser, asHttpError(refusals)),
			)
			.handle("gitHubAppMade", ({ request, query }) =>
				request.method === "HEAD"
					? headRefused
					: gitHosts
							.gitHubAppMade({ code: query.code, state: query.state })
							.pipe(Effect.map(redirect), asSessionUser),
			)
			.handle("gitHubAppInstalled", ({ request, query }) =>
				request.method === "HEAD"
					? headRefused
					: gitHosts
							.gitHubAppInstalled({ installationId: query.installation_id, state: query.state })
							.pipe(Effect.map(redirect), asSessionUser),
			)
			.handle("podRepositories", ({ params }) =>
				gitHosts.podRepositories(params.podId).pipe(asSessionUser, asHttpError(refusals)),
			)
			.handle("availableRepositories", ({ params }) =>
				gitHosts
					.availableRepositories(params.podId)
					.pipe(asSessionUser, asHttpError({ ...refusals, GitHubFailed: BadRequest })),
			)
			.handle("addRepository", ({ params, payload }) =>
				gitHosts.addRepository({ podId: params.podId, ...payload }).pipe(
					asSessionUser,
					asHttpError({
						...refusals,
						RepositoryUnreachable: BadRequest,
						GitHubFailed: BadRequest,
					}),
				),
			)
			.handle("removeRepository", ({ params, payload }) =>
				gitHosts
					.removeRepository({ podId: params.podId, ...payload })
					.pipe(asSessionUser, asHttpError(refusals)),
			);
	}),
);
