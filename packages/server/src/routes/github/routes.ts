import { GITHUB_APP_RETURN_PATH } from "@sugabots/contracts";
import { BadRequest, Conflict, CurrentUser } from "@sugabots/contracts/http";
import { githubOperations } from "@sugabots/core/github/operations";
import type { GithubStore } from "@sugabots/core/github/store";
import type { GithubTokens } from "@sugabots/core/github/tokens";
import type { CredentialCipher } from "@sugabots/core/providers/model-providers/credentials";
import type {
	EgressHttpClients,
	EgressUrlValidator,
} from "@sugabots/core/providers/network/egress";
import type { Authorization } from "@sugabots/core/workspaces/access";
import { Effect } from "effect";
import { type HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { ServerApi } from "../../http/api.ts";
import { grantedPod, grantedWorkspace } from "../../http/authorisation.ts";
import { asHttpError } from "../../http/errors.ts";

export interface GithubRoutesOptions {
	github: GithubStore;
	tokens: GithubTokens;
	httpClients: EgressHttpClients;
	validateProviderUrl: EgressUrlValidator;
	cipher: CredentialCipher;
	authorization: Authorization;
	/** Where the API answers, for the addresses GitHub sends the browser back to. */
	apiUrl: string;
	/** Where the web app is, for sending the browser back to settings. */
	webAppUrl: string;
}

export function githubRoutes(options: GithubRoutesOptions) {
	const { github, tokens, httpClients, validateProviderUrl, cipher, authorization } = options;
	const operations = githubOperations({
		github,
		tokens,
		httpClients,
		validateUrl: validateProviderUrl,
		cipher,
		urls: {
			homepage: options.webAppUrl,
			appCreated: `${options.apiUrl}/github/app/created`,
			appInstalled: `${options.apiUrl}/github/app/installed`,
		},
		mayManage: (userId, workspaceId) =>
			authorization.workspace(userId, workspaceId, "workspace.providers.manage").pipe(
				Effect.as(true),
				Effect.catch(() => Effect.succeed(false)),
			),
	});

	/** The workspace's GitHub settings, saying what went wrong if something did. */
	const backToSettings = (workspaceSlug: string | undefined, error?: string) => {
		const back = new URL(options.webAppUrl);
		back.pathname = `${back.pathname.replace(/\/$/, "")}${workspaceSlug ? `/${workspaceSlug}${GITHUB_APP_RETURN_PATH}` : "/"}`;
		if (error) back.searchParams.set("github_error", error);
		return HttpServerResponse.redirect(back.toString(), { status: 302 });
	};

	/** A HEAD must not spend the one-time code a GET would. */
	const refuseHead = (request: HttpServerRequest.HttpServerRequest) =>
		request.method === "HEAD"
			? HttpServerResponse.empty({ status: 405, headers: { allow: "GET" } })
			: undefined;

	return HttpApiBuilder.group(ServerApi, "github", (handlers) =>
		handlers
			.handle("get", () =>
				Effect.flatMap(grantedWorkspace, ({ workspaceId, actor }) =>
					operations.get(workspaceId, actor.userId),
				),
			)
			.handle("replace", ({ payload }) =>
				Effect.flatMap(grantedWorkspace, ({ workspaceId, actor }) =>
					operations.replace(workspaceId, actor.userId, payload).pipe(asHttpError(githubErrors)),
				),
			)
			.handle("update", ({ payload }) =>
				Effect.flatMap(grantedWorkspace, ({ workspaceId }) =>
					operations.update(workspaceId, payload).pipe(asHttpError(githubErrors)),
				),
			)
			.handle("remove", () =>
				Effect.flatMap(grantedWorkspace, ({ workspaceId }) =>
					operations.remove(workspaceId).pipe(asHttpError(githubErrors)),
				),
			)
			.handle("test", () =>
				Effect.flatMap(grantedWorkspace, ({ workspaceId }) =>
					operations.test(workspaceId).pipe(asHttpError(githubErrors)),
				),
			)
			.handle("startApp", ({ payload }) =>
				Effect.flatMap(grantedWorkspace, ({ workspaceId, actor }) =>
					operations.startApp(workspaceId, actor.userId, payload.organization),
				),
			)
			.handle("appCreated", ({ request, query }) =>
				Effect.gen(function* () {
					const head = refuseHead(request);
					if (head) return head;
					const { id: userId } = yield* CurrentUser;
					return yield* operations.appCreated(userId, query.code, query.state).pipe(
						Effect.map(({ installUrl }) =>
							HttpServerResponse.redirect(installUrl, { status: 302 }),
						),
						Effect.catchTag("GithubAppSetupFailed", (failure) =>
							Effect.map(operations.workspaceSlugForState(userId, query.state), (slug) =>
								backToSettings(slug, failure.message),
							),
						),
					);
				}),
			)
			.handle("appInstalled", ({ request, query }) =>
				Effect.gen(function* () {
					const head = refuseHead(request);
					if (head) return head;
					const { id: userId } = yield* CurrentUser;
					return yield* operations.appInstalled(userId, query.installation_id, query.state).pipe(
						Effect.map(({ workspaceSlug }) => backToSettings(workspaceSlug)),
						Effect.catchTag("GithubAppSetupFailed", (failure) =>
							Effect.map(operations.workspaceSlugForState(userId, query.state), (slug) =>
								backToSettings(slug, failure.message),
							),
						),
					);
				}),
			)
			.handle("listPodRepositories", () =>
				Effect.flatMap(grantedPod, ({ pod }) => operations.listRepositories(pod.id)),
			)
			.handle("listAvailableRepositories", () =>
				Effect.flatMap(grantedPod, ({ pod }) =>
					operations
						.listAvailableRepositories({ workspaceId: pod.workspaceId, podId: pod.id })
						.pipe(asHttpError(githubErrors)),
				),
			)
			.handle("addPodRepository", ({ payload }) =>
				Effect.flatMap(grantedPod, ({ pod, actor }) =>
					operations
						.addRepository({ workspaceId: pod.workspaceId, podId: pod.id }, actor.userId, payload)
						.pipe(asHttpError(githubErrors)),
				),
			)
			.handle("removePodRepository", ({ params }) =>
				Effect.flatMap(grantedPod, ({ pod }) =>
					operations.removeRepository(pod.id, params.repositoryId),
				),
			),
	);
}

const badRequest = (failure: { message: string }) => new BadRequest({ message: failure.message });

const githubErrors = {
	GithubConnectionNotFound: badRequest,
	GithubUrlNotAllowed: badRequest,
	RepositoryNotReadable: badRequest,
	RepositoryAlreadyAdded: (failure: { message: string }) =>
		new Conflict({ message: failure.message }),
};
