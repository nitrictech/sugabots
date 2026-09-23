import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";
import {
	newSearchProviderSchema,
	searchProviderResponseSchema,
	searchProviderSchema,
	searchProviderTestResultSchema,
	searchProviderUpdateSchema,
} from "../../search-providers.ts";
import { uuidSchema } from "../../uuid.ts";
import { BadRequest } from "../errors.ts";
import { Authorise, Session } from "../middleware.ts";

/** A workspace has at most one search provider, so it is addressed by the workspace alone. */
const root = "/workspaces/:workspaceId/search-provider";
const params = { workspaceId: uuidSchema };

export class SearchProvidersApi extends HttpApiGroup.make("searchProviders")
	.add(
		HttpApiEndpoint.get("get", root, { params, success: searchProviderResponseSchema }),
		HttpApiEndpoint.put("replace", root, {
			params,
			payload: newSearchProviderSchema,
			success: searchProviderSchema.pipe(HttpApiSchema.status(201)),
			error: BadRequest,
		}),
		HttpApiEndpoint.patch("update", root, {
			params,
			payload: searchProviderUpdateSchema,
			success: searchProviderSchema,
			error: BadRequest,
		}),
		HttpApiEndpoint.delete("remove", root, { params }),
		HttpApiEndpoint.post("test", `${root}/test`, {
			params,
			success: searchProviderTestResultSchema,
		}),
	)
	.middleware(Authorise)
	.middleware(Session) {}
