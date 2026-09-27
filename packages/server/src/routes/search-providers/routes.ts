import { BadRequest, NotFound } from "@sugabots/contracts/http";
import { SearchProviderSetup } from "@sugabots/core/providers/search-providers/search-provider-setup";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { ServerApi } from "../../http/api.ts";
import { grantedWorkspace } from "../../http/authorisation.ts";
import { asHttpError } from "../../http/errors.ts";

export const searchProviderRoutes = HttpApiBuilder.group(ServerApi, "searchProviders", (handlers) =>
	Effect.gen(function* () {
		const search = yield* SearchProviderSetup.Service;
		return handlers
			.handle("get", () =>
				Effect.flatMap(grantedWorkspace, ({ workspaceId }) =>
					Effect.map(search.get(workspaceId), (provider) => ({ provider: provider ?? null })),
				),
			)
			.handle("webAccess", () =>
				Effect.flatMap(grantedWorkspace, ({ workspaceId }) =>
					Effect.map(search.webAccess(workspaceId), (enabled) => ({ enabled })),
				),
			)
			.handle("replace", ({ payload }) =>
				Effect.flatMap(grantedWorkspace, ({ workspaceId, actor }) =>
					search
						.replace({ workspaceId, createdById: actor.userId, provider: payload })
						.pipe(asHttpError(searchProviderErrors)),
				),
			)
			.handle("update", ({ payload }) =>
				Effect.flatMap(grantedWorkspace, ({ workspaceId }) =>
					search.update({ workspaceId, changes: payload }).pipe(asHttpError(searchProviderErrors)),
				),
			)
			.handle("remove", () =>
				Effect.flatMap(grantedWorkspace, ({ workspaceId }) =>
					search.remove(workspaceId).pipe(asHttpError(searchProviderErrors)),
				),
			)
			.handle("test", () =>
				Effect.flatMap(grantedWorkspace, ({ workspaceId }) =>
					search.test(workspaceId).pipe(asHttpError(searchProviderErrors)),
				),
			);
	}),
);

const searchProviderErrors = {
	SearchProviderNotFound: NotFound,
	UrlNotAllowed: BadRequest,
	SearchProviderApiKeyRequired: BadRequest,
};
