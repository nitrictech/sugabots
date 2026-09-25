import { BadRequest, Conflict } from "@sugabots/contracts/http";
import { githubOperations } from "@sugabots/core/github/operations";
import type { GithubStore } from "@sugabots/core/github/store";
import type {
	EgressHttpClients,
	EgressUrlValidator,
} from "@sugabots/core/providers/network/egress";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { ServerApi } from "../../http/api.ts";
import { grantedPod, grantedWorkspace } from "../../http/authorisation.ts";
import { asHttpError } from "../../http/errors.ts";

export interface GithubRoutesOptions {
	github: GithubStore;
	httpClients: EgressHttpClients;
	validateProviderUrl: EgressUrlValidator;
}

export function githubRoutes({ github, httpClients, validateProviderUrl }: GithubRoutesOptions) {
	const operations = githubOperations({ github, httpClients, validateUrl: validateProviderUrl });

	return HttpApiBuilder.group(ServerApi, "github", (handlers) =>
		handlers
			.handle("get", () =>
				Effect.flatMap(grantedWorkspace, ({ workspaceId }) => operations.get(workspaceId)),
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
			.handle("listPodRepositories", () =>
				Effect.flatMap(grantedPod, ({ pod }) => operations.listRepositories(pod.id)),
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
