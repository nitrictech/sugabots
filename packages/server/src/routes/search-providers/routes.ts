import { BadRequest, NotFound } from "@sugabots/contracts/http";
import { SearchProviderSetup } from "@sugabots/core/providers/search-providers/search-provider-setup";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { asSessionUser } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";
import { asHttpError, refusals } from "../../http/errors.ts";

export const searchProviderRoutes = HttpApiBuilder.group(ServerApi, "searchProviders", (handlers) =>
	Effect.gen(function* () {
		const search = yield* SearchProviderSetup.Service;
		return handlers
			.handle("get", ({ params }) =>
				search.get(params.workspace).pipe(
					Effect.map((provider) => ({ provider: provider ?? null })),
					asSessionUser,
					asHttpError(searchProviderErrors),
				),
			)
			.handle("webAccess", ({ params }) =>
				search.webAccess(params.workspace).pipe(
					Effect.map((enabled) => ({ enabled })),
					asSessionUser,
					asHttpError(searchProviderErrors),
				),
			)
			.handle("replace", ({ params, payload }) =>
				search
					.replace({ workspace: params.workspace, provider: payload })
					.pipe(asSessionUser, asHttpError(searchProviderErrors)),
			)
			.handle("update", ({ params, payload }) =>
				search
					.update({ workspace: params.workspace, changes: payload })
					.pipe(asSessionUser, asHttpError(searchProviderErrors)),
			)
			.handle("remove", ({ params }) =>
				search.remove(params.workspace).pipe(asSessionUser, asHttpError(searchProviderErrors)),
			)
			.handle("test", ({ params }) =>
				search.test(params.workspace).pipe(asSessionUser, asHttpError(searchProviderErrors)),
			);
	}),
);

const searchProviderErrors = {
	...refusals,
	SearchProviderNotFound: NotFound,
	UrlNotAllowed: BadRequest,
	SearchProviderApiKeyRequired: BadRequest,
};
