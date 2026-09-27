import { BadRequest, NotFound } from "@sugabots/contracts/http";
import type {
	EgressHttpClients,
	EgressUrlValidator,
} from "@sugabots/core/providers/network/egress";
import { searchProviderOperations } from "@sugabots/core/providers/search-providers/operations";
import type { SearchProviderStore } from "@sugabots/core/providers/search-providers/store";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { ServerApi } from "../../http/api.ts";
import { grantedWorkspace } from "../../http/authorisation.ts";
import { asHttpError } from "../../http/errors.ts";

export interface SearchProviderRoutesOptions {
	searchProviders: SearchProviderStore;
	httpClients: EgressHttpClients;
	validateProviderUrl: EgressUrlValidator;
}

export function searchProviderRoutes({
	searchProviders,
	httpClients,
	validateProviderUrl,
}: SearchProviderRoutesOptions) {
	const operations = searchProviderOperations({
		providers: searchProviders,
		httpClients,
		validateProviderUrl,
	});

	return HttpApiBuilder.group(ServerApi, "searchProviders", (handlers) =>
		handlers
			.handle("get", () =>
				Effect.flatMap(grantedWorkspace, ({ workspaceId }) => operations.get(workspaceId)),
			)
			.handle("webAccess", () =>
				Effect.flatMap(grantedWorkspace, ({ workspaceId }) => operations.webAccess(workspaceId)),
			)
			.handle("replace", ({ payload }) =>
				Effect.flatMap(grantedWorkspace, ({ workspaceId, actor }) =>
					operations
						.replace(workspaceId, actor.userId, payload)
						.pipe(asHttpError(searchProviderErrors)),
				),
			)
			.handle("update", ({ payload }) =>
				Effect.flatMap(grantedWorkspace, ({ workspaceId }) =>
					operations.update(workspaceId, payload).pipe(asHttpError(searchProviderErrors)),
				),
			)
			.handle("remove", () =>
				Effect.flatMap(grantedWorkspace, ({ workspaceId }) =>
					operations.remove(workspaceId).pipe(asHttpError(searchProviderErrors)),
				),
			)
			.handle("test", () =>
				Effect.flatMap(grantedWorkspace, ({ workspaceId }) =>
					operations.test(workspaceId).pipe(asHttpError(searchProviderErrors)),
				),
			),
	);
}

const searchProviderErrors = {
	SearchProviderNotFound: (failure: { message: string }) =>
		new NotFound({ message: failure.message }),
	SearchProviderUrlNotAllowed: (failure: { message: string }) =>
		new BadRequest({ message: failure.message }),
	SearchProviderApiKeyRequired: (failure: { message: string }) =>
		new BadRequest({ message: failure.message }),
};
