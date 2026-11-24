import { BadRequest, NotFound } from "@sugabots/contracts/http";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { operationCaller } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";
import { asHttpError, refusals } from "../../http/errors.ts";

/** A workspace's one search provider, each endpoint its operation. */
export const searchProviderRoutes = HttpApiBuilder.group(ServerApi, "searchProviders", (handlers) =>
	Effect.map(operationCaller, (callOperation) =>
		handlers
			.handle("get", ({ params }) =>
				callOperation("searchProviders.get", params).pipe(asHttpError(searchProviderErrors)),
			)
			.handle("webAccess", ({ params }) =>
				callOperation("searchProviders.webAccess", params).pipe(asHttpError(searchProviderErrors)),
			)
			.handle("replace", ({ params, payload }) =>
				callOperation("searchProviders.replace", { ...params, ...payload }).pipe(
					asHttpError(searchProviderErrors),
				),
			)
			.handle("update", ({ params, payload }) =>
				callOperation("searchProviders.update", { ...params, changes: payload }).pipe(
					asHttpError(searchProviderErrors),
				),
			)
			.handle("remove", ({ params }) =>
				callOperation("searchProviders.remove", params).pipe(asHttpError(searchProviderErrors)),
			)
			.handle("test", ({ params }) =>
				callOperation("searchProviders.test", params).pipe(asHttpError(searchProviderErrors)),
			),
	),
);

/** What each way a search providers operation can fail means over HTTP. */
const searchProviderErrors = {
	...refusals,
	SearchProviderNotFound: NotFound,
	UrlNotAllowed: BadRequest,
	SearchProviderApiKeyRequired: BadRequest,
};
